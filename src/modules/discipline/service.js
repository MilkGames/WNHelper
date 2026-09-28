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
const {
    DISCIPLINE_STAGE_LABELS,
    DISCIPLINE_STAGES,
    getDisciplineSettings,
} = require('./settings/schema');
const { getDepartments } = require('../../core/config/departmentSchema');
const { getExams } = require('../examination');
const disciplineCases = require('./database').disciplineCases;
const disciplineRemovalRequests = require('./database').disciplineRemovalRequests;
const guildConfigService = require('../../core/config/guildConfigService');
const { getMemberRankMatches, getRank } = require('../staff-audit');
const {
    closeThreadWithRetry,
    editMessageWithRetry,
    runDiscordRequest,
    sendMessageWithRetry,
    startThreadWithRetry,
} = require('../../core/discord/request');
const { mutateDatabase: mutateDb, readDatabase: readDb } = require('./database');
const logger = require('../../core/logging/logger');
const { invokeAction } = require('../../core/integrations/actionRegistry');
const DisciplineError = require('./error');
const disciplinePolicy = require('./policy');
const targetService = require('./targetService');
const disciplinePresentation = require('./presentation').createDisciplinePresentation({
    findTransferredSanctionLink,
});
const {
    addEmbedMetadata,
    buildCaseComponents,
    buildCaseEmbed,
    buildCombinedSanctionEmbed,
    buildRemovalRequestComponents,
    buildSanctionEmbed,
    formatCaseTargetIdentity,
    formatMemberIdentity,
    getSanctionLabel,
} = disciplinePresentation;

const ACTIVE_SANCTION_STATUSES = new Set(['active', 'dismissal_pending', 'replacement_pending']);
const TERMINAL_CASE_STATUSES = new Set(['completed', 'closed_by_dismissal']);
const TERMINAL_REMOVAL_REQUEST_STATUSES = new Set([
    'approved',
    'rejected',
    'failed',
    'cancelled_by_dismissal',
]);
const memberLocks = new Map();
const MOSCOW_TIME_ZONE = 'Europe/Moscow';

function shortId(prefix, bytes = 6) {
    return `${prefix}-${crypto.randomBytes(bytes).toString('hex')}`;
}

function clone(value) {
    return structuredClone(value);
}

async function fetchThread(client, threadId) {
    if (!client || !threadId) return null;
    const thread = await client.channels.fetch(String(threadId)).catch(() => null);
    return thread?.isThread?.() ? thread : thread || null;
}

async function closeCaseEvidenceThread(client, caseRecord) {
    if (!caseRecord?.evidenceThreadId || caseRecord.batchId || !TERMINAL_CASE_STATUSES.has(caseRecord.status)) {
        return false;
    }
    const thread = await fetchThread(client, caseRecord.evidenceThreadId);
    if (!thread) return false;
    await closeThreadWithRetry(thread, {
        reason: `WN Helper: дисциплинарное дело ${caseRecord.caseId} завершено`,
    });
    return true;
}

async function closeRemovalRequestThread(client, request) {
    if (!request?.threadId || !TERMINAL_REMOVAL_REQUEST_STATUSES.has(request.status)) return false;
    const thread = await fetchThread(client, request.threadId);
    if (!thread) return false;
    await closeThreadWithRetry(thread, {
        reason: `WN Helper: запрос снятия ${request.requestId} завершён`,
    });
    return true;
}

async function closeInactiveDisciplineThreads(client) {
    const db = readDb();
    let closed = 0;
    for (const caseRecord of db.disciplineCases || []) {
        if (await closeCaseEvidenceThread(client, caseRecord).catch((error) => {
            logger.warn('Не удалось закрыть ветку завершённого дисциплинарного дела', {
                caseId: caseRecord.caseId,
                threadId: caseRecord.evidenceThreadId || null,
            }, error);
            return false;
        })) closed += 1;
    }
    for (const request of db.disciplineRemovalRequests || []) {
        if (await closeRemovalRequestThread(client, request).catch((error) => {
            logger.warn('Не удалось закрыть ветку завершённого запроса снятия взыскания', {
                requestId: request.requestId,
                threadId: request.threadId || null,
            }, error);
            return false;
        })) closed += 1;
    }
    return closed;
}

function withMemberLock(guildId, memberId, callback) {
    const key = `${guildId}:${memberId}`;
    const previous = memberLocks.get(key) || Promise.resolve();
    const task = previous.then(callback, callback);
    let tracked;
    tracked = task.finally(() => {
        if (memberLocks.get(key) === tracked) memberLocks.delete(key);
    });
    memberLocks.set(key, tracked);
    return tracked;
}

function assertFeatureEnabled(config) {
    if (!config) throw new DisciplineError('Для этого сервера нет настроек.', 'no_config');
    if (!config.features?.discipline) {
        throw new DisciplineError('Функция "Взыскания" отключена на этом сервере.', 'feature_disabled');
    }
}

function assertMemberHasMainRole(member, config) {
    const roleId = config?.commonRoles?.weazelNewsRoleId;
    if (!roleId) {
        throw new DisciplineError('Основная роль Weazel News не настроена.', 'main_role_not_configured');
    }
    if (!member?.roles?.cache?.has?.(roleId)) {
        throw new DisciplineError(
            'Нельзя оформить взыскание сотруднику без основной роли Weazel News.',
            'target_missing_main_role'
        );
    }
    return true;
}

function assertNoDismissalConflict(guildId, memberId) {
    const guard = require('../staff-audit');
    try {
        return guard.assertNoDismissalConflict(guildId, { memberId });
    } catch (error) {
        throw new DisciplineError(error.userMessage || error.message, error.code || 'dismissal_conflict');
    }
}

function formatDateKey(date) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getMoscowDateKey(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: MOSCOW_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}

function parseViolationDate(value) {
    const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) throw new DisciplineError('Дата нарушения должна быть в формате YYYY-MM-DD.', 'invalid_violation_date');
    const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    const date = new Date(timestamp);
    if (formatDateKey(date) !== `${match[1]}-${match[2]}-${match[3]}`) {
        throw new DisciplineError('Указана несуществующая дата нарушения.', 'invalid_violation_date');
    }
    return { key: formatDateKey(date), timestamp };
}

function validateIssueDate(violationDate, settings) {
    const parsed = parseViolationDate(violationDate);
    const today = parseViolationDate(getMoscowDateKey());
    const todayUtc = today.timestamp;
    if (parsed.timestamp > todayUtc) {
        throw new DisciplineError('Дата нарушения не может быть в будущем.', 'future_violation_date');
    }
    const oldestAllowed = todayUtc - settings.maxIssueDelayDays * 86_400_000;
    if (parsed.timestamp < oldestAllowed) {
        throw new DisciplineError(
            `С момента нарушения прошло больше ${settings.maxIssueDelayDays} дней.`,
            'violation_too_old'
        );
    }
    return parsed.key;
}

async function getTextChannel(client, guildId, channelId, label) {
    if (!channelId) throw new DisciplineError(`${label} не настроен.`, 'channel_not_configured');
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (
        !channel?.isTextBased?.() ||
        !channel.send ||
        channel.isThread?.() ||
        String(channel.guildId) !== String(guildId)
    ) {
        throw new DisciplineError(`${label} недоступен боту.`, 'channel_unavailable');
    }
    return channel;
}

function getMemberDepartmentIds(member, config) {
    if (!member) return [];
    return getDepartments(config)
        .filter((department) => department.roles?.memberRoleId && member.roles.cache.has(department.roles.memberRoleId))
        .map((department) => department.id);
}

function getAvailableMethods(member, config, stage) {
    const settings = getDisciplineSettings(config);
    const departmentIds = new Set(getMemberDepartmentIds(member, config));
    return [
        { id: 'any', name: 'Любой', stages: DISCIPLINE_STAGES, departmentIds: [] },
        ...settings.workoffMethods.filter((method) => (
            method.stages.includes(stage) &&
            (!member || !method.departmentIds.length || method.departmentIds.some((id) => departmentIds.has(id)))
        )),
    ];
}

function resolveMethod(member, config, stage, methodId) {
    const normalizedMethodId = String(methodId || '').trim();
    const methods = getAvailableMethods(member, config, stage);
    const method = methods.find((entry) => entry.id === normalizedMethodId);
    if (!method) {
        throw new DisciplineError(
            `Способ отработки ${normalizedMethodId || 'не указан'} недоступен для этого сотрудника и этапа.`,
            'workoff_method_unavailable'
        );
    }
    return method;
}

function createWorkoffPart({ stage, stageSettings, method, responsibleActorId, sourceSanctionId = null, deadlineAt = null }) {
    if (!stageSettings.workoffEnabled) return null;
    return {
        id: shortId('part'),
        stage,
        sourceSanctionId,
        methodId: method.id,
        methodName: method.name,
        responsibleActorId: String(responsibleActorId),
        deadlineAt: deadlineAt || Date.now() + stageSettings.deadlineDays * 86_400_000,
        status: 'pending',
        createdAt: Date.now(),
        completedAt: null,
        overdueProcessedAt: null,
    };
}

