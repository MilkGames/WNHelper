/*
 * WN Helper Discord Bot
 * Copyright (C) 2026 MilkGames
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */
const crypto = require('crypto');
const { getDepartments } = require('../../core/config/departmentSchema');
const { getVacationSettings } = require('./settings/schema');
const vacationRequests = require('./database').vacationRequests;
const guildConfigService = require('../../core/config/guildConfigService');
const { getMemberRank, getMemberRankMatches } = require('../staff-audit');
const { mutateDatabase: mutateDb, readDatabase: readDb } = require('./database');
const {
    editMessageWithRetry,
    runDiscordRequest,
    sendMessageWithRetry,
} = require('../../core/discord/request');
const logger = require('../../core/logging/logger');
const { invokeAction } = require('../../core/integrations/actionRegistry');
const shifts = require('../shifts');
const VacationError = require('./error');
const {
    buildPanelPayload,
    buildRequestComponents,
    buildRequestEmbed,
    formatDate,
    getStatusLabel,
} = require('./presentation');

const ACTIVE_REQUEST_STATUSES = new Set([
    'pending',
    'approved',
    'scheduled',
    'active',
    'awaiting_return',
]);
const ACCESS_BLOCKING_STATUSES = new Set(['active', 'awaiting_return', 'overdue']);
const MONTH_USAGE_STATUSES = new Set([
    'approved',
    'scheduled',
    'active',
    'awaiting_return',
    'completed',
    'overdue',
    'closed_by_dismissal',
]);
const MOSCOW_OFFSET = '+03:00';
const DAY_MS = 86_400_000;

