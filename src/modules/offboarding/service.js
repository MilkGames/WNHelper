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
const staffAudit = require('../staff-audit');
const {
    buildApprovalComponents,
    buildApprovalEmbed,
    buildCustomId,
} = require('./presentation');
const { getStaffAuditSettings, StaffAuditError } = staffAudit;
const uvalOperations = require('./database').uvalOperations;
const giveRoles = require('../give-roles');
const guildConfigService = require('../../core/config/guildConfigService');
const {
    assertCanDismissTarget,
    buildMemberStateHash,
    canApproveDismissal,
    reserveDismissal,
} = staffAudit;
const { scheduleGuildChannelCounterUpdate } = require('../channel-counters');
const { scheduleGuildStaffListUpdate } = require('../staff-lists');
const shifts = require('../shifts');
const { scheduleGuildShiftSync } = shifts;
const {
    editMessageWithRetry,
    runDiscordRequest,
    sendMessageWithRetry,
} = require('../../core/discord/request');
const { mutateDatabase: mutateDb } = require('./database');
const { invokeAction } = require('../../core/integrations/actionRegistry');
const logger = require('../../core/logging/logger');

function createApprovalGroupId() {
    return typeof crypto.randomUUID === 'function'
        ? `uval-group-${crypto.randomUUID()}`
        : `uval-group-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function stripDepartmentPrefix(displayName) {
    const source = String(displayName || '').trim();
    const parts = source.split('|').map((part) => part.trim()).filter(Boolean);
    if (parts.length >= 3) return parts.slice(1).join(' | ');
    return source;
}

async function updateOperation(uvalId, patch) {
    return uvalOperations.updateOne(
        { uvalId },
        { ...patch, updatedAt: Date.now() }
    );
}

function calculateBatchStatus(items) {
    const list = Array.isArray(items) ? items : [];
    if (list.some((item) => item.status === 'failed')) return 'partially_completed';
    if (list.some((item) => item.status === 'approved')) return 'partially_completed';
    if (list.some((item) => item.status === 'pending_approval')) return 'awaiting_approvals';
    if (list.some((item) => ['rejected', 'skipped_state_changed', 'cancelled_by_dismissal'].includes(item.status))) {
        return 'completed_with_issues';
    }
    if (list.every((item) => item.status === 'completed')) return 'completed';
    return 'processing';
}

async function updateLinkedBatchItems(uvalId, patch) {
    const now = Date.now();
    await mutateDb((db) => {
        for (const batch of db.staffAuditBatches || []) {
            let changed = false;
            for (const item of batch.items || []) {
                if (String(item.uvalId || '') !== String(uvalId)) continue;
                Object.assign(item, patch, { processedAt: now });
                changed = true;
            }
            if (changed) {
                batch.status = calculateBatchStatus(batch.items);
                batch.updatedAt = now;
            }
        }
    });
}

async function closeOtherPendingBatchItems(guildId, memberId, uvalId) {
    if (!memberId) return;
    const now = Date.now();
    await mutateDb((db) => {
        for (const batch of db.staffAuditBatches || []) {
            if (String(batch.guildId) !== String(guildId)) continue;
            let changed = false;
            for (const item of batch.items || []) {
                if (String(item.memberId || '') !== String(memberId)) continue;
                if (String(item.uvalId || '') === String(uvalId)) continue;
                if (!['pending', 'failed', 'pending_approval'].includes(item.status)) continue;
                item.status = 'cancelled_by_dismissal';
                item.error = 'Операция отменена: сотрудник уволен.';
                item.processedAt = now;
                changed = true;
            }
            if (changed) {
                batch.status = calculateBatchStatus(batch.items);
                batch.updatedAt = now;
            }
        }
    });
}

async function completeStep(operation, step, callback) {
    if (Array.isArray(operation.completedSteps) && operation.completedSteps.includes(step)) return;
    await callback();
    operation.completedSteps = [...new Set([...(operation.completedSteps || []), step])];
    await updateOperation(operation.uvalId, { completedSteps: operation.completedSteps });
}

async function closeGiveRolesRequests(client, guildId, memberId) {
    return giveRoles.closeMemberRequests(client, guildId, memberId);
}

async function releaseMemberShifts(client, guildId, memberId, uvalId) {
    return shifts.releaseMemberFromSchedules(client, guildId, memberId, {
        reason: `dismissal:${uvalId}`,
    });
}

async function closeMemberQueues(guildId, memberId) {
    const examination = require('../examination');
    await examination.closeMemberQueueJobs(guildId, memberId);
    await examination.closeMemberAttempts(guildId, memberId);
}

function getRolesToRemove(member, config) {
    const settings = getStaffAuditSettings(config);
    const keep = new Set(settings.dismissalKeepRoleIds);
    const roles = [];

    for (const role of member.roles.cache.values()) {
        if (role.id === member.guild.id || role.managed || keep.has(role.id)) continue;
        if (!role.editable) {
            throw new StaffAuditError(
                `Бот не может снять роль "${role.name}" (${role.id}).`,
                'role_not_editable'
            );
        }
        roles.push(role);
    }
    return roles;
}

async function removeMemberRoles(member, config, reason) {
    if (!member) return;
    const roles = getRolesToRemove(member, config);
    if (!member.manageable) {
        throw new StaffAuditError('Бот не может изменить никнейм этого сотрудника.', 'member_not_manageable');
    }

    if (roles.length) {
        await runDiscordRequest(() => member.roles.remove(
            roles,
            `WN Helper: увольнение (${reason})`
        ));
    }

    await runDiscordRequest(() => member.setNickname(stripDepartmentPrefix(member.displayName)));
}

async function acknowledgeSourceMessage(client, operation) {
    const sourceAck = operation?.sourceAck;
    if (!sourceAck?.channelId || !sourceAck?.messageId) return;

    try {
        const channel = await client.channels.fetch(sourceAck.channelId);
        const message = await channel?.messages?.fetch?.(sourceAck.messageId);
        if (message) {
            await runDiscordRequest(() => message.react(sourceAck.emoji || '✅'));
        }
    } catch (error) {
        logger.warn('Не удалось отметить исходное сообщение после увольнения', {
            uvalId: operation.uvalId,
            channelId: sourceAck.channelId,
            messageId: sourceAck.messageId,
        }, error);
    }
}

async function sendPendingApprovalRequests(client, { uvalIds, config = null }) {
    const requestedIds = [...new Set((Array.isArray(uvalIds) ? uvalIds : []).map(String).filter(Boolean))];
    const operations = [];
    for (const uvalId of requestedIds) {
        const operation = await uvalOperations.findOne({ uvalId });
        if (!operation || operation.status !== 'pending_approval' || operation.approvalMessageId) continue;
        if (!operation.targetMemberId) continue;
        operations.push(operation);
    }
    if (!operations.length) return null;

    const guildId = String(operations[0].guildId);
    const actorId = String(operations[0].actorId);
    if (operations.some((operation) => (
        String(operation.guildId) !== guildId || String(operation.actorId) !== actorId
    ))) {
        throw new StaffAuditError(
            'Нельзя объединить подтверждения увольнений разных серверов или исполнителей.',
            'dismissal_approval_group_mismatch'
        );
    }

    const resolvedConfig = config || guildConfigService.get(guildId);
    const settings = getStaffAuditSettings(resolvedConfig);
    if (!settings.dismissalApprovalChannelId || !settings.dismissalApprovalRoleIds.length) {
        for (const operation of operations) {
            await updateOperation(operation.uvalId, { status: 'blocked_no_approval_config' });
        }
        throw new StaffAuditError(
            'Лимит увольнений исчерпан, но канал или роли подтверждения не настроены.',
            'dismissal_approval_not_configured'
        );
    }

    const channel = await client.channels.fetch(settings.dismissalApprovalChannelId).catch(() => null);
    if (!channel?.isTextBased?.() || !channel.send) {
        throw new StaffAuditError('Канал подтверждения увольнений недоступен.', 'approval_channel_unavailable');
    }

    const rolesMention = settings.dismissalApprovalRoleIds.map((roleId) => `<@&${roleId}>`).join(' ');
    const approvalKey = operations.length > 1 ? createApprovalGroupId() : operations[0].uvalId;
    const embed = buildApprovalEmbed(operations);

    const components = buildApprovalComponents(approvalKey);

    const message = await sendMessageWithRetry(channel, {
        content: rolesMention,
        embeds: [embed],
        components,
        allowedMentions: { parse: [], roles: settings.dismissalApprovalRoleIds },
    }, {
        nonceSeed: `uvalApproval:${approvalKey}`,
    });

    const operationIds = new Set(operations.map((operation) => String(operation.uvalId)));
    const now = Date.now();
    await mutateDb((db) => {
        for (const operation of db.uvalOperations || []) {
            if (!operationIds.has(String(operation.uvalId))) continue;
            if (operation.status !== 'pending_approval' || operation.approvalMessageId) continue;
            operation.approvalGroupId = operations.length > 1 ? approvalKey : null;
            operation.approvalMessageId = String(message.id);
            operation.approvalChannelId = String(message.channelId);
            operation.updatedAt = now;
        }
    });
    return message;
}

async function executeOperation(client, operation, { approver = null } = {}) {
    const current = await uvalOperations.findOne({ uvalId: operation.uvalId });
    if (!current) throw new StaffAuditError('Операция увольнения не найдена.', 'operation_not_found');
    if (current.status === 'completed') return { status: 'completed', operation: current };
    if (!['reserved', 'approved', 'processing', 'failed'].includes(current.status)) {
        throw new StaffAuditError('Операция увольнения не готова к выполнению.', 'operation_not_executable');
    }

    const config = guildConfigService.get(current.guildId);
    if (!config) throw new StaffAuditError('Настройки сервера не найдены.', 'no_config');
    const guild = await client.guilds.fetch(current.guildId);
    const effectiveActorId = current.executeAsApprover && current.requiresApproval
        ? (approver?.id || current.approvedBy || null)
        : current.actorId;
    let actor = effectiveActorId
        ? await guild.members.fetch(effectiveActorId).catch(() => null)
        : null;
    const member = current.targetMemberId
        ? await guild.members.fetch(current.targetMemberId).catch(() => null)
        : null;

    if (!actor && !current.targetMemberId && effectiveActorId) {
        actor = {
            id: String(effectiveActorId),
            displayName: `Discord ID ${effectiveActorId}`,
            toString: () => `<@${effectiveActorId}>`,
        };
    }
    if (!actor) {
        throw new StaffAuditError(
            current.executeAsApprover
                ? 'Подтверждающий увольнение больше не находится на сервере.'
                : 'Исполнитель увольнения больше не находится на сервере.',
            current.executeAsApprover ? 'approver_missing' : 'actor_missing'
        );
    }
    if (
        member &&
        current.expectedTargetStateHash &&
        current.status !== 'failed' &&
        !(current.completedSteps || []).length &&
        buildMemberStateHash(member) !== current.expectedTargetStateHash
    ) {
        await updateOperation(current.uvalId, {
            status: 'cancelled_state_changed',
            cancelledAt: Date.now(),
        });
        await updateLinkedBatchItems(current.uvalId, {
            status: 'skipped_state_changed',
            error: 'Состояние сотрудника изменилось после предпросмотра.',
        });
        const error = new StaffAuditError(
            'Состояние сотрудника изменилось после предпросмотра. Создайте новый пакет.',
            'target_state_changed'
        );
        error.batchItemStatus = 'skipped_state_changed';
        throw error;
    }
    if (member) {
        assertCanDismissTarget(actor, member, config, {
            savedTargetRankNumber: current.status === 'failed' ? current.targetRankNumber : null,
            actionLabel: 'уволить',
        });
        if (!current.bypassActiveDiscipline) {
            await invokeAction('discipline.assertOrdinaryDismissalAllowed', guild.id, member.id, config);
        }
    }

    const target = {
        member,
        memberId: current.targetMemberId,
        displayName: member?.displayName || current.targetDisplayName,
        staticId: current.targetStaticId,
        displayValue: member ? `${member}` : current.targetDisplayName,
    };

    await updateOperation(current.uvalId, {
        status: 'processing',
        approvedBy: approver?.id || current.approvedBy || null,
    });
    current.status = 'processing';

    try {
        await completeStep(current, 'give_roles', () => closeGiveRolesRequests(client, guild.id, target.memberId, config));
        await completeStep(current, 'exam_queue', () => closeMemberQueues(guild.id, target.memberId));
        await completeStep(current, 'examination_requests', async () => {
            if (!target.memberId) return;
            const examination = require('../examination');
            await examination.closeMemberRequests(client, guild.id, target.memberId);
        });
        await completeStep(current, 'vacations', async () => {
            if (!target.memberId) return;
            const vacations = require('../vacations');
            await vacations.closeMemberVacations(client, guild.id, target.memberId);
        });
        await completeStep(current, 'shifts', () => releaseMemberShifts(
            client,
            guild.id,
            target.memberId,
            current.uvalId
        ));
        await completeStep(current, 'discipline', async () => {
            if (target.memberId) {
                await invokeAction('discipline.closeMemberDiscipline', client, guild.id, target.memberId);
                return;
            }
            if (target.staticId) {
                await invokeAction('discipline.closeExternalDiscipline', client, guild.id, target.staticId);
            }
        });
        await completeStep(current, 'roles', () => removeMemberRoles(member, config, current.reason));
        await completeStep(current, 'audit_record', async () => {
            await invokeAction('staff-audit.sendDismissalRecord', client, {
                guildId: guild.id,
                config,
                actor,
                target,
                reason: current.reason,
                nonceSeed: current.nonceSeed,
            });
        });
        await completeStep(current, 'source_ack', () => acknowledgeSourceMessage(client, current));
        await completeStep(current, 'pending_batches', () => closeOtherPendingBatchItems(
            guild.id,
            target.memberId,
            current.uvalId
        ));
        await completeStep(current, 'discipline_history', async () => {
            if (!target.memberId) return;
            await invokeAction('discipline.purgeMemberDisciplineHistory', client, guild.id, target.memberId, {
                updateDiscord: false,
            });
        });
        await completeStep(current, 'refresh', async () => {
            scheduleGuildStaffListUpdate(client, guild.id, { reason: `uvalApproval:${current.uvalId}` });
            scheduleGuildChannelCounterUpdate(client, guild.id, { reason: `uvalApproval:${current.uvalId}` });
            scheduleGuildShiftSync(client, guild.id, { reason: `uvalApproval:${current.uvalId}` });
        });

        const completedAt = Date.now();
        await updateOperation(current.uvalId, {
            status: 'completed',
            completedAt,
        });
        await updateLinkedBatchItems(current.uvalId, {
            status: 'completed',
            error: null,
        });
        return { status: 'completed', operation: { ...current, status: 'completed' }, target };
    } catch (error) {
        const thrown = error instanceof Error ? error : new Error(String(error));
        const errorText = String(thrown.stack || thrown.message || thrown);
        await updateOperation(current.uvalId, {
            status: 'failed',
            lastError: errorText,
        });
        await updateLinkedBatchItems(current.uvalId, {
            status: 'failed',
            error: thrown.userMessage || thrown.message || String(thrown),
        });
        thrown.uvalId = current.uvalId;
        thrown.userMessage = thrown.userMessage
            ? `${thrown.userMessage}
ID увольнения для повторного запуска: ${current.uvalId}`
            : `Увольнение выполнено не полностью. Повторите операцию через ` +
              `/manualtools retry_uval. ID: ${current.uvalId}`;
        throw thrown;
    }
}

async function requestDismissal(client, {
    guild,
    config,
    actor,
    target,
    reason,
    source = 'slash_uval',
    nonceSeed,
    sourceAck = null,
    expectedTargetStateHash = null,
    bypassActiveDiscipline = false,
    forceApproval = false,
    executeAsApprover = false,
    skipInitialHierarchy = false,
    bypassLimitApproval = false,
    deferApprovalRequest = false,
}) {
    if (target.member && !bypassActiveDiscipline) {
        await invokeAction('discipline.assertOrdinaryDismissalAllowed', guild.id, target.member.id, config);
    }
    const hierarchy = target.member && !skipInitialHierarchy
        ? assertCanDismissTarget(actor, target.member, config, { actionLabel: 'уволить' })
        : null;

    const operation = await reserveDismissal({
        guildId: guild.id,
        actor,
        target,
        config,
        source,
        reason,
        nonceSeed,
        hierarchy,
        sourceAck,
        expectedTargetStateHash,
        bypassActiveDiscipline,
        forceApproval,
        executeAsApprover,
        bypassLimitApproval,
    });

    if (operation.requiresApproval) {
        if (deferApprovalRequest) {
            return { status: 'pending_approval', operation, approvalMessage: null };
        }
        const message = await sendPendingApprovalRequests(client, {
            uvalIds: [operation.uvalId],
            config,
        });
        return { status: 'pending_approval', operation, approvalMessage: message };
    }

    return executeOperation(client, operation);
}

async function handleApprovalInteraction(client, interaction, action, approvalKey) {
    const directOperation = await uvalOperations.findOne({ uvalId: approvalKey });
    const operations = directOperation?.status === 'pending_approval'
        ? [directOperation]
        : (await uvalOperations.find({ approvalGroupId: approvalKey }))
            .filter((operation) => operation.status === 'pending_approval');
    if (!operations.length) {
        throw new StaffAuditError('Запрос уже обработан или не найден.', 'approval_not_pending');
    }

    const config = guildConfigService.get(interaction.guildId);
    const guild = interaction.guild || await client.guilds.fetch(interaction.guildId);
    const approver = await guild.members.fetch(interaction.user.id);
    if (!canApproveDismissal(approver, config)) {
        throw new StaffAuditError('У вас нет роли подтверждения увольнений.', 'approval_access_denied');
    }
    if (operations.some((operation) => String(operation.actorId) === String(approver.id))) {
        throw new StaffAuditError('Нельзя подтвердить собственное увольнение сверх лимита.', 'self_approval_denied');
    }

    if (action === 'reject') {
        for (const operation of operations) {
            await updateOperation(operation.uvalId, {
                status: 'rejected',
                rejectedBy: approver.id,
                rejectedAt: Date.now(),
            });
            await updateLinkedBatchItems(operation.uvalId, {
                status: 'rejected',
                error: 'Увольнение отклонено подтверждающим.',
            });
            await invokeAction('discipline.handleUvalRejected', client, interaction.guildId, operation.uvalId);
        }
        await editMessageWithRetry(interaction.message, { components: [] });
        return { status: 'rejected', count: operations.length };
    }

    for (const operation of operations) {
        await updateOperation(operation.uvalId, {
            status: 'approved',
            approvedBy: approver.id,
            approvedAt: Date.now(),
        });
        await updateLinkedBatchItems(operation.uvalId, {
            status: 'approved',
            error: null,
        });
    }
    await editMessageWithRetry(interaction.message, { components: [] });

    if (operations.length === 1) {
        return executeOperation(client, { ...operations[0], status: 'approved' }, { approver });
    }

    const failures = [];
    for (const operation of operations) {
        try {
            await executeOperation(client, { ...operation, status: 'approved' }, { approver });
        } catch (error) {
            failures.push({
                uvalId: operation.uvalId,
                error: error?.userMessage || error?.message || String(error),
            });
        }
    }
    return {
        status: failures.length ? 'completed_with_issues' : 'completed',
        count: operations.length,
        failures,
    };
}

async function retryFailedOperation(client, { uvalId, requester }) {
    const operation = await uvalOperations.findOne({ uvalId });
    if (!operation) throw new StaffAuditError('Операция увольнения не найдена.', 'operation_not_found');
    if (operation.status !== 'failed') {
        throw new StaffAuditError('Повторно запустить можно только неудавшуюся операцию.', 'operation_not_failed');
    }

    const config = guildConfigService.get(operation.guildId);
    const guild = await client.guilds.fetch(operation.guildId);
    const requesterMember = requester?.id
        ? requester
        : await guild.members.fetch(requester).catch(() => null);
    if (!requesterMember) throw new StaffAuditError('Пользователь повторного запуска не найден.', 'requester_missing');
    if (
        String(requesterMember.id) !== String(operation.actorId) &&
        !canApproveDismissal(requesterMember, config)
    ) {
        throw new StaffAuditError(
            'Продолжить чужое увольнение может только пользователь с ролью подтверждения.',
            'retry_access_denied'
        );
    }

    return executeOperation(client, operation);
}

async function getOperation(uvalId) {
    return uvalOperations.findOne({ uvalId });
}

module.exports = {
    executeOperation,
    getOperation,
    handleApprovalInteraction,
    requestDismissal,
    retryFailedOperation,
    sendPendingApprovalRequests,
    updateOperation,
};
