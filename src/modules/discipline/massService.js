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
const { PermissionFlagsBits } = require('discord.js');
const {
    DISCIPLINE_STAGE_LABELS,
    DISCIPLINE_STAGES,
    getDisciplineSettings,
} = require('./settings/schema');
const { getExams } = require('../examination');
const massDisciplineBatches = require('./database').massDisciplineBatches;
const guildConfigService = require('../../core/config/guildConfigService');
const { getMemberRankMatches, getPreviousRank } = require('../staff-audit');
const {
    assertCanDismissTarget,
    assertCanManageTarget,
    buildMemberStateHash,
} = require('../staff-audit');
const {
    closeThreadWithRetry,
    editMessageWithRetry,
    sendMessageWithRetry,
    startThreadWithRetry,
} = require('../../core/discord/request');
const { mutateDatabase: mutateDb, readDatabase: readDb } = require('./database');
const logger = require('../../core/logging/logger');
const DisciplineError = require('./error');
const StaffAuditError = require('../staff-audit').StaffAuditError;
const disciplineService = require('./service');
const targetService = require('./targetService');

const ACTIVE_BATCH_STATUSES = new Set([
    'awaiting_confirmation',
    'awaiting_approval',
    'executing',
    'partially_completed',
]);
const NON_BLOCKING_PARALLEL_ITEM_STATUSES = new Set(['completed', 'invalid']);
const CONFIRMATION_TTL_MS = 20 * 60_000;
const {
    SANCTION_LABELS,
    createMassDisciplinePresentation,
    getBatchStatusLabel,
    getItemStatusLabel,
    getSelectionSummary,
} = require('./massPresentation');
const massPresentation = createMassDisciplinePresentation({
    formatGroupLinks,
    formatItemTarget,
    getItemTargetKey,
});
const {
    buildApprovalEmbed,
    buildApprovalRow,
    buildConfirmationRow,
    buildGroupEmbed,
    buildPreview,
    buildPreviewComponents,
    buildPreviewPayload,
    buildResult,
    buildResultPayload,
    chunkFieldLines,
    getGroupLabel,
} = massPresentation;