function id(prefix = 'vac') {
    const suffix = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}-${suffix}`;
}

function clone(value) {
    return value == null ? value : structuredClone(value);
}

function normalizeId(value) {
    const result = String(value || '').trim();
    return result || null;
}

function normalizeReason(value) {
    return String(value || '').trim().slice(0, 1000);
}

function getMoscowDateKey(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Moscow',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}

function parseDateKey(value) {
    const text = String(value || '').trim();
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!match) return null;
    const timestamp = Date.parse(`${text}T00:00:00${MOSCOW_OFFSET}`);
    if (!Number.isFinite(timestamp)) return null;
    const date = new Date(timestamp);
    const expected = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
    // компоненты UTC отличаются на день при смещении +03, поэтому дата проверяется отдельным расчётом ниже
    const [year, month, day] = match.slice(1).map(Number);
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
    return { key: text, timestamp, year, month, day, expected };
}

function dateKeyAtTime(dateKey, time = '00:00') {
    const parsed = parseDateKey(dateKey);
    if (!parsed) return null;
    const normalizedTime = /^\d{2}:\d{2}$/.test(String(time || '')) ? String(time) : '00:00';
    const timestamp = Date.parse(`${parsed.key}T${normalizedTime}:00${MOSCOW_OFFSET}`);
    return Number.isFinite(timestamp) ? timestamp : null;
}

function addDays(dateKey, days) {
    const parsed = parseDateKey(dateKey);
    if (!parsed) return null;
    const date = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + Number(days || 0)));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function compareDateKeys(left, right) {
    return String(left).localeCompare(String(right));
}

function countInclusiveDays(startDate, endDate) {
    const start = parseDateKey(startDate);
    const end = parseDateKey(endDate);
    if (!start || !end) return null;
    const startUtc = Date.UTC(start.year, start.month - 1, start.day);
    const endUtc = Date.UTC(end.year, end.month - 1, end.day);
    if (endUtc < startUtc) return null;
    return Math.floor((endUtc - startUtc) / DAY_MS) + 1;
}

function getEffectiveApprovalPeriod(request, today = getMoscowDateKey()) {
    const requestedStartDate = request?.requestedStartDate || request?.startDate;
    const requestedEndDate = request?.requestedEndDate || request?.endDate;
    if (!parseDateKey(requestedStartDate) || !parseDateKey(requestedEndDate) || !parseDateKey(today)) {
        throw new VacationError('В заявке указаны некорректные даты.', 'invalid_dates');
    }
    if (compareDateKeys(requestedEndDate, today) < 0) {
        throw new VacationError('Период заявки уже полностью закончился.', 'vacation_period_expired');
    }

    const startDate = compareDateKeys(requestedStartDate, today) < 0
        ? today
        : requestedStartDate;
    const durationDays = countInclusiveDays(startDate, requestedEndDate);
    if (!durationDays) {
        throw new VacationError('Период заявки уже полностью закончился.', 'vacation_period_expired');
    }
    const approvalWaitDays = compareDateKeys(requestedStartDate, startDate) < 0
        ? countInclusiveDays(requestedStartDate, addDays(startDate, -1)) || 0
        : 0;

    return {
        requestedStartDate,
        requestedEndDate,
        startDate,
        endDate: requestedEndDate,
        durationDays,
        approvalWaitDays,
    };
}

function getMonthSlices(startDate, endDate) {
    const total = countInclusiveDays(startDate, endDate);
    if (!total) return [];
    const result = new Map();
    let current = startDate;
    for (let index = 0; index < total; index += 1) {
        const monthKey = current.slice(0, 7);
        result.set(monthKey, (result.get(monthKey) || 0) + 1);
        current = addDays(current, 1);
    }
    return [...result.entries()].map(([monthKey, days]) => ({ monthKey, days }));
}

function getConfig(guildId) {
    return guildConfigService.get(String(guildId));
}

function assertFeatureEnabled(config) {
    if (!config?.features?.vacations) {
        throw new VacationError('Функция отпусков отключена на этом сервере.', 'feature_disabled');
    }
}

function getType(config, typeId) {
    return getVacationSettings(config).types.find((type) => type.id === String(typeId || '')) || null;
}

function getActiveRequest(guildId, memberId) {
    const db = readDb();
    return clone((db.vacationRequests || []).find((entry) => (
        String(entry.guildId) === String(guildId) &&
        String(entry.memberId) === String(memberId) &&
        ACTIVE_REQUEST_STATUSES.has(entry.status)
    )) || null);
}

function getRequestById(requestId) {
    const db = readDb();
    return clone((db.vacationRequests || []).find((entry) => String(entry.requestId) === String(requestId)) || null);
}

function getBlockingVacation(guildId, memberId) {
    const db = readDb();
    return clone((db.vacationRequests || []).find((entry) => (
        String(entry.guildId) === String(guildId) &&
        String(entry.memberId) === String(memberId) &&
        ACCESS_BLOCKING_STATUSES.has(entry.status)
    )) || null);
}

function findMemberDepartment(member, config) {
    const matches = getDepartments(config).filter((department) => (
        department.roles?.memberRoleId && member.roles.cache.has(department.roles.memberRoleId)
    ));
    if (matches.length > 1) {
        throw new VacationError(
            `У сотрудника найдено несколько основных отделов: ${matches.map((entry) => entry.shortName).join(', ')}.`,
            'department_conflict'
        );
    }
    return matches[0] || null;
}

function memberHasAnyRole(member, roleIds) {
    return (Array.isArray(roleIds) ? roleIds : []).some((roleId) => member?.roles?.cache?.has(roleId));
}

function assertMemberCanUseType(member, config, type) {
    const wnRoleId = normalizeId(config.commonRoles?.weazelNewsRoleId);
    if (!wnRoleId || !member.roles.cache.has(wnRoleId)) {
        throw new VacationError('Подать заявку может только действующий сотрудник Weazel News.', 'wn_role_required');
    }
    const department = findMemberDepartment(member, config);
    const rankMatches = getMemberRankMatches(member, config);
    if (rankMatches.length > 1) {
        throw new VacationError('У сотрудника обнаружено несколько ролей ранга.', 'rank_conflict');
    }
    const rank = getMemberRank(member, config);
    const availability = type.availability || {};
    const configuredConditions = Boolean(
        availability.minRankNumber ||
        availability.allowNoDepartment ||
        availability.roleIds?.length
    );
    if (!configuredConditions) return { department, rank };

    const rankAllowed = availability.minRankNumber && rank && rank.number >= availability.minRankNumber;
    const noDepartmentAllowed = availability.allowNoDepartment && !department;
    const roleAllowed = memberHasAnyRole(member, availability.roleIds);
    if (!rankAllowed && !noDepartmentAllowed && !roleAllowed) {
        throw new VacationError('Этот тип отпуска недоступен для вашего ранга, отдела или ролей.', 'vacation_type_unavailable');
    }
    return { department, rank };
}

function resolveApprovalRoute(member, config, type, department, exceedReasons) {
    const settings = getVacationSettings(config);
    if (exceedReasons.length) {
        if (type.exceedMode === 'block') {
            throw new VacationError(
                `Заявка превышает ограничения:\n${exceedReasons.map((entry) => `• ${entry}`).join('\n')}`,
                'vacation_limits_exceeded'
            );
        }
        if (!type.exceedApproverRoleIds.length) {
            throw new VacationError('Для превышения лимитов не настроены роли согласования.', 'exceed_approvers_missing');
        }
        return {
            roleIds: type.exceedApproverRoleIds,
            routeType: 'limit_exceeded',
            routeLabel: 'Превышение лимитов',
        };
    }

    const roleRoute = settings.roleRoutes.find((route) => memberHasAnyRole(member, route.applicantRoleIds));
    if (roleRoute) {
        if (!roleRoute.approverRoleIds.length) {
            throw new VacationError(`В маршруте "${roleRoute.name}" не выбраны роли согласования.`, 'route_approvers_missing');
        }
        return { roleIds: roleRoute.approverRoleIds, routeType: 'role', routeLabel: roleRoute.name };
    }

    if (!department) {
        if (!settings.noDepartmentApproverRoleIds.length) {
            throw new VacationError('Для сотрудников без отдела не настроены роли согласования отпусков.', 'no_department_route_missing');
        }
        return {
            roleIds: settings.noDepartmentApproverRoleIds,
            routeType: 'no_department',
            routeLabel: 'Без основного отдела',
        };
    }

    const isHead = Boolean(department.roles?.headRoleId && member.roles.cache.has(department.roles.headRoleId));
    const isDeputy = Boolean(department.roles?.deputyHeadRoleId && member.roles.cache.has(department.roles.deputyHeadRoleId));
    let roleIds;
    let routeType;
    let routeLabel;
    if (isHead) {
        roleIds = settings.upperLeadershipRoleIds;
        routeType = 'department_head';
        routeLabel = `Руководитель ${department.shortName}`;
    } else if (isDeputy) {
        roleIds = department.roles?.headRoleId ? [department.roles.headRoleId] : [];
        routeType = 'department_deputy';
        routeLabel = `Заместитель руководителя ${department.shortName}`;
    } else {
        roleIds = [department.roles?.headRoleId, department.roles?.deputyHeadRoleId].filter(Boolean);
        routeType = 'department_member';
        routeLabel = `Руководство ${department.shortName}`;
    }
    roleIds = [...new Set(roleIds)].filter(Boolean);
    if (!roleIds.length) {
        throw new VacationError(`Для маршрута "${routeLabel}" не настроены роли согласования.`, 'department_route_missing');
    }
    return { roleIds, routeType, routeLabel };
}

function getMonthlyUsage(guildId, memberId, excludedRequestId = null) {
    const db = readDb();
    const usage = new Map();
    for (const request of db.vacationRequests || []) {
        if (String(request.guildId) !== String(guildId) || String(request.memberId) !== String(memberId)) continue;
        if (excludedRequestId && String(request.requestId) === String(excludedRequestId)) continue;
        if (!MONTH_USAGE_STATUSES.has(request.status)) continue;
        const usageEndDate = request.status === 'completed' && parseDateKey(request.effectiveEndDate)
            ? request.effectiveEndDate
            : request.endDate;
        for (const slice of getMonthSlices(request.startDate, usageEndDate)) {
            usage.set(slice.monthKey, (usage.get(slice.monthKey) || 0) + slice.days);
        }
    }
    return usage;
}

function validatePeriodAndLimits({ guildId, memberId, type, startDate, endDate, excludedRequestId = null }) {
    const today = getMoscowDateKey();
    if (!parseDateKey(startDate) || !parseDateKey(endDate)) {
        throw new VacationError('Даты должны быть указаны в формате YYYY-MM-DD.', 'invalid_dates');
    }
    if (compareDateKeys(startDate, today) < 0) {
        throw new VacationError('Дата начала отпуска не может быть в прошлом.', 'start_date_past');
    }
    const durationDays = countInclusiveDays(startDate, endDate);
    if (!durationDays) {
        throw new VacationError('Дата окончания должна быть не раньше даты начала.', 'invalid_period');
    }
    if (durationDays < type.minDurationDays) {
        throw new VacationError(`Минимальная продолжительность этого отпуска - ${type.minDurationDays} дн.`, 'duration_too_short');
    }

    const exceedReasons = [];
    if (type.maxDurationDays > 0 && durationDays > type.maxDurationDays) {
        exceedReasons.push(`максимальная продолжительность ${type.maxDurationDays} дн.; запрошено ${durationDays} дн.`);
    }
    const monthlyUsage = getMonthlyUsage(guildId, memberId, excludedRequestId);
    const monthSlices = getMonthSlices(startDate, endDate).map((slice) => {
        const usedBefore = monthlyUsage.get(slice.monthKey) || 0;
        const usedAfter = usedBefore + slice.days;
        if (type.monthlyLimitDays > 0 && usedAfter > type.monthlyLimitDays) {
            exceedReasons.push(
                `${slice.monthKey}: лимит ${type.monthlyLimitDays} дн.; было ${usedBefore}, запрошено ${slice.days}, станет ${usedAfter}`
            );
        }
        return { ...slice, usedBefore, usedAfter, limit: type.monthlyLimitDays };
    });
    return { durationDays, monthSlices, exceedReasons };
}

async function updateStoredRequest(requestId, updater) {
    let result = null;
    await mutateDb((db) => {
        db.vacationRequests ||= [];
        const index = db.vacationRequests.findIndex((entry) => String(entry.requestId) === String(requestId));
        if (index < 0) return;
        const next = updater(db.vacationRequests[index]);
        if (next) db.vacationRequests[index] = next;
        result = clone(db.vacationRequests[index]);
    });
    return result;
}

async function getRequestChannel(client, guildId, config) {
    const settings = getVacationSettings(config);
    if (!settings.requestChannelId) {
        throw new VacationError('Канал заявок на отпуск не настроен.', 'request_channel_missing');
    }
    const channel = await client.channels.fetch(settings.requestChannelId).catch(() => null);
    if (!channel?.isTextBased?.() || typeof channel.send !== 'function' || String(channel.guildId) !== String(guildId)) {
        throw new VacationError('Канал заявок на отпуск недоступен боту.', 'request_channel_unavailable');
    }
    return channel;
}

async function updateRequestMessage(client, request) {
    if (!request?.requestChannelId || !request?.requestMessageId) return false;
    const channel = await client.channels.fetch(request.requestChannelId).catch(() => null);
    const message = await channel?.messages?.fetch?.(request.requestMessageId).catch(() => null);
    if (!message) return false;
    const roles = [...new Set(request.approvalRoleIds || [])];
    await editMessageWithRetry(message, {
        content: roles.map((roleId) => `<@&${roleId}>`).join(' '),
        embeds: [buildRequestEmbed(request)],
        components: buildRequestComponents(request),
        allowedMentions: { parse: [], roles },
    });
    return true;
}

async function publishRequest(client, request, { recoveryKey = null } = {}) {
    const config = getConfig(request.guildId);
    const channel = await getRequestChannel(client, request.guildId, config);
    const roles = [...new Set(request.approvalRoleIds || [])];
    const content = roles.map((roleId) => `<@&${roleId}>`).join(' ');
    const message = await sendMessageWithRetry(channel, {
        content,
        embeds: [buildRequestEmbed(request)],
        components: buildRequestComponents(request),
        allowedMentions: { parse: [], roles },
    }, { nonceSeed: recoveryKey ? `vacationRequestRecovery:${request.requestId}:${recoveryKey}` : `vacationRequest:${request.requestId}` });
    return updateStoredRequest(request.requestId, (entry) => {
        entry.requestChannelId = String(message.channelId);
        entry.requestMessageId = String(message.id);
        entry.requestMessageLink = `https://discord.com/channels/${entry.guildId}/${message.channelId}/${message.id}`;
        entry.updatedAt = Date.now();
        return entry;
    });
}