function buildDiscordMessageLink(guildId, channelId, messageId) {
    if (!guildId || !channelId || !messageId) return null;
    return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

function getSanctionMessageLink(caseRecord, sanction) {
    return buildDiscordMessageLink(
        caseRecord?.guildId,
        caseRecord?.channelId,
        sanction?.messageId || caseRecord?.headerMessageId
    );
}

function requireSanctionMessageLink(caseRecord, sanction) {
    const link = getSanctionMessageLink(caseRecord, sanction);
    if (!link) {
        throw new DisciplineError(
            'Не удалось определить ссылку на сообщение взыскания.',
            'sanction_message_link_missing'
        );
    }
    return link;
}

function findTransferredSanctionLink(transferredToSanctionId) {
    if (!transferredToSanctionId) return null;
    const db = readDb();
    for (const caseRecord of db.disciplineCases || []) {
        const sanction = findSanction(caseRecord, transferredToSanctionId);
        if (sanction) return getSanctionMessageLink(caseRecord, sanction);
    }
    return null;
}

function buildSanctionComponents(caseRecord, sanction, { includeExternalLink = false } = {}) {
    const appealsEnabled = getDisciplineSettings(guildConfigService.get(caseRecord?.guildId)).appeals.enabled;
    return disciplinePresentation.buildSanctionComponents(caseRecord, sanction, {
        includeExternalLink,
        appealsEnabled,
    });
}

async function persistCase(caseRecord) {
    await disciplineCases.replaceOne({ caseId: caseRecord.caseId }, caseRecord);
}

async function fetchCase(caseId) {
    const record = await disciplineCases.findOne({ caseId });
    return record ? clone(record) : null;
}

function findSanction(caseRecord, sanctionId) {
    return (caseRecord?.sanctions || []).find((sanction) => sanction.id === sanctionId) || null;
}

function refreshCaseStatus(caseRecord) {
    const statuses = new Set((caseRecord.sanctions || []).map((sanction) => sanction.status));
    if (statuses.has('dismissal_pending')) caseRecord.status = 'dismissal_pending';
    else if (statuses.has('replacement_pending')) caseRecord.status = 'active';
    else if (statuses.has('active')) caseRecord.status = 'active';
    else if (statuses.has('pending')) caseRecord.status = 'processing';
    else if (statuses.has('failed')) caseRecord.status = 'failed';
    else caseRecord.status = 'completed';
    return caseRecord.status;
}

async function updateSanctionMessage(client, caseRecord, sanction, { closeEvidenceThread = true } = {}) {
    if (sanction?.messageId && caseRecord.channelId) {
        const channel = await client.channels.fetch(caseRecord.channelId).catch(() => null);
        const message = await channel?.messages?.fetch?.(sanction.messageId).catch(() => null);
        if (message) {
            await editMessageWithRetry(message, {
                embeds: [caseRecord.sanctions?.length === 1 && caseRecord.headerMessageId === sanction.messageId
                    ? buildCombinedSanctionEmbed(caseRecord, sanction)
                    : buildSanctionEmbed(caseRecord, sanction)],
                components: buildSanctionComponents(caseRecord, sanction, {
                    includeExternalLink: caseRecord.sanctions?.length === 1 && caseRecord.headerMessageId === sanction.messageId,
                }),
                allowedMentions: { parse: [] },
            }).catch((error) => logger.warn('Не удалось обновить сообщение взыскания', {
                caseId: caseRecord.caseId,
                sanctionId: sanction.id,
                messageId: sanction.messageId,
            }, error));
        }
    }
    if (closeEvidenceThread) {
        await closeCaseEvidenceThread(client, caseRecord).catch((error) => {
            logger.warn('Не удалось закрыть ветку завершённого дисциплинарного дела', {
                caseId: caseRecord.caseId,
                threadId: caseRecord.evidenceThreadId || null,
            }, error);
        });
    }
}

async function updateCaseMessages(client, caseRecord) {
    if (!caseRecord) return;
    const channel = caseRecord.channelId
        ? await client.channels.fetch(caseRecord.channelId).catch(() => null)
        : null;
    const header = caseRecord.headerMessageId
        ? await channel?.messages?.fetch?.(caseRecord.headerMessageId).catch(() => null)
        : null;
    const singleSanction = caseRecord.sanctions?.length === 1 ? caseRecord.sanctions[0] : null;
    if (header) {
        await editMessageWithRetry(header, {
            embeds: [singleSanction
                ? buildCombinedSanctionEmbed(caseRecord, singleSanction)
                : buildCaseEmbed(caseRecord)],
            components: singleSanction
                ? buildSanctionComponents(caseRecord, singleSanction, { includeExternalLink: true })
                : buildCaseComponents(caseRecord),
            allowedMentions: { parse: [] },
        }).catch((error) => logger.warn('Не удалось обновить дисциплинарное дело', {
            caseId: caseRecord.caseId,
            messageId: caseRecord.headerMessageId,
        }, error));
    }
    if (!singleSanction) {
        for (const sanction of caseRecord.sanctions || []) {
            await updateSanctionMessage(client, caseRecord, sanction, { closeEvidenceThread: false });
        }
    }
    await closeCaseEvidenceThread(client, caseRecord).catch((error) => {
        logger.warn('Не удалось закрыть ветку завершённого дисциплинарного дела', {
            caseId: caseRecord.caseId,
            threadId: caseRecord.evidenceThreadId || null,
        }, error);
    });
}

function assertExternalLinkAccess(actor, caseRecord, config) {
    if (!canManageSanction(actor, caseRecord, config)) {
        throw new DisciplineError(
            'Привязать Discord может выдавший взыскание или пользователь с ролью подтверждения снятия.',
            'external_link_access_denied'
        );
    }
}

async function getExternalLinkPreview({ guild, actor, caseId, memberId }) {
    const config = guildConfigService.get(guild.id);
    assertFeatureEnabled(config);
    const caseRecord = await fetchCase(caseId);
    if (!caseRecord || String(caseRecord.guildId) !== String(guild.id)) {
        throw new DisciplineError('Дисциплинарное дело не найдено.', 'case_not_found');
    }
    assertExternalLinkAccess(actor, caseRecord, config);

    const requestedMemberId = String(memberId || '');
    const member = await guild.members.fetch(requestedMemberId).catch(() => null);
    if (!member) throw new DisciplineError('Пользователь с таким Discord ID не найден на сервере.', 'external_link_member_missing');
    assertMemberHasMainRole(member, config);

    const isUnlinkedExternal = caseRecord.targetType === 'external' && !caseRecord.memberId && caseRecord.externalTargetId;
    const isLinkedExternal = Boolean(caseRecord.memberId && caseRecord.linkedFromExternalTargetId);
    if (!isUnlinkedExternal && !isLinkedExternal) {
        throw new DisciplineError('Это дисциплинарное дело не является внешней выдачей.', 'external_link_unavailable');
    }
    if (isLinkedExternal && String(caseRecord.memberId) !== requestedMemberId) {
        throw new DisciplineError(
            `Эта внешняя выдача уже привязана к <@${caseRecord.memberId}>.`,
            'external_already_linked_other_member'
        );
    }

    const externalTargetId = String(
        isUnlinkedExternal ? caseRecord.externalTargetId : caseRecord.linkedFromExternalTargetId
    );
    const db = readDb();
    const conflictingExternal = (db.disciplineCases || []).find((entry) => (
        String(entry.guildId) === String(guild.id) &&
        String(entry.memberId || '') === requestedMemberId &&
        entry.linkedFromExternalTargetId &&
        String(entry.linkedFromExternalTargetId) !== externalTargetId
    ));
    if (conflictingExternal) {
        throw new DisciplineError(
            `Этот Discord уже привязан к другой внешней записи (${conflictingExternal.caseId}).`,
            'external_link_conflict'
        );
    }

    const cases = (db.disciplineCases || []).filter((entry) => (
        String(entry.guildId) === String(guild.id) && (
            (!entry.memberId && String(entry.externalTargetId || '') === externalTargetId) ||
            (String(entry.memberId || '') === requestedMemberId &&
                String(entry.linkedFromExternalTargetId || '') === externalTargetId)
        )
    ));
    const sanctions = cases.flatMap((entry) => entry.sanctions || []);
    const snapshot = caseRecord.externalSnapshot || {};
    return {
        caseRecord,
        member,
        externalTargetId,
        displayName: caseRecord.externalDisplayName || snapshot.displayName || caseRecord.memberDisplayName,
        staticId: caseRecord.externalStaticId || snapshot.staticId || caseRecord.memberStaticId,
        alreadyLinked: isLinkedExternal,
        caseCount: cases.length,
        activeSanctionCount: sanctions.filter((sanction) => ACTIVE_SANCTION_STATUSES.has(sanction.status)).length,
        pendingWorkoffCount: sanctions.flatMap((sanction) => sanction.workoffParts || [])
            .filter((part) => part.status === 'pending').length,
        activeRecertificationCount: sanctions.filter((sanction) => (
            sanction.type === 'recertification' && sanction.status === 'active'
        )).length,
    };
}

async function linkExternalTarget(client, { guild, actor, caseId, memberId }) {
    const preview = await getExternalLinkPreview({ guild, actor, caseId, memberId });
    const config = guildConfigService.get(guild.id);
    return withMemberLock(guild.id, `external:${preview.externalTargetId}`, async () => {
        const linked = await mutateDb((db) => {
            const current = (db.disciplineCases || []).find((entry) => entry.caseId === caseId);
            const currentExternalId = current?.externalTargetId || current?.linkedFromExternalTargetId;
            if (!current || String(currentExternalId || '') !== String(preview.externalTargetId)) {
                throw new DisciplineError('Внешняя выдача изменилась. Откройте привязку заново.', 'external_link_state_changed');
            }
            if (current.memberId && String(current.memberId) !== String(preview.member.id)) {
                throw new DisciplineError('Внешняя выдача уже привязана к другому Discord.', 'external_already_linked_other_member');
            }

            const affectedCaseIds = [];
            const affectedRequestIds = [];
            const affectedBatchIds = new Set();
            const now = Date.now();
            for (const caseRecord of db.disciplineCases || []) {
                if (String(caseRecord.guildId) !== String(guild.id)) continue;
                const isUnlinked = !caseRecord.memberId &&
                    String(caseRecord.externalTargetId || '') === String(preview.externalTargetId);
                const isAlreadyLinked = String(caseRecord.memberId || '') === String(preview.member.id) &&
                    String(caseRecord.linkedFromExternalTargetId || '') === String(preview.externalTargetId);
                if (!isUnlinked && !isAlreadyLinked) continue;

                if (!caseRecord.externalSnapshot) {
                    caseRecord.externalSnapshot = {
                        externalTargetId: preview.externalTargetId,
                        displayName: caseRecord.externalDisplayName || caseRecord.memberDisplayName,
                        staticId: caseRecord.externalStaticId || caseRecord.memberStaticId,
                    };
                }
                caseRecord.linkedFromExternalTargetId = preview.externalTargetId;
                caseRecord.targetType = 'member';
                caseRecord.targetKey = `member:${preview.member.id}`;
                caseRecord.memberId = String(preview.member.id);
                caseRecord.memberDisplayName = String(
                    preview.member.displayName || preview.member.user?.username || preview.member.id
                );
                caseRecord.memberStaticId = null;
                caseRecord.externalTargetId = null;
                caseRecord.externalDisplayName = null;
                caseRecord.externalStaticId = null;
                caseRecord.linkedAt ||= now;
                caseRecord.linkedBy ||= String(actor.id);
                caseRecord.updatedAt = now;
                affectedCaseIds.push(caseRecord.caseId);
            }
            for (const request of db.disciplineRemovalRequests || []) {
                if (String(request.guildId) !== String(guild.id)) continue;
                const belongsToExternal = String(request.externalTargetId || '') === String(preview.externalTargetId) ||
                    String(request.linkedFromExternalTargetId || '') === String(preview.externalTargetId);
                if (!belongsToExternal) continue;
                request.memberId = String(preview.member.id);
                request.linkedFromExternalTargetId = preview.externalTargetId;
                request.externalTargetId = null;
                request.linkedAt ||= now;
                request.updatedAt = now;
                affectedRequestIds.push(request.requestId);
            }
            for (const batch of db.massDisciplineBatches || []) {
                if (String(batch.guildId) !== String(guild.id)) continue;
                for (const item of batch.items || []) {
                    const belongsToExternal = String(item.externalTargetId || '') === String(preview.externalTargetId) ||
                        String(item.linkedFromExternalTargetId || '') === String(preview.externalTargetId);
                    if (!belongsToExternal) continue;
                    item.externalSnapshot ||= {
                        externalTargetId: preview.externalTargetId,
                        displayName: item.displayName,
                        staticId: item.staticId || item.externalStaticId || null,
                    };
                    item.memberId = String(preview.member.id);
                    item.targetType = 'member';
                    item.targetKey = `member:${preview.member.id}`;
                    item.linkedFromExternalTargetId = preview.externalTargetId;
                    item.externalTargetId = null;
                    item.staticId = null;
                    item.externalStaticId = null;
                    item.displayName = String(preview.member.displayName || preview.member.user?.username || preview.member.id);
                    affectedBatchIds.add(batch.massdisciplineId);
                }
            }
            return {
                affectedCaseIds: [...new Set(affectedCaseIds)],
                affectedRequestIds: [...new Set(affectedRequestIds)],
                affectedBatchIds: [...affectedBatchIds],
            };
        });

        const warnings = [];
        await syncDisciplineRoles(preview.member, config).catch((error) => {
            warnings.push('Не удалось синхронизировать роли взысканий.');
            logger.warn('Не удалось синхронизировать роли после привязки Discord', {
                guildId: guild.id,
                memberId: preview.member.id,
                externalTargetId: preview.externalTargetId,
            }, error);
        });
        for (const affectedCaseId of linked.affectedCaseIds) {
            const caseRecord = await fetchCase(affectedCaseId);
            if (!caseRecord) continue;
            await updateCaseMessages(client, caseRecord).catch((error) => {
                warnings.push(`Не удалось обновить сообщение дела ${affectedCaseId}.`);
                logger.warn('Не удалось обновить дисциплинарное дело после привязки Discord', {
                    guildId: guild.id,
                    caseId: affectedCaseId,
                    externalTargetId: preview.externalTargetId,
                }, error);
            });
        }
        for (const requestId of linked.affectedRequestIds) {
            const request = await disciplineRemovalRequests.findOne({ requestId });
            if (!request?.messageId || !['creating', 'pending'].includes(request.status)) continue;
            const caseRecord = await fetchCase(request.caseId);
            const sanction = caseRecord && findSanction(caseRecord, request.sanctionId);
            if (!caseRecord || !sanction) continue;
            const selectedPart = request.partId
                ? (sanction.workoffParts || []).find((part) => part.id === request.partId) || null
                : null;
            const requester = await guild.members.fetch(request.requesterId).catch(() => ({
                id: String(request.requesterId),
                displayName: request.requesterDisplayName || String(request.requesterId),
                user: { username: request.requesterDisplayName || String(request.requesterId) },
            }));
            const identities = await resolveRemovalIdentities(guild, requester, caseRecord, sanction);
            const settings = getDisciplineSettings(config);
            const approvalTarget = await resolveRemovalApprovalTarget(guild, config, caseRecord, sanction, settings);
            const channel = await client.channels.fetch(settings.removalChannelId).catch(() => null);
            const message = await channel?.messages?.fetch?.(request.messageId).catch(() => null);
            if (!message) continue;
            const components = buildRemovalRequestComponents(request.requestId);
            await editMessageWithRetry(message, {
                content: approvalTarget.content,
                embeds: [disciplinePresentation.buildRemovalRequestEmbed(
                    request,
                    caseRecord,
                    sanction,
                    identities,
                    {
                        workoffMethods: formatRemovalWorkoffMethods(sanction, selectedPart),
                        sanctionMessageLink: requireSanctionMessageLink(caseRecord, sanction),
                    }
                )],
                components,
                allowedMentions: approvalTarget.allowedMentions,
            }).catch((error) => {
                warnings.push(`Не удалось обновить запрос на снятие ${requestId}.`);
                logger.warn('Не удалось обновить запрос на снятие после привязки Discord', {
                    guildId: guild.id,
                    requestId,
                }, error);
            });
        }
        if (linked.affectedBatchIds.length) {
            for (const batchId of linked.affectedBatchIds) {
                await invokeAction('discipline.refreshBatchMessages', client, batchId).catch((error) => {
                    warnings.push(`Не удалось обновить массовое дело ${batchId}.`);
                    logger.warn('Не удалось обновить массовое дисциплинарное дело после привязки Discord',
                        { guildId: guild.id, batchId, externalTargetId: preview.externalTargetId },
                        error
                    );
                });
            }
        }
        return { ...preview, ...linked, warnings: [...new Set(warnings)] };
    });
}

function normalizeTargetKey(value) {
    const text = String(value || '');
    return text.startsWith('member:') || text.startsWith('external:') ? text : `member:${text}`;
}

function collectActiveReferences(db, guildId, targetKey, type) {
    const normalizedTargetKey = normalizeTargetKey(targetKey);
    const refs = [];
    for (const caseRecord of db.disciplineCases || []) {
        if (String(caseRecord.guildId) !== String(guildId) || !targetService.matchesCaseTarget(caseRecord, normalizedTargetKey)) continue;
        for (const sanction of caseRecord.sanctions || []) {
            if (sanction.type === type && sanction.status === 'active') refs.push({ caseRecord, sanction });
        }
    }
    return refs.sort((left, right) => Number(left.sanction.createdAt) - Number(right.sanction.createdAt));
}

function transferWorkoffParts(sourceRefs, derivedSanction, stageSettings, method, responsibleActorId) {
    const inherited = [];
    for (const ref of sourceRefs) {
        for (const part of ref.sanction.workoffParts || []) {
            if (part.status !== 'pending') continue;
            part.status = 'transferred';
            part.transferredAt = Date.now();
            part.transferredToSanctionId = derivedSanction.id;
            inherited.push({
                ...clone(part),
                id: shortId('part'),
                sourcePartId: part.id,
                sourceSanctionId: ref.sanction.id,
                status: 'pending',
                transferredAt: null,
                transferredToSanctionId: null,
            });
        }
    }
    if (!inherited.length) {
        const part = createWorkoffPart({
            stage: derivedSanction.type,
            stageSettings,
            method,
            responsibleActorId,
        });
        if (part) inherited.push(part);
    }
    derivedSanction.workoffParts = inherited;
}

async function normalizeConversions(client, {
    guildId,
    memberId,
    config,
    responsibleActorId,
    targetMember,
    suppressWorkoff = false,
}) {
    const settings = getDisciplineSettings(config);
    const actions = await mutateDb((db) => {
        const conversions = [];
        for (const [sourceType, targetType] of [['conversation', 'oral'], ['oral', 'written']]) {
            const sourceSettings = settings.stages[sourceType];
            if (sourceType === 'conversation' && !sourceSettings.enabled) continue;
            while (true) {
                const refs = collectActiveReferences(db, guildId, memberId, sourceType);
                if (refs.length < sourceSettings.threshold) break;
                const selected = refs.slice(0, sourceSettings.threshold);
                const primary = selected[0];
                const targetSettings = settings.stages[targetType];
                const method = resolveMethod(targetMember, config, targetType, 'any');
                const derived = {
                    id: shortId('sanction'),
                    type: targetType,
                    status: 'active',
                    issuerId: String(responsibleActorId),
                    responsibleActorId: String(responsibleActorId),
                    createdAt: Date.now(),
                    systemGenerated: true,
                    sourceSanctionIds: selected.map((ref) => ref.sanction.id),
                    workoffParts: [],
                    messageId: primary.sanction.messageId || null,
                };
                if (!suppressWorkoff) {
                    transferWorkoffParts(selected, derived, targetSettings, method, responsibleActorId);
                }
                for (const ref of selected) {
                    ref.sanction.status = 'converted';
                    ref.sanction.convertedAt = Date.now();
                    ref.sanction.conversionTargetId = derived.id;
                    refreshCaseStatus(ref.caseRecord);
                }
                primary.caseRecord.sanctions.push(derived);
                refreshCaseStatus(primary.caseRecord);
                conversions.push({
                    sourceRefs: selected.map((ref) => ({
                        caseId: ref.caseRecord.caseId,
                        sanctionId: ref.sanction.id,
                    })),
                    derivedRef: { caseId: primary.caseRecord.caseId, sanctionId: derived.id },
                });
            }
        }
        return conversions;
    });

    for (const action of actions) {
        for (const ref of action.sourceRefs) {
            const caseRecord = await fetchCase(ref.caseId);
            const sanction = findSanction(caseRecord, ref.sanctionId);
            await updateSanctionMessage(client, caseRecord, sanction);
        }
        const caseRecord = await fetchCase(action.derivedRef.caseId);
        const sanction = findSanction(caseRecord, action.derivedRef.sanctionId);
        await updateSanctionMessage(client, caseRecord, sanction);
    }
    return actions;
}

function getActiveCounts(guildId, targetKey) {
    const db = readDb();
    return Object.fromEntries(DISCIPLINE_STAGES.map((stage) => [
        stage,
        collectActiveReferences(db, guildId, targetKey, stage).length,
    ]));
}

function previewSelectionOutcome(guildId, targetKey, selection, configOrSettings) {
    const settings = configOrSettings?.stages
        ? configOrSettings
        : getDisciplineSettings(configOrSettings);
    const counts = getActiveCounts(guildId, targetKey);
    let explicitDismissal = false;
    for (const item of Array.isArray(selection) ? selection : []) {
        if (DISCIPLINE_STAGES.includes(item.type)) {
            counts[item.type] = (counts[item.type] || 0) + (Number(item.count) || 0);
        } else if (['dismissal', 'dismissal_blacklist'].includes(item.type)) {
            explicitDismissal = true;
        }
    }
    if (settings.stages.conversation.enabled) {
        const converted = Math.floor((counts.conversation || 0) / settings.stages.conversation.threshold);
        counts.conversation = (counts.conversation || 0) % settings.stages.conversation.threshold;
        counts.oral = (counts.oral || 0) + converted;
    }
    const writtenFromOral = Math.floor((counts.oral || 0) / settings.stages.oral.threshold);
    counts.oral = (counts.oral || 0) % settings.stages.oral.threshold;
    counts.written = (counts.written || 0) + writtenFromOral;
    return {
        counts,
        explicitDismissal,
        thresholdDismissal: (counts.written || 0) >= settings.stages.written.threshold,
        willDismiss: explicitDismissal || (counts.written || 0) >= settings.stages.written.threshold,
    };
}

function hasActiveRecertification(guildId, targetKey) {
    const normalizedTargetKey = normalizeTargetKey(targetKey);
    const db = readDb();
    return (db.disciplineCases || []).some((caseRecord) => (
        String(caseRecord.guildId) === String(guildId) &&
        targetService.matchesCaseTarget(caseRecord, normalizedTargetKey) &&
        (caseRecord.sanctions || []).some((sanction) => (
            sanction.type === 'recertification' && sanction.status === 'active'
        ))
    ));
}

function getConfiguredDisciplineRoleIds(settings) {
    return [...new Set([
        ...DISCIPLINE_STAGES.flatMap((stage) => Object.values(settings.stages[stage].roleByCount || {})),
        settings.recertificationRoleId,
    ].filter(Boolean))];
}

async function syncDisciplineRoles(member, config) {
    if (!member) return;
    const settings = getDisciplineSettings(config);
    const counts = getActiveCounts(member.guild.id, member.id);
    const expected = new Set();
    for (const stage of DISCIPLINE_STAGES) {
        const roleId = settings.stages[stage].roleByCount[String(counts[stage])];
        if (roleId) expected.add(roleId);
    }
    if (settings.recertificationRoleId && hasActiveRecertification(member.guild.id, member.id)) {
        expected.add(settings.recertificationRoleId);
    }
    const configured = getConfiguredDisciplineRoleIds(settings);
    const toRemove = configured.filter((roleId) => member.roles.cache.has(roleId) && !expected.has(roleId));
    const toAdd = [...expected].filter((roleId) => !member.roles.cache.has(roleId));
    for (const roleId of [...toRemove, ...toAdd]) {
        const role = member.guild.roles.cache.get(roleId);
        if (!role) throw new DisciplineError(`Роль взыскания ${roleId} не найдена.`, 'discipline_role_missing');
        if (!role.editable) throw new DisciplineError(`Бот не может управлять ролью "${role.name}".`, 'discipline_role_unmanageable');
    }
    if (toRemove.length) await runDiscordRequest(() => member.roles.remove(toRemove, 'WN Helper: синхронизация взысканий'));
    if (toAdd.length) await runDiscordRequest(() => member.roles.add(toAdd, 'WN Helper: синхронизация взысканий'));
}

function getBlockingSanctions(guildId, memberId, config, key) {
    const settings = getDisciplineSettings(config);
    const db = readDb();
    const result = [];
    for (const stage of DISCIPLINE_STAGES) {
        if (!settings.stages[stage][key]) continue;
        result.push(...collectActiveReferences(db, guildId, memberId, stage));
    }
    return result;
}

function assertPromotionAllowed(guildId, memberId, config) {
    const blocking = getBlockingSanctions(guildId, memberId, config, 'blocksPromotion');
    if (blocking.length) {
        throw new DisciplineError(
            `Повышение заблокировано активными взысканиями: ${blocking.map((ref) => DISCIPLINE_STAGE_LABELS[ref.sanction.type]).join(', ')}.`,
            'promotion_blocked_by_discipline'
        );
    }
}

function assertOrdinaryDismissalAllowed(guildId, memberId, config) {
    const blocking = getBlockingSanctions(guildId, memberId, config, 'blocksOrdinaryDismissal');
    if (blocking.length) {
        throw new DisciplineError(
            `Обычное увольнение заблокировано активными взысканиями: ${blocking.map((ref) => DISCIPLINE_STAGE_LABELS[ref.sanction.type]).join(', ')}.`,
            'dismissal_blocked_by_discipline'
        );
    }
}

async function applyConditionalRules(client, { guild, member, config, actor, knownRankNumber }) {
    const settings = getDisciplineSettings(config);
    if (!settings.conditionalRules.length) return [];
    const matches = getMemberRankMatches(member, config);
    if (matches.length > 1) throw new DisciplineError('У сотрудника найдено несколько ролей рангов.', 'target_multiple_ranks');
    let currentRank = matches[0] || (knownRankNumber ? getRank(config, knownRankNumber) : null);
    if (!currentRank) return [];
    const counts = getActiveCounts(guild.id, member.id);
    const applied = [];
    for (const rule of settings.conditionalRules) {
        if (currentRank.number < rule.minRankNumber || counts[rule.stage] < rule.count) continue;
        const sourceRefs = collectActiveReferences(
            readDb(),
            guild.id,
            member.id,
            rule.stage
        ).slice(0, rule.count);
        if (sourceRefs.length !== rule.count) {
            logger.warn('Условное дисциплинарное правило пропущено: недостаточно исходных взысканий', {
                guildId: guild.id,
                memberId: member.id,
                ruleId: rule.id,
                expectedCount: rule.count,
                actualCount: sourceRefs.length,
            });
            continue;
        }
        const sourceSanctionIds = sourceRefs.map((ref) => ref.sanction.id).sort().join(',');
        const sourceLinks = sourceRefs.map((ref) => getSanctionMessageLink(ref.caseRecord, ref.sanction));
        if (sourceLinks.some((link) => !link) || sourceLinks.length !== rule.count) {
            logger.warn('Условное дисциплинарное правило пропущено: не удалось собрать все ссылки на взыскания', {
                guildId: guild.id,
                memberId: member.id,
                ruleId: rule.id,
                expectedCount: rule.count,
                actualLinkCount: sourceLinks.filter(Boolean).length,
                sourceSanctionIds,
            });
            continue;
        }
        const reasonHeader = rule.clause || `${DISCIPLINE_STAGE_LABELS[rule.stage]} × ${rule.count}`;
        const actionReason = [reasonHeader, ...sourceLinks].join('\n').slice(0, 512);

        if (rule.action.type === 'update_roles') {
            const removeRoleIds = (rule.action.removeRoleIds || []).filter((roleId) => member.roles.cache.has(roleId));
            const addRoleIds = (rule.action.addRoleIds || []).filter((roleId) => !member.roles.cache.has(roleId));
            if (!removeRoleIds.length && !addRoleIds.length) continue;
            for (const roleId of [...removeRoleIds, ...addRoleIds]) {
                const role = guild.roles.cache.get(roleId);
                if (!role) throw new DisciplineError(`Роль условного правила ${roleId} не найдена.`, 'conditional_role_missing');
                if (!role.editable) {
                    throw new DisciplineError(`Бот не может управлять ролью "${role.name}".`, 'conditional_role_unmanageable');
                }
            }
            if (removeRoleIds.length) {
                await runDiscordRequest(() => member.roles.remove(
                    removeRoleIds,
                    `WN Helper: условное правило взысканий ${rule.id}. ${actionReason}`.slice(0, 512)
                ));
            }
            if (addRoleIds.length) {
                await runDiscordRequest(() => member.roles.add(
                    addRoleIds,
                    `WN Helper: условное правило взысканий ${rule.id}. ${actionReason}`.slice(0, 512)
                ));
            }
            logger.info('Применено условное правило ролей взысканий', {
                guildId: guild.id,
                memberId: member.id,
                ruleId: rule.id,
                removeRoleIds,
                addRoleIds,
                sourceSanctionIds,
            });
            applied.push(rule.id);
            continue;
        }

        if (currentRank.number === rule.action.rankNumber) continue;
        const staffAuditService = require('../staff-audit');
        const target = await staffAuditService.resolveMemberInput(guild, member.id);
        await staffAuditService.changeRank(client, {
            guild,
            config,
            actor,
            target,
            actionInput: `${currentRank.number}-${rule.action.rankNumber}`,
            reason: [
                `${reasonHeader}:`,
                ...sourceLinks,
            ].join('\n'),
            keepDepartment: true,
            nonceSeed: `disciplineRule:${guild.id}:${member.id}:${rule.id}:${sourceSanctionIds}`,
            currentRankConfirmed: true,
            bypassDisciplinePromotionBlock: true,
        });
        applied.push(rule.id);
        currentRank = getRank(config, rule.action.rankNumber);
    }
    return applied;
}

async function markWrittenThresholdPending(guildId, memberId) {
    return mutateDb((db) => {
        const refs = collectActiveReferences(db, guildId, memberId, 'written');
        if (refs.length < 3) return [];
        const selected = refs.slice(0, 3);
        const touchedCases = new Set();
        for (const ref of selected) {
            ref.sanction.status = 'dismissal_pending';
            touchedCases.add(ref.caseRecord);
        }
        const now = Date.now();
        for (const caseRecord of touchedCases) {
            caseRecord.updatedAt = now;
            refreshCaseStatus(caseRecord);
        }
        return selected.map((ref) => ({ caseId: ref.caseRecord.caseId, sanctionId: ref.sanction.id }));
    });
}

async function triggerThresholdDismissal(client, {
    guild,
    member = null,
    externalTarget = null,
    config,
    actor,
    blacklist = false,
    bypassLimitApproval = false,
}) {
    if (!member && !externalTarget) return null;
    const targetKey = member ? `member:${member.id}` : externalTarget.targetKey;
    const refs = await markWrittenThresholdPending(guild.id, targetKey);
    if (!refs.length) return null;
    const staffAuditService = require('../staff-audit');
    const { assertCanDismissTarget } = require('../staff-audit');
    const target = member
        ? await staffAuditService.resolveMemberInput(guild, member.id)
        : {
            member: null,
            memberId: null,
            displayName: externalTarget.displayName,
            staticId: externalTarget.staticId,
            displayValue: `${externalTarget.displayName} | ${externalTarget.staticId}`,
        };
    let forceApproval = false;
    if (member) {
        try {
            assertCanDismissTarget(actor, member, config, { actionLabel: 'уволить' });
        } catch (error) {
            forceApproval = true;
            logger.warn('Пороговое дисциплинарное увольнение передано на подтверждение', {
                guildId: guild.id,
                memberId: member.id,
                actorId: actor?.id || null,
                reason: error?.userMessage || error?.message || String(error),
            });
        }
    }
    try {
        const triggerRef = refs.at(-1);
        const triggerCase = await fetchCase(triggerRef.caseId);
        const triggerSanction = findSanction(triggerCase, triggerRef.sanctionId);
        const result = await staffAuditService.dismissMember(client, {
            guild,
            config,
            actor,
            target,
            reason: requireSanctionMessageLink(triggerCase, triggerSanction),
            source: blacklist ? 'discipline_threshold_blacklist' : 'discipline_threshold',
            nonceSeed: `disciplineThreshold:${guild.id}:${targetKey}:${refs.map((ref) => ref.sanctionId).sort().join(',')}`,
            bypassActiveDiscipline: true,
            forceApproval,
            executeAsApprover: forceApproval,
            skipInitialHierarchy: !member || forceApproval,
            bypassLimitApproval: bypassLimitApproval === true && !forceApproval,
        });
        await mutateDb((db) => {
            const touchedCases = new Set();
            for (const ref of refs) {
                const caseRecord = (db.disciplineCases || []).find((entry) => entry.caseId === ref.caseId);
                const sanction = caseRecord && findSanction(caseRecord, ref.sanctionId);
                if (!sanction) continue;
                sanction.uvalId = result.operation?.uvalId || null;
                touchedCases.add(caseRecord);
            }
            const now = Date.now();
            for (const caseRecord of touchedCases) {
                caseRecord.updatedAt = now;
                refreshCaseStatus(caseRecord);
            }
        });
        for (const ref of refs) {
            const caseRecord = await fetchCase(ref.caseId);
            const sanction = findSanction(caseRecord, ref.sanctionId);
            await updateSanctionMessage(client, caseRecord, sanction);
        }
        return result;
    } catch (error) {
        await mutateDb((db) => {
            const touchedCases = new Set();
            for (const ref of refs) {
                const caseRecord = (db.disciplineCases || []).find((entry) => entry.caseId === ref.caseId);
                const sanction = caseRecord && findSanction(caseRecord, ref.sanctionId);
                if (!sanction) continue;
                sanction.status = 'active';
                touchedCases.add(caseRecord);
            }
            const now = Date.now();
            for (const caseRecord of touchedCases) {
                caseRecord.updatedAt = now;
                refreshCaseStatus(caseRecord);
            }
        });
        throw error;
    }
}

function validateSanctionSelection(selection, settings) {
    const list = Array.isArray(selection) ? selection : [];
    if (!list.length) throw new DisciplineError('Не выбрана ни одна санкция.', 'sanctions_empty');
    const dismissal = list.filter((item) => ['dismissal', 'dismissal_blacklist'].includes(item.type));
    if (dismissal.length && list.length > 1) {
        throw new DisciplineError('Увольнение нельзя объединять с другими санкциями.', 'dismissal_must_be_exclusive');
    }
    let recertificationCount = 0;
    let demotionCount = 0;
    for (const item of list) {
        if (DISCIPLINE_STAGES.includes(item.type)) {
            if (item.type === 'conversation' && !settings.stages.conversation.enabled) {
                throw new DisciplineError('Беседы отключены в настройках сервера.', 'conversations_disabled');
            }
            if (!Number.isSafeInteger(item.count) || item.count <= 0 || item.count > 10) {
                throw new DisciplineError('Количество взысканий должно быть от 1 до 10.', 'invalid_sanction_count');
            }
            continue;
        }
        if (item.type === 'recertification') recertificationCount += 1;
        else if (item.type === 'demotion') demotionCount += 1;
        else if (!['dismissal', 'dismissal_blacklist'].includes(item.type)) {
            throw new DisciplineError(`Неизвестная санкция: ${item.type}.`, 'unknown_sanction');
        }
    }
    if (recertificationCount > 1) throw new DisciplineError('В одном деле может быть только одна переаттестация.', 'duplicate_recertification');
    if (demotionCount > 1) throw new DisciplineError('В одном деле может быть только одно понижение.', 'duplicate_demotion');
}

function findCaseBySystemSource(guildId, systemSource) {
    const source = systemSource && typeof systemSource === 'object' ? systemSource : null;
    if (!source) return null;
    const expected = {
        type: String(source.type || ''),
        action: String(source.action || ''),
        sourceCaseId: String(source.sourceCaseId || ''),
        sourceSanctionId: String(source.sourceSanctionId || ''),
        sourcePartId: String(source.sourcePartId || ''),
    };
    if (!expected.type || !expected.action || !expected.sourceCaseId) return null;
    return (readDb().disciplineCases || []).find((caseRecord) => (
        String(caseRecord.guildId) === String(guildId) &&
        String(caseRecord.systemSource?.type || '') === expected.type &&
        String(caseRecord.systemSource?.action || '') === expected.action &&
        String(caseRecord.systemSource?.sourceCaseId || '') === expected.sourceCaseId &&
        String(caseRecord.systemSource?.sourceSanctionId || '') === expected.sourceSanctionId &&
        String(caseRecord.systemSource?.sourcePartId || '') === expected.sourcePartId
    )) || null;
}

async function issueCase(client, {
    guild,
    config,
    issuer,
    member = null,
    externalTarget = null,
    violationDate,
    violatedRules,
    reason,
    evidence,
    selection,
    methodAssignments = {},
    currentRankNumber = null,
    demotionRankNumber = null,
    recertificationExamIds = [],
    systemSource = null,
    publicationChannel = null,
    sharedEvidenceThreadId = null,
    suppressEvidenceThread = false,
    suppressTargetPing = false,
    batchId = null,
    dismissalApprovalSatisfied = false,
}) {
    assertFeatureEnabled(config);
    if (!member && !externalTarget) {
        throw new DisciplineError('Не указан сотрудник для взыскания.', 'discipline_target_required');
    }
    if (member) assertMemberHasMainRole(member, config);
    if (!systemSource) {
        disciplinePolicy.assertCanIssueDiscipline(issuer, member, config, {
            externalTarget: !member,
        });
    }
    const normalizedExternalTarget = member ? null : targetService.createExternalTarget({
        guildId: guild.id,
        displayName: externalTarget.displayName,
        staticId: externalTarget.staticId,
        externalTargetId: externalTarget.externalTargetId,
    });
    const targetKey = member ? `member:${member.id}` : normalizedExternalTarget.targetKey;
    const settings = getDisciplineSettings(config);
    const normalizedViolationDate = validateIssueDate(violationDate, settings);
    validateSanctionSelection(selection, settings);
    if (!String(violatedRules || '').trim()) throw new DisciplineError('Не указаны нарушенные пункты.', 'rules_required');
    if (!String(reason || '').trim()) throw new DisciplineError('Не указана причина взыскания.', 'reason_required');
    if (!String(evidence || '').trim()) throw new DisciplineError('Не указаны доказательства.', 'evidence_required');

    const outcome = previewSelectionOutcome(guild.id, targetKey, selection, settings);
    if (outcome.willDismiss) {
        if (member) assertNoDismissalConflict(guild.id, member.id);
        else {
            const guard = require('../staff-audit');
            try {
                guard.assertNoDismissalConflict(guild.id, { staticId: normalizedExternalTarget.staticId });
            } catch (error) {
                throw new DisciplineError(error.userMessage || error.message, error.code || 'dismissal_conflict');
            }
        }
    }
    const recertificationSelected = selection.some((item) => item.type === 'recertification');
    const configuredExams = getExams(config);
    const examIds = Array.from(new Set((Array.isArray(recertificationExamIds) ? recertificationExamIds : [])
        .map(String).filter(Boolean)));
    if (recertificationSelected) {
        if (hasActiveRecertification(guild.id, targetKey)) {
            throw new DisciplineError('У сотрудника уже есть активная переаттестация.', 'recertification_already_active');
        }
        if (!examIds.length) throw new DisciplineError('Для переаттестации нужно выбрать хотя бы один экзамен.', 'recertification_exams_required');
        const knownExamIds = new Set(configuredExams.map((exam) => exam.id));
        const unknown = examIds.find((examId) => !knownExamIds.has(examId));
        if (unknown) throw new DisciplineError(`Экзамен ${unknown} больше не существует.`, 'recertification_exam_missing');
    }

    return withMemberLock(guild.id, targetKey, async () => {
        if (systemSource && typeof systemSource === 'object') {
            const existingCase = findCaseBySystemSource(guild.id, systemSource);
            if (existingCase) {
                return {
                    caseRecord: existingCase,
                    counts: getActiveCounts(guild.id, targetKey),
                    appliedRules: [],
                    thresholdDismissal: null,
                    idempotent: true,
                };
            }
        }
        if (member) assertMemberHasMainRole(member, config);
        const lockedOutcome = previewSelectionOutcome(guild.id, targetKey, selection, settings);
        if (lockedOutcome.willDismiss) {
            if (member) assertNoDismissalConflict(guild.id, member.id);
            else {
                const guard = require('../staff-audit');
                try {
                    guard.assertNoDismissalConflict(guild.id, { staticId: normalizedExternalTarget.staticId });
                } catch (error) {
                    throw new DisciplineError(error.userMessage || error.message, error.code || 'dismissal_conflict');
                }
            }
        }
        if (recertificationSelected && hasActiveRecertification(guild.id, targetKey)) {
            throw new DisciplineError('У сотрудника уже есть активная переаттестация.', 'recertification_already_active');
        }
        const channel = publicationChannel || await getTextChannel(client, guild.id, settings.channelId, 'Канал взысканий');
        const now = Date.now();
        const caseRecord = {
            caseId: shortId('case', 7),
            guildId: String(guild.id),
            targetType: member ? 'member' : 'external',
            targetKey,
            memberId: member ? String(member.id) : null,
            memberDisplayName: member
                ? String(member.displayName || member.user?.username || member.id)
                : normalizedExternalTarget.displayName,
            memberStaticId: member ? null : normalizedExternalTarget.staticId,
            externalTargetId: member ? null : normalizedExternalTarget.externalTargetId,
            externalDisplayName: member ? null : normalizedExternalTarget.displayName,
            externalStaticId: member ? null : normalizedExternalTarget.staticId,
            issuerId: String(issuer.id),
            issuerDisplayName: String(issuer.displayName || issuer.user?.username || issuer.id),
            targetRankNumberAtIssue: currentRankNumber,
            violationDate: normalizedViolationDate,
            violatedRules: String(violatedRules).trim(),
            reason: String(reason).trim(),
            evidence: String(evidence).trim(),
            status: 'active',
            channelId: channel.id,
            headerMessageId: null,
            evidenceThreadId: sharedEvidenceThreadId ? String(sharedEvidenceThreadId) : null,
            batchId: batchId ? String(batchId) : null,
            sanctions: [],
            createdAt: now,
            updatedAt: now,
            systemSource: systemSource && typeof systemSource === 'object' ? {
                type: String(systemSource.type || ''),
                action: String(systemSource.action || ''),
                sourceCaseId: String(systemSource.sourceCaseId || ''),
                sourceSanctionId: String(systemSource.sourceSanctionId || ''),
                sourcePartId: String(systemSource.sourcePartId || ''),
            } : null,
            executionProgress: {},
        };

        for (const item of selection) {
            if (DISCIPLINE_STAGES.includes(item.type)) {
                for (let index = 0; index < item.count; index += 1) {
                    const stageSettings = settings.stages[item.type];
                    const unitKey = `${item.type}-${index + 1}`;
                    const method = lockedOutcome.willDismiss || !stageSettings.workoffEnabled
                        ? null
                        : resolveMethod(member, config, item.type, methodAssignments[unitKey] || 'any');
                    const part = method ? createWorkoffPart({
                        stage: item.type,
                        stageSettings,
                        method,
                        responsibleActorId: issuer.id,
                    }) : null;
                    caseRecord.sanctions.push({
                        id: shortId('sanction'),
                        type: item.type,
                        status: 'active',
                        issuerId: String(issuer.id),
                        issuerDisplayName: String(issuer.displayName || issuer.user?.username || issuer.id),
                        responsibleActorId: String(issuer.id),
                        createdAt: now + index,
                        workoffParts: part ? [part] : [],
                        messageId: null,
                    });
                }
            } else if (item.type === 'demotion') {
                const hasCurrentRank = Number.isSafeInteger(Number(currentRankNumber)) && Number(currentRankNumber) > 0;
                const hasTargetRank = Number.isSafeInteger(Number(demotionRankNumber)) && Number(demotionRankNumber) > 0;
                if (member && (!hasCurrentRank || !hasTargetRank)) {
                    throw new DisciplineError('Для понижения нужно выбрать текущий и новый ранг.', 'demotion_ranks_required');
                }
                if (!member && hasCurrentRank !== hasTargetRank) {
                    throw new DisciplineError(
                        'Для внешнего сотрудника укажите оба ранга либо оформите понижение на один ранг без номеров.',
                        'external_demotion_ranks_incomplete'
                    );
                }
                if (hasCurrentRank && hasTargetRank && Number(demotionRankNumber) >= Number(currentRankNumber)) {
                    throw new DisciplineError('Дисциплинарное понижение должно вести на более низкий ранг.', 'invalid_demotion');
                }
                caseRecord.sanctions.push({
                    id: shortId('sanction'),
                    type: 'demotion',
                    status: 'pending',
                    issuerId: String(issuer.id),
                    issuerDisplayName: String(issuer.displayName || issuer.user?.username || issuer.id),
                    responsibleActorId: String(issuer.id),
                    currentRankNumber: hasCurrentRank ? Number(currentRankNumber) : null,
                    targetRankNumber: hasTargetRank ? Number(demotionRankNumber) : null,
                    executionMode: member ? 'discord_rank_sync' : 'external_record',
                    createdAt: now,
                    workoffParts: [],
                    messageId: null,
                });
            } else if (item.type === 'recertification') {
                const selectedExams = configuredExams.filter((exam) => examIds.includes(exam.id));
                caseRecord.sanctions.push({
                    id: shortId('sanction'),
                    type: 'recertification',
                    status: 'active',
                    issuerId: String(issuer.id),
                    issuerDisplayName: String(issuer.displayName || issuer.user?.username || issuer.id),
                    responsibleActorId: String(issuer.id),
                    createdAt: now,
                    deadlineAt: now + settings.recertificationDeadlineDays * 86_400_000,
                    expiryAction: settings.recertificationExpiryAction,
                    recertificationCycleId: shortId('recert-cycle'),
                    recertificationExams: selectedExams.map((exam) => ({
                        examId: exam.id,
                        examName: exam.name,
                        status: 'pending',
                        attempts: [],
                    })),
                    workoffParts: [],
                    messageId: null,
                });
            } else if (['dismissal', 'dismissal_blacklist'].includes(item.type)) {
                caseRecord.sanctions.push({
                    id: shortId('sanction'),
                    type: item.type,
                    status: 'pending',
                    issuerId: String(issuer.id),
                    issuerDisplayName: String(issuer.displayName || issuer.user?.username || issuer.id),
                    responsibleActorId: String(issuer.id),
                    createdAt: now,
                    workoffParts: [],
                    messageId: null,
                });
            }
        }

        await new disciplineCases(caseRecord).save();
        try {
            const singleSanction = caseRecord.sanctions.length === 1 ? caseRecord.sanctions[0] : null;
            const header = await sendMessageWithRetry(channel, {
                content: suppressTargetPing || !caseRecord.memberId ? '' : `<@${caseRecord.memberId}>`,
                embeds: [singleSanction
                    ? buildCombinedSanctionEmbed(caseRecord, singleSanction)
                    : buildCaseEmbed(caseRecord)],
                components: singleSanction
                    ? buildSanctionComponents(caseRecord, singleSanction, { includeExternalLink: true })
                    : buildCaseComponents(caseRecord),
                allowedMentions: suppressTargetPing || !caseRecord.memberId ? { parse: [] } : { parse: [], users: [caseRecord.memberId] },
            }, { nonceSeed: `disciplineCase:${caseRecord.caseId}` });
            caseRecord.headerMessageId = header.id;
            if (singleSanction) singleSanction.messageId = header.id;
            if (!suppressEvidenceThread) {
                const thread = await startThreadWithRetry(header, {
                    name: `Доказательства ${caseRecord.caseId}`.slice(0, 100),
                    autoArchiveDuration: 1440,
                    reason: `WN Helper: доказательства по делу ${caseRecord.caseId}`,
                });
                caseRecord.evidenceThreadId = thread?.id || null;
                if (thread?.send) {
                    await sendMessageWithRetry(thread, {
                        content: [
                            `**Доказательства по делу ${caseRecord.caseId}**`,
                            caseRecord.evidence,
                        ].join('\n').slice(0, 2000),
                        allowedMentions: { parse: [] },
                    }, { nonceSeed: `disciplineEvidence:${caseRecord.caseId}` });
                }
            }

            if (singleSanction) {
                await editMessageWithRetry(header, {
                    embeds: [buildCombinedSanctionEmbed(caseRecord, singleSanction)],
                    components: buildSanctionComponents(caseRecord, singleSanction, { includeExternalLink: true }),
                    allowedMentions: suppressTargetPing || !caseRecord.memberId ? { parse: [] } : { parse: [], users: [caseRecord.memberId] },
                });
            }

            if (!singleSanction) {
                for (const sanction of caseRecord.sanctions) {
                    const message = await sendMessageWithRetry(channel, {
                        embeds: [buildSanctionEmbed(caseRecord, sanction)],
                        components: buildSanctionComponents(caseRecord, sanction),
                        allowedMentions: { parse: [] },
                    }, { nonceSeed: `disciplineSanction:${caseRecord.caseId}:${sanction.id}` });
                    sanction.messageId = message.id;
                }
            }
            caseRecord.executionProgress ||= {};
            caseRecord.executionProgress.publicationCompletedAt = Date.now();
            caseRecord.updatedAt = Date.now();
            await persistCase(caseRecord);

            for (const sanction of caseRecord.sanctions.filter((entry) => entry.type === 'demotion' && entry.status === 'pending')) {
                if (member) {
                    const staffAuditService = require('../staff-audit');
                    const target = await staffAuditService.resolveMemberInput(guild, member.id);
                    await staffAuditService.changeRank(client, {
                        guild,
                        config,
                        actor: issuer,
                        target,
                        actionInput: `${sanction.currentRankNumber}-${sanction.targetRankNumber}`,
                        reason: `Дисциплинарное дело ${caseRecord.caseId}: ${caseRecord.reason}`,
                        keepDepartment: true,
                        nonceSeed: `disciplineDemotion:${caseRecord.caseId}:${sanction.id}`,
                        currentRankConfirmed: true,
                        bypassDisciplinePromotionBlock: true,
                    });
                }
                sanction.status = 'completed';
                sanction.completedAt = Date.now();
                sanction.executionMode ||= member ? 'discord_rank_sync' : 'external_record';
                refreshCaseStatus(caseRecord);
                await updateSanctionMessage(client, caseRecord, sanction);
            }

            caseRecord.executionProgress.demotionsCompletedAt = Date.now();
            await persistCase(caseRecord);

            for (const sanction of caseRecord.sanctions.filter((entry) => (
                ['dismissal', 'dismissal_blacklist'].includes(entry.type) && entry.status === 'pending'
            ))) {
                const staffAuditService = require('../staff-audit');
                const target = member
                    ? await staffAuditService.resolveMemberInput(guild, member.id)
                    : {
                        member: null,
                        memberId: null,
                        displayName: normalizedExternalTarget.displayName,
                        staticId: normalizedExternalTarget.staticId,
                        displayValue: `${normalizedExternalTarget.displayName} | ${normalizedExternalTarget.staticId}`,
                    };
                const result = await staffAuditService.dismissMember(client, {
                    guild,
                    config,
                    actor: issuer,
                    target,
                    reason: requireSanctionMessageLink(caseRecord, sanction),
                    source: sanction.type === 'dismissal_blacklist' ? 'discipline_blacklist' : 'discipline_direct',
                    nonceSeed: `disciplineDismissal:${caseRecord.caseId}:${sanction.id}`,
                    bypassActiveDiscipline: true,
                    bypassLimitApproval: dismissalApprovalSatisfied === true,
                    skipInitialHierarchy: !member,
                });
                sanction.status = result.status === 'pending_approval' ? 'dismissal_pending' : 'completed';
                sanction.uvalId = result.operation?.uvalId || null;
                refreshCaseStatus(caseRecord);
                await updateSanctionMessage(client, caseRecord, sanction);
            }

            caseRecord.executionProgress.dismissalsCompletedAt = Date.now();
            await persistCase(caseRecord);

            const dismissalSanction = caseRecord.sanctions.find((entry) => (
                ['dismissal', 'dismissal_blacklist'].includes(entry.type)
            ));
            if (dismissalSanction) {
                caseRecord.status = dismissalSanction.status === 'dismissal_pending'
                    ? 'dismissal_pending'
                    : 'completed';
                caseRecord.executionProgress ||= {};
                caseRecord.executionProgress.postProcessingCompletedAt = Date.now();
                caseRecord.lastError = null;
                caseRecord.updatedAt = Date.now();
                await persistCase(caseRecord);
                return {
                    caseRecord: await fetchCase(caseRecord.caseId),
                    counts: getActiveCounts(guild.id, targetKey),
                    appliedRules: [],
                    thresholdDismissal: null,
                };
            }

            await persistCase(caseRecord);
            await normalizeConversions(client, {
                guildId: guild.id,
                memberId: targetKey,
                config,
                responsibleActorId: issuer.id,
                targetMember: member,
                suppressWorkoff: lockedOutcome.willDismiss,
            });
            if (member) await syncDisciplineRoles(member, config);
            const appliedRules = !member || lockedOutcome.thresholdDismissal
                ? []
                : await applyConditionalRules(client, {
                    guild,
                    member,
                    config,
                    actor: issuer,
                    knownRankNumber: currentRankNumber,
                });
            const thresholdDismissal = await triggerThresholdDismissal(client, {
                guild,
                member,
                externalTarget: normalizedExternalTarget,
                config,
                actor: issuer,
                bypassLimitApproval: dismissalApprovalSatisfied === true,
            });
            const completedRecord = await fetchCase(caseRecord.caseId);
            completedRecord.executionProgress ||= {};
            completedRecord.executionProgress.postProcessingCompletedAt = Date.now();
            completedRecord.lastError = null;
            completedRecord.updatedAt = Date.now();
            refreshCaseStatus(completedRecord);
            await persistCase(completedRecord);
            return {
                caseRecord: await fetchCase(caseRecord.caseId),
                counts: getActiveCounts(guild.id, targetKey),
                appliedRules,
                thresholdDismissal,
            };
        } catch (error) {
            caseRecord.status = 'failed';
            caseRecord.lastError = String(error?.stack || error?.message || error);
            caseRecord.updatedAt = Date.now();
            await persistCase(caseRecord);
            const thrown = error instanceof Error ? error : new Error(String(error));
            thrown.disciplineCaseId = caseRecord.caseId;
            thrown.userMessage = `${thrown.userMessage || thrown.message || 'Не удалось оформить взыскание.'}\nID дела: ${caseRecord.caseId}`;
            throw thrown;
        }
    });
}

async function fetchMessageOrNull(channel, messageId) {
    if (!messageId) return null;
    const request = channel?.messages?.fetch?.(String(messageId));
    return request ? request.catch(() => null) : null;
}

async function ensureFailedCasePublication(client, {
    guild,
    caseRecord,
    sharedEvidenceThreadId = null,
    suppressEvidenceThread = false,
    suppressTargetPing = false,
}) {
    const channel = await getTextChannel(client, guild.id, caseRecord.channelId, 'Канал взысканий');
    const singleSanction = caseRecord.sanctions.length === 1 ? caseRecord.sanctions[0] : null;
    let header = await fetchMessageOrNull(channel, caseRecord.headerMessageId);
    if (!header) {
        header = await sendMessageWithRetry(channel, {
            content: suppressTargetPing || !caseRecord.memberId ? '' : `<@${caseRecord.memberId}>`,
            embeds: [singleSanction
                ? buildCombinedSanctionEmbed(caseRecord, singleSanction)
                : buildCaseEmbed(caseRecord)],
            components: singleSanction
                ? buildSanctionComponents(caseRecord, singleSanction, { includeExternalLink: true })
                : buildCaseComponents(caseRecord),
            allowedMentions: suppressTargetPing || !caseRecord.memberId
                ? { parse: [] }
                : { parse: [], users: [caseRecord.memberId] },
        }, { nonceSeed: `disciplineCase:${caseRecord.caseId}` });
        caseRecord.headerMessageId = String(header.id);
    }

    if (singleSanction) {
        singleSanction.messageId = String(header.id);
        await editMessageWithRetry(header, {
            content: suppressTargetPing || !caseRecord.memberId ? '' : `<@${caseRecord.memberId}>`,
            embeds: [buildCombinedSanctionEmbed(caseRecord, singleSanction)],
            components: buildSanctionComponents(caseRecord, singleSanction, { includeExternalLink: true }),
            allowedMentions: suppressTargetPing || !caseRecord.memberId
                ? { parse: [] }
                : { parse: [], users: [caseRecord.memberId] },
        });
    } else {
        await editMessageWithRetry(header, {
            content: suppressTargetPing || !caseRecord.memberId ? '' : `<@${caseRecord.memberId}>`,
            embeds: [buildCaseEmbed(caseRecord)],
            components: buildCaseComponents(caseRecord),
            allowedMentions: suppressTargetPing || !caseRecord.memberId
                ? { parse: [] }
                : { parse: [], users: [caseRecord.memberId] },
        });
        for (const sanction of caseRecord.sanctions || []) {
            let message = await fetchMessageOrNull(channel, sanction.messageId);
            if (!message) {
                message = await sendMessageWithRetry(channel, {
                    embeds: [buildSanctionEmbed(caseRecord, sanction)],
                    components: buildSanctionComponents(caseRecord, sanction),
                    allowedMentions: { parse: [] },
                }, { nonceSeed: `disciplineSanction:${caseRecord.caseId}:${sanction.id}` });
                sanction.messageId = String(message.id);
            } else {
                await editMessageWithRetry(message, {
                    embeds: [buildSanctionEmbed(caseRecord, sanction)],
                    components: buildSanctionComponents(caseRecord, sanction),
                    allowedMentions: { parse: [] },
                });
            }
        }
    }

    if (sharedEvidenceThreadId) caseRecord.evidenceThreadId = String(sharedEvidenceThreadId);
    if (!suppressEvidenceThread && !caseRecord.evidenceThreadId) {
        const thread = await startThreadWithRetry(header, {
            name: `Доказательства ${caseRecord.caseId}`.slice(0, 100),
            autoArchiveDuration: 1440,
            reason: `WN Helper: доказательства по делу ${caseRecord.caseId}`,
        });
        caseRecord.evidenceThreadId = thread?.id || null;
        if (thread?.send) {
            await sendMessageWithRetry(thread, {
                content: [`**Доказательства по делу ${caseRecord.caseId}**`, caseRecord.evidence].join('\n').slice(0, 2000),
                allowedMentions: { parse: [] },
            }, { nonceSeed: `disciplineEvidence:${caseRecord.caseId}` });
        }
    }

    caseRecord.executionProgress ||= {};
    caseRecord.executionProgress.publicationCompletedAt = Date.now();
    caseRecord.lastError = null;
    caseRecord.updatedAt = Date.now();
    await persistCase(caseRecord);
    return { channel, caseRecord };
}

async function resumeFailedCase(client, {
    guild,
    config,
    issuer,
    member = null,
    externalTarget = null,
    caseId,
    sharedEvidenceThreadId = null,
    suppressEvidenceThread = false,
    suppressTargetPing = false,
    dismissalApprovalSatisfied = false,
}) {
    assertFeatureEnabled(config);
    const initial = await fetchCase(caseId);
    if (!initial || String(initial.guildId) !== String(guild.id)) {
        throw new DisciplineError('Частично созданное дисциплинарное дело не найдено.', 'failed_case_not_found');
    }
    const targetKey = targetService.getCaseTargetKey(initial);
    if (!targetKey) throw new DisciplineError('У дела отсутствует идентификатор сотрудника.', 'failed_case_target_missing');

    return withMemberLock(guild.id, targetKey, async () => {
        const caseRecord = await fetchCase(caseId);
        if (!caseRecord) throw new DisciplineError('Частично созданное дисциплинарное дело не найдено.', 'failed_case_not_found');
        if (caseRecord.executionProgress?.postProcessingCompletedAt) {
            return {
                caseRecord,
                counts: getActiveCounts(guild.id, targetKey),
                appliedRules: [],
                thresholdDismissal: null,
            };
        }
        if (member) assertMemberHasMainRole(member, config);
        const normalizedExternalTarget = member ? null : targetService.createExternalTarget({
            guildId: guild.id,
            displayName: externalTarget?.displayName || caseRecord.externalDisplayName || caseRecord.memberDisplayName,
            staticId: externalTarget?.staticId || caseRecord.externalStaticId || caseRecord.memberStaticId,
            externalTargetId: externalTarget?.externalTargetId || caseRecord.externalTargetId,
        });

        try {
            await ensureFailedCasePublication(client, {
                guild,
                caseRecord,
                sharedEvidenceThreadId,
                suppressEvidenceThread,
                suppressTargetPing,
            });

            for (const sanction of caseRecord.sanctions.filter((entry) => entry.type === 'demotion' && entry.status === 'pending')) {
                if (member) {
                    const staffAuditService = require('../staff-audit');
                    const target = await staffAuditService.resolveMemberInput(guild, member.id);
                    await staffAuditService.changeRank(client, {
                        guild,
                        config,
                        actor: issuer,
                        target,
                        actionInput: `${sanction.currentRankNumber}-${sanction.targetRankNumber}`,
                        reason: `Дисциплинарное дело ${caseRecord.caseId}: ${caseRecord.reason}`,
                        keepDepartment: true,
                        nonceSeed: `disciplineDemotion:${caseRecord.caseId}:${sanction.id}`,
                        currentRankConfirmed: true,
                        bypassDisciplinePromotionBlock: true,
                    });
                }
                sanction.status = 'completed';
                sanction.completedAt = Date.now();
                sanction.executionMode ||= member ? 'discord_rank_sync' : 'external_record';
                refreshCaseStatus(caseRecord);
                await persistCase(caseRecord);
                await updateSanctionMessage(client, caseRecord, sanction);
            }
            caseRecord.executionProgress ||= {};
            caseRecord.executionProgress.demotionsCompletedAt = Date.now();
            await persistCase(caseRecord);

            for (const sanction of caseRecord.sanctions.filter((entry) => (
                ['dismissal', 'dismissal_blacklist'].includes(entry.type) && entry.status === 'pending'
            ))) {
                const staffAuditService = require('../staff-audit');
                const target = member
                    ? await staffAuditService.resolveMemberInput(guild, member.id)
                    : {
                        member: null,
                        memberId: null,
                        displayName: normalizedExternalTarget.displayName,
                        staticId: normalizedExternalTarget.staticId,
                        displayValue: `${normalizedExternalTarget.displayName} | ${normalizedExternalTarget.staticId}`,
                    };
                const result = await staffAuditService.dismissMember(client, {
                    guild,
                    config,
                    actor: issuer,
                    target,
                    reason: requireSanctionMessageLink(caseRecord, sanction),
                    source: sanction.type === 'dismissal_blacklist' ? 'discipline_blacklist' : 'discipline_direct',
                    nonceSeed: `disciplineDismissal:${caseRecord.caseId}:${sanction.id}`,
                    bypassActiveDiscipline: true,
                    bypassLimitApproval: dismissalApprovalSatisfied === true,
                    skipInitialHierarchy: !member,
                });
                sanction.status = result.status === 'pending_approval' ? 'dismissal_pending' : 'completed';
                sanction.uvalId = result.operation?.uvalId || null;
                refreshCaseStatus(caseRecord);
                await persistCase(caseRecord);
                await updateSanctionMessage(client, caseRecord, sanction);
            }
            caseRecord.executionProgress.dismissalsCompletedAt = Date.now();
            await persistCase(caseRecord);

            const dismissalSanction = caseRecord.sanctions.find((entry) => (
                ['dismissal', 'dismissal_blacklist'].includes(entry.type)
            ));
            if (dismissalSanction) {
                caseRecord.status = dismissalSanction.status === 'dismissal_pending' ? 'dismissal_pending' : 'completed';
                caseRecord.executionProgress.postProcessingCompletedAt = Date.now();
                caseRecord.lastError = null;
                caseRecord.updatedAt = Date.now();
                await persistCase(caseRecord);
                return {
                    caseRecord: await fetchCase(caseRecord.caseId),
                    counts: getActiveCounts(guild.id, targetKey),
                    appliedRules: [],
                    thresholdDismissal: null,
                };
            }

            await normalizeConversions(client, {
                guildId: guild.id,
                memberId: targetKey,
                config,
                responsibleActorId: issuer.id,
                targetMember: member,
                suppressWorkoff: false,
            });
            if (member) await syncDisciplineRoles(member, config);
            const appliedRules = member
                ? await applyConditionalRules(client, {
                    guild,
                    member,
                    config,
                    actor: issuer,
                    knownRankNumber: caseRecord.targetRankNumberAtIssue,
                })
                : [];
            const thresholdDismissal = await triggerThresholdDismissal(client, {
                guild,
                member,
                externalTarget: normalizedExternalTarget,
                config,
                actor: issuer,
                bypassLimitApproval: dismissalApprovalSatisfied === true,
            });
            const completedRecord = await fetchCase(caseRecord.caseId);
            completedRecord.executionProgress ||= {};
            completedRecord.executionProgress.postProcessingCompletedAt = Date.now();
            completedRecord.lastError = null;
            completedRecord.updatedAt = Date.now();
            refreshCaseStatus(completedRecord);
            await persistCase(completedRecord);
            return {
                caseRecord: await fetchCase(caseRecord.caseId),
                counts: getActiveCounts(guild.id, targetKey),
                appliedRules,
                thresholdDismissal,
            };
        } catch (error) {
            const failed = await fetchCase(caseId) || caseRecord;
            failed.status = 'failed';
            failed.lastError = String(error?.stack || error?.message || error);
            failed.updatedAt = Date.now();
            await persistCase(failed);
            const thrown = error instanceof Error ? error : new Error(String(error));
            thrown.disciplineCaseId = caseId;
            thrown.userMessage = `${thrown.userMessage || thrown.message || 'Не удалось восстановить взыскание.'}\nID дела: ${caseId}`;
            throw thrown;
        }
    });
}

function memberHasAnyRole(member, roleIds) {
    return (Array.isArray(roleIds) ? roleIds : []).some((roleId) => member.roles.cache.has(roleId));
}

function canManageSanction(member, caseRecord, config) {
    const settings = getDisciplineSettings(config);
    if (String(member.id) === String(caseRecord.issuerId)) return true;
    if (!memberHasAnyRole(member, settings.removalApproverRoleIds)) return false;
    return disciplinePolicy.canUseFallbackPermission(member, caseRecord, config);
}

function assertCanManageSanction(member, caseRecord, config) {
    if (!canManageSanction(member, caseRecord, config)) {
        throw new DisciplineError('У вас нет доступа к управлению этим взысканием.', 'sanction_manage_denied');
    }
}

function canRequestRemoval(member, caseRecord, config) {
    const settings = getDisciplineSettings(config);
    return String(member.id) === String(caseRecord.memberId) ||
        String(member.id) === String(caseRecord.issuerId) ||
        memberHasAnyRole(member, settings.removalApproverRoleIds);
}

function assertCanRequestRemoval(member, caseRecord, config) {
    if (!canRequestRemoval(member, caseRecord, config)) {
        throw new DisciplineError(
            'Запросить снятие может сотрудник, инициатор взыскания или подтверждающий.',
            'removal_request_denied'
        );
    }
}

function getPendingParts(sanction) {
    return (sanction?.workoffParts || []).filter((part) => part.status === 'pending');
}

async function changeWorkoffMethod(client, { guild, actor, caseId, sanctionId, partId = null, methodId }) {
    const config = guildConfigService.get(guild.id);
    const caseRecord = await fetchCase(caseId);
    if (!caseRecord || String(caseRecord.guildId) !== String(guild.id)) throw new DisciplineError('Дело не найдено.', 'case_not_found');
    if (!canManageSanction(actor, caseRecord, config)) throw new DisciplineError('У вас нет доступа к изменению способа.', 'method_access_denied');
    const sanction = findSanction(caseRecord, sanctionId);
    if (!sanction || sanction.status !== 'active') throw new DisciplineError('Активное взыскание не найдено.', 'sanction_not_active');
    const pendingParts = getPendingParts(sanction);
    const parts = partId ? pendingParts.filter((entry) => entry.id === partId) : pendingParts;
    if (!parts.length) throw new DisciplineError('Активная часть отработки не найдена.', 'part_not_found');
    const target = caseRecord.memberId
        ? await guild.members.fetch(caseRecord.memberId).catch(() => null)
        : null;
    if (caseRecord.memberId && !target) throw new DisciplineError('Сотрудник не найден на сервере.', 'member_not_found');
    const methods = parts.map((part) => resolveMethod(target, config, part.stage || sanction.type, methodId));
    const changedAt = Date.now();
    parts.forEach((part, index) => {
        part.methodId = methods[index].id;
        part.methodName = methods[index].name;
        part.methodChangedAt = changedAt;
        part.methodChangedBy = actor.id;
    });
    caseRecord.updatedAt = changedAt;
    await persistCase(caseRecord);
    await updateSanctionMessage(client, caseRecord, sanction);
    return { caseRecord, sanction, parts };
}

async function extendWorkoffDeadline(client, { guild, actor, caseId, sanctionId, partId = null, days }) {
    const config = guildConfigService.get(guild.id);
    const caseRecord = await fetchCase(caseId);
    if (!caseRecord || String(caseRecord.guildId) !== String(guild.id)) throw new DisciplineError('Дело не найдено.', 'case_not_found');
    if (!canManageSanction(actor, caseRecord, config)) throw new DisciplineError('У вас нет доступа к продлению срока.', 'deadline_access_denied');
    const sanction = findSanction(caseRecord, sanctionId);
    if (!sanction || sanction.status !== 'active') throw new DisciplineError('Активное взыскание не найдено.', 'sanction_not_active');
    const pendingParts = getPendingParts(sanction);
    const parts = partId ? pendingParts.filter((entry) => entry.id === partId) : pendingParts;
    if (!parts.length) throw new DisciplineError('Активная часть отработки не найдена.', 'part_not_found');
    if (!Number.isSafeInteger(days) || days <= 0 || days > 365) throw new DisciplineError('Продление должно быть от 1 до 365 дней.', 'invalid_extension');
    const changedAt = Date.now();
    for (const part of parts) {
        part.deadlineAt += days * 86_400_000;
        part.deadlineExtendedAt = changedAt;
        part.deadlineExtendedBy = actor.id;
    }
    caseRecord.updatedAt = changedAt;
    await persistCase(caseRecord);
    await updateSanctionMessage(client, caseRecord, sanction);
    return { caseRecord, sanction, parts };
}

function formatRemovalWorkoffMethods(sanction, selectedPart) {
    const parts = selectedPart ? [selectedPart] : getPendingParts(sanction);
    if (!parts.length) return null;
    return parts.map((part, index) => (
        parts.length === 1 ? part.methodName : `${index + 1}. ${part.methodName}`
    )).join('\n').slice(0, 1024);
}

async function resolveRemovalIdentities(guild, requester, caseRecord, sanction) {
    const issuerId = String(sanction.issuerId || caseRecord.issuerId || '');
    const target = caseRecord.memberId
        ? await guild.members.fetch(caseRecord.memberId).catch(() => null)
        : null;
    const issuer = issuerId ? await guild.members.fetch(issuerId).catch(() => null) : null;
    return {
        member: caseRecord.memberId
            ? formatMemberIdentity(caseRecord.memberId, target?.displayName || caseRecord.memberDisplayName)
            : formatCaseTargetIdentity(caseRecord),
        requester: formatMemberIdentity(
            requester.id,
            requester.displayName || requester.user?.username || requester.id
        ),
        issuer: formatMemberIdentity(
            issuerId,
            issuer?.displayName || sanction.issuerDisplayName || caseRecord.issuerDisplayName
        ),
    };
}

async function resolveRemovalApprovalTarget(guild, config, caseRecord, sanction, settings) {
    const issuerId = String(sanction.issuerId || caseRecord.issuerId || '');
    const issuer = issuerId ? await guild.members.fetch(issuerId).catch(() => null) : null;
    const mainRoleId = config.commonRoles?.weazelNewsRoleId || null;
    if (issuer && mainRoleId && issuer.roles.cache.has(mainRoleId)) {
        return {
            primaryApproverId: issuer.id,
            content: `<@${issuer.id}>`,
            allowedMentions: { parse: [], users: [issuer.id] },
        };
    }
    const roleIds = settings.removalApproverRoleIds;
    return {
        primaryApproverId: null,
        content: roleIds.map((roleId) => `<@&${roleId}>`).join(' '),
        allowedMentions: { parse: [], roles: roleIds },
    };
}

async function createRemovalRequest(client, { guild, requester, caseId, sanctionId, partId = null, reason, proof }) {
    const config = guildConfigService.get(guild.id);
    assertFeatureEnabled(config);
    const settings = getDisciplineSettings(config);
    const caseRecord = await fetchCase(caseId);
    if (!caseRecord || String(caseRecord.guildId) !== String(guild.id)) throw new DisciplineError('Дело не найдено.', 'case_not_found');
    assertCanRequestRemoval(requester, caseRecord, config);
    if (!String(reason || '').trim()) throw new DisciplineError('Не указана причина снятия.', 'removal_reason_required');
    if (!String(proof || '').trim()) throw new DisciplineError('Не указаны доказательства снятия.', 'removal_proof_required');
    const sanction = findSanction(caseRecord, sanctionId);
    if (!sanction || sanction.status !== 'active') throw new DisciplineError('Активное взыскание не найдено.', 'sanction_not_active');
    const pendingParts = getPendingParts(sanction);
    const part = partId ? pendingParts.find((entry) => entry.id === partId) : null;
    if (partId && !part) throw new DisciplineError('Часть отработки не найдена.', 'part_not_found');
    const existing = await disciplineRemovalRequests.find({ guildId: String(guild.id), caseId, sanctionId });
    const overlappingRequest = existing.find((entry) => (
        ['creating', 'pending'].includes(entry.status) && (
            !entry.partId ||
            !partId ||
            String(entry.partId) === String(partId)
        )
    ));
    if (overlappingRequest) {
        throw new DisciplineError(
            `Для этого взыскания уже есть активный запрос на снятие ${overlappingRequest.requestId}.`,
            'removal_already_pending'
        );
    }
    const channel = await getTextChannel(client, guild.id, settings.removalChannelId, 'Канал запросов на снятие');
    const approvalTarget = await resolveRemovalApprovalTarget(guild, config, caseRecord, sanction, settings);
    const identities = await resolveRemovalIdentities(guild, requester, caseRecord, sanction);
    const request = {
        requestId: shortId('remove', 7),
        guildId: String(guild.id),
        caseId,
        sanctionId,
        partId,
        requesterId: String(requester.id),
        requesterDisplayName: String(requester.displayName || requester.user?.username || requester.id),
        memberId: caseRecord.memberId ? String(caseRecord.memberId) : null,
        externalTargetId: caseRecord.externalTargetId || null,
        primaryApproverId: approvalTarget.primaryApproverId,
        reason: String(reason || '').trim(),
        proof: String(proof || '').trim(),
        status: 'creating',
        messageId: null,
        threadId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    const components = buildRemovalRequestComponents(request.requestId);
    await new disciplineRemovalRequests(request).save();
    let message = null;
    try {
        message = await sendMessageWithRetry(channel, {
            content: approvalTarget.content,
            embeds: [disciplinePresentation.buildRemovalRequestEmbed(
                request,
                caseRecord,
                sanction,
                identities,
                {
                    workoffMethods: formatRemovalWorkoffMethods(sanction, part),
                    sanctionMessageLink: requireSanctionMessageLink(caseRecord, sanction),
                }
            )],
            components,
            allowedMentions: approvalTarget.allowedMentions,
        }, { nonceSeed: `disciplineRemoval:${request.requestId}` });
        request.messageId = message.id;
        await disciplineRemovalRequests.updateOne({ requestId: request.requestId }, {
            messageId: request.messageId,
            updatedAt: Date.now(),
        });

        const thread = await startThreadWithRetry(message, {
            name: `Снятие ${request.requestId}`.slice(0, 100),
            autoArchiveDuration: 1440,
            reason: `WN Helper: запрос на снятие ${request.requestId}`,
        });
        if (!thread?.id || !thread?.send) {
            throw new DisciplineError('Не удалось создать ветку доказательств снятия.', 'removal_thread_unavailable');
        }
        request.threadId = thread.id;
        await disciplineRemovalRequests.updateOne({ requestId: request.requestId }, {
            threadId: request.threadId,
            updatedAt: Date.now(),
        });
        await sendMessageWithRetry(thread, {
            content: [
                `**Доказательства снятия по запросу ${request.requestId}**`,
                request.proof,
            ].join('\n').slice(0, 2000),
            allowedMentions: { parse: [] },
        }, { nonceSeed: `disciplineRemovalThread:${request.requestId}` });

        request.status = 'pending';
        request.updatedAt = Date.now();
        await disciplineRemovalRequests.updateOne({ requestId: request.requestId }, {
            status: request.status,
            updatedAt: request.updatedAt,
        });
        await editMessageWithRetry(message, {
            content: approvalTarget.content,
            embeds: [disciplinePresentation.buildRemovalRequestEmbed(
                request,
                caseRecord,
                sanction,
                identities,
                {
                    workoffMethods: formatRemovalWorkoffMethods(sanction, part),
                    sanctionMessageLink: requireSanctionMessageLink(caseRecord, sanction),
                }
            )],
            components,
            allowedMentions: approvalTarget.allowedMentions,
        });
        return request;
    } catch (error) {
        const errorText = String(error?.stack || error?.message || error);
        await disciplineRemovalRequests.updateOne({ requestId: request.requestId }, {
            status: 'failed',
            lastError: errorText,
            updatedAt: Date.now(),
        });
        if (message) {
            await editMessageWithRetry(message, {
                content: `Запрос ${request.requestId} не создан из-за ошибки.`,
                components: [],
                allowedMentions: { parse: [] },
            }).catch(() => undefined);
        }
        await closeRemovalRequestThread(client, {
            ...request,
            status: 'failed',
        }).catch((closeError) => {
            logger.warn('Не удалось закрыть ветку неуспешного запроса снятия взыскания', {
                requestId: request.requestId,
                threadId: request.threadId || null,
            }, closeError);
        });
        const thrown = error instanceof Error ? error : new Error(String(error));
        thrown.removalRequestId = request.requestId;
        thrown.userMessage = `${thrown.userMessage || thrown.message || 'Не удалось создать запрос на снятие.'}\nID запроса: ${request.requestId}`;
        throw thrown;
    }
}

async function handleRemovalDecision(client, { guild, approver, requestId, approve, rejectionReason = null, message }) {
    const config = guildConfigService.get(guild.id);
    const settings = getDisciplineSettings(config);
    const request = await disciplineRemovalRequests.findOne({ requestId });
    if (!request || request.status !== 'pending') throw new DisciplineError('Запрос уже обработан или не найден.', 'removal_not_pending');
    const mainRoleId = config.commonRoles?.weazelNewsRoleId || null;
    const primaryApprover = request.primaryApproverId
        ? await guild.members.fetch(request.primaryApproverId).catch(() => null)
        : null;
    const primaryStillEligible = Boolean(
        primaryApprover && mainRoleId && primaryApprover.roles.cache.has(mainRoleId)
    );
    const canApprove = primaryStillEligible
        ? String(approver.id) === String(request.primaryApproverId)
        : memberHasAnyRole(approver, settings.removalApproverRoleIds);
    if (!canApprove) {
        throw new DisciplineError(
            primaryStillEligible
                ? 'Подтвердить этот запрос должен сотрудник, выдавший взыскание.'
                : 'У вас нет роли подтверждения снятия взысканий.',
            'removal_approval_denied'
        );
    }
    const caseRecord = await fetchCase(request.caseId);
    const sanction = findSanction(caseRecord, request.sanctionId);
    if (!caseRecord || !sanction) throw new DisciplineError('Связанное взыскание не найдено.', 'sanction_not_found');
    let decisionMessage = message || null;
    if (!decisionMessage && request.messageId && settings.removalChannelId) {
        const channel = await client.channels.fetch(settings.removalChannelId).catch(() => null);
        decisionMessage = await channel?.messages?.fetch?.(request.messageId).catch(() => null);
    }

    if (!approve) {
        const normalizedReason = String(rejectionReason || '').trim();
        if (!normalizedReason) throw new DisciplineError('Укажите причину отклонения запроса.', 'removal_rejection_reason_required');
        await disciplineRemovalRequests.updateOne({ requestId }, {
            status: 'rejected',
            rejectionReason: normalizedReason,
            decidedBy: approver.id,
            decidedAt: Date.now(),
            updatedAt: Date.now(),
        });
        if (decisionMessage) await editMessageWithRetry(decisionMessage, {
            content: `Отклонено <@${approver.id}>.\n**Причина:** ${normalizedReason}`.slice(0, 2000),
            components: [],
            allowedMentions: { parse: [] },
        });
        await closeRemovalRequestThread(client, { ...request, status: 'rejected' }).catch((error) => {
            logger.warn('Не удалось закрыть ветку отклонённого запроса снятия взыскания', {
                requestId,
                threadId: request.threadId || null,
            }, error);
        });
        return { status: 'rejected', rejectionReason: normalizedReason };
    }

    if (request.partId) {
        const part = (sanction.workoffParts || []).find((entry) => entry.id === request.partId);
        if (!part || part.status !== 'pending') throw new DisciplineError('Часть отработки уже закрыта.', 'part_not_pending');
        part.status = 'completed';
        part.completedAt = Date.now();
        part.completedBy = approver.id;
        if (!(sanction.workoffParts || []).some((entry) => entry.status === 'pending')) {
            sanction.status = 'resolved';
            sanction.resolvedAt = Date.now();
        }
    } else {
        sanction.status = 'resolved';
        sanction.resolvedAt = Date.now();
        for (const part of sanction.workoffParts || []) {
            if (part.status === 'pending') {
                part.status = 'completed';
                part.completedAt = Date.now();
                part.completedBy = approver.id;
            }
        }
    }
    refreshCaseStatus(caseRecord);
    caseRecord.updatedAt = Date.now();
    await persistCase(caseRecord);
    await disciplineRemovalRequests.updateOne({ requestId }, {
        status: 'approved',
        decidedBy: approver.id,
        decidedAt: Date.now(),
        updatedAt: Date.now(),
    });
    if (decisionMessage) await editMessageWithRetry(decisionMessage, {
        content: `Одобрено <@${approver.id}>.`,
        components: [],
        allowedMentions: { parse: [] },
    });
    const member = await guild.members.fetch(caseRecord.memberId).catch(() => null);
    if (member) await syncDisciplineRoles(member, config);
    await updateSanctionMessage(client, caseRecord, sanction);
    await closeRemovalRequestThread(client, { ...request, status: 'approved' }).catch((error) => {
        logger.warn('Не удалось закрыть ветку одобренного запроса снятия взыскания', {
            requestId,
            threadId: request.threadId || null,
        }, error);
    });
    return { status: 'approved', sanction };
}

async function handleUvalRejected(client, guildId, uvalId) {
    const now = Date.now();
    const affected = await mutateDb((db) => {
        const result = [];
        for (const caseRecord of db.disciplineCases || []) {
            if (String(caseRecord.guildId) !== String(guildId)) continue;
            let changed = false;
            for (const sanction of caseRecord.sanctions || []) {
                if (String(sanction.uvalId || '') !== String(uvalId)) continue;
                if (sanction.status !== 'dismissal_pending') continue;

                if (sanction.type === 'written') {
                    sanction.status = 'active';
                    sanction.uvalId = null;
                    sanction.dismissalRejectedAt = now;
                } else if (sanction.type === 'recertification') {
                    sanction.status = 'expired';
                    sanction.uvalId = null;
                    sanction.dismissalRejectedAt = now;
                } else if (['dismissal', 'dismissal_blacklist'].includes(sanction.type)) {
                    sanction.status = 'rejected';
                    sanction.rejectedAt = now;
                    sanction.rejectedUvalId = uvalId;
                }
                changed = true;
                result.push({
                    caseId: caseRecord.caseId,
                    sanctionId: sanction.id,
                    memberId: caseRecord.memberId,
                });
            }
            if (changed) {
                refreshCaseStatus(caseRecord);
                caseRecord.updatedAt = now;
            }
        }
        return result;
    });

    if (!client || !affected.length) return affected;
    const memberIds = new Set();
    for (const ref of affected) {
        const caseRecord = await fetchCase(ref.caseId);
        const sanction = findSanction(caseRecord, ref.sanctionId);
        await updateSanctionMessage(client, caseRecord, sanction);
        memberIds.add(String(ref.memberId));
    }

    const config = guildConfigService.get(guildId);
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    for (const memberId of memberIds) {
        const member = await guild?.members?.fetch?.(memberId).catch(() => null);
        if (member && config) await syncDisciplineRoles(member, config);
    }
    return affected;
}

async function closeMemberDiscipline(client, guildId, memberId) {
    const now = Date.now();
    const affected = await mutateDb((db) => {
        const result = { sanctions: [], requests: [], appeals: [] };
        for (const caseRecord of db.disciplineCases || []) {
            if (String(caseRecord.guildId) !== String(guildId) || String(caseRecord.memberId) !== String(memberId)) continue;
            let active = false;
            for (const sanction of caseRecord.sanctions || []) {
                if (ACTIVE_SANCTION_STATUSES.has(sanction.status)) {
                    sanction.status = 'closed_by_dismissal';
                    sanction.closedAt = now;
                    active = true;
                    result.sanctions.push({ caseId: caseRecord.caseId, sanctionId: sanction.id });
                }
            }
            if (active) {
                caseRecord.status = 'closed_by_dismissal';
                caseRecord.closedAt = now;
                caseRecord.updatedAt = now;
            }
        }
        for (const request of db.disciplineRemovalRequests || []) {
            if (String(request.guildId) !== String(guildId) || String(request.memberId) !== String(memberId)) continue;
            if (request.status === 'pending' || request.status === 'creating') {
                request.status = 'cancelled_by_dismissal';
                request.updatedAt = now;
                result.requests.push({
                    requestId: request.requestId,
                    messageId: request.messageId,
                    threadId: request.threadId || null,
                });
            }
        }
        const caseIds = new Set(
            (db.disciplineCases || [])
                .filter((caseRecord) => (
                    String(caseRecord.guildId) === String(guildId) &&
                    String(caseRecord.memberId) === String(memberId)
                ))
                .map((caseRecord) => String(caseRecord.caseId))
        );
        for (const appeal of db.disciplineAppeals || []) {
            if (String(appeal.guildId) !== String(guildId) || !caseIds.has(String(appeal.caseId))) continue;
            if (['satisfied', 'rejected_final', 'withdrawn', 'cancelled_by_dismissal'].includes(appeal.status)) continue;
            appeal.status = 'cancelled_by_dismissal';
            appeal.decidedAt = now;
            appeal.updatedAt = now;
            appeal.currentReviewerUserIds = [];
            appeal.currentReviewerRoleIds = [];
            appeal.history ||= [];
            appeal.history.push({ action: 'cancelled_by_dismissal', at: now });
            result.appeals.push({ ...appeal });
        }
        return result;
    });

    if (!client) return affected;
    for (const ref of affected.sanctions) {
        const caseRecord = await fetchCase(ref.caseId);
        const sanction = findSanction(caseRecord, ref.sanctionId);
        await updateSanctionMessage(client, caseRecord, sanction);
    }
    const config = guildConfigService.get(guildId);
    const removalChannelId = getDisciplineSettings(config).removalChannelId;
    if (removalChannelId) {
        const channel = await client.channels.fetch(removalChannelId).catch(() => null);
        for (const request of affected.requests) {
            const message = await channel?.messages?.fetch?.(request.messageId).catch(() => null);
            if (message) {
                await editMessageWithRetry(message, {
                    content: 'Запрос закрыт из-за увольнения сотрудника.',
                    components: [],
                    allowedMentions: { parse: [] },
                }).catch(() => undefined);
            }
            await closeRemovalRequestThread(client, {
                ...request,
                status: 'cancelled_by_dismissal',
            }).catch((error) => {
                logger.warn('Не удалось закрыть ветку запроса снятия после увольнения', {
                    requestId: request.requestId,
                    threadId: request.threadId || null,
                }, error);
            });
        }
    }
    if (affected.appeals.length) {
        for (const appeal of affected.appeals) {
            if (appeal.channelId && appeal.messageId) {
                const channel = await client.channels.fetch(appeal.channelId).catch(() => null);
                const message = await channel?.messages?.fetch?.(appeal.messageId).catch(() => null);
                if (message) {
                    await editMessageWithRetry(message, {
                        content: 'Обжалование закрыто из-за увольнения сотрудника.',
                        components: [],
                        allowedMentions: { parse: [] },
                    }).catch(() => undefined);
                }
            }
            if (appeal.threadId) {
                const thread = await client.channels.fetch(appeal.threadId).catch(() => null);
                if (thread) {
                    await closeThreadWithRetry(thread, {
                        reason: `WN Helper: сотрудник ${memberId} уволен`,
                    }).catch(() => undefined);
                }
            }
        }
    }
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    const member = await guild?.members?.fetch?.(memberId).catch(() => null);
    if (member && config) await syncDisciplineRoles(member, config);
    return affected;
}


async function purgeMemberDisciplineHistory(client, guildId, memberId, { updateDiscord = true } = {}) {
    if (updateDiscord) await closeMemberDiscipline(client, guildId, memberId);
    return mutateDb((db) => {
        const caseIds = new Set(
            (db.disciplineCases || [])
                .filter((record) => (
                    String(record.guildId) === String(guildId) &&
                    String(record.memberId) === String(memberId)
                ))
                .map((record) => String(record.caseId))
        );
        const beforeCases = (db.disciplineCases || []).length;
        const beforeAppeals = (db.disciplineAppeals || []).length;
        const beforeRequests = (db.disciplineRemovalRequests || []).length;
        db.disciplineCases = (db.disciplineCases || []).filter((record) => !(
            String(record.guildId) === String(guildId) &&
            String(record.memberId) === String(memberId)
        ));
        db.disciplineAppeals = (db.disciplineAppeals || []).filter((appeal) => !(
            String(appeal.guildId) === String(guildId) &&
            caseIds.has(String(appeal.caseId))
        ));
        db.disciplineRemovalRequests = (db.disciplineRemovalRequests || []).filter((request) => !(
            String(request.guildId) === String(guildId) &&
            (
                String(request.memberId || '') === String(memberId) ||
                caseIds.has(String(request.caseId || ''))
            )
        ));
        return {
            cases: beforeCases - db.disciplineCases.length,
            appeals: beforeAppeals - db.disciplineAppeals.length,
            requests: beforeRequests - db.disciplineRemovalRequests.length,
        };
    });
}

async function closeExternalDiscipline(client, guildId, staticId) {
    const normalizedStaticId = targetService.normalizeStaticId(staticId);
    const now = Date.now();
    const affected = await mutateDb((db) => {
        const result = { sanctions: [], requests: [] };
        const externalTargetIds = new Set();
        for (const caseRecord of db.disciplineCases || []) {
            if (
                String(caseRecord.guildId) !== String(guildId) ||
                caseRecord.memberId ||
                String(caseRecord.externalStaticId || '') !== normalizedStaticId
            ) continue;
            if (caseRecord.externalTargetId) externalTargetIds.add(String(caseRecord.externalTargetId));
            let active = false;
            for (const sanction of caseRecord.sanctions || []) {
                if (ACTIVE_SANCTION_STATUSES.has(sanction.status)) {
                    sanction.status = 'closed_by_dismissal';
                    sanction.closedAt = now;
                    active = true;
                    result.sanctions.push({ caseId: caseRecord.caseId, sanctionId: sanction.id });
                }
            }
            if (active) {
                caseRecord.status = 'closed_by_dismissal';
                caseRecord.closedAt = now;
                caseRecord.updatedAt = now;
            }
        }
        for (const request of db.disciplineRemovalRequests || []) {
            if (String(request.guildId) !== String(guildId)) continue;
            if (!externalTargetIds.has(String(request.externalTargetId || ''))) continue;
            if (request.status === 'pending' || request.status === 'creating') {
                request.status = 'cancelled_by_dismissal';
                request.updatedAt = now;
                result.requests.push({
                    requestId: request.requestId,
                    messageId: request.messageId,
                    threadId: request.threadId || null,
                });
            }
        }
        return result;
    });

    if (!client) return affected;
    for (const ref of affected.sanctions) {
        const caseRecord = await fetchCase(ref.caseId);
        const sanction = findSanction(caseRecord, ref.sanctionId);
        await updateSanctionMessage(client, caseRecord, sanction);
    }
    const config = guildConfigService.get(guildId);
    const removalChannelId = getDisciplineSettings(config).removalChannelId;
    if (removalChannelId) {
        const channel = await client.channels.fetch(removalChannelId).catch(() => null);
        for (const request of affected.requests) {
            const message = await channel?.messages?.fetch?.(request.messageId).catch(() => null);
            if (message) {
                await editMessageWithRetry(message, {
                    content: 'Запрос закрыт из-за увольнения сотрудника.',
                    components: [],
                    allowedMentions: { parse: [] },
                }).catch(() => undefined);
            }
            await closeRemovalRequestThread(client, {
                ...request,
                status: 'cancelled_by_dismissal',
            }).catch((error) => {
                logger.warn('Не удалось закрыть ветку запроса снятия после увольнения', {
                    requestId: request.requestId,
                    threadId: request.threadId || null,
                }, error);
            });
        }
    }
    return affected;
}

function findSystemDisciplineCase({ action, sourceCaseId, sourceSanctionId, sourcePartId }) {
    const db = readDb();
    return (db.disciplineCases || []).find((caseRecord) => (
        caseRecord.systemSource?.type === 'workoff_noncompliance' &&
        caseRecord.systemSource?.action === action &&
        caseRecord.systemSource?.sourceCaseId === sourceCaseId &&
        caseRecord.systemSource?.sourceSanctionId === sourceSanctionId &&
        caseRecord.systemSource?.sourcePartId === sourcePartId
    )) || null;
}

async function issueSystemSanction(client, {
    guild,
    config,
    actor,
    member = null,
    externalTarget = null,
    stage,
    reason,
    sourceCaseId,
    sourceSanctionId,
    sourcePart,
    action,
}) {
    const source = {
        type: 'workoff_noncompliance',
        action,
        sourceCaseId: String(sourceCaseId),
        sourceSanctionId: String(sourceSanctionId),
        sourcePartId: String(sourcePart.id),
    };
    const existing = findSystemDisciplineCase(source);
    if (existing) {
        if (existing.status === 'failed') {
            throw new DisciplineError(
                `Автоматическое взыскание ранее завершилось ошибкой. ID дела: ${existing.caseId}`,
                'system_discipline_failed'
            );
        }
        const existingTargetKey = targetService.getCaseTargetKey(existing);
        return {
            caseRecord: clone(existing),
            counts: existingTargetKey ? getActiveCounts(guild.id, existingTargetKey) : {},
            appliedRules: [],
            thresholdDismissal: null,
            reused: true,
        };
    }
    return issueCase(client, {
        guild,
        config,
        issuer: actor,
        member,
        externalTarget,
        violationDate: getMoscowDateKey(),
        violatedRules: 'Неисполнение дисциплинарного взыскания в установленный срок',
        reason,
        evidence: `Автоматическое действие за просрочку отработки. Исходная часть: ${sourcePart.id}`,
        selection: [{ type: stage, count: 1 }],
        methodAssignments: { [`${stage}-1`]: 'any' },
        currentRankNumber: member ? getMemberRankMatches(member, config)[0]?.number || null : null,
        systemSource: source,
    });
}

async function markOverdueReplacementPending(caseId, sanctionId, action) {
    return mutateDb((db) => {
        const caseRecord = (db.disciplineCases || []).find((entry) => entry.caseId === caseId);
        const sanction = caseRecord && findSanction(caseRecord, sanctionId);
        if (!sanction || !['active', 'replacement_pending'].includes(sanction.status)) return false;
        sanction.status = 'replacement_pending';
        sanction.replacementStartedAt = sanction.replacementStartedAt || Date.now();
        sanction.replacementAction = sanction.replacementAction || String(action || '');
        caseRecord.updatedAt = Date.now();
        refreshCaseStatus(caseRecord);
        return true;
    });
}

async function restoreOverdueReplacement(caseId, sanctionId) {
    await mutateDb((db) => {
        const caseRecord = (db.disciplineCases || []).find((entry) => entry.caseId === caseId);
        const sanction = caseRecord && findSanction(caseRecord, sanctionId);
        if (!sanction || sanction.status !== 'replacement_pending') return;
        sanction.status = 'active';
        sanction.replacementStartedAt = null;
        sanction.replacementAction = null;
        caseRecord.updatedAt = Date.now();
        refreshCaseStatus(caseRecord);
    });
}

async function finalizeOverdueReplacement(client, {
    sourceCaseId,
    sourceSanctionId,
    sourcePartId,
    replacementResult,
}) {
    const replacementCase = replacementResult?.caseRecord || null;
    const replacementSanction = (replacementCase?.sanctions || []).find((entry) => (
        DISCIPLINE_STAGES.includes(entry.type) && entry.status !== 'converted'
    )) || (replacementCase?.sanctions || []).find((entry) => DISCIPLINE_STAGES.includes(entry.type)) || null;
    const sourceCase = await mutateDb((db) => {
        const caseRecord = (db.disciplineCases || []).find((entry) => entry.caseId === sourceCaseId);
        const sanction = caseRecord && findSanction(caseRecord, sourceSanctionId);
        if (!sanction) return null;
        sanction.status = 'replaced_overdue';
        sanction.replacedAt = Date.now();
        sanction.replacementCaseId = replacementCase?.caseId || null;
        sanction.replacementSanctionId = replacementSanction?.id || null;
        sanction.replacementStartedAt = null;
        sanction.replacementAction = null;
        for (const part of sanction.workoffParts || []) {
            if (part.status !== 'pending') continue;
            part.status = 'closed_by_overdue_replacement';
            part.closedAt = Date.now();
            if (part.id === sourcePartId) part.overdueProcessedAt = Date.now();
        }
        caseRecord.updatedAt = Date.now();
        refreshCaseStatus(caseRecord);
        return clone(caseRecord);
    });
    if (sourceCase) {
        const sanction = findSanction(sourceCase, sourceSanctionId);
        await updateSanctionMessage(client, sourceCase, sanction);
    }
    return sourceCase;
}


function findRecertificationExpiryCase({ sourceCaseId, sourceSanctionId, action }) {
    const db = readDb();
    return (db.disciplineCases || []).find((caseRecord) => (
        caseRecord.systemSource?.type === 'recertification_expiry' &&
        caseRecord.systemSource?.sourceCaseId === String(sourceCaseId) &&
        caseRecord.systemSource?.sourceSanctionId === String(sourceSanctionId) &&
        caseRecord.systemSource?.action === String(action)
    )) || null;
}

async function issueRecertificationWritten(client, {
    guild,
    config,
    actor,
    member = null,
    externalTarget = null,
    caseRecord,
    sanction,
}) {
    const source = {
        type: 'recertification_expiry',
        action: 'add_written',
        sourceCaseId: String(caseRecord.caseId),
        sourceSanctionId: String(sanction.id),
    };
    const existing = findRecertificationExpiryCase(source);
    if (existing) return { caseRecord: clone(existing), reused: true };
    return issueCase(client, {
        guild,
        config,
        issuer: actor,
        member,
        externalTarget,
        violationDate: getMoscowDateKey(),
        violatedRules: 'Непрохождение переаттестации в установленный срок',
        reason: `Просрочена переаттестация по делу ${caseRecord.caseId}.`,
        evidence: `Автоматическое действие по просрочке переаттестации ${sanction.id}.`,
        selection: [{ type: 'written', count: 1 }],
        methodAssignments: { 'written-1': 'any' },
        currentRankNumber: member ? getMemberRankMatches(member, config)[0]?.number || null : null,
        systemSource: source,
    });
}

async function executeRecertificationDismissal(client, {
    guild,
    config,
    actor,
    member = null,
    externalTarget = null,
    caseRecord,
    sanction,
    blacklist,
}) {
    const staffAuditService = require('../staff-audit');
    const guard = require('../staff-audit');
    const conflictTarget = member
        ? { memberId: member.id }
        : { staticId: externalTarget?.staticId };
    const conflict = guard.findDismissalConflict(guild.id, conflictTarget);
    if (conflict) {
        return {
            status: conflict.operation.status === 'pending_approval' ? 'pending_approval' : 'existing',
            operation: conflict.operation,
            reused: true,
        };
    }
    const target = member
        ? await staffAuditService.resolveMemberInput(guild, member.id)
        : {
            member: null,
            memberId: null,
            displayName: externalTarget.displayName,
            staticId: externalTarget.staticId,
            displayValue: `${externalTarget.displayName} | ${externalTarget.staticId}`,
        };
    let forceApproval = !actor;
    if (actor && member) {
        try {
            guard.assertCanDismissTarget(actor, member, config, { actionLabel: 'уволить' });
        } catch (error) {
            forceApproval = true;
            logger.warn('Увольнение за просрочку переаттестации передано на подтверждение', {
                guildId: guild.id,
                memberId: member.id,
                actorId: actor.id,
                caseId: caseRecord.caseId,
                sanctionId: sanction.id,
                reason: error?.userMessage || error?.message || String(error),
            });
        }
    }
    const responsible = actor || {
        id: String(sanction.responsibleActorId || sanction.issuerId || caseRecord.issuerId),
        roles: { cache: { has: () => false } },
    };
    return staffAuditService.dismissMember(client, {
        guild,
        config,
        actor: responsible,
        target,
        reason: requireSanctionMessageLink(caseRecord, sanction),
        source: blacklist
            ? 'discipline_recertification_expiry_blacklist'
            : 'discipline_recertification_expiry',
        nonceSeed: `recertification:expiry:${caseRecord.caseId}:${sanction.id}`,
        bypassActiveDiscipline: true,
        forceApproval,
        executeAsApprover: forceApproval,
        skipInitialHierarchy: !member || forceApproval,
    });
}

async function finalizeRecertificationExpiry(client, {
    guild,
    config,
    caseId,
    sanctionId,
    action,
    actionResult = null,
}) {
    const updated = await mutateDb((db) => {
        const caseRecord = (db.disciplineCases || []).find((entry) => entry.caseId === caseId);
        const sanction = caseRecord && findSanction(caseRecord, sanctionId);
        if (!caseRecord || !sanction) return null;
        const now = Date.now();
        sanction.recertificationAction = action;
        sanction.recertificationActionProcessedAt = now;
        sanction.uvalId = actionResult?.operation?.uvalId || sanction.uvalId || null;
        if (sanction.status !== 'closed_by_dismissal') {
            if (action === 'dismiss' || action === 'dismiss_blacklist') {
                sanction.status = actionResult?.status === 'pending_approval' || actionResult?.status === 'existing'
                    ? 'dismissal_pending'
                    : 'completed';
            } else {
                sanction.status = 'expired';
            }
        }
        sanction.expiredAt = now;
        caseRecord.updatedAt = now;
        refreshCaseStatus(caseRecord);
        return { caseRecord: clone(caseRecord), sanction: clone(sanction) };
    });
    if (!updated) return null;
    const member = await guild.members.fetch(updated.caseRecord.memberId).catch(() => null);
    if (member) await syncDisciplineRoles(member, config);
    await updateSanctionMessage(client, updated.caseRecord, updated.sanction);
    return updated;
}

async function processRecertificationExpiry(client, {
    guild,
    config,
    caseRecord,
    sanction,
}) {
    const settings = getDisciplineSettings(config);
    const action = sanction.expiryAction || settings.recertificationExpiryAction;
    if (sanction.recertificationActionProcessedAt) return null;
    const member = caseRecord.memberId
        ? await guild.members.fetch(caseRecord.memberId).catch(() => null)
        : null;
    if (caseRecord.memberId && !member) {
        throw new DisciplineError('Сотрудник переаттестации не найден на сервере.', 'recertification_member_missing');
    }
    const externalTarget = member ? null : targetService.targetFromCase(caseRecord);
    const actorId = sanction.responsibleActorId || sanction.issuerId || caseRecord.issuerId;
    const actor = actorId ? await guild.members.fetch(actorId).catch(() => null) : null;
    let actionResult = null;
    if (action === 'add_written') {
        if (!actor) {
            throw new DisciplineError('Не удалось определить ответственного за взыскание по переаттестации.', 'recertification_actor_missing');
        }
        actionResult = await issueRecertificationWritten(client, {
            guild,
            config,
            actor,
            member,
            externalTarget,
            caseRecord,
            sanction,
        });
    } else if (action === 'dismiss' || action === 'dismiss_blacklist') {
        actionResult = await executeRecertificationDismissal(client, {
            guild,
            config,
            actor,
            member,
            externalTarget,
            caseRecord,
            sanction,
            blacklist: action === 'dismiss_blacklist',
        });
    }
    return finalizeRecertificationExpiry(client, {
        guild,
        config,
        caseId: caseRecord.caseId,
        sanctionId: sanction.id,
        action,
        actionResult,
    });
}

async function recordRecertificationExamResult(client, {
    guild,
    memberId,
    examId,
    passed,
    examinerId = null,
    sourceMessageId = null,
    messageLink = null,
}) {
    const config = guildConfigService.get(guild.id);
    if (!config?.features?.discipline) return null;
    const result = await withMemberLock(guild.id, memberId, async () => mutateDb((db) => {
        const cases = (db.disciplineCases || [])
            .filter((caseRecord) => (
                String(caseRecord.guildId) === String(guild.id) &&
                String(caseRecord.memberId) === String(memberId)
            ))
            .sort((left, right) => Number(right.createdAt) - Number(left.createdAt));
        for (const caseRecord of cases) {
            const sanction = (caseRecord.sanctions || []).find((entry) => (
                entry.type === 'recertification' &&
                entry.status === 'active' &&
                (entry.recertificationExams || []).some((exam) => exam.examId === String(examId))
            ));
            if (!sanction) continue;
            const exam = sanction.recertificationExams.find((entry) => entry.examId === String(examId));
            const dedupeKey = sourceMessageId ? String(sourceMessageId) : null;
            if (dedupeKey && (exam.attempts || []).some((attempt) => attempt.sourceMessageId === dedupeKey)) {
                return {
                    duplicate: true,
                    caseRecord: clone(caseRecord),
                    sanction: clone(sanction),
                };
            }
            const now = Date.now();
            exam.attempts = Array.isArray(exam.attempts) ? exam.attempts : [];
            exam.attempts.push({
                passed: passed === true,
                examinerId: examinerId ? String(examinerId) : null,
                sourceMessageId: dedupeKey,
                messageLink: messageLink ? String(messageLink) : null,
                createdAt: now,
            });
            exam.status = passed === true ? 'passed' : 'failed';
            exam.lastResultAt = now;
            if (passed === true && sanction.recertificationExams.every((entry) => entry.status === 'passed')) {
                sanction.status = 'completed';
                sanction.completedAt = now;
            }
            caseRecord.updatedAt = now;
            refreshCaseStatus(caseRecord);
            return { duplicate: false, caseRecord: clone(caseRecord), sanction: clone(sanction) };
        }
        return null;
    }));
    if (!result) return null;
    const member = await guild.members.fetch(memberId).catch(() => null);
    if (member) await syncDisciplineRoles(member, config);
    await updateSanctionMessage(client, result.caseRecord, result.sanction);
    return result;
}

function calculatePauseExtension(startAt, endAt, otherActivePauseStartedAt = null) {
    const start = Number(startAt);
    const end = Number(endAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
    const fullDuration = end - start;
    if (otherActivePauseStartedAt === null || otherActivePauseStartedAt === undefined || otherActivePauseStartedAt === '') {
        return fullDuration;
    }
    const otherStart = Number(otherActivePauseStartedAt);
    if (!Number.isFinite(otherStart) || otherStart >= end) return fullDuration;
    const overlapStartedAt = Math.max(start, otherStart);
    return Math.max(0, fullDuration - (end - overlapStartedAt));
}

function getFinitePauseTimestamp(value) {
    if (value === null || value === undefined || value === '') return null;
    const timestamp = Number(value);
    return Number.isFinite(timestamp) ? timestamp : null;
}

function startWorkoffDeadlinePause(part, reason, pauseId, startedAt) {
    if (!part || part.status !== 'pending') return false;
    const start = getFinitePauseTimestamp(startedAt);
    if (start === null) return false;
    const idField = reason === 'appeal' ? 'appealPauseId' : 'vacationPauseId';
    const startedAtField = reason === 'appeal' ? 'appealPauseStartedAt' : 'vacationPauseStartedAt';
    if (part[idField] && String(part[idField]) !== String(pauseId || '')) return false;

    const currentReasonStart = getFinitePauseTimestamp(part[startedAtField]);
    part[startedAtField] = currentReasonStart === null ? start : currentReasonStart;
    part[idField] = String(pauseId || '');

    const starts = [
        getFinitePauseTimestamp(part.deadlinePauseStartedAt),
        getFinitePauseTimestamp(part.vacationPauseStartedAt),
        getFinitePauseTimestamp(part.appealPauseStartedAt),
    ].filter((value) => value !== null);
    part.deadlinePauseStartedAt = Math.min(...starts);
    return true;
}

function finishWorkoffDeadlinePause(part, reason, pauseId, endedAt, { shiftDeadline = true } = {}) {
    if (!part) return { changed: false, extension: 0 };
    const idField = reason === 'appeal' ? 'appealPauseId' : 'vacationPauseId';
    const startedAtField = reason === 'appeal' ? 'appealPauseStartedAt' : 'vacationPauseStartedAt';
    if (!part[startedAtField]) return { changed: false, extension: 0 };
    if (pauseId && String(part[idField] || '') !== String(pauseId)) return { changed: false, extension: 0 };

    const ended = getFinitePauseTimestamp(endedAt);
    const reasonStarted = getFinitePauseTimestamp(part[startedAtField]);
    const unifiedStarted = getFinitePauseTimestamp(part.deadlinePauseStartedAt);
    const start = unifiedStarted ?? reasonStarted;

    part[startedAtField] = null;
    part[idField] = null;

    const otherStartedAt = reason === 'appeal'
        ? getFinitePauseTimestamp(part.vacationPauseStartedAt)
        : getFinitePauseTimestamp(part.appealPauseStartedAt);
    if (otherStartedAt !== null) {
        const candidates = [start, otherStartedAt].filter((value) => value !== null);
        part.deadlinePauseStartedAt = Math.min(...candidates);
        return { changed: true, extension: 0 };
    }

    const extension = shiftDeadline && start !== null && ended !== null && ended > start
        ? ended - start
        : 0;
    if (extension > 0 && Number.isFinite(Number(part.deadlineAt))) {
        part.deadlineAt = Number(part.deadlineAt) + extension;
    }
    part.deadlinePauseStartedAt = null;
    return { changed: true, extension };
}

async function setMemberVacationPause(client, guildId, memberId, { vacationId, paused, effectiveAt = Date.now() }) {
    const now = Date.now();
    const effectAt = Number.isFinite(Number(effectiveAt)) ? Number(effectiveAt) : now;
    const affectedCaseIds = await mutateDb((db) => {
        const result = [];
        for (const caseRecord of db.disciplineCases || []) {
            if (String(caseRecord.guildId) !== String(guildId)) continue;
            if (String(caseRecord.memberId || '') !== String(memberId)) continue;
            if (caseRecord.status !== 'active') continue;
            let changed = false;
            for (const sanction of caseRecord.sanctions || []) {
                if (!['active', 'replacement_pending'].includes(sanction.status)) continue;
                if (paused) {
                    if (!sanction.vacationPauseStartedAt && ['conversation', 'recertification'].includes(sanction.type)) {
                        sanction.vacationPauseStartedAt = effectAt;
                        sanction.vacationPauseId = String(vacationId || '');
                        changed = true;
                    }
                    for (const part of sanction.workoffParts || []) {
                        if (startWorkoffDeadlinePause(part, 'vacation', vacationId, effectAt)) changed = true;
                    }
                } else {
                    if (
                        sanction.vacationPauseStartedAt &&
                        (!vacationId || String(sanction.vacationPauseId || '') === String(vacationId))
                    ) {
                        const duration = Math.max(0, effectAt - Number(sanction.vacationPauseStartedAt));
                        if (sanction.type === 'conversation') {
                            sanction.autoExpiryPausedMs = Number(sanction.autoExpiryPausedMs || 0) + duration;
                        } else if (sanction.type === 'recertification' && Number.isFinite(Number(sanction.deadlineAt))) {
                            sanction.deadlineAt = Number(sanction.deadlineAt) + duration;
                        }
                        sanction.vacationPauseStartedAt = null;
                        sanction.vacationPauseId = null;
                        changed = true;
                    }
                    for (const part of sanction.workoffParts || []) {
                        const result = finishWorkoffDeadlinePause(
                            part,
                            'vacation',
                            vacationId,
                            effectAt
                        );
                        if (result.changed) changed = true;
                    }
                }
            }
            if (changed) {
                caseRecord.updatedAt = now;
                result.push(caseRecord.caseId);
            }
        }
        return result;
    });

    for (const caseId of affectedCaseIds) {
        const caseRecord = await fetchCase(caseId);
        if (!caseRecord) continue;
        for (const sanction of caseRecord.sanctions || []) {
            await updateSanctionMessage(client, caseRecord, sanction).catch((error) => {
                logger.warn('Не удалось обновить сообщение взыскания после изменения паузы отпуска', {
                    guildId,
                    memberId,
                    caseId,
                    sanctionId: sanction.id,
                }, error);
            });
        }
    }
    return affectedCaseIds.length;
}

async function processDeadlines(client) {
    const db = readDb();
    const now = Date.now();
    const jobs = [];
    for (const caseRecord of db.disciplineCases || []) {
        if (caseRecord.status !== 'active') continue;
        const config = guildConfigService.get(caseRecord.guildId);
        if (!config?.features?.discipline) continue;
        const settings = getDisciplineSettings(config);
        for (const sanction of caseRecord.sanctions || []) {
            if (!['active', 'replacement_pending'].includes(sanction.status)) continue;
            if (
                sanction.status === 'active' &&
                sanction.type === 'conversation' &&
                settings.stages.conversation.enabled &&
                settings.stages.conversation.autoExpireEnabled &&
                !sanction.vacationPauseStartedAt &&
                Number(sanction.createdAt) + Number(sanction.autoExpiryPausedMs || 0) + settings.stages.conversation.autoExpireDays * 86_400_000 <= now
            ) {
                jobs.push({ type: 'expire', caseId: caseRecord.caseId, sanctionId: sanction.id });
            }
            if (
                sanction.status === 'active' &&
                sanction.type === 'recertification' &&
                !sanction.recertificationActionProcessedAt &&
                !sanction.vacationPauseStartedAt &&
                Number(sanction.deadlineAt) <= now
            ) {
                jobs.push({ type: 'recertification_expiry', caseId: caseRecord.caseId, sanctionId: sanction.id });
            }
            for (const part of sanction.workoffParts || []) {
                const partStageSettings = settings.stages[part.stage] || settings.stages[sanction.type];
                if (!partStageSettings) continue;
                if (part.status === 'pending' && !part.overdueProcessedAt && !part.vacationPauseStartedAt && !part.appealPauseStartedAt && Number(part.deadlineAt) <= now) {
                    jobs.push({
                        type: 'overdue',
                        caseId: caseRecord.caseId,
                        sanctionId: sanction.id,
                        partId: part.id,
                        action: caseRecord.systemSource?.type === 'workoff_noncompliance' && sanction.type === 'written'
                            ? settings.noncomplianceOverdueAction
                            : sanction.status === 'replacement_pending' && sanction.replacementAction
                                ? sanction.replacementAction
                                : partStageSettings.overdueAction,
                        actorId: part.responsibleActorId || sanction.responsibleActorId || caseRecord.issuerId,
                    });
                }
            }
        }
    }

    for (const job of jobs) {
        try {
            const caseRecord = await fetchCase(job.caseId);
            if (!caseRecord) continue;
            const config = guildConfigService.get(caseRecord.guildId);
            const guild = await client.guilds.fetch(caseRecord.guildId);
            const member = caseRecord.memberId
                ? await guild.members.fetch(caseRecord.memberId).catch(() => null)
                : null;
            if (caseRecord.memberId && !member) continue;
            const externalTarget = member ? null : targetService.targetFromCase(caseRecord);
            const sanction = findSanction(caseRecord, job.sanctionId);
            if (!sanction || !['active', 'replacement_pending'].includes(sanction.status)) continue;
            if (job.type === 'recertification_expiry') {
                await processRecertificationExpiry(client, {
                    guild,
                    config,
                    caseRecord,
                    sanction,
                });
                continue;
            }
            if (job.type === 'expire') {
                sanction.status = 'expired';
                sanction.expiredAt = Date.now();
                caseRecord.updatedAt = Date.now();
                await persistCase(caseRecord);
                if (member) await syncDisciplineRoles(member, config);
                await updateSanctionMessage(client, caseRecord, sanction);
                continue;
            }
            const part = (sanction.workoffParts || []).find((entry) => entry.id === job.partId);
            if (!part || part.status !== 'pending' || part.overdueProcessedAt) continue;
            if (job.action === 'none') {
                part.overdueProcessedAt = Date.now();
                caseRecord.updatedAt = Date.now();
                await persistCase(caseRecord);
                continue;
            }
            const responsibleActor = await guild.members.fetch(job.actorId).catch(() => null);
            let overdueUvalId = null;
            const isAddAction = job.action === 'add_oral' || job.action === 'add_written';
            const isReplaceAction = job.action === 'replace_oral' || job.action === 'replace_written';
            if (isAddAction || isReplaceAction) {
                if (!responsibleActor) {
                    logger.warn('Не удалось выдать взыскание за просрочку: ответственный отсутствует', job);
                    continue;
                }
                if (isReplaceAction) {
                    const marked = await markOverdueReplacementPending(caseRecord.caseId, sanction.id, job.action);
                    if (!marked) continue;
                }
                let replacementResult;
                try {
                    replacementResult = await issueSystemSanction(client, {
                        guild,
                        config,
                        actor: responsibleActor,
                        member,
                        externalTarget,
                        stage: job.action.endsWith('oral') ? 'oral' : 'written',
                        reason: isReplaceAction
                            ? `Взыскание ${sanction.id} заменено из-за просрочки отработки.`
                            : `Просрочена отработка взыскания ${sanction.id}.`,
                        sourceCaseId: caseRecord.caseId,
                        sourceSanctionId: sanction.id,
                        sourcePart: part,
                        action: job.action,
                    });
                } catch (error) {
                    if (isReplaceAction) await restoreOverdueReplacement(caseRecord.caseId, sanction.id);
                    throw error;
                }
                if (isReplaceAction) {
                    await finalizeOverdueReplacement(client, {
                        sourceCaseId: caseRecord.caseId,
                        sourceSanctionId: sanction.id,
                        sourcePartId: part.id,
                        replacementResult,
                    });
                }
            } else {
                const staffAuditService = require('../staff-audit');
                const { assertCanDismissTarget } = require('../staff-audit');
                const target = member
                    ? await staffAuditService.resolveMemberInput(guild, member.id)
                    : {
                        member: null,
                        memberId: null,
                        displayName: externalTarget.displayName,
                        staticId: externalTarget.staticId,
                        displayValue: `${externalTarget.displayName} | ${externalTarget.staticId}`,
                    };
                let forceApproval = !responsibleActor;
                if (responsibleActor && member) {
                    try {
                        assertCanDismissTarget(responsibleActor, member, config, { actionLabel: 'уволить' });
                    } catch (error) {
                        forceApproval = true;
                        logger.warn('Автоматическое увольнение за просрочку передано на подтверждение', {
                            ...job,
                            reason: error?.userMessage || error?.message || String(error),
                        });
                    }
                }
                const actor = responsibleActor || {
                    id: String(job.actorId),
                    roles: { cache: { has: () => false } },
                };
                const dismissalResult = await staffAuditService.dismissMember(client, {
                    guild,
                    config,
                    actor,
                    target,
                    reason: requireSanctionMessageLink(caseRecord, sanction),
                    source: job.action === 'dismiss_blacklist' ? 'discipline_overdue_blacklist' : 'discipline_overdue',
                    nonceSeed: `disciplineOverdue:${caseRecord.caseId}:${sanction.id}:${part.id}`,
                    bypassActiveDiscipline: true,
                    forceApproval,
                    executeAsApprover: forceApproval,
                    skipInitialHierarchy: !member || forceApproval,
                });
                overdueUvalId = dismissalResult.operation?.uvalId || null;
            }
            const latest = await fetchCase(job.caseId);
            const latestSanction = findSanction(latest, job.sanctionId);
            const latestPart = (latestSanction?.workoffParts || []).find((entry) => entry.id === job.partId);
            if (latestPart && !latestPart.overdueProcessedAt) {
                latestPart.overdueProcessedAt = Date.now();
                latestPart.overdueUvalId = overdueUvalId;
                latest.updatedAt = Date.now();
                await persistCase(latest);
            }
        } catch (error) {
            logger.error('Ошибка фоновой обработки взысканий', job, error);
        }
    }
}

module.exports = {
    ACTIVE_SANCTION_STATUSES,
    DisciplineError,
    assertCanManageSanction,
    assertCanRequestRemoval,
    assertFeatureEnabled,
    assertMemberHasMainRole,
    assertNoDismissalConflict,
    assertOrdinaryDismissalAllowed,
    assertPromotionAllowed,
    calculatePauseExtension,
    finishWorkoffDeadlinePause,
    buildSanctionComponents,
    changeWorkoffMethod,
    closeInactiveDisciplineThreads,
    closeExternalDiscipline,
    closeMemberDiscipline,
    purgeMemberDisciplineHistory,
    createRemovalRequest,
    extendWorkoffDeadline,
    fetchCase,
    findSanction,
    getSanctionLabel,
    getSanctionMessageLink,
    getActiveCounts,
    getAvailableMethods,
    getExternalLinkPreview,
    getPendingParts,
    handleRemovalDecision,
    handleUvalRejected,
    issueCase,
    findCaseBySystemSource,
    linkExternalTarget,
    previewSelectionOutcome,
    persistCase,
    processDeadlines,
    refreshCaseStatus,
    recordRecertificationExamResult,
    resumeFailedCase,
    syncDisciplineRoles,
    updateSanctionMessage,
    setMemberVacationPause,
    startWorkoffDeadlinePause,
    validateIssueDate,
};
