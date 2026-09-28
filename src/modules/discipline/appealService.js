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
const { getRanks } = require('../../core/config/rankSchema');
const guildConfigService = require('../../core/config/guildConfigService');
const {
    closeThreadWithRetry,
    editMessageWithRetry,
    sendMessageWithRetry,
    startThreadWithRetry,
} = require('../../core/discord/request');
const logger = require('../../core/logging/logger');
const { disciplineAppeals, mutateDatabase: mutateDb, readDatabase: readDb } = require('./database');
const DisciplineError = require('./error');
const { getStaffListSettings } = require('../staff-lists');
const disciplineService = require('./service');
const { getDisciplineSettings } = require('./settings/schema');

const APPEAL_TYPES = new Set(['basis', 'workoff_method']);
const {
    STATUS_LABELS,
    TERMINAL_STATUSES,
    TYPE_LABELS,
    buildAppealComponents,
    buildAppealEmbed,
} = require('./appealPresentation');

function createId() {
    return `appeal-${crypto.randomBytes(7).toString('hex')}`;
}

function clone(value) {
    return structuredClone(value);
}

function buildMessageLink(guildId, channelId, messageId) {
    if (!guildId || !channelId || !messageId) return null;
    return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

function getAppealFromDb(appealId) {
    const appeal = (readDb().disciplineAppeals || []).find((entry) => entry.appealId === appealId);
    return appeal ? clone(appeal) : null;
}

async function fetchAppeal(appealId) {
    const appeal = await disciplineAppeals.findOne({ appealId: String(appealId) });
    return appeal ? clone(appeal) : null;
}

function assertAppealsEnabled(config) {
    const settings = getDisciplineSettings(config).appeals;
    if (!settings.enabled) {
        throw new DisciplineError('Обжалования взысканий отключены на этом сервере.', 'appeals_disabled');
    }
    if (!settings.channelId) {
        throw new DisciplineError('Канал обжалований не настроен.', 'appeals_channel_missing');
    }
    return settings;
}

function findTargetDepartment(member, config) {
    if (!member) return null;
    return getDepartments(config).find((department) => (
        department.roles?.memberRoleId && member.roles.cache.has(department.roles.memberRoleId)
    )) || null;
}

function buildCuratorRouteStage(department, config) {
    if (!department || department.curatorsEnabled === false) return null;

    const curatorRoleId = department.roles?.curatorRoleId;
    if (curatorRoleId) {
        return {
            key: 'curator',
            type: 'roles',
            roleIds: [curatorRoleId],
            departmentId: department.id,
        };
    }

    const headRoleId = department.roles?.headRoleId;
    if (!headRoleId) return null;

    const managementRankNumbers = new Set(
        getStaffListSettings(config).curatorManagementRankNumbers
    );
    const managementRankRoleIds = getRanks(config)
        .filter((rank) => managementRankNumbers.has(rank.number) && rank.roleId)
        .map((rank) => rank.roleId);
    if (!managementRankRoleIds.length) return null;

    return {
        key: 'curator',
        type: 'role_intersection',
        allRoleIds: [headRoleId],
        anyRoleIds: managementRankRoleIds,
        departmentId: department.id,
    };
}

function buildRoute({ appealType, caseRecord, member, config }) {
    const settings = getDisciplineSettings(config).appeals;
    if (appealType === 'workoff_method') {
        return [
            {
                key: 'workoff_issuer',
                type: 'user',
                userId: String(caseRecord.issuerId || ''),
            },
            {
                key: 'workoff_leadership',
                type: 'roles',
                roleIds: settings.workoffReviewerRoleIds,
            },
        ];
    }

    const department = findTargetDepartment(member, config);
    const route = [
        {
            key: 'issuer',
            type: 'user',
            userId: String(caseRecord.issuerId || ''),
        },
    ];
    if (department?.roles?.headRoleId) {
        route.push({
            key: 'department_head',
            type: 'roles',
            roleIds: [department.roles.headRoleId],
            departmentId: department.id,
        });
    }
    const curatorStage = buildCuratorRouteStage(department, config);
    if (curatorStage) route.push(curatorStage);
    route.push({
        key: 'final',
        type: 'roles',
        roleIds: settings.finalReviewerRoleIds,
    });
    return route;
}

async function fetchGuildMembers(guild) {
    try {
        const collection = await guild.members.fetch();
        return collection?.values ? [...collection.values()] : [...(guild.members.cache?.values?.() || [])];
    } catch (_error) {
        return [...(guild.members.cache?.values?.() || [])];
    }
}

function getPreviousReviewerIds(appeal, beforeRouteIndex) {
    const result = new Set();
    for (const entry of appeal.history || []) {
        if (entry.action !== 'routed' || Number(entry.routeIndex) >= Number(beforeRouteIndex)) continue;
        for (const userId of entry.reviewerUserIds || []) result.add(String(userId));
    }
    return result;
}

async function resolveStage(guild, stage, applicantId, excludedReviewerIds = []) {
    if (!stage) return null;
    const excluded = new Set([...excludedReviewerIds].map(String));
    excluded.add(String(applicantId));

    if (stage.type === 'user') {
        if (!stage.userId || excluded.has(String(stage.userId))) return null;
        const member = await guild.members.fetch(stage.userId).catch(() => null);
        if (!member || member.user?.bot) return null;
        return {
            ...stage,
            reviewerUserIds: [String(member.id)],
            reviewerRoleIds: [],
        };
    }

    if (stage.type === 'role_intersection') {
        const allRoleIds = (Array.isArray(stage.allRoleIds) ? stage.allRoleIds : [])
            .map(String)
            .filter((roleId) => guild.roles.cache.has(roleId));
        const anyRoleIds = (Array.isArray(stage.anyRoleIds) ? stage.anyRoleIds : [])
            .map(String)
            .filter((roleId) => guild.roles.cache.has(roleId));
        if (!allRoleIds.length || !anyRoleIds.length) return null;

        const members = await fetchGuildMembers(guild);
        const reviewerUserIds = members
            .filter((member) => (
                !member.user?.bot &&
                !excluded.has(String(member.id)) &&
                allRoleIds.every((roleId) => member.roles.cache.has(roleId)) &&
                anyRoleIds.some((roleId) => member.roles.cache.has(roleId))
            ))
            .map((member) => String(member.id));
        if (!reviewerUserIds.length) return null;
        return {
            ...stage,
            allRoleIds,
            anyRoleIds,
            reviewerUserIds: [...new Set(reviewerUserIds)].sort(),
            reviewerRoleIds: [],
        };
    }

    const roleIds = (Array.isArray(stage.roleIds) ? stage.roleIds : [])
        .map(String)
        .filter((roleId) => guild.roles.cache.has(roleId));
    if (!roleIds.length) return null;
    const members = await fetchGuildMembers(guild);
    const reviewerUserIds = members
        .filter((member) => (
            !member.user?.bot &&
            !excluded.has(String(member.id)) &&
            roleIds.some((roleId) => member.roles.cache.has(roleId))
        ))
        .map((member) => String(member.id));
    if (!reviewerUserIds.length) return null;
    return {
        ...stage,
        roleIds,
        reviewerUserIds: [...new Set(reviewerUserIds)].sort(),
        reviewerRoleIds: roleIds,
    };
}

async function resolveNextStage(guild, appeal, startIndex) {
    for (let index = Math.max(0, Number(startIndex) || 0); index < appeal.route.length; index += 1) {
        const excluded = getPreviousReviewerIds(appeal, index);
        const resolved = await resolveStage(guild, appeal.route[index], appeal.applicantId, excluded);
        if (resolved) return { index, stage: resolved };
    }
    return null;
}

function getReviewerMentions(appeal) {
    const roleMentions = (appeal.currentReviewerRoleIds || []).map((roleId) => `<@&${roleId}>`);
    if (roleMentions.length) return roleMentions;
    return (appeal.currentReviewerUserIds || []).map((userId) => `<@${userId}>`);
}

function getAllowedMentions(appeal, { includeApplicant = false } = {}) {
    return {
        parse: [],
        roles: appeal.currentReviewerRoleIds || [],
        users: [
            ...(appeal.currentReviewerRoleIds?.length ? [] : appeal.currentReviewerUserIds || []),
            ...(includeApplicant ? [appeal.applicantId] : []),
        ],
    };
}

async function updateAppealMessage(client, appeal) {
    if (!appeal.channelId || !appeal.messageId) return;
    const channel = await client.channels.fetch(appeal.channelId).catch(() => null);
    const message = await channel?.messages?.fetch?.(appeal.messageId).catch(() => null);
    if (!message) return;
    await editMessageWithRetry(message, {
        content: appeal.status === 'pending_review' ? getReviewerMentions(appeal).join(' ') : '',
        embeds: [buildAppealEmbed(appeal)],
        components: buildAppealComponents(appeal),
        allowedMentions: getAllowedMentions(appeal),
    });
}

async function updateAppeal(appealId, mutator) {
    return mutateDb((db) => {
        const appeal = (db.disciplineAppeals || []).find((entry) => entry.appealId === appealId);
        if (!appeal) return null;
        const result = mutator(appeal, db);
        appeal.updatedAt = Date.now();
        return clone(result === undefined ? appeal : result);
    });
}

async function markSanctionAppeal(client, appeal, statusLabel) {
    const caseRecord = await disciplineService.fetchCase(appeal.caseId);
    const sanction = disciplineService.findSanction(caseRecord, appeal.sanctionId);
    if (!caseRecord || !sanction) return;
    sanction.appealId = appeal.appealId;
    sanction.appealMessageLink = buildMessageLink(appeal.guildId, appeal.channelId, appeal.messageId);
    sanction.appealStatusLabel = statusLabel;
    caseRecord.updatedAt = Date.now();
    await disciplineService.persistCase(caseRecord);
    await disciplineService.updateSanctionMessage(client, caseRecord, sanction);
}

async function pauseDeadline(appeal) {
    if (appeal.type !== 'basis' || !appeal.pauseWorkoffDeadline || appeal.pauseStartedAt) return appeal;
    const now = Date.now();
    const updated = await mutateDb((db) => {
        const record = (db.disciplineAppeals || []).find((entry) => entry.appealId === appeal.appealId);
        if (!record) return null;
        if (record.pauseStartedAt) return clone(record);

        const caseRecord = (db.disciplineCases || []).find((entry) => entry.caseId === appeal.caseId);
        const sanction = disciplineService.findSanction(caseRecord, appeal.sanctionId);
        if (!sanction || sanction.status !== 'active') return clone(record);

        const existingPauseAt = String(sanction.appealPauseId || '') === String(appeal.appealId)
            ? Number(sanction.appealPauseStartedAt)
            : NaN;
        const pauseAt = Number.isFinite(existingPauseAt) ? existingPauseAt : now;
        sanction.appealPauseStartedAt = pauseAt;
        sanction.appealPauseId = appeal.appealId;

        for (const part of sanction.workoffParts || []) {
            disciplineService.startWorkoffDeadlinePause(part, 'appeal', appeal.appealId, pauseAt);
        }

        record.pauseStartedAt = pauseAt;
        record.history.push({ action: 'deadline_paused', at: pauseAt });
        record.updatedAt = now;
        caseRecord.updatedAt = now;
        return clone(record);
    });
    return updated || appeal;
}

async function resumeDeadline(appeal, { shiftDeadline = true } = {}) {
    const now = Date.now();
    const updated = await mutateDb((db) => {
        const record = (db.disciplineAppeals || []).find((entry) => entry.appealId === appeal.appealId);
        if (!record) return null;

        const caseRecord = (db.disciplineCases || []).find((entry) => entry.caseId === appeal.caseId);
        const sanction = disciplineService.findSanction(caseRecord, appeal.sanctionId);
        const matchingPartStarts = (sanction?.workoffParts || [])
            .filter((part) => String(part.appealPauseId || '') === String(appeal.appealId))
            .map((part) => Number(part.appealPauseStartedAt))
            .filter(Number.isFinite);
        const candidateStarts = [
            Number(record.pauseStartedAt),
            String(sanction?.appealPauseId || '') === String(appeal.appealId)
                ? Number(sanction.appealPauseStartedAt)
                : NaN,
            ...matchingPartStarts,
        ].filter(Number.isFinite);
        if (!candidateStarts.length) return clone(record);
        const pauseStartedAt = Math.min(...candidateStarts);

        if (sanction) {
            if (String(sanction.appealPauseId || '') === String(appeal.appealId)) {
                sanction.appealPauseStartedAt = null;
                sanction.appealPauseId = null;
            }
            for (const part of sanction.workoffParts || []) {
                disciplineService.finishWorkoffDeadlinePause(
                    part,
                    'appeal',
                    appeal.appealId,
                    now,
                    { shiftDeadline }
                );
            }
            caseRecord.updatedAt = now;
        }

        const duration = Math.max(0, now - pauseStartedAt);
        record.pauseTotalMs = Number(record.pauseTotalMs || 0) + duration;
        record.pauseStartedAt = null;
        record.history.push({ action: 'deadline_resumed', at: now, duration, shiftDeadline });
        record.updatedAt = now;
        return clone(record);
    });
    return updated || appeal;
}

async function assignResolvedStage(client, guild, appeal, resolved) {
    let updated = await updateAppeal(appeal.appealId, (record) => {
        record.routeIndex = resolved.index;
        record.currentStageKey = resolved.stage.key;
        record.currentReviewerUserIds = resolved.stage.reviewerUserIds;
        record.currentReviewerRoleIds = resolved.stage.reviewerRoleIds;
        record.status = 'pending_review';
        record.history.push({
            action: 'routed',
            stage: resolved.stage.key,
            routeIndex: resolved.index,
            reviewerUserIds: resolved.stage.reviewerUserIds,
            reviewerRoleIds: resolved.stage.reviewerRoleIds,
            at: Date.now(),
        });
    });
    updated = await pauseDeadline(updated);
    await updateAppealMessage(client, updated);
    await markSanctionAppeal(client, updated, STATUS_LABELS[updated.status]);
    return updated;
}

async function routeAppeal(client, guild, appeal, startIndex) {
    const resolved = await resolveNextStage(guild, appeal, startIndex);
    if (!resolved) {
        const updated = await updateAppeal(appeal.appealId, (record) => {
            record.status = 'routing_failed';
            record.currentStageKey = null;
            record.currentReviewerUserIds = [];
            record.currentReviewerRoleIds = [];
            record.history.push({ action: 'routing_failed', startIndex, at: Date.now() });
        });
        await updateAppealMessage(client, updated);
        await markSanctionAppeal(client, updated, STATUS_LABELS[updated.status]);
        return updated;
    }
    return assignResolvedStage(client, guild, appeal, resolved);
}

async function findAppealThread(client, message, appeal) {
    if (appeal.threadId) {
        const stored = await client.channels.fetch(appeal.threadId).catch(() => null);
        if (stored) return stored;
    }

    if (message?.thread) return message.thread;
    const attachedThreadId = message?.threadId || (message?.hasThread ? message.id : null);
    if (!attachedThreadId) return null;
    return client.channels.fetch(attachedThreadId).catch(() => null);
}

async function ensureAppealPublication(client, guild, appeal) {
    const channel = await client.channels.fetch(appeal.channelId).catch(() => null);
    if (!channel?.isTextBased?.() || !channel.send || channel.isThread?.()) {
        throw new DisciplineError('Канал обжалований недоступен боту.', 'appeal_channel_unavailable');
    }

    let message = appeal.messageId
        ? await channel.messages?.fetch?.(appeal.messageId).catch(() => null)
        : null;
    if (!message) {
        message = await sendMessageWithRetry(channel, {
            content: '',
            embeds: [buildAppealEmbed(appeal)],
            components: [],
            allowedMentions: { parse: [] },
        }, { nonceSeed: `disciplineAppeal:${appeal.appealId}` });
        appeal = await updateAppeal(appeal.appealId, (record) => {
            record.messageId = String(message.id);
            record.history.push({ action: 'message_published', messageId: record.messageId, at: Date.now() });
        });
    }

    let thread = await findAppealThread(client, message, appeal);
    if (!thread) {
        thread = await startThreadWithRetry(message, {
            name: `Доказательства ${appeal.appealId}`.slice(0, 100),
            autoArchiveDuration: 1440,
            reason: `WN Helper: доказательства по обжалованию ${appeal.appealId}`,
        });
    }
    if (!thread?.id) {
        throw new DisciplineError('Не удалось создать ветку доказательств обращения.', 'appeal_thread_unavailable');
    }
    if (String(appeal.threadId || '') !== String(thread.id)) {
        appeal = await updateAppeal(appeal.appealId, (record) => {
            record.threadId = String(thread.id);
            record.history.push({ action: 'thread_created', threadId: record.threadId, at: Date.now() });
        });
    }
    if (thread.send) {
        await sendMessageWithRetry(thread, {
            content: [
                `<@${appeal.applicantId}>, отправьте в эту ветку доказательства и дополнительные пояснения.`,
                appeal.evidenceNote ? `Первичное пояснение: ${appeal.evidenceNote}` : null,
            ].filter(Boolean).join('\n').slice(0, 2000),
            allowedMentions: { parse: [], users: [String(appeal.applicantId)] },
        }, { nonceSeed: `disciplineAppealEvidence:${appeal.appealId}` });
    }

    appeal = await updateAppeal(appeal.appealId, (record) => {
        record.status = 'creating';
        record.lastPublicationError = null;
        record.history.push({ action: 'publication_ready', at: Date.now() });
    });
    await updateAppealMessage(client, appeal);
    return appeal;
}

async function recoverAppealPublication(client, guild, appeal) {
    try {
        const published = await ensureAppealPublication(client, guild, appeal);
        return routeAppeal(client, guild, published, Math.max(0, published.routeIndex + 1));
    } catch (error) {
        const failed = await updateAppeal(appeal.appealId, (record) => {
            record.status = 'publication_failed';
            record.lastPublicationError = error?.message || 'Неизвестная ошибка публикации';
            record.history.push({
                action: 'publication_failed',
                error: record.lastPublicationError,
                at: Date.now(),
            });
        }).catch(() => null);
        if (failed) await updateAppealMessage(client, failed).catch(() => undefined);
        throw error;
    }
}

function findBlockingAppeal(appeals, { caseId, sanctionId, type }) {
    return (Array.isArray(appeals) ? appeals : []).find((entry) => (
        entry.caseId === caseId &&
        entry.sanctionId === sanctionId &&
        entry.type === type &&
        (type === 'basis' || entry.status !== 'satisfied')
    )) || null;
}

async function createAppeal(client, {
    guild,
    applicant,
    caseId,
    sanctionId,
    type,
    reason,
    evidenceNote = '',
    partId = null,
    requestedMethodId = null,
}) {
    const config = guildConfigService.get(guild.id);
    const settings = assertAppealsEnabled(config);
    if (!APPEAL_TYPES.has(type)) throw new DisciplineError('Неизвестный тип обращения.', 'appeal_type_invalid');
    if (!String(reason || '').trim()) throw new DisciplineError('Укажите причину обращения.', 'appeal_reason_required');

    const caseRecord = await disciplineService.fetchCase(caseId);
    if (!caseRecord || String(caseRecord.guildId) !== String(guild.id)) {
        throw new DisciplineError('Дисциплинарное дело не найдено.', 'appeal_case_not_found');
    }
    if (String(caseRecord.memberId || '') !== String(applicant.id)) {
        throw new DisciplineError('Обжаловать взыскание может только сотрудник, которому оно выдано.', 'appeal_applicant_denied');
    }
    const sanction = disciplineService.findSanction(caseRecord, sanctionId);
    if (!sanction || sanction.status !== 'active') {
        throw new DisciplineError('Активное взыскание не найдено.', 'appeal_sanction_not_active');
    }

    let selectedPart = null;
    let requestedMethod = null;
    if (type === 'workoff_method') {
        const pendingParts = disciplineService.getPendingParts(sanction);
        selectedPart = partId
            ? pendingParts.find((part) => part.id === partId)
            : pendingParts.length === 1 ? pendingParts[0] : null;
        if (!selectedPart) throw new DisciplineError('Выберите часть отработки.', 'appeal_workoff_part_required');
        const methods = disciplineService.getAvailableMethods(applicant, config, selectedPart.stage);
        requestedMethod = methods.find((method) => method.id === requestedMethodId) || null;
        if (!requestedMethod) throw new DisciplineError('Выбранный способ отработки недоступен.', 'appeal_method_unavailable');
        if (requestedMethod.id === selectedPart.methodId) {
            throw new DisciplineError('Выбран текущий способ отработки.', 'appeal_method_unchanged');
        }
    }

    const now = Date.now();
    const appeal = {
        appealId: createId(),
        guildId: String(guild.id),
        caseId,
        sanctionId,
        type,
        applicantId: String(applicant.id),
        applicantDisplayName: String(applicant.displayName || applicant.user?.username || applicant.id),
        sanctionLabel: disciplineService.getSanctionLabel
            ? disciplineService.getSanctionLabel(sanction)
            : sanction.type,
        sanctionMessageLink: disciplineService.getSanctionMessageLink(caseRecord, sanction),
        reason: String(reason).trim().slice(0, 2000),
        evidenceNote: String(evidenceNote || '').trim().slice(0, 2000),
        partId: selectedPart?.id || null,
        currentMethodId: selectedPart?.methodId || null,
        currentMethodName: selectedPart?.methodName || null,
        requestedMethodId: requestedMethod?.id || null,
        requestedMethodName: requestedMethod?.name || null,
        route: buildRoute({ appealType: type, caseRecord, member: applicant, config }),
        routeIndex: -1,
        currentStageKey: null,
        currentReviewerUserIds: [],
        currentReviewerRoleIds: [],
        status: 'creating',
        channelId: settings.channelId,
        messageId: null,
        threadId: null,
        pauseWorkoffDeadline: type === 'basis' && settings.pauseWorkoffDeadline,
        pauseStartedAt: null,
        pauseTotalMs: 0,
        createdAt: now,
        updatedAt: now,
        history: [{ action: 'created', actorId: String(applicant.id), at: now }],
    };

    const inserted = await mutateDb((db) => {
        const existing = findBlockingAppeal(db.disciplineAppeals, { caseId, sanctionId, type });
        if (existing) return { inserted: false, existing: clone(existing) };
        db.disciplineAppeals.push(clone(appeal));
        return { inserted: true };
    });
    if (!inserted.inserted) {
        throw new DisciplineError(
            `По этому взысканию уже существует обращение ${inserted.existing.appealId}.`,
            'appeal_already_exists'
        );
    }

    try {
        return await recoverAppealPublication(client, guild, appeal);
    } catch (error) {
        if (error instanceof DisciplineError) throw error;
        throw new DisciplineError(
            'Не удалось опубликовать обращение. Бот повторит попытку автоматически.',
            'appeal_publication_failed'
        );
    }
}

async function assertCurrentReviewer(guild, appeal, actorId) {
    if (appeal.status !== 'pending_review') {
        throw new DisciplineError('Обращение сейчас не ожидает решения.', 'appeal_not_pending_review');
    }
    const stage = appeal.route[appeal.routeIndex];
    const excluded = getPreviousReviewerIds(appeal, appeal.routeIndex);
    const resolved = await resolveStage(guild, stage, appeal.applicantId, excluded);
    if (!resolved) return { available: false, resolved: null };
    if (!resolved.reviewerUserIds.includes(String(actorId))) {
        throw new DisciplineError('У вас нет права принимать решение по этому обращению.', 'appeal_review_denied');
    }
    return { available: true, resolved };
}

async function closeThread(client, appeal) {
    if (!appeal.threadId) return false;
    const thread = await client.channels.fetch(appeal.threadId).catch(() => null);
    if (!thread) return false;
    await closeThreadWithRetry(thread, {
        reason: `WN Helper: обращение ${appeal.appealId} закрыто`,
    });
    return true;
}

async function closeInactiveAppealThreads(client) {
    const appeals = (readDb().disciplineAppeals || []).filter((appeal) => (
        appeal.threadId && TERMINAL_STATUSES.has(appeal.status)
    ));
    let closed = 0;
    for (const appeal of appeals) {
        if (await closeThread(client, appeal).catch((error) => {
            logger.warn('Не удалось закрыть ветку завершённого обжалования', {
                appealId: appeal.appealId,
                threadId: appeal.threadId || null,
            }, error);
            return false;
        })) closed += 1;
    }
    return closed;
}

async function satisfyBasisAppeal(client, guild, appeal, actor, decisionReason) {
    await resumeDeadline(appeal, { shiftDeadline: false });
    const result = await mutateDb((db) => {
        const caseRecord = (db.disciplineCases || []).find((entry) => entry.caseId === appeal.caseId);
        const sanction = disciplineService.findSanction(caseRecord, appeal.sanctionId);
        if (!caseRecord || !sanction || sanction.status !== 'active') return null;
        sanction.status = 'annulled';
        sanction.annulledAt = Date.now();
        sanction.annulledById = String(actor.id);
        sanction.annulmentReason = String(decisionReason || '').trim();
        sanction.appealStatusLabel = 'Удовлетворено';
        sanction.appealPauseStartedAt = null;
        sanction.appealPauseId = null;
        sanction.vacationPauseStartedAt = null;
        sanction.vacationPauseId = null;
        for (const part of sanction.workoffParts || []) {
            if (part.status === 'pending') {
                part.status = 'cancelled_by_appeal';
                part.completedAt = Date.now();
            }
            part.appealPauseStartedAt = null;
            part.appealPauseId = null;
            part.vacationPauseStartedAt = null;
            part.vacationPauseId = null;
            part.deadlinePauseStartedAt = null;
        }
        disciplineService.refreshCaseStatus(caseRecord);
        caseRecord.updatedAt = Date.now();
        return clone(caseRecord);
    });
    if (!result) throw new DisciplineError('Взыскание уже изменено и не может быть аннулировано.', 'appeal_sanction_changed');
    const member = await guild.members.fetch(appeal.applicantId).catch(() => null);
    const config = guildConfigService.get(guild.id);
    if (member) await disciplineService.syncDisciplineRoles(member, config);
    const sanction = disciplineService.findSanction(result, appeal.sanctionId);
    await disciplineService.updateSanctionMessage(client, result, sanction);
}

async function getWorkoffReviewOptions(guild, appealId, actorId) {
    const appeal = await fetchAppeal(appealId);
    if (!appeal || String(appeal.guildId) !== String(guild.id)) {
        throw new DisciplineError('Обращение не найдено.', 'appeal_not_found');
    }
    if (appeal.type !== 'workoff_method') {
        throw new DisciplineError('Это обращение не изменяет способ отработки.', 'appeal_type_mismatch');
    }
    const reviewer = await assertCurrentReviewer(guild, appeal, actorId);
    if (!reviewer.available) {
        throw new DisciplineError('Текущий этап больше недоступен. Повторите действие для передачи обращения выше.', 'appeal_stage_unavailable');
    }

    const caseRecord = await disciplineService.fetchCase(appeal.caseId);
    const sanction = disciplineService.findSanction(caseRecord, appeal.sanctionId);
    const part = (sanction?.workoffParts || []).find((entry) => entry.id === appeal.partId);
    if (!caseRecord || !sanction || sanction.status !== 'active' || !part || part.status !== 'pending') {
        throw new DisciplineError('Отработка уже изменена или закрыта.', 'appeal_workoff_changed');
    }
    const applicant = await guild.members.fetch(appeal.applicantId).catch(() => null);
    if (!applicant) throw new DisciplineError('Сотрудник больше не найден на сервере.', 'appeal_applicant_missing');
    const config = guildConfigService.get(guild.id);
    const methods = disciplineService.getAvailableMethods(applicant, config, part.stage)
        .filter((method) => method.id !== part.methodId);
    if (!methods.length) {
        throw new DisciplineError('Для этой отработки больше нет доступных альтернатив.', 'appeal_no_alternative_method');
    }
    return {
        appeal,
        currentMethodId: part.methodId,
        currentMethodName: part.methodName,
        methods,
    };
}

async function satisfyWorkoffAppeal(client, appeal, actor, decisionReason, approvedMethod) {
    const updatedCase = await mutateDb((db) => {
        const caseRecord = (db.disciplineCases || []).find((entry) => entry.caseId === appeal.caseId);
        const sanction = disciplineService.findSanction(caseRecord, appeal.sanctionId);
        const part = (sanction?.workoffParts || []).find((entry) => entry.id === appeal.partId);
        if (!caseRecord || !sanction || sanction.status !== 'active' || !part || part.status !== 'pending') return null;
        part.methodId = approvedMethod.id;
        part.methodName = approvedMethod.name;
        part.methodChangedAt = Date.now();
        part.methodChangedById = String(actor.id);
        part.methodChangeReason = String(decisionReason || '').trim();
        sanction.appealStatusLabel = 'Изменение способа одобрено';
        caseRecord.updatedAt = Date.now();
        return clone(caseRecord);
    });
    if (!updatedCase) throw new DisciplineError('Отработка уже изменена или закрыта.', 'appeal_workoff_changed');
    const sanction = disciplineService.findSanction(updatedCase, appeal.sanctionId);
    await disciplineService.updateSanctionMessage(client, updatedCase, sanction);
}

async function approveAppeal(client, { guild, actor, appealId, decisionReason, approvedMethodId = null }) {
    let appeal = await fetchAppeal(appealId);
    if (!appeal || String(appeal.guildId) !== String(guild.id)) throw new DisciplineError('Обращение не найдено.', 'appeal_not_found');
    const reviewer = await assertCurrentReviewer(guild, appeal, actor.id);
    if (!reviewer.available) {
        appeal = await routeAppeal(client, guild, appeal, appeal.routeIndex + 1);
        throw new DisciplineError('Текущий этап больше недоступен. Обращение передано выше.', 'appeal_stage_skipped');
    }
    if (!String(decisionReason || '').trim()) throw new DisciplineError('Укажите причину решения.', 'appeal_decision_reason_required');

    let approvedMethod = null;
    if (appeal.type === 'basis') {
        await satisfyBasisAppeal(client, guild, appeal, actor, decisionReason);
    } else {
        const options = await getWorkoffReviewOptions(guild, appeal.appealId, actor.id);
        approvedMethod = options.methods.find((method) => method.id === approvedMethodId) || null;
        if (!approvedMethod) {
            throw new DisciplineError('Выбранный итоговый способ отработки недоступен.', 'appeal_approved_method_unavailable');
        }
        await satisfyWorkoffAppeal(client, appeal, actor, decisionReason, approvedMethod);
    }
    appeal = await updateAppeal(appealId, (record) => {
        record.status = 'satisfied';
        record.lastDecisionReason = String(decisionReason).trim();
        record.decidedById = String(actor.id);
        record.decidedByDisplayName = String(actor.displayName || actor.user?.username || actor.id);
        record.decidedAt = Date.now();
        if (approvedMethod) {
            record.approvedMethodId = approvedMethod.id;
            record.approvedMethodName = approvedMethod.name;
        }
        record.history.push({ action: 'satisfied', actorId: String(actor.id), reason: record.lastDecisionReason, at: record.decidedAt });
    });
    await updateAppealMessage(client, appeal);
    await markSanctionAppeal(client, appeal, STATUS_LABELS[appeal.status]);
    await closeThread(client, appeal);
    return appeal;
}

async function rejectAppeal(client, { guild, actor, appealId, decisionReason }) {
    let appeal = await fetchAppeal(appealId);
    if (!appeal || String(appeal.guildId) !== String(guild.id)) throw new DisciplineError('Обращение не найдено.', 'appeal_not_found');
    const reviewer = await assertCurrentReviewer(guild, appeal, actor.id);
    if (!reviewer.available) {
        appeal = await routeAppeal(client, guild, appeal, appeal.routeIndex + 1);
        throw new DisciplineError('Текущий этап больше недоступен. Обращение передано выше.', 'appeal_stage_skipped');
    }
    if (!String(decisionReason || '').trim()) throw new DisciplineError('Укажите причину отказа.', 'appeal_rejection_reason_required');
    appeal = await resumeDeadline(appeal);
    const hasNextStage = Boolean(await resolveNextStage(guild, appeal, appeal.routeIndex + 1));
    appeal = await updateAppeal(appealId, (record) => {
        record.lastDecisionReason = String(decisionReason).trim();
        record.decidedById = String(actor.id);
        record.decidedByDisplayName = String(actor.displayName || actor.user?.username || actor.id);
        record.history.push({
            action: hasNextStage ? 'rejected_stage' : 'rejected_final',
            stage: record.currentStageKey,
            actorId: String(actor.id),
            reason: record.lastDecisionReason,
            at: Date.now(),
        });
        record.status = hasNextStage ? 'awaiting_escalation' : 'rejected_final';
        if (!hasNextStage) record.decidedAt = Date.now();
        record.currentReviewerUserIds = [];
        record.currentReviewerRoleIds = [];
    });
    await updateAppealMessage(client, appeal);
    await markSanctionAppeal(client, appeal, STATUS_LABELS[appeal.status]);
    if (appeal.status === 'rejected_final') await closeThread(client, appeal);
    return appeal;
}

async function escalateAppeal(client, { guild, applicant, appealId }) {
    let appeal = await fetchAppeal(appealId);
    if (!appeal || String(appeal.guildId) !== String(guild.id)) throw new DisciplineError('Обращение не найдено.', 'appeal_not_found');
    if (String(appeal.applicantId) !== String(applicant.id)) {
        throw new DisciplineError('Передать обращение выше может только заявитель.', 'appeal_escalate_denied');
    }
    if (!['awaiting_escalation', 'routing_failed'].includes(appeal.status)) {
        throw new DisciplineError('Обращение сейчас нельзя передать выше.', 'appeal_escalate_unavailable');
    }
    appeal = await updateAppeal(appealId, (record) => {
        record.history.push({ action: 'escalated', actorId: String(applicant.id), at: Date.now() });
    });
    return routeAppeal(client, guild, appeal, appeal.routeIndex + 1);
}

async function withdrawAppeal(client, { guild, applicant, appealId }) {
    let appeal = await fetchAppeal(appealId);
    if (!appeal || String(appeal.guildId) !== String(guild.id)) throw new DisciplineError('Обращение не найдено.', 'appeal_not_found');
    if (String(appeal.applicantId) !== String(applicant.id)) {
        throw new DisciplineError('Отозвать обращение может только заявитель.', 'appeal_withdraw_denied');
    }
    if (TERMINAL_STATUSES.has(appeal.status)) throw new DisciplineError('Обращение уже закрыто.', 'appeal_already_closed');
    appeal = await resumeDeadline(appeal);
    appeal = await updateAppeal(appealId, (record) => {
        record.status = 'withdrawn';
        record.decidedAt = Date.now();
        record.currentReviewerUserIds = [];
        record.currentReviewerRoleIds = [];
        record.history.push({ action: 'withdrawn', actorId: String(applicant.id), at: record.decidedAt });
    });
    await updateAppealMessage(client, appeal);
    await markSanctionAppeal(client, appeal, STATUS_LABELS[appeal.status]);
    await closeThread(client, appeal);
    return appeal;
}

async function processPendingAppeals(client) {
    const appeals = (readDb().disciplineAppeals || []).filter((appeal) => (
        guildConfigService.isEnabled(appeal.guildId) &&
        (
            appeal.status === 'creating' ||
            appeal.status === 'publication_failed' ||
            appeal.status === 'pending_review' ||
            appeal.status === 'routing_failed'
        )
    ));
    for (const snapshot of appeals) {
        try {
            const guild = await client.guilds.fetch(snapshot.guildId);
            if (snapshot.status === 'creating' || snapshot.status === 'publication_failed') {
                await recoverAppealPublication(client, guild, snapshot);
                continue;
            }
            if (snapshot.status === 'routing_failed') {
                await routeAppeal(client, guild, snapshot, Math.max(0, snapshot.routeIndex + 1));
                continue;
            }
            const stage = snapshot.route[snapshot.routeIndex];
            const excluded = getPreviousReviewerIds(snapshot, snapshot.routeIndex);
            const resolved = await resolveStage(guild, stage, snapshot.applicantId, excluded);
            if (!resolved) {
                const appeal = await resumeDeadline(snapshot);
                await routeAppeal(client, guild, appeal, snapshot.routeIndex + 1);
            }
        } catch (error) {
            logger.error('Не удалось проверить маршрут обжалования взыскания', {
                appealId: snapshot.appealId,
                guildId: snapshot.guildId,
            }, error);
        }
    }
}

module.exports = {
    APPEAL_TYPES,
    approveAppeal,
    buildCuratorRouteStage,
    buildRoute,
    assertAppealsEnabled,
    closeInactiveAppealThreads,
    createAppeal,
    escalateAppeal,
    fetchAppeal,
    findAppealThread,
    findBlockingAppeal,
    getPreviousReviewerIds,
    getAppealFromDb,
    getWorkoffReviewOptions,
    processPendingAppeals,
    recoverAppealPublication,
    rejectAppeal,
    resolveNextStage,
    resolveStage,
    routeAppeal,
    updateAppealMessage,
    withdrawAppeal,
};