async function sendApprovalNotice(client, request, text, nonceSeed) {
    if (!request?.requestChannelId) return false;
    const channel = await client.channels.fetch(request.requestChannelId).catch(() => null);
    const roleIds = [...new Set(request.approvalRoleIds || [])];
    if (!channel?.send || !roleIds.length) return false;
    await sendMessageWithRetry(channel, {
        content: [
            roleIds.map((roleId) => `<@&${roleId}>`).join(' '),
            text,
            request.requestMessageLink || '',
        ].filter(Boolean).join('\n'),
        allowedMentions: { parse: [], roles: roleIds },
    }, { nonceSeed });
    return true;
}

async function createOrUpdateRequest(client, {
    guild,
    member,
    typeId,
    startDate,
    endDate,
    reason,
    existingRequestId = null,
}) {
    const config = getConfig(guild.id);
    assertFeatureEnabled(config);
    const type = getType(config, typeId);
    if (!type?.enabled) throw new VacationError('Выбранный тип отпуска недоступен.', 'vacation_type_missing');
    const existing = existingRequestId ? getRequestById(existingRequestId) : getActiveRequest(guild.id, member.id);
    if (existing && String(existing.memberId) !== String(member.id)) {
        throw new VacationError('Нельзя изменить чужую заявку.', 'request_owner_mismatch');
    }
    if (existing && !['pending', 'scheduled'].includes(existing.status)) {
        throw new VacationError('Эту заявку уже нельзя изменить.', 'request_not_editable');
    }
    if (!existing && getActiveRequest(guild.id, member.id)) {
        throw new VacationError('У вас уже есть активная заявка или отпуск.', 'active_request_exists');
    }
    const normalizedReason = normalizeReason(reason);
    if (!normalizedReason) throw new VacationError('Укажите причину отпуска.', 'reason_required');
    const { department, rank } = assertMemberCanUseType(member, config, type);
    const period = validatePeriodAndLimits({
        guildId: guild.id,
        memberId: member.id,
        type,
        startDate,
        endDate,
        excludedRequestId: existing?.requestId || null,
    });
    const route = resolveApprovalRoute(member, config, type, department, period.exceedReasons);
    const now = Date.now();
    const record = {
        requestId: existing?.requestId || id('vacation'),
        guildId: String(guild.id),
        memberId: String(member.id),
        memberDisplayName: String(member.displayName || member.user?.username || member.id),
        typeId: type.id,
        typeName: type.name,
        typeSnapshot: clone(type),
        departmentId: department?.id || null,
        departmentName: department ? `${department.shortName} - ${department.fullName}` : null,
        rankNumber: rank?.number || null,
        rankName: rank?.name || null,
        requestedStartDate: startDate,
        requestedEndDate: endDate,
        startDate,
        endDate,
        durationDays: period.durationDays,
        approvalWaitDays: 0,
        monthSlices: period.monthSlices,
        reason: normalizedReason,
        exceedReasons: period.exceedReasons,
        approvalRoleIds: route.roleIds,
        approvalRouteType: route.routeType,
        approvalRouteLabel: route.routeLabel,
        status: 'pending',
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        requestChannelId: existing?.requestChannelId || null,
        requestMessageId: existing?.requestMessageId || null,
        requestMessageLink: existing?.requestMessageLink || null,
        approvedBy: null,
        approvedAt: null,
        rejectionReason: null,
        activationProgress: {},
        returnProgress: {},
        overdueActions: type.overdueRules.map((rule) => ({ ...clone(rule), status: 'pending' })),
        history: [
            ...(existing?.history || []),
            { action: existing ? 'edited' : 'created', actorId: member.id, at: now },
        ],
    };

    if (existing) {
        await vacationRequests.replaceOne({ requestId: existing.requestId }, record);
        await updateRequestMessage(client, record);
        await sendApprovalNotice(
            client,
            record,
            'Заявка на отпуск изменена и повторно отправлена на рассмотрение.',
            `vacationRequestEdited:${record.requestId}:${record.updatedAt}`
        ).catch(() => false);
        return record;
    }
    await new vacationRequests(record).save();
    return publishRequest(client, record);
}

function canApprove(member, request) {
    if (!member || String(member.id) === String(request.memberId)) return false;
    return memberHasAnyRole(member, request.approvalRoleIds || []);
}