function createId() {
    return typeof crypto.randomUUID === 'function'
        ? `massdiscipline-${crypto.randomUUID()}`
        : `massdiscipline-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function clone(value) {
    return structuredClone(value);
}

async function closeBatchThread(client, batch) {
    if (!client || !batch?.sharedThreadId) return false;
    const thread = await client.channels.fetch(String(batch.sharedThreadId)).catch(() => null);
    if (!thread) return false;
    await closeThreadWithRetry(thread, {
        reason: `WN Helper: массовое взыскание ${batch.massdisciplineId} завершено`,
    });
    return true;
}

async function closeInactiveMassThreads(client) {
    const terminalStatuses = new Set(['completed', 'rejected', 'cancelled', 'expired']);
    const batches = (readDb().massDisciplineBatches || []).filter((batch) => (
        batch.sharedThreadId && terminalStatuses.has(batch.status)
    ));
    let closed = 0;
    for (const batch of batches) {
        if (await closeBatchThread(client, batch).catch((error) => {
            logger.warn('Не удалось закрыть ветку завершённого массового взыскания', {
                massdisciplineId: batch.massdisciplineId,
                threadId: batch.sharedThreadId || null,
            }, error);
            return false;
        })) closed += 1;
    }
    return closed;
}

function memberHasAnyRole(member, roleIds) {
    return (Array.isArray(roleIds) ? roleIds : []).some((roleId) => member?.roles?.cache?.has?.(roleId));
}

function normalizeTargets(values, guildId = null) {
    return targetService.normalizeTargets(values, guildId);
}

function parseTargetText(text, guildId = null) {
    return targetService.parseTargetText(text, guildId);
}

function normalizeSelection(selection) {
    const result = [];
    for (const source of Array.isArray(selection) ? selection : []) {
        const type = String(source?.type || '');
        if (DISCIPLINE_STAGES.includes(type)) {
            const count = Number(source.count);
            if (!Number.isSafeInteger(count) || count <= 0 || count > 10) {
                throw new DisciplineError('Количество одинаковых взысканий должно быть от 1 до 10.', 'mass_invalid_count');
            }
            result.push({ type, count });
            continue;
        }
        if (['demotion', 'recertification', 'dismissal', 'dismissal_blacklist'].includes(type)) {
            if (!result.some((entry) => entry.type === type)) result.push({ type, count: 1 });
            continue;
        }
        throw new DisciplineError(`Неизвестная санкция: ${type || 'пусто'}.`, 'mass_unknown_sanction');
    }
    if (!result.length) throw new DisciplineError('Не выбрана ни одна санкция.', 'mass_sanctions_empty');
    const dismissals = result.filter((entry) => ['dismissal', 'dismissal_blacklist'].includes(entry.type));
    if (dismissals.length && result.length > 1) {
        throw new DisciplineError('Увольнение нельзя объединять с другими санкциями.', 'mass_dismissal_exclusive');
    }
    if (dismissals.length > 1) {
        throw new DisciplineError('Нельзя одновременно выбрать обычное увольнение и увольнение с ЧС.', 'mass_dismissal_duplicate');
    }
    return result;
}

function hasActiveRecertification(guildId, targetKey) {
    const db = readDb();
    return (db.disciplineCases || []).some((caseRecord) => (
        String(caseRecord.guildId) === String(guildId) &&
        targetService.matchesCaseTarget(caseRecord, targetKey) &&
        (caseRecord.sanctions || []).some((sanction) => (
            sanction.type === 'recertification' && sanction.status === 'active'
        ))
    ));
}

function getItemTargetKey(item) {
    return item?.targetKey || (item?.memberId ? `member:${item.memberId}` : item?.externalTargetId ? `external:${item.externalTargetId}` : null);
}

function formatItemTarget(item, { mention = true } = {}) {
    return targetService.formatTarget({
        type: item.targetType || (item.memberId ? 'member' : 'external'),
        targetKey: getItemTargetKey(item),
        memberId: item.memberId || null,
        externalTargetId: item.externalTargetId || null,
        displayName: item.displayName,
        staticId: item.staticId || item.externalStaticId || null,
    }, { mention });
}

function findParallelBatch(guildId, targetKey, excludeId = null) {
    const db = readDb();
    return (db.massDisciplineBatches || []).find((batch) => (
        String(batch.guildId) === String(guildId) &&
        String(batch.massdisciplineId) !== String(excludeId || '') &&
        ACTIVE_BATCH_STATUSES.has(batch.status) &&
        (batch.items || []).some((item) => (
            getItemTargetKey(item) === String(targetKey) && !NON_BLOCKING_PARALLEL_ITEM_STATUSES.has(item.status)
        ))
    )) || null;
}

function selectionHas(selection, type) {
    return selection.some((entry) => entry.type === type);
}

function getWorkoffUnitKeys(selection, settings, willDismiss) {
    if (willDismiss) return [];
    const keys = [];
    for (const entry of selection) {
        if (!DISCIPLINE_STAGES.includes(entry.type) || !settings.stages[entry.type].workoffEnabled) continue;
        for (let index = 1; index <= entry.count; index += 1) keys.push(`${entry.type}-${index}`);
    }
    return keys;
}

function resolveTargetMethodId(payload, targetKey) {
    if (payload.workoffMode === 'individual') {
        return String(payload.memberMethodIds?.[targetKey] || 'any');
    }
    return String(payload.commonMethodId || 'any');
}

function buildMethodAssignments(member, target, config, selection, outcome, payload) {
    const settings = getDisciplineSettings(config);
    const unitKeys = getWorkoffUnitKeys(selection, settings, outcome.willDismiss);
    if (!unitKeys.length) return {};
    const requestedMethodId = resolveTargetMethodId(payload, target.targetKey);
    const assignments = {};
    for (const key of unitKeys) {
        const stage = key.split('-')[0];
        const available = disciplineService.getAvailableMethods(member, config, stage);
        if (!available.some((method) => method.id === requestedMethodId)) {
            throw new DisciplineError(
                `Способ отработки "${requestedMethodId}" недоступен сотруднику ${target.displayName} для этапа "${DISCIPLINE_STAGE_LABELS[stage]}".`,
                'mass_method_unavailable'
            );
        }
        assignments[key] = requestedMethodId;
    }
    return assignments;
}

function validateRecertification(payload, config) {
    if (!selectionHas(payload.selection, 'recertification')) return [];
    const configured = getExams(config);
    const selectedIds = Array.from(new Set((payload.recertificationExamIds || []).map(String).filter(Boolean)));
    if (!selectedIds.length) {
        throw new DisciplineError('Для переаттестации выберите хотя бы один экзамен.', 'mass_recertification_exams_empty');
    }
    const known = new Set(configured.map((exam) => exam.id));
    const missing = selectedIds.find((examId) => !known.has(examId));
    if (missing) throw new DisciplineError(`Экзамен ${missing} больше не существует.`, 'mass_exam_missing');
    return selectedIds;
}

function validateDetails(payload) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(payload.violationDate || ''))) {
        throw new DisciplineError('Дата нарушения должна быть в формате YYYY-MM-DD.', 'mass_date_invalid');
    }
    if (!String(payload.violatedRules || '').trim()) throw new DisciplineError('Не указаны нарушенные пункты.', 'mass_rules_empty');
    if (!String(payload.reason || '').trim()) throw new DisciplineError('Не указана причина.', 'mass_reason_empty');
    if (!String(payload.evidence || '').trim()) throw new DisciplineError('Не указаны доказательства.', 'mass_evidence_empty');
}

async function preflight({ client, guild, config, actor }) {
    disciplineService.assertFeatureEnabled(config);
    const settings = getDisciplineSettings(config);
    const mainRoleId = String(config?.commonRoles?.weazelNewsRoleId || '');
    if (!mainRoleId) {
        throw new DisciplineError('Основная роль Weazel News не настроена.', 'main_role_not_configured');
    }

    const roles = await guild.roles.fetch().catch(() => guild.roles.cache);
    if (!roles?.has?.(mainRoleId)) {
        throw new DisciplineError('Настроенная основная роль Weazel News больше не существует.', 'main_role_unavailable');
    }

    if (!settings.channelId) throw new DisciplineError('Канал взысканий не настроен.', 'mass_channel_not_configured');
    const channel = await client.channels.fetch(settings.channelId).catch(() => null);
    if (!channel?.send || String(channel.guildId) !== String(guild.id)) {
        throw new DisciplineError('Канал взысканий недоступен боту.', 'mass_channel_unavailable');
    }

    const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
    if (!botMember) {
        throw new DisciplineError('Не удалось определить участника бота на сервере.', 'mass_bot_member_unavailable');
    }
    const permissions = channel.permissionsFor?.(botMember);
    const requiredPermissions = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.SendMessagesInThreads,
    ];
    if (permissions && !permissions.has(requiredPermissions)) {
        throw new DisciplineError(
            'Боту не хватает прав в канале взысканий: просмотр, отправка сообщений, история сообщений и публичные ветки.',
            'mass_channel_permissions_missing'
        );
    }

    const bypass = memberHasAnyRole(actor, settings.massApprovalBypassRoleIds);
    const availableApprovalRoleIds = settings.massApprovalRoleIds.filter((roleId) => roles?.has?.(roleId));
    if (!bypass && !availableApprovalRoleIds.length) {
        throw new DisciplineError(
            'Для массовых взысканий не настроена доступная роль подтверждения. Проверьте /settings или выдайте исполнителю роль обхода.',
            'mass_approval_roles_missing'
        );
    }
    return { settings, channel, bypass, availableApprovalRoleIds };
}

async function validateTarget({ guild, config, actor, target, payload, excludeBatchId = null }) {
    const parallel = findParallelBatch(guild.id, target.targetKey, excludeBatchId);
    if (parallel) {
        throw new DisciplineError(
            `Сотрудник уже участвует в незавершённом массовом дисциплинарном деле ${parallel.massdisciplineId}.`,
            'mass_parallel_batch'
        );
    }
    const selection = payload.selection;
    const outcome = disciplineService.previewSelectionOutcome(guild.id, target.targetKey, selection, config);

    if (target.type === 'external') {
        const linked = targetService.getLinkedMemberForExternal(guild.id, target.externalTargetId, target.staticId);
        if (linked) {
            throw new DisciplineError(
                `Внешняя запись уже привязана к Discord ${linked.memberId}. Обновите список сотрудников.`,
                'mass_external_already_linked'
            );
        }
        if (outcome.willDismiss) {
            const guard = require('../staff-audit');
            try {
                guard.assertNoDismissalConflict(guild.id, { staticId: target.staticId });
            } catch (error) {
                throw new DisciplineError(error.userMessage || error.message, error.code || 'dismissal_conflict');
            }
        }
        if (selectionHas(selection, 'recertification') && hasActiveRecertification(guild.id, target.targetKey)) {
            throw new DisciplineError('У сотрудника уже есть активная переаттестация.', 'mass_recertification_active');
        }
        return {
            targetType: 'external',
            targetKey: target.targetKey,
            memberId: null,
            externalTargetId: target.externalTargetId,
            displayName: target.displayName,
            staticId: target.staticId,
            stateHash: `external:${target.externalTargetId}`,
            currentRankNumber: null,
            demotionRankNumber: null,
            methodAssignments: buildMethodAssignments(null, target, config, selection, outcome, payload),
            outcome,
            status: 'pending',
            caseId: null,
            error: null,
        };
    }

    const member = await guild.members.fetch(target.memberId).catch(() => null);
    if (!member) throw new DisciplineError(`Сотрудник ${target.memberId} не найден на сервере.`, 'mass_member_not_found');
    if (String(member.id) === String(actor.id)) {
        throw new DisciplineError('Нельзя включить самого себя в массовое дисциплинарное дело.', 'mass_self_denied');
    }
    disciplineService.assertMemberHasMainRole(member, config);
    const matches = getMemberRankMatches(member, config);
    if (matches.length > 1) throw new DisciplineError('У сотрудника найдено несколько ролей рангов.', 'mass_multiple_ranks');

    const currentRankNumber = matches[0]?.number || null;
    let demotionRankNumber = null;
    if (selectionHas(selection, 'demotion')) {
        if (!currentRankNumber) {
            throw new DisciplineError('Для автоматического понижения у сотрудника должна определяться ровно одна роль ранга.', 'mass_demotion_rank_missing');
        }
        const previous = getPreviousRank(config, currentRankNumber);
        if (!previous) throw new DisciplineError('Для текущего ранга сотрудника нет более низкого настроенного ранга.', 'mass_demotion_no_previous');
        assertCanManageTarget(actor, member, config, {
            currentTargetRankNumber: currentRankNumber,
            targetRankNumber: previous.number,
            actionLabel: 'понизить',
        });
        demotionRankNumber = previous.number;
    }
    if (outcome.willDismiss) {
        assertCanDismissTarget(actor, member, config, {
            savedTargetRankNumber: currentRankNumber,
            actionLabel: 'уволить',
        });
        disciplineService.assertNoDismissalConflict(guild.id, member.id);
    }
    if (selectionHas(selection, 'recertification') && hasActiveRecertification(guild.id, target.targetKey)) {
        throw new DisciplineError('У сотрудника уже есть активная переаттестация.', 'mass_recertification_active');
    }
    return {
        targetType: 'member',
        targetKey: target.targetKey,
        memberId: String(member.id),
        externalTargetId: null,
        displayName: String(member.displayName || member.user?.username || member.id),
        staticId: null,
        stateHash: buildMemberStateHash(member),
        currentRankNumber,
        demotionRankNumber,
        methodAssignments: buildMethodAssignments(member, target, config, selection, outcome, payload),
        outcome,
        status: 'pending',
        caseId: null,
        error: null,
    };
}

async function validateTargetsEarly({ guild, config, actor, targets }) {
    const normalized = normalizeTargets(targets, guild.id);
    const valid = [];
    const invalid = [];
    for (const target of normalized) {
        if (target.type === 'external') {
            valid.push({ ...target, displayName: target.displayName, error: null });
            continue;
        }
        const member = await guild.members.fetch(target.memberId).catch(() => null);
        let error = null;
        if (!member) error = 'Сотрудник не найден на сервере.';
        else if (String(member.id) === String(actor.id)) error = 'Нельзя добавить самого себя.';
        else {
            try {
                disciplineService.assertMemberHasMainRole(member, config);
                if (getMemberRankMatches(member, config).length > 1) {
                    throw new DisciplineError('У сотрудника найдено несколько ролей рангов.', 'mass_multiple_ranks');
                }
            } catch (caught) {
                error = caught.userMessage || caught.message;
            }
        }
        if (error) invalid.push({ ...target, error });
        else valid.push(targetService.createMemberTarget(member));
    }
    return { targets: normalized, valid, invalid };
}

async function validateTargetsDraft({ guild, config, actor, targets, data }) {
    const normalized = normalizeTargets(targets, guild.id);
    if (!Array.isArray(data?.selection) || !data.selection.length) {
        return { ...(await validateTargetsEarly({ guild, config, actor, targets: normalized })), globalError: null };
    }

    let payload;
    try {
        payload = {
            selection: normalizeSelection(data.selection),
            recertificationExamIds: Array.isArray(data.recertificationExamIds)
                ? data.recertificationExamIds.map(String)
                : [],
            workoffMode: data.workoffMode === 'individual' ? 'individual' : 'common',
            commonMethodId: String(data.commonMethodId || 'any'),
            memberMethodIds: data.memberMethodIds && typeof data.memberMethodIds === 'object'
                ? Object.fromEntries(Object.entries(data.memberMethodIds).map(([key, value]) => [String(key), String(value || 'any')]))
                : {},
        };
        validateRecertification(payload, config);
    } catch (error) {
        return {
            targets: normalized,
            valid: [],
            invalid: [],
            globalError: error?.userMessage || error?.message || String(error),
        };
    }

    const valid = [];
    const invalid = [];
    for (const target of normalized) {
        try {
            const item = await validateTarget({ guild, config, actor, target, payload });
            valid.push({ ...target, outcome: item.outcome, error: null });
        } catch (error) {
            invalid.push({
                ...target,
                error: error?.userMessage || error?.message || String(error),
            });
        }
    }
    return { targets: normalized, valid, invalid, globalError: null };
}

async function createBatch({ guild, config, actor, targets, data, sessionId = null }) {
    disciplineService.assertFeatureEnabled(config);
    const settings = getDisciplineSettings(config);
    const normalizedTargets = normalizeTargets(targets || [], guild.id);
    if (normalizedTargets.length < 2) {
        throw new DisciplineError('Для массового взыскания выберите минимум двух сотрудников.', 'mass_too_few_targets');
    }
    if (normalizedTargets.length > settings.massMaxTargets) {
        throw new DisciplineError(
            `В одном массовом взыскании разрешено не более ${settings.massMaxTargets} сотрудников.`,
            'mass_too_many_targets'
        );
    }

    const payload = {
        violationDate: String(data.violationDate || '').trim(),
        violatedRules: String(data.violatedRules || '').trim(),
        reason: String(data.reason || '').trim(),
        evidence: String(data.evidence || '').trim(),
        selection: normalizeSelection(data.selection),
        recertificationExamIds: Array.isArray(data.recertificationExamIds)
            ? data.recertificationExamIds.map(String)
            : [],
        workoffMode: data.workoffMode === 'individual' ? 'individual' : 'common',
        commonMethodId: String(data.commonMethodId || 'any'),
        memberMethodIds: data.memberMethodIds && typeof data.memberMethodIds === 'object'
            ? Object.fromEntries(Object.entries(data.memberMethodIds).map(([key, value]) => [String(key), String(value || 'any')]))
            : {},
    };
    validateDetails(payload);
    payload.violationDate = disciplineService.validateIssueDate(payload.violationDate, settings);
    validateRecertification(payload, config);

    const validItems = [];
    const invalidItems = [];
    for (const target of normalizedTargets) {
        try {
            validItems.push(await validateTarget({ guild, config, actor, target, payload }));
        } catch (error) {
            invalidItems.push({
                targetType: target.type,
                targetKey: target.targetKey,
                memberId: target.memberId,
                externalTargetId: target.externalTargetId,
                displayName: target.displayName,
                staticId: target.staticId,
                status: 'invalid',
                error: error?.userMessage || error?.message || String(error),
            });
        }
    }
    if (validItems.length < 2) {
        const details = invalidItems.map((item) => `${formatItemTarget(item)} - ${item.error}`).join('\n').slice(0, 1500);
        const suffix = details ? `\n${details}` : '';
        throw new DisciplineError(
            `После проверки для исполнения осталось меньше двух сотрудников.${suffix}`,
            validItems.length ? 'mass_too_few_valid_targets' : 'mass_no_valid_targets'
        );
    }

    const now = Date.now();
    const batch = {
        massdisciplineId: createId(),
        sessionId: sessionId ? String(sessionId) : null,
        guildId: String(guild.id),
        actorId: String(actor.id),
        actorDisplayName: String(actor.displayName || actor.user?.username || actor.id),
        status: 'awaiting_confirmation',
        payload,
        items: [...validItems, ...invalidItems],
        approvalChannelId: null,
        approvalMessageId: null,
        approvedBy: null,
        rejectedBy: null,
        approvalSatisfied: false,
        groupMessages: [],
        sharedThreadId: null,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + CONFIRMATION_TTL_MS,
    };
    await new massDisciplineBatches(batch).save();
    return batch;
}

async function updateBatch(batchId, mutator) {
    return mutateDb((db) => {
        const batch = (db.massDisciplineBatches || []).find((entry) => entry.massdisciplineId === batchId);
        if (!batch) return null;
        const result = mutator(batch);
        batch.updatedAt = Date.now();
        return clone(result === undefined ? batch : result);
    });
}

async function getBatch(batchId) {
    const batch = await massDisciplineBatches.findOne({ massdisciplineId: String(batchId) });
    return batch ? clone(batch) : null;
}

async function cancelBatch(batchId, actorId) {
    return updateBatch(batchId, (batch) => {
        if (String(batch.actorId) !== String(actorId)) {
            throw new DisciplineError('Этот пакет принадлежит другому пользователю.', 'mass_batch_owner');
        }
        if (!['awaiting_confirmation', 'awaiting_approval'].includes(batch.status)) return batch;
        batch.status = 'cancelled';
        batch.cancelledAt = Date.now();
        return batch;
    });
}

async function submitBatch(client, { batchId, actor }) {
    const batch = await getBatch(batchId);
    if (!batch) throw new DisciplineError('Массовое дисциплинарное дело не найдено.', 'mass_batch_not_found');
    if (String(batch.actorId) !== String(actor.id)) throw new DisciplineError('Пакет принадлежит другому пользователю.', 'mass_batch_owner');
    if (batch.status !== 'awaiting_confirmation') {
        throw new DisciplineError('Пакет уже подтверждён, отменён или исполнен.', 'mass_batch_status');
    }
    if (Date.now() > Number(batch.expiresAt)) {
        await updateBatch(batchId, (record) => { record.status = 'expired'; });
        throw new DisciplineError('Срок подтверждения предпросмотра истёк. Создайте пакет заново.', 'mass_confirmation_expired');
    }
    const config = guildConfigService.get(batch.guildId);
    const guild = actor.guild || await client.guilds.fetch(batch.guildId);
    const { settings, channel, bypass, availableApprovalRoleIds } = await preflight({ client, guild, config, actor });
    if (bypass) {
        await updateBatch(batchId, (record) => {
            record.status = 'executing';
            record.approvalSatisfied = true;
            record.bypassedApprovalBy = String(actor.id);
            record.startedAt = Date.now();
        });
        return executeBatch(client, { batchId, requester: actor });
    }
    const roleMentions = availableApprovalRoleIds.map((roleId) => `<@&${roleId}>`).join(' ');
    const message = await sendMessageWithRetry(channel, {
        content: roleMentions,
        embeds: [buildApprovalEmbed(batch)],
        components: [buildApprovalRow(batch.massdisciplineId)],
        allowedMentions: { parse: [], roles: availableApprovalRoleIds },
    }, { nonceSeed: `massDisciplineApproval:${batch.massdisciplineId}` });
    return updateBatch(batchId, (record) => {
        record.status = 'awaiting_approval';
        record.approvalChannelId = String(channel.id);
        record.approvalMessageId = String(message.id);
        record.expiresAt = Date.now() + settings.massApprovalTimeoutMinutes * 60_000;
        return record;
    });
}

function groupKey(type) {
    return ['dismissal', 'dismissal_blacklist'].includes(type) ? 'dismissal' : type;
}

function getPublicationGroups(selection) {
    const groups = new Map();
    for (const entry of selection) {
        const key = groupKey(entry.type);
        const current = groups.get(key) || { key, entries: [] };
        current.entries.push(entry);
        groups.set(key, current);
    }
    return [...groups.values()];
}

function buildMessageLink(guildId, channelId, messageId) {
    if (!guildId || !channelId || !messageId) return null;
    return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

function buildSanctionLinks(caseRecord) {
    const links = {};
    for (const sanction of caseRecord?.sanctions || []) {
        const key = groupKey(sanction.type);
        const link = buildMessageLink(
            caseRecord.guildId,
            caseRecord.channelId,
            sanction.messageId || caseRecord.headerMessageId
        );
        if (!link) continue;
        links[key] ||= [];
        if (!links[key].includes(link)) links[key].push(link);
    }
    return links;
}

function formatGroupLinks(item, groupKeyValue) {
    const links = Array.isArray(item?.sanctionLinks?.[groupKeyValue])
        ? item.sanctionLinks[groupKeyValue]
        : [];
    if (!links.length) return item?.caseLink ? ` - ${item.caseLink}` : '';
    if (links.length === 1) return ` - ${links[0]}`;
    const primaryLink = item?.caseLink || links[0];
    return ` - ${primaryLink} · сообщений: ${links.length}`;
}

async function publishGroups(client, batch, config) {
    const settings = getDisciplineSettings(config);
    const channel = await client.channels.fetch(settings.channelId).catch(() => null);
    if (!channel?.send) throw new DisciplineError('Канал взысканий недоступен.', 'mass_channel_unavailable');
    const groups = getPublicationGroups(batch.payload.selection);
    const groupMessages = [];
    for (let index = 0; index < groups.length; index += 1) {
        const group = groups[index];
        const message = await sendMessageWithRetry(channel, {
            content: '',
            embeds: [buildGroupEmbed(batch, group)],
            allowedMentions: { parse: [] },
        }, { nonceSeed: `massDisciplineGroup:${batch.massdisciplineId}:${group.key}` });
        groupMessages.push({ key: group.key, channelId: String(channel.id), messageId: String(message.id) });
    }
    if (!groupMessages.length) throw new DisciplineError('Не удалось сформировать публикации взысканий.', 'mass_groups_empty');
    const firstMessage = await channel.messages.fetch(groupMessages[0].messageId);
    const thread = await startThreadWithRetry(firstMessage, {
        name: `Дело ${batch.massdisciplineId}`.slice(0, 100),
        autoArchiveDuration: 1440,
        reason: `WN Helper: массовое дисциплинарное дело ${batch.massdisciplineId}`,
    });
    if (!thread?.send) throw new DisciplineError('Не удалось создать общую ветку массового взыскания.', 'mass_thread_unavailable');
    await sendMessageWithRetry(thread, {
        content: [`**Общие доказательства**`, batch.payload.evidence].join('\n').slice(0, 2000),
        allowedMentions: { parse: [] },
    }, { nonceSeed: `massDisciplineEvidence:${batch.massdisciplineId}` });
    return { channel, thread, groups, groupMessages };
}

async function revalidateItem({ guild, config, actor, batch, item, resumeExistingCase = false }) {
    const target = item.targetType === 'external'
        ? targetService.createExternalTarget({
            guildId: guild.id,
            displayName: item.displayName,
            staticId: item.staticId,
            externalTargetId: item.externalTargetId,
        })
        : targetService.createMemberTarget(item.memberId, item.displayName);
    if (target.type === 'member') {
        const member = await guild.members.fetch(target.memberId).catch(() => null);
        if (!member) throw new DisciplineError('Сотрудник покинул сервер.', 'mass_member_left');
        if (buildMemberStateHash(member) !== item.stateHash) {
            throw new DisciplineError('Состояние сотрудника изменилось после предпросмотра.', 'mass_state_changed');
        }
        if (resumeExistingCase) {
            if (String(member.id) === String(actor.id)) {
                throw new DisciplineError('Нельзя включить самого себя в массовое дисциплинарное дело.', 'mass_self_denied');
            }
            disciplineService.assertMemberHasMainRole(member, config);
            const matches = getMemberRankMatches(member, config);
            if (matches.length > 1) throw new DisciplineError('У сотрудника найдено несколько ролей рангов.', 'mass_multiple_ranks');
            const currentRankNumber = matches[0]?.number || null;
            if (selectionHas(batch.payload.selection, 'demotion')) {
                assertCanManageTarget(actor, member, config, {
                    currentTargetRankNumber: currentRankNumber,
                    targetRankNumber: item.demotionRankNumber,
                    actionLabel: 'понизить',
                });
            }
            if (item.outcome?.willDismiss) {
                assertCanDismissTarget(actor, member, config, {
                    savedTargetRankNumber: currentRankNumber,
                    actionLabel: 'уволить',
                });
            }
            return {
                member,
                target,
                validated: {
                    currentRankNumber,
                    demotionRankNumber: item.demotionRankNumber,
                    methodAssignments: item.methodAssignments || {},
                    outcome: item.outcome || {},
                },
            };
        }
    } else if (resumeExistingCase) {
        const linked = targetService.getLinkedMemberForExternal(guild.id, target.externalTargetId, target.staticId);
        if (linked) {
            throw new DisciplineError(
                `Внешняя запись уже привязана к Discord ${linked.memberId}. Обновите пакет перед восстановлением.`,
                'mass_external_already_linked'
            );
        }
        return {
            member: null,
            target,
            validated: {
                currentRankNumber: null,
                demotionRankNumber: null,
                methodAssignments: item.methodAssignments || {},
                outcome: item.outcome || {},
            },
        };
    }
    const validated = await validateTarget({
        guild,
        config,
        actor,
        target,
        payload: batch.payload,
        excludeBatchId: batch.massdisciplineId,
    });
    const member = target.type === 'member'
        ? await guild.members.fetch(target.memberId).catch(() => null)
        : null;
    return { member, target, validated };
}

function findExistingBatchCase(batchId, guildId, item) {
    const db = readDb();
    const targetKey = getItemTargetKey(item);
    return (db.disciplineCases || []).find((caseRecord) => (
        String(caseRecord.batchId || '') === String(batchId) &&
        String(caseRecord.guildId) === String(guildId) &&
        targetService.getCaseTargetKey(caseRecord) === targetKey
    )) || null;
}

function buildCompletedItemFromCase(caseRecord) {
    return {
        status: 'completed',
        caseId: caseRecord.caseId,
        caseLink: buildMessageLink(caseRecord.guildId, caseRecord.channelId, caseRecord.headerMessageId),
        sanctionLinks: buildSanctionLinks(caseRecord),
        error: null,
    };
}

async function executeOne(client, { guild, config, actor, batch, item, thread }) {
    const existingCase = findExistingBatchCase(batch.massdisciplineId, guild.id, item);
    const { member, target, validated } = await revalidateItem({
        guild,
        config,
        actor,
        batch,
        item,
        resumeExistingCase: Boolean(existingCase),
    });
    if (existingCase) {
        if (existingCase.executionProgress?.postProcessingCompletedAt && existingCase.headerMessageId) {
            return buildCompletedItemFromCase(existingCase);
        }
        const resumed = await disciplineService.resumeFailedCase(client, {
            guild,
            config,
            issuer: actor,
            member,
            externalTarget: target.type === 'external' ? target : null,
            caseId: existingCase.caseId,
            sharedEvidenceThreadId: thread.id,
            suppressEvidenceThread: true,
            suppressTargetPing: false,
            dismissalApprovalSatisfied: batch.approvalSatisfied === true,
        });
        return buildCompletedItemFromCase(resumed.caseRecord);
    }
    const result = await disciplineService.issueCase(client, {
        guild,
        config,
        issuer: actor,
        member,
        externalTarget: target.type === 'external' ? target : null,
        violationDate: batch.payload.violationDate,
        violatedRules: batch.payload.violatedRules,
        reason: batch.payload.reason,
        evidence: batch.payload.evidence,
        selection: batch.payload.selection,
        methodAssignments: validated.methodAssignments,
        currentRankNumber: validated.currentRankNumber,
        demotionRankNumber: validated.demotionRankNumber,
        recertificationExamIds: batch.payload.recertificationExamIds,
        sharedEvidenceThreadId: thread.id,
        suppressEvidenceThread: true,
        suppressTargetPing: false,
        batchId: batch.massdisciplineId,
        dismissalApprovalSatisfied: batch.approvalSatisfied === true,
    });
    return buildCompletedItemFromCase(result.caseRecord);
}

async function refreshGroupMessages(client, batch, publication) {
    for (const record of publication.groupMessages) {
        try {
            const channel = await client.channels.fetch(record.channelId);
            const message = await channel.messages.fetch(record.messageId);
            const group = publication.groups.find((entry) => entry.key === record.key);
            await editMessageWithRetry(message, {
                embeds: [buildGroupEmbed(batch, group, batch.items)],
                allowedMentions: { parse: [] },
            });
        } catch (error) {
            logger.warn('Не удалось обновить сводное сообщение массового взыскания', {
                massdisciplineId: batch.massdisciplineId,
                messageId: record.messageId,
            }, error);
        }
    }
}

async function refreshBatchMessages(client, batchId) {
    const batch = await getBatch(batchId);
    if (!batch) return false;

    if (batch.approvalChannelId && batch.approvalMessageId) {
        const channel = await client.channels.fetch(batch.approvalChannelId).catch(() => null);
        const message = await channel?.messages?.fetch?.(batch.approvalMessageId).catch(() => null);
        if (message) {
            const statusText = batch.status === 'awaiting_approval'
                ? 'Ожидает подтверждения'
                : getBatchStatusLabel(batch.status);
            await editMessageWithRetry(message, {
                embeds: [buildApprovalEmbed(batch, statusText)],
                allowedMentions: { parse: [] },
            }).catch((error) => logger.warn('Не удалось обновить подтверждение массового взыскания', {
                massdisciplineId: batch.massdisciplineId,
                messageId: batch.approvalMessageId,
            }, error));
        }
    }

    if (Array.isArray(batch.groupMessages) && batch.groupMessages.length) {
        await refreshGroupMessages(client, batch, {
            groups: getPublicationGroups(batch.payload.selection),
            groupMessages: batch.groupMessages,
        });
    }
    return true;
}

async function prevalidateExecutionItems({ guild, config, actor, batch, requireAtLeastTwo }) {
    const failures = [];
    let executableCount = 0;
    for (const item of batch.items || []) {
        if (item.status === 'invalid' || item.status === 'completed') continue;
        try {
            const existingCase = findExistingBatchCase(batch.massdisciplineId, guild.id, item);
            await revalidateItem({
                guild,
                config,
                actor,
                batch,
                item,
                resumeExistingCase: Boolean(existingCase),
            });
            executableCount += 1;
        } catch (error) {
            const stateChanged = error?.code === 'mass_state_changed';
            failures.push({
                targetKey: getItemTargetKey(item),
                status: stateChanged ? 'skipped_state_changed' : 'failed',
                error: error?.userMessage || error?.message || String(error),
            });
        }
    }
    if (failures.length) {
        batch = await updateBatch(batch.massdisciplineId, (record) => {
            for (const failure of failures) {
                const target = record.items.find((entry) => getItemTargetKey(entry) === failure.targetKey);
                if (!target || target.status === 'completed' || target.status === 'invalid') continue;
                target.status = failure.status;
                target.error = failure.error;
            }
            return record;
        });
    }
    if (requireAtLeastTwo && executableCount < 2) {
        throw new DisciplineError(
            'Перед публикацией для исполнения осталось меньше двух сотрудников. Исправьте список и создайте пакет заново.',
            'mass_too_few_valid_targets_at_execution'
        );
    }
    if (!executableCount) {
        throw new DisciplineError('Перед публикацией не осталось сотрудников, доступных для исполнения.', 'mass_no_executable_targets');
    }
    return batch;
}

async function executeBatch(client, { batchId, requester }) {
    let batch = await getBatch(batchId);
    if (!batch) throw new DisciplineError('Массовое дисциплинарное дело не найдено.', 'mass_batch_not_found');
    if (!['executing', 'partially_completed'].includes(batch.status)) {
        throw new DisciplineError('Пакет не готов к исполнению.', 'mass_batch_not_executable');
    }

    let guild;
    let config;
    let actor;
    let publication;
    try {
        guild = await client.guilds.fetch(batch.guildId);
        config = guildConfigService.get(batch.guildId);
        actor = await guild.members.fetch(batch.actorId).catch(() => null);
        if (!actor) throw new DisciplineError('Инициатор массового взыскания больше не находится на сервере.', 'mass_actor_missing');
        if (requester && String(requester.guild?.id || batch.guildId) !== String(batch.guildId)) {
            throw new DisciplineError('Запрос восстановления выполнен не на том сервере.', 'mass_wrong_guild');
        }

        await preflight({ client, guild, config, actor });
        const hasPublication = Boolean(batch.sharedThreadId && batch.groupMessages?.length);
        batch = await prevalidateExecutionItems({
            guild,
            config,
            actor,
            batch,
            requireAtLeastTwo: !hasPublication,
        });

        if (hasPublication) {
            const thread = await client.channels.fetch(batch.sharedThreadId).catch(() => null);
            if (!thread?.send) throw new DisciplineError('Общая ветка массового взыскания недоступна.', 'mass_thread_missing');
            publication = {
                thread,
                groups: getPublicationGroups(batch.payload.selection),
                groupMessages: batch.groupMessages,
            };
        } else {
            publication = await publishGroups(client, batch, config);
            batch = await updateBatch(batchId, (record) => {
                record.groupMessages = publication.groupMessages;
                record.sharedThreadId = String(publication.thread.id);
                record.status = 'executing';
                record.startedAt ||= Date.now();
                record.executionError = null;
                return record;
            });
        }
    } catch (caughtError) {
        const error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));
        await updateBatch(batchId, (record) => {
            if (record.status === 'executing') record.status = 'partially_completed';
            record.executionError = error?.userMessage || error?.message || String(error);
            return record;
        }).catch(() => undefined);
        error.userMessage = [
            error?.userMessage || error?.message || 'Исполнение массового взыскания прервано.',
            `ID пакета: ${batchId}`,
            `Для повторения: /manualtools retry_massdiscipline massdiscipline_id:${batchId}`,
        ].join('\n');
        throw error;
    }

    for (const item of batch.items) {
        if (item.status === 'invalid' || item.status === 'completed') continue;
        try {
            const result = await executeOne(client, {
                guild,
                config,
                actor,
                batch,
                item,
                thread: publication.thread,
            });
            batch = await updateBatch(batchId, (record) => {
                const target = record.items.find((entry) => getItemTargetKey(entry) === getItemTargetKey(item));
                Object.assign(target, result);
                return record;
            });
        } catch (error) {
            const stateChanged = error?.code === 'mass_state_changed';
            batch = await updateBatch(batchId, (record) => {
                const target = record.items.find((entry) => getItemTargetKey(entry) === getItemTargetKey(item));
                target.status = stateChanged ? 'skipped_state_changed' : 'failed';
                target.error = error?.userMessage || error?.message || String(error);
                target.disciplineCaseId = error?.disciplineCaseId || null;
                return record;
            });
            logger[stateChanged || error instanceof DisciplineError || error instanceof StaffAuditError ? 'warn' : 'error']('Ошибка сотрудника в массовом взыскании', {
                massdisciplineId: batchId,
                targetKey: getItemTargetKey(item),
                memberId: item.memberId || null,
                externalTargetId: item.externalTargetId || null,
            }, error);
        }
    }

    const failed = batch.items.filter((item) => ['failed', 'skipped_state_changed'].includes(item.status));
    const pending = batch.items.filter((item) => !['invalid', 'completed', 'failed', 'skipped_state_changed'].includes(item.status));
    batch = await updateBatch(batchId, (record) => {
        record.status = failed.length || pending.length ? 'partially_completed' : 'completed';
        record.completedAt = record.status === 'completed' ? Date.now() : null;
        record.executionError = null;
        return record;
    });
    await refreshGroupMessages(client, batch, publication);
    if (batch.status === 'completed') {
        await closeBatchThread(client, batch).catch((error) => {
            logger.warn('Не удалось закрыть ветку завершённого массового взыскания', {
                massdisciplineId: batch.massdisciplineId,
                threadId: batch.sharedThreadId || null,
            }, error);
        });
    }
    return batch;
}

async function approveBatch(client, { batchId, approver }) {
    let batch = await getBatch(batchId);
    if (!batch) throw new DisciplineError('Массовое дисциплинарное дело не найдено.', 'mass_batch_not_found');
    if (batch.status !== 'awaiting_approval') throw new DisciplineError('Этот пакет уже рассмотрен или истёк.', 'mass_approval_closed');
    if (Date.now() > Number(batch.expiresAt)) {
        await updateBatch(batchId, (record) => { record.status = 'expired'; });
        throw new DisciplineError('Срок подтверждения массового взыскания истёк.', 'mass_approval_expired');
    }
    if (String(batch.actorId) === String(approver.id)) {
        throw new DisciplineError('Инициатор не может подтвердить собственное массовое взыскание.', 'mass_self_approval');
    }
    const config = guildConfigService.get(batch.guildId);
    const settings = getDisciplineSettings(config);
    if (!memberHasAnyRole(approver, settings.massApprovalRoleIds)) {
        throw new DisciplineError('У вас нет роли подтверждения массовых взысканий.', 'mass_approval_denied');
    }
    batch = await updateBatch(batchId, (record) => {
        if (record.status !== 'awaiting_approval') throw new DisciplineError('Пакет уже рассмотрен.', 'mass_approval_closed');
        record.status = 'executing';
        record.approvedBy = String(approver.id);
        record.approvedAt = Date.now();
        record.approvalSatisfied = true;
        record.startedAt = Date.now();
        return record;
    });
    return executeBatch(client, { batchId, requester: approver });
}

async function rejectBatch({ batchId, approver }) {
    const batch = await getBatch(batchId);
    if (!batch) throw new DisciplineError('Массовое дисциплинарное дело не найдено.', 'mass_batch_not_found');
    if (batch.status !== 'awaiting_approval') throw new DisciplineError('Этот пакет уже рассмотрен.', 'mass_approval_closed');
    if (Date.now() > Number(batch.expiresAt)) {
        await updateBatch(batchId, (record) => { record.status = 'expired'; });
        throw new DisciplineError('Срок подтверждения массового взыскания истёк.', 'mass_approval_expired');
    }
    if (String(batch.actorId) === String(approver.id)) {
        throw new DisciplineError('Инициатор не может отклонить собственный пакет через панель подтверждения.', 'mass_self_approval');
    }
    const config = guildConfigService.get(batch.guildId);
    const settings = getDisciplineSettings(config);
    if (!memberHasAnyRole(approver, settings.massApprovalRoleIds)) {
        throw new DisciplineError('У вас нет роли подтверждения массовых взысканий.', 'mass_approval_denied');
    }
    return updateBatch(batchId, (record) => {
        record.status = 'rejected';
        record.rejectedBy = String(approver.id);
        record.rejectedAt = Date.now();
        return record;
    });
}

async function retryBatch(client, { batchId, requester }) {
    const batch = await getBatch(batchId);
    if (!batch) throw new DisciplineError('Массовое дисциплинарное дело не найдено.', 'mass_batch_not_found');
    if (batch.status !== 'partially_completed') {
        throw new DisciplineError('Повторить можно только частично выполненный пакет.', 'mass_retry_status');
    }
    if (requester && String(requester.guild?.id || batch.guildId) !== String(batch.guildId)) {
        throw new DisciplineError('Запрос восстановления выполнен не на том сервере.', 'mass_wrong_guild');
    }

    const guild = await client.guilds.fetch(batch.guildId);
    const actor = await guild.members.fetch(batch.actorId).catch(() => null);
    if (!actor) throw new DisciplineError('Инициатор пакета отсутствует на сервере.', 'mass_actor_missing');

    const retryableItems = (batch.items || []).filter((item) => ['pending', 'failed', 'skipped_state_changed'].includes(item.status));
    if (!retryableItems.length) {
        throw new DisciplineError('В пакете нет сотрудников, которых можно повторить.', 'mass_retry_empty');
    }
    const stateHashes = new Map();
    for (const item of retryableItems) {
        if (item.targetType === 'external' || !item.memberId) {
            stateHashes.set(getItemTargetKey(item), `external:${item.externalTargetId}`);
            continue;
        }
        const member = await guild.members.fetch(item.memberId).catch(() => null);
        stateHashes.set(getItemTargetKey(item), member ? buildMemberStateHash(member) : 'missing');
    }

    await updateBatch(batchId, (record) => {
        if (record.status !== 'partially_completed') {
            throw new DisciplineError('Статус пакета изменился до начала восстановления.', 'mass_retry_status');
        }
        for (const item of record.items || []) {
            if (!['pending', 'failed', 'skipped_state_changed'].includes(item.status)) continue;
            item.status = 'pending';
            item.error = null;
            item.stateHash = stateHashes.get(getItemTargetKey(item)) || 'missing';
        }
        record.status = 'executing';
        record.retryRequestedBy = String(requester.id);
        record.retryRequestedAt = Date.now();
        record.executionError = null;
        return record;
    });
    return executeBatch(client, { batchId, requester });
}

async function recoverInterruptedBatches() {
    return mutateDb((db) => {
        let recovered = 0;
        for (const batch of db.massDisciplineBatches || []) {
            if (batch.status !== 'executing') continue;
            batch.status = 'partially_completed';
            batch.executionError = 'Исполнение было прервано перезапуском бота.';
            batch.updatedAt = Date.now();
            recovered += 1;
        }
        return recovered;
    });
}

async function expirePendingBatches(client) {
    const now = Date.now();
    const expired = await mutateDb((db) => {
        const results = [];
        for (const batch of db.massDisciplineBatches || []) {
            if (['awaiting_confirmation', 'awaiting_approval'].includes(batch.status) && Number(batch.expiresAt) <= now) {
                const previousStatus = batch.status;
                batch.status = 'expired';
                batch.expiredFromStatus = previousStatus;
                batch.updatedAt = now;
                results.push(clone(batch));
            }
        }
        return results;
    });
    for (const batch of expired) {
        if (batch.expiredFromStatus !== 'awaiting_approval' || !batch.approvalChannelId || !batch.approvalMessageId) continue;
        try {
            const channel = await client.channels.fetch(batch.approvalChannelId);
            const message = await channel.messages.fetch(batch.approvalMessageId);
            await editMessageWithRetry(message, {
                content: '',
                embeds: [buildApprovalEmbed(batch, 'Срок подтверждения истёк')],
                components: [buildApprovalRow(batch.massdisciplineId, true)],
                allowedMentions: { parse: [] },
            });
        } catch (error) {
            logger.warn('Не удалось закрыть истёкшую панель массового взыскания', {
                massdisciplineId: batch.massdisciplineId,
            }, error);
        }
    }
    return expired.length;
}

module.exports = {
    ACTIVE_BATCH_STATUSES,
    approveBatch,
    buildApprovalEmbed,
    buildApprovalRow,
    buildConfirmationRow,
    buildPreviewComponents,
    buildPreviewPayload,
    buildPreview,
    buildResult,
    buildResultPayload,
    getBatchStatusLabel,
    getItemStatusLabel,
    cancelBatch,
    closeInactiveMassThreads,
    createBatch,
    executeBatch,
    expirePendingBatches,
    getBatch,
    getSelectionSummary,
    normalizeTargets,
    parseTargetText,
    preflight,
    recoverInterruptedBatches,
    refreshBatchMessages,
    rejectBatch,
    retryBatch,
    submitBatch,
    validateTargetsDraft,
    validateTargetsEarly,
};