async function approveRequest(client, requestId, approver, { exceptionReason = null } = {}) {
    let request = getRequestById(requestId);
    if (!request || request.status !== 'pending') throw new VacationError('Заявка уже обработана.', 'request_not_pending');
    const config = getConfig(request.guildId);
    const type = getType(config, request.typeId);
    if (!type?.enabled) throw new VacationError('Тип отпуска отключён или удалён.', 'vacation_type_missing');
    const target = await approver.guild.members.fetch(request.memberId).catch(() => null);
    if (!target) throw new VacationError('Сотрудник больше не находится на сервере.', 'member_missing');
    const { department, rank } = assertMemberCanUseType(target, config, type);
    const today = getMoscowDateKey();
    const effectivePeriod = getEffectiveApprovalPeriod(request, today);
    const period = validatePeriodAndLimits({
        guildId: request.guildId,
        memberId: request.memberId,
        type,
        startDate: effectivePeriod.startDate,
        endDate: effectivePeriod.endDate,
        excludedRequestId: request.requestId,
    });
    const route = resolveApprovalRoute(target, config, type, department, period.exceedReasons);
    const routeChanged = (
        route.routeType !== request.approvalRouteType ||
        JSON.stringify([...route.roleIds].sort()) !== JSON.stringify([...(request.approvalRoleIds || [])].sort())
    );
    const approvalPeriodChanged = (
        effectivePeriod.startDate !== request.startDate ||
        effectivePeriod.endDate !== request.endDate ||
        effectivePeriod.durationDays !== request.durationDays ||
        effectivePeriod.approvalWaitDays !== Number(request.approvalWaitDays || 0) ||
        !request.requestedStartDate ||
        !request.requestedEndDate
    );
    const limitsChanged = JSON.stringify(period.monthSlices) !== JSON.stringify(request.monthSlices || []) ||
        JSON.stringify(period.exceedReasons) !== JSON.stringify(request.exceedReasons || []);
    if (routeChanged || limitsChanged || approvalPeriodChanged) {
        request = await updateStoredRequest(request.requestId, (entry) => {
            const now = Date.now();
            entry.departmentId = department?.id || null;
            entry.departmentName = department ? `${department.shortName} - ${department.fullName}` : null;
            entry.rankNumber = rank?.number || null;
            entry.rankName = rank?.name || null;
            entry.requestedStartDate = effectivePeriod.requestedStartDate;
            entry.requestedEndDate = effectivePeriod.requestedEndDate;
            entry.startDate = effectivePeriod.startDate;
            entry.endDate = effectivePeriod.endDate;
            entry.durationDays = period.durationDays;
            entry.approvalWaitDays = effectivePeriod.approvalWaitDays;
            entry.monthSlices = period.monthSlices;
            entry.exceedReasons = period.exceedReasons;
            entry.approvalRoleIds = route.roleIds;
            entry.approvalRouteType = route.routeType;
            entry.approvalRouteLabel = route.routeLabel;
            entry.updatedAt = now;
            entry.history ||= [];
            if (approvalPeriodChanged) {
                entry.history.push({
                    action: effectivePeriod.approvalWaitDays > 0
                        ? 'approval_period_adjusted'
                        : 'approval_period_revalidated',
                    at: now,
                    requestedStartDate: effectivePeriod.requestedStartDate,
                    effectiveStartDate: effectivePeriod.startDate,
                    endDate: effectivePeriod.endDate,
                    approvalWaitDays: effectivePeriod.approvalWaitDays,
                });
            }
            if (routeChanged || limitsChanged) {
                entry.history.push({ action: 'approval_route_revalidated', at: now });
            }
            return entry;
        });
        await updateRequestMessage(client, request).catch(() => false);
        if (routeChanged && request.requestChannelId) {
            const channel = await client.channels.fetch(request.requestChannelId).catch(() => null);
            const roles = [...new Set(request.approvalRoleIds || [])];
            if (channel?.send && roles.length) {
                await sendMessageWithRetry(channel, {
                    content: [
                        roles.map((roleId) => `<@&${roleId}>`).join(' '),
                        `Маршрут согласования заявки изменён: ${request.approvalRouteLabel}.`,
                        request.requestMessageLink || '',
                    ].filter(Boolean).join('\n'),
                    allowedMentions: { parse: [], roles },
                }, { nonceSeed: `vacationRouteChanged:${request.requestId}:${request.approvalRouteType}` }).catch(() => undefined);
            }
        }
    }
    if (!canApprove(approver, request)) {
        throw new VacationError(
            routeChanged
                ? `Маршрут согласования изменился на "${request.approvalRouteLabel}". Заявку должен рассмотреть сотрудник с одной из новых ролей.`
                : 'У вас нет роли согласования этой заявки.',
            routeChanged ? 'approval_route_changed' : 'approval_access_denied'
        );
    }
    const normalizedExceptionReason = normalizeReason(exceptionReason);
    if (request.exceedReasons?.length && !normalizedExceptionReason) {
        throw new VacationError('Для одобрения превышения лимитов укажите причину исключения.', 'exception_reason_required');
    }
    request = await updateStoredRequest(requestId, (entry) => {
        if (entry.status !== 'pending') throw new VacationError('Заявка уже обработана.', 'state_conflict');
        const now = Date.now();
        entry.status = compareDateKeys(entry.startDate, today) <= 0 ? 'approved' : 'scheduled';
        entry.approvedBy = String(approver.id);
        entry.approvedByDisplayName = String(approver.displayName || approver.id);
        entry.approvedAt = now;
        entry.limitExceptionReason = entry.exceedReasons?.length ? normalizedExceptionReason : null;
        entry.limitExceptionApprovedBy = entry.exceedReasons?.length ? String(approver.id) : null;
        entry.updatedAt = now;
        entry.history ||= [];
        entry.history.push({
            action: entry.exceedReasons?.length ? 'approved_with_limit_exception' : 'approved',
            actorId: approver.id,
            at: now,
            exceptionReason: entry.limitExceptionReason || null,
        });
        return entry;
    });
    await updateRequestMessage(client, request).catch(() => false);
    if (request.status === 'approved') return activateRequest(client, request.requestId);
    return request;
}

async function rejectRequest(client, requestId, approver, reason) {
    const normalizedReason = normalizeReason(reason);
    if (!normalizedReason) throw new VacationError('Укажите причину отклонения.', 'rejection_reason_required');
    const current = getRequestById(requestId);
    if (!current || current.status !== 'pending') throw new VacationError('Заявка уже обработана.', 'request_not_pending');
    if (!canApprove(approver, current)) throw new VacationError('У вас нет роли согласования этой заявки.', 'approval_access_denied');
    const request = await updateStoredRequest(requestId, (entry) => {
        if (entry.status !== 'pending') throw new VacationError('Заявка уже обработана.', 'state_conflict');
        const now = Date.now();
        entry.status = 'rejected';
        entry.rejectionReason = normalizedReason;
        entry.rejectedBy = String(approver.id);
        entry.rejectedAt = now;
        entry.updatedAt = now;
        entry.history ||= [];
        entry.history.push({ action: 'rejected', actorId: approver.id, at: now, reason: normalizedReason });
        return entry;
    });
    await updateRequestMessage(client, request).catch(() => false);
    return request;
}

async function withdrawRequest(client, requestId, actor) {
    const current = getRequestById(requestId);
    if (!current || !['pending', 'scheduled'].includes(current.status)) {
        throw new VacationError('Эту заявку уже нельзя отозвать.', 'withdraw_not_allowed');
    }
    if (String(current.memberId) !== String(actor.id)) throw new VacationError('Отозвать заявку может только её автор.', 'withdraw_access_denied');
    const request = await updateStoredRequest(requestId, (entry) => {
        if (!['pending', 'scheduled'].includes(entry.status)) throw new VacationError('Заявка уже изменилась.', 'state_conflict');
        const now = Date.now();
        entry.status = 'cancelled';
        entry.cancelledAt = now;
        entry.updatedAt = now;
        entry.history ||= [];
        entry.history.push({ action: 'withdrawn', actorId: actor.id, at: now });
        return entry;
    });
    await updateRequestMessage(client, request).catch(() => false);
    return request;
}

async function releaseShifts(client, request) {
    if (!request.memberId) return;
    await shifts.releaseMemberFromSchedulesInPeriod(
        client,
        request.guildId,
        request.memberId,
        request.startDate,
        request.endDate,
        { reason: `vacation:${request.requestId}` }
    );
}

async function closeOwnSettingsSession(client, request) {
    const session = await invokeAction('settings.forceCloseSession', request.guildId, request.memberId);
    if (!session?.channelId || !session?.messageId) return;
    const channel = await client.channels.fetch(session.channelId).catch(() => null);
    const message = await channel?.messages?.fetch?.(session.messageId).catch(() => null);
    if (message) {
        await editMessageWithRetry(message, {
            content: `Сессия настроек закрыта автоматически: <@${request.memberId}> ушёл в отпуск.`,
            components: [],
            allowedMentions: { parse: [] },
        }).catch(() => undefined);
    }
}

function getActivationRoleIdsToRemove(type = {}, durationDays = 0) {
    const threshold = Number(type.conditionalRemoveMinDurationDays || 0);
    const includeConditional = Number.isFinite(threshold) &&
        threshold > 0 &&
        Number(durationDays) >= threshold;
    return [...new Set([
        ...(type.removeRoleIdsOnStart || []),
        ...(includeConditional ? type.conditionalRemoveRoleIdsOnStart || [] : []),
    ].map(String).filter(Boolean))];
}

async function activateRequest(client, requestId) {
    let request = getRequestById(requestId);
    if (!request || !['approved', 'scheduled', 'activation_failed'].includes(request.status)) return request;
    const today = getMoscowDateKey();
    if (compareDateKeys(request.startDate, today) > 0) return request;
    if (compareDateKeys(request.endDate, today) < 0) return request;
    const config = getConfig(request.guildId);
    assertFeatureEnabled(config);
    const type = request.typeSnapshot || getType(config, request.typeId);
    const guild = await client.guilds.fetch(request.guildId);
    const member = await guild.members.fetch(request.memberId).catch(() => null);
    if (!member) {
        request = await updateStoredRequest(requestId, (entry) => {
            entry.status = 'activation_failed';
            entry.lastError = 'Сотрудник отсутствует на сервере.';
            entry.updatedAt = Date.now();
            return entry;
        });
        await updateRequestMessage(client, request).catch(() => false);
        return request;
    }

    const completeStep = async (step, callback) => {
        if (request.activationProgress?.[step]) return;
        await callback();
        request = await updateStoredRequest(requestId, (entry) => {
            entry.activationProgress ||= {};
            entry.activationProgress[step] = Date.now();
            entry.updatedAt = Date.now();
            return entry;
        });
    };

    try {
        if (type.vacationRoleId) {
            await completeStep('vacation_role', async () => {
                const role = guild.roles.cache.get(type.vacationRoleId);
                if (!role || !role.editable) throw new VacationError('Бот не может выдать настроенную роль отпуска.', 'vacation_role_unmanageable');
                if (!member.roles.cache.has(role.id)) await runDiscordRequest(() => member.roles.add(role, `WN Helper: отпуск ${request.requestId}`));
            });
        }
        const roleIdsToRemove = getActivationRoleIdsToRemove(type, request.durationDays);
        if (roleIdsToRemove.length) {
            await completeStep('remove_roles', async () => {
                const roles = roleIdsToRemove
                    .filter((roleId) => member.roles.cache.has(roleId))
                    .map((roleId) => guild.roles.cache.get(roleId))
                    .filter(Boolean);
                const blocked = roles.find((role) => !role.editable);
                if (blocked) throw new VacationError(`Бот не может снять роль "${blocked.name}".`, 'vacation_remove_role_unmanageable');
                if (roles.length) await runDiscordRequest(() => member.roles.remove(roles, `WN Helper: начало отпуска ${request.requestId}`));
            });
        }
        if (type.releaseShiftsOnStart) await completeStep('shifts', () => releaseShifts(client, request));
        if (type.releaseExaminationAssignmentsOnStart) {
            await completeStep('examination', async () => {
                const examination = require('../examination');
                await examination.releaseHandledRequestsForVacation?.(client, request.guildId, request.memberId, request.requestId);
            });
        }
        if (type.closeSettingsSessionOnStart) await completeStep('settings', () => closeOwnSettingsSession(client, request));
        if (type.pauseDisciplineDeadlines) {
            await completeStep('discipline_pause', async () => {
                await invokeAction('discipline.setMemberVacationPause', client, request.guildId, request.memberId, {
                    vacationId: request.requestId,
                    paused: true,
                });
            });
        }
        request = await updateStoredRequest(requestId, (entry) => {
            const now = Date.now();
            entry.status = 'active';
            entry.activatedAt = entry.activatedAt || now;
            entry.lastError = null;
            entry.updatedAt = now;
            entry.history ||= [];
            if (!entry.history.some((item) => item.action === 'activated')) {
                entry.history.push({ action: 'activated', at: now });
            }
            return entry;
        });
    } catch (error) {
        request = await updateStoredRequest(requestId, (entry) => {
            entry.status = 'activation_failed';
            entry.lastError = String(error?.stack || error?.message || error);
            entry.updatedAt = Date.now();
            return entry;
        });
        await updateRequestMessage(client, request).catch(() => false);
        throw error;
    }
    await updateRequestMessage(client, request).catch(() => false);
    return request;
}

async function moveToAwaitingReturn(client, requestId) {
    const current = getRequestById(requestId);
    if (!current || current.status !== 'active') return current;
    const request = await updateStoredRequest(requestId, (entry) => {
        if (entry.status !== 'active') return entry;
        const now = Date.now();
        entry.status = 'awaiting_return';
        entry.awaitingReturnAt = now;
        entry.updatedAt = now;
        entry.history ||= [];
        entry.history.push({ action: 'awaiting_return', at: now });
        return entry;
    });
    await updateRequestMessage(client, request).catch(() => false);
    return request;
}

function canConfirmReturn(member, request) {
    if (String(member.id) === String(request.memberId)) return true;
    if (memberHasAnyRole(member, request.approvalRoleIds || [])) return true;
    const config = getConfig(request.guildId);
    const settings = getVacationSettings(config);
    return memberHasAnyRole(member, [
        ...settings.upperLeadershipRoleIds,
        ...settings.noDepartmentApproverRoleIds,
    ]);
}

async function confirmReturn(client, requestId, actor, { skipAuthorization = false } = {}) {
    let request = getRequestById(requestId);
    if (!request || !['active', 'awaiting_return'].includes(request.status)) {
        throw new VacationError('Завершить отпуск можно только после его начала.', 'return_not_available');
    }
    if (!skipAuthorization && !canConfirmReturn(actor, request)) throw new VacationError('У вас нет права подтверждать это возвращение.', 'return_access_denied');
    const guild = actor.guild;
    const member = await guild.members.fetch(request.memberId).catch(() => null);
    const type = request.typeSnapshot || getType(getConfig(request.guildId), request.typeId);
    const completeStep = async (step, callback) => {
        if (request.returnProgress?.[step]) return;
        await callback();
        request = await updateStoredRequest(requestId, (entry) => {
            entry.returnProgress ||= {};
            entry.returnProgress[step] = Date.now();
            entry.updatedAt = Date.now();
            return entry;
        });
    };
    try {
        if (member && type?.vacationRoleId) {
            await completeStep('vacation_role', async () => {
                if (member.roles.cache.has(type.vacationRoleId)) {
                    const role = guild.roles.cache.get(type.vacationRoleId);
                    if (role?.editable) await runDiscordRequest(() => member.roles.remove(role, `WN Helper: возвращение из отпуска ${request.requestId}`));
                }
            });
        }
        if (type?.pauseDisciplineDeadlines) {
            await completeStep('discipline_resume', async () => {
                await invokeAction('discipline.setMemberVacationPause', client, request.guildId, request.memberId, {
                    vacationId: request.requestId,
                    paused: false,
                });
            });
        }
        const now = Date.now();
        const today = getMoscowDateKey(new Date(now));
        const effectiveEndDate = compareDateKeys(today, request.endDate) < 0 ? today : request.endDate;
        const actualDurationDays = countInclusiveDays(request.startDate, effectiveEndDate) || request.durationDays;
        const monthlyUsage = getMonthlyUsage(request.guildId, request.memberId, request.requestId);
        const actualMonthSlices = getMonthSlices(request.startDate, effectiveEndDate).map((slice) => {
            const usedBefore = monthlyUsage.get(slice.monthKey) || 0;
            return {
                ...slice,
                usedBefore,
                usedAfter: usedBefore + slice.days,
                limit: type?.monthlyLimitDays || 0,
            };
        });
        request = await updateStoredRequest(requestId, (entry) => {
            entry.status = 'completed';
            entry.completedAt = now;
            entry.effectiveEndDate = effectiveEndDate;
            entry.actualDurationDays = actualDurationDays;
            entry.monthSlices = actualMonthSlices;
            entry.returnConfirmedBy = String(actor.id);
            entry.returnConfirmedAt = now;
            entry.lastError = null;
            entry.updatedAt = now;
            entry.overdueActions = (entry.overdueActions || []).map((rule) => (
                ['pending', 'failed'].includes(rule.status)
                    ? { ...rule, status: 'cancelled', cancelledAt: now, lastError: null }
                    : rule
            ));
            entry.history ||= [];
            entry.history.push({
                action: compareDateKeys(effectiveEndDate, entry.endDate) < 0
                    ? 'vacation_completed_early'
                    : 'return_confirmed',
                actorId: actor.id,
                at: now,
                effectiveEndDate,
            });
            return entry;
        });
    } catch (error) {
        request = await updateStoredRequest(requestId, (entry) => {
            entry.status = 'return_failed';
            entry.lastError = String(error?.stack || error?.message || error);
            entry.updatedAt = Date.now();
            return entry;
        });
        await updateRequestMessage(client, request).catch(() => false);
        throw error;
    }
    await updateRequestMessage(client, request).catch(() => false);
    return request;
}

async function executeOverdueRule(client, request, rule) {
    const guild = await client.guilds.fetch(request.guildId);
    const member = await guild.members.fetch(request.memberId).catch(() => null);
    if (!member) throw new Error('Сотрудник отсутствует на сервере.');
    const config = getConfig(request.guildId);
    const approver = request.approvedBy
        ? await guild.members.fetch(request.approvedBy).catch(() => null)
        : null;
    const reason = rule.reason || `Не подтверждено возвращение из отпуска ${request.requestMessageLink || request.requestId}`;

    if (rule.action === 'notify') {
        const channel = await client.channels.fetch(request.requestChannelId).catch(() => null);
        if (!channel?.send) throw new Error('Канал заявки недоступен.');
        const roleIds = rule.notifyRoleIds || [];
        await sendMessageWithRetry(channel, {
            content: [
                roleIds.map((roleId) => `<@&${roleId}>`).join(' '),
                `<@${request.memberId}> не подтвердил возвращение из отпуска.`,
                normalizeReason(rule.reason),
                request.requestMessageLink || '',
            ].filter(Boolean).join('\n'),
            allowedMentions: { parse: [], roles: roleIds, users: [request.memberId] },
        }, { nonceSeed: `vacationOverdueNotify:${request.requestId}:${rule.id}` });
        return { status: 'completed' };
    }

    if (rule.action === 'written') {
        if (!approver) throw new Error('Одобривший отпуск отсутствует на сервере.');
        const result = await invokeAction('discipline.issueCase', client, {
            guild,
            config,
            issuer: approver,
            member,
            violationDate: getMoscowDateKey(),
            violatedRules: 'Просрочка возвращения из отпуска',
            reason,
            evidence: request.requestMessageLink || request.requestId,
            selection: [{ type: 'written', count: 1 }],
            methodAssignments: { 'written-1': 'any' },
            suppressTargetPing: false,
            systemSource: {
                type: 'vacation_overdue',
                action: 'written',
                sourceCaseId: request.requestId,
                sourceSanctionId: rule.id,
            },
        });
        return { status: 'completed', caseId: result?.caseRecord?.caseId || null };
    }

    if (rule.action === 'dismissal') {
                let actor = approver;
        let forceApproval = false;
        let skipInitialHierarchy = false;
        if (!actor) {
            actor = [...(request.approvalRoleIds || [])]
                .flatMap((roleId) => [...(guild.roles.cache.get(roleId)?.members?.values?.() || [])])
                .find((candidate) => String(candidate.id) !== String(member.id)) || null;
            forceApproval = true;
            skipInitialHierarchy = true;
        }
        if (!actor) throw new Error('Не найден ответственный для запуска увольнения.');
        const target = {
            member,
            memberId: member.id,
            displayName: member.displayName,
            staticId: await invokeAction('staff-audit.extractStaticId', member.displayName),
            displayValue: `${member}`,
        };
        if (!target.staticId) throw new Error('Не удалось определить статик сотрудника для увольнения.');
        let outcome;
        try {
            outcome = await invokeAction('staff-audit.dismissMember', client, {
                guild,
                config,
                actor,
                target,
                reason,
                nonceSeed: `vacationOverdueDismissal:${request.requestId}:${rule.id}`,
                source: 'vacation_overdue',
                bypassActiveDiscipline: true,
                forceApproval,
                executeAsApprover: forceApproval,
                skipInitialHierarchy,
            });
        } catch (error) {
            if (!forceApproval && ['hierarchy_denied', 'target_higher_or_equal'].includes(error?.code)) {
                outcome = await invokeAction('staff-audit.dismissMember', client, {
                    guild,
                    config,
                    actor,
                    target,
                    reason,
                    nonceSeed: `vacationOverdueDismissalApproval:${request.requestId}:${rule.id}`,
                    source: 'vacation_overdue',
                    bypassActiveDiscipline: true,
                    forceApproval: true,
                    executeAsApprover: true,
                    skipInitialHierarchy: true,
                });
            } else {
                throw error;
            }
        }
        return { status: 'completed', uvalId: outcome?.operation?.uvalId || null, dismissalStatus: outcome?.status || null };
    }
    throw new Error(`Неизвестное действие просрочки: ${rule.action}`);
}

async function processOverdueRules(client, request) {
    if (request.status !== 'awaiting_return') return request;
    let current = request;
    for (const rule of current.overdueActions || []) {
        if (rule.status === 'completed') continue;
        const dueDate = addDays(current.endDate, rule.afterDays);
        const dueAt = dateKeyAtTime(dueDate, rule.time);
        if (!dueAt || Date.now() < dueAt) continue;
        try {
            const result = await executeOverdueRule(client, current, rule);
            current = await updateStoredRequest(current.requestId, (entry) => {
                const targetRule = (entry.overdueActions || []).find((item) => item.id === rule.id);
                if (targetRule) Object.assign(targetRule, result, { processedAt: Date.now(), lastError: null });
                if (rule.action === 'dismissal' && entry.status !== 'closed_by_dismissal') entry.status = 'overdue';
                entry.updatedAt = Date.now();
                entry.history ||= [];
                entry.history.push({ action: `overdue_${rule.action}`, at: Date.now(), ruleId: rule.id });
                return entry;
            });
            await updateRequestMessage(client, current).catch(() => false);
            if (rule.action === 'dismissal' || current.status === 'overdue' || current.status === 'closed_by_dismissal') break;
        } catch (error) {
            current = await updateStoredRequest(current.requestId, (entry) => {
                const targetRule = (entry.overdueActions || []).find((item) => item.id === rule.id);
                if (targetRule) {
                    targetRule.status = 'failed';
                    targetRule.lastError = String(error?.stack || error?.message || error);
                    targetRule.lastAttemptAt = Date.now();
                }
                entry.updatedAt = Date.now();
                return entry;
            });
            logger.warn('Не удалось выполнить действие просрочки отпуска', {
                guildId: current.guildId,
                requestId: current.requestId,
                ruleId: rule.id,
            }, error);
        }
    }
    return current;
}


async function recoverEndedRequest(client, requestId) {
    let request = getRequestById(requestId);
    if (!request || !['approved', 'scheduled', 'activation_failed'].includes(request.status)) return request;
    const today = getMoscowDateKey();
    if (compareDateKeys(request.endDate, today) >= 0) return request;

    const config = getConfig(request.guildId);
    const type = request.typeSnapshot || getType(config, request.typeId);
    const startAt = dateKeyAtTime(request.startDate, '00:00');
    const endAt = dateKeyAtTime(addDays(request.endDate, 1), '00:00');
    const completeActivationStep = async (step, callback) => {
        if (request.activationProgress?.[step]) return;
        await callback();
        request = await updateStoredRequest(requestId, (entry) => {
            entry.activationProgress ||= {};
            entry.activationProgress[step] = Date.now();
            entry.updatedAt = Date.now();
            return entry;
        });
    };
    const completeReturnStep = async (step, callback) => {
        if (request.returnProgress?.[step]) return;
        await callback();
        request = await updateStoredRequest(requestId, (entry) => {
            entry.returnProgress ||= {};
            entry.returnProgress[step] = Date.now();
            entry.updatedAt = Date.now();
            return entry;
        });
    };

    try {
        if (type?.releaseShiftsOnStart) {
            await completeActivationStep('shifts', () => releaseShifts(client, request));
        }
        if (type?.pauseDisciplineDeadlines && startAt && endAt) {
            if (!request.activationProgress?.discipline_pause) {
                await invokeAction('discipline.setMemberVacationPause', client, request.guildId, request.memberId, {
                    vacationId: request.requestId,
                    paused: true,
                    effectiveAt: startAt,
                });
                request = await updateStoredRequest(requestId, (entry) => {
                    entry.activationProgress ||= {};
                    entry.activationProgress.discipline_pause = Date.now();
                    entry.updatedAt = Date.now();
                    return entry;
                });
            }
            await completeReturnStep('discipline_resume', () => invokeAction(
                'discipline.setMemberVacationPause',
                client,
                request.guildId,
                request.memberId,
                { vacationId: request.requestId, paused: false, effectiveAt: endAt }
            ));
        }

        if (request.activationProgress?.vacation_role && type?.vacationRoleId) {
            await completeReturnStep('vacation_role', async () => {
                const guild = await client.guilds.fetch(request.guildId);
                const member = await guild.members.fetch(request.memberId).catch(() => null);
                const role = guild.roles.cache.get(type.vacationRoleId);
                if (member?.roles?.cache?.has(type.vacationRoleId) && role?.editable) {
                    await runDiscordRequest(() => member.roles.remove(
                        role,
                        `WN Helper: восстановление завершившегося отпуска ${request.requestId}`
                    ));
                }
            });
        }

        request = await updateStoredRequest(requestId, (entry) => {
            const now = Date.now();
            entry.status = 'awaiting_return';
            entry.awaitingReturnAt = entry.awaitingReturnAt || now;
            entry.missedVacationRecoveredAt = now;
            entry.lastError = null;
            entry.updatedAt = now;
            entry.history ||= [];
            if (!entry.history.some((item) => item.action === 'missed_vacation_recovered')) {
                entry.history.push({
                    action: 'missed_vacation_recovered',
                    at: now,
                    periodStartAt: startAt,
                    periodEndAt: endAt,
                });
            }
            return entry;
        });
        await updateRequestMessage(client, request).catch(() => false);
        return processOverdueRules(client, request);
    } catch (error) {
        request = await updateStoredRequest(requestId, (entry) => {
            entry.status = 'activation_failed';
            entry.lastError = String(error?.stack || error?.message || error);
            entry.updatedAt = Date.now();
            return entry;
        });
        await updateRequestMessage(client, request).catch(() => false);
        throw error;
    }
}

async function processSchedules(client) {
    const db = readDb();
    const today = getMoscowDateKey();
    const candidates = (db.vacationRequests || []).filter((entry) => (
        guildConfigService.isEnabled(entry.guildId) &&
        ['approved', 'scheduled', 'activation_failed', 'active', 'awaiting_return'].includes(entry.status)
    ));
    for (const record of candidates) {
        try {
            if (['approved', 'scheduled', 'activation_failed'].includes(record.status)) {
                if (compareDateKeys(record.endDate, today) < 0) {
                    await recoverEndedRequest(client, record.requestId);
                    continue;
                }
                if (compareDateKeys(record.startDate, today) <= 0) {
                    await activateRequest(client, record.requestId);
                    continue;
                }
            }
            if (record.status === 'active') {
                if (record.typeSnapshot?.releaseShiftsOnStart) await releaseShifts(client, record);
                if (compareDateKeys(record.endDate, today) < 0) {
                    await moveToAwaitingReturn(client, record.requestId);
                }
                continue;
            }
            if (record.status === 'awaiting_return') await processOverdueRules(client, record);
        } catch (error) {
            const context = {
                guildId: record.guildId,
                requestId: record.requestId,
                status: record.status,
                code: error?.code || null,
            };
            if (error instanceof VacationError) logger.warn('Ожидаемая ошибка плановой обработки отпуска', context, error);
            else logger.error('Ошибка плановой обработки отпуска', context, error);
        }
    }
}

async function retryRequest(client, { guildId, requestId, requester }) {
    let request = getRequestById(requestId);
    if (!request || String(request.guildId) !== String(guildId)) {
        throw new VacationError('Заявка на отпуск с таким ID не найдена на этом сервере.', 'request_not_found');
    }

    if (request.status === 'activation_failed') {
        request = await updateStoredRequest(request.requestId, (entry) => {
            entry.lastError = null;
            entry.updatedAt = Date.now();
            entry.history ||= [];
            entry.history.push({ action: 'manual_retry_activation', actorId: requester?.id || null, at: Date.now() });
            return entry;
        });
        request = compareDateKeys(request.endDate, getMoscowDateKey()) < 0
            ? await recoverEndedRequest(client, request.requestId)
            : await activateRequest(client, request.requestId);
    } else if (request.status === 'return_failed') {
        request = await updateStoredRequest(request.requestId, (entry) => {
            entry.status = 'awaiting_return';
            entry.lastError = null;
            entry.updatedAt = Date.now();
            entry.history ||= [];
            entry.history.push({ action: 'manual_retry_return', actorId: requester?.id || null, at: Date.now() });
            return entry;
        });
        request = await confirmReturn(client, request.requestId, requester, { skipAuthorization: true });
    } else {
        await processSchedules(client);
        request = getRequestById(request.requestId) || request;
    }

    const updated = await updateRequestMessage(client, request).catch(() => false);
    if (updated) return { status: 'updated', request };

    const republished = await publishRequest(client, request, { recoveryKey: `${Date.now()}:${requester?.id || 'system'}` });
    return { status: 'republished', request: republished };
}

async function closeMemberVacations(client, guildId, memberId) {
    const db = readDb();
    const records = (db.vacationRequests || []).filter((entry) => (
        String(entry.guildId) === String(guildId) &&
        String(entry.memberId) === String(memberId) &&
        !['completed', 'rejected', 'cancelled', 'closed_by_dismissal'].includes(entry.status)
    ));
    for (const record of records) {
        const type = record.typeSnapshot || getType(getConfig(guildId), record.typeId);
        if (type?.vacationRoleId) {
            const guild = await client.guilds.fetch(guildId).catch(() => null);
            const member = await guild?.members?.fetch?.(memberId).catch(() => null);
            const role = guild?.roles?.cache?.get(type.vacationRoleId);
            if (member?.roles?.cache?.has(type.vacationRoleId) && role?.editable) {
                await runDiscordRequest(() => member.roles.remove(
                    role,
                    `WN Helper: увольнение во время отпуска ${record.requestId}`
                )).catch((error) => {
                    logger.warn('Не удалось снять роль отпуска при увольнении', {
                        guildId,
                        memberId,
                        requestId: record.requestId,
                        roleId: type.vacationRoleId,
                    }, error);
                });
            }
        }
        if (type?.pauseDisciplineDeadlines) {
            await invokeAction('discipline.setMemberVacationPause', client, guildId, memberId, {
                vacationId: record.requestId,
                paused: false,
            }).catch(() => undefined);
        }
        const updated = await updateStoredRequest(record.requestId, (entry) => {
            const now = Date.now();
            entry.status = 'closed_by_dismissal';
            entry.closedAt = now;
            entry.updatedAt = now;
            entry.history ||= [];
            entry.history.push({ action: 'closed_by_dismissal', at: now });
            return entry;
        });
        await updateRequestMessage(client, updated).catch(() => false);
    }
    return records.length;
}

function isAccessBlocked(guildId, memberId, group, member = null) {
    const request = getBlockingVacation(guildId, memberId);
    if (!request) return { blocked: false, request: null };
    const type = request.typeSnapshot || getType(getConfig(guildId), request.typeId);
    if (!type?.blockedAccessGroups?.includes(group)) return { blocked: false, request };
    if (member && memberHasAnyRole(member, type.accessBypassRoleIds)) return { blocked: false, request };
    return { blocked: true, request, type };
}

function validatePanelPublication(guild, config) {
    const errors = [];
    if (!config?.features?.vacations) errors.push('Функция отпусков выключена.');
    const settings = getVacationSettings(config);
    if (!settings.requestChannelId) errors.push('Не настроен канал заявок на отпуск.');
    const channel = settings.requestChannelId ? guild.channels.cache.get(settings.requestChannelId) : null;
    if (settings.requestChannelId && (!channel?.isTextBased?.() || typeof channel.send !== 'function')) {
        errors.push('Канал заявок на отпуск недоступен или имеет неподходящий тип.');
    }
    if (!settings.types.some((type) => type.enabled)) errors.push('Не добавлен ни один включённый тип отпуска.');
    return errors;
}

module.exports = {
    ACCESS_BLOCKING_STATUSES,
    ACTIVE_REQUEST_STATUSES,
    VacationError,
    activateRequest,
    approveRequest,
    closeMemberVacations,
    confirmReturn,
    countInclusiveDays,
    createOrUpdateRequest,
    getEffectiveApprovalPeriod,
    getActivationRoleIdsToRemove,
    getActiveRequest,
    getBlockingVacation,
    getMoscowDateKey,
    getRequestById,
    getType,
    isAccessBlocked,
    parseDateKey,
    processSchedules,
    publishRequest,
    rejectRequest,
    retryRequest,
    updateRequestMessage,
    validatePanelPublication,
    withdrawRequest,
};
