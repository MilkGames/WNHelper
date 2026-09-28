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
const { getStaffAuditSettings } = require('./settings/schema');
const staffAuditBatches = require('./database').staffAuditBatches;
const giveRolesService = require('../give-roles');
const guildConfigService = require('../../core/config/guildConfigService');
const { getGrantDecision, getMemberRankMatches } = require('./ranks');
const {
    assertCanDismissTarget,
    assertCanManageTarget,
    buildMemberStateHash,
} = require('./policy');
const staffAuditService = require('./service');
const { invokeAction } = require('../../core/integrations/actionRegistry');
const { mutateDatabase: mutateDb } = require('./database');
const { parseMassAuditText } = require('./massAuditParser');
const StaffAuditError = require('./error');

function createId() {
    return typeof crypto.randomUUID === 'function'
        ? `massaudit-${crypto.randomUUID()}`
        : `massaudit-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function assertCurrentRankMatchesAction(member, config, fromRankNumber, lineNumber) {
    const matches = getMemberRankMatches(member, config);
    if (matches.length > 1) {
        throw new StaffAuditError(
            `Строка ${lineNumber}: у сотрудника найдено несколько ролей рангов.`,
            'mass_audit_target_multiple_ranks'
        );
    }
    if (matches.length === 1 && matches[0].number !== fromRankNumber) {
        throw new StaffAuditError(
            `Строка ${lineNumber}: начало action:${fromRankNumber} не совпадает с ролью ранга ${matches[0].number}.`,
            'mass_audit_action_rank_mismatch'
        );
    }
}

function buildTargetLabel(item) {
    if (item.memberId) return `<@${item.memberId}>`;
    return `${item.displayName} | ${item.staticId}`;
}

function findDuplicateTargetLabels(items) {
    const seenMemberIds = new Set();
    const seenStaticIds = new Set();
    const duplicates = [];

    for (const item of items) {
        const memberId = item.memberId ? String(item.memberId) : null;
        const staticId = item.staticId ? String(item.staticId) : null;
        const duplicate = Boolean(
            (memberId && seenMemberIds.has(memberId)) ||
            (staticId && seenStaticIds.has(staticId))
        );
        if (duplicate) duplicates.push(buildTargetLabel(item));
        if (memberId) seenMemberIds.add(memberId);
        if (staticId) seenStaticIds.add(staticId);
    }

    return [...new Set(duplicates)];
}

async function validateItem(guild, config, actor, item) {
    let target;
    try {
        target = await staffAuditService.resolveMemberInput(guild, item.memberInput, item.staticId || null);
    } catch (error) {
        if (error instanceof StaffAuditError) {
            error.userMessage = `Строка ${item.lineNumber}: ${error.userMessage}`;
        }
        throw error;
    }

    const member = target.member;
    const snapshot = member ? {
        memberId: member.id,
        displayName: member.displayName,
        stateHash: buildMemberStateHash(member),
    } : {
        memberId: null,
        displayName: target.displayName,
        staticId: target.staticId,
        stateHash: null,
    };
    const resolvedItem = {
        ...item,
        memberId: target.memberId,
        displayName: target.displayName,
        staticId: target.staticId,
        targetKey: target.memberId ? `member:${target.memberId}` : `external:${target.staticId}`,
    };

    if (item.action === 'invite') {
        const { errors, assignment } = giveRolesService.getManualAssignmentErrors(guild, config, {
            rankNumber: item.rankNumber,
            departmentId: item.departmentId,
            reason: item.reason,
        });
        if (errors.length) throw new StaffAuditError(`Строка ${item.lineNumber}: ${errors.join(' ')}`, 'assignment_invalid');
        const decision = getGrantDecision(actor, config, assignment.rank.number);
        if (!decision.allowed) throw new StaffAuditError(`Строка ${item.lineNumber}: ${decision.reason}`, 'rank_access_denied');
        if (member) {
            const memberErrors = giveRolesService.getMemberAssignmentErrors(member, assignment);
            if (memberErrors.length) {
                throw new StaffAuditError(`Строка ${item.lineNumber}: ${memberErrors.join(' ')}`, 'member_assignment_invalid');
            }
        }
        return {
            ...resolvedItem,
            assignment: {
                rankNumber: assignment.rank.number,
                departmentId: assignment.department?.id || null,
                departmentName: assignment.department?.fullName || null,
                departmentOverridden: assignment.departmentOverridden,
            },
            snapshot,
            preview: `Принять на ${assignment.rank.number}${assignment.department ? `, ${assignment.department.shortName}` : ''}`,
            status: 'pending',
        };
    }

    if (item.action === 'rank') {
        const rankAction = staffAuditService.parseRankAction(item.actionInput, config);
        if (member) {
            assertCurrentRankMatchesAction(member, config, rankAction.fromNumber, item.lineNumber);
            snapshot.rankNumber = rankAction.fromNumber;
            assertCanManageTarget(actor, member, config, {
                currentTargetRankNumber: rankAction.fromNumber,
                targetRankNumber: rankAction.toNumber,
                actionLabel: rankAction.promotion ? 'повысить' : 'понизить',
                allowActorWithoutRank: rankAction.promotion && !rankAction.toRank.roleId,
            });
            if (rankAction.promotion) {
                await invokeAction('discipline.assertPromotionAllowed', guild.id, member.id, config);
            }
        }
        const decision = getGrantDecision(actor, config, rankAction.toNumber);
        if (!decision.allowed) throw new StaffAuditError(`Строка ${item.lineNumber}: ${decision.reason}`, 'rank_access_denied');
        return {
            ...resolvedItem,
            actionInput: `${rankAction.fromNumber}-${rankAction.toNumber}`,
            fromRankNumber: rankAction.fromNumber,
            rankNumber: rankAction.toNumber,
            snapshot,
            preview: `${rankAction.promotion ? 'Повысить' : 'Понизить'} ${rankAction.fromNumber}-${rankAction.toNumber}`,
            status: 'pending',
        };
    }

    if (member) {
        const hierarchy = assertCanDismissTarget(actor, member, config, { actionLabel: 'уволить' });
        await invokeAction('discipline.assertOrdinaryDismissalAllowed', guild.id, member.id, config);
        snapshot.rankNumber = hierarchy.targetRank?.number || null;
    }
    return { ...resolvedItem, snapshot, preview: 'Уволить', status: 'pending' };
}

async function createBatch(client, { guild, config, actor, text }) {
    staffAuditService.assertFeatureEnabled(config);
    const parsed = parseMassAuditText(text);
    const settings = getStaffAuditSettings(config);
    if (parsed.length > settings.massAuditMaxItems) {
        throw new StaffAuditError(
            `В одном массовом КА разрешено не более ${settings.massAuditMaxItems} операций.`,
            'mass_audit_too_large'
        );
    }

    const items = [];
    for (const item of parsed) items.push(await validateItem(guild, config, actor, item));

    const duplicateTargets = findDuplicateTargetLabels(items);
    if (duplicateTargets.length) {
        throw new StaffAuditError(
            `Один сотрудник не может встречаться в пакете несколько раз: ${duplicateTargets.join(', ')}.`,
            'mass_audit_duplicate_member'
        );
    }

    const now = Date.now();
    const batch = {
        massauditId: createId(),
        guildId: guild.id,
        actorId: actor.id,
        status: 'awaiting_confirmation',
        items,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + 24 * 60 * 60_000,
    };
    await new staffAuditBatches(batch).save();
    return batch;
}

function buildPreview(batch) {
    const lines = [
        `**Массовый кадровый аудит** · ${batch.massauditId}`,
        `Операций: **${batch.items.length}**`,
        '',
    ];
    for (const item of batch.items) {
        lines.push(`${item.lineNumber}. ${buildTargetLabel(item)} - ${item.preview}`);
    }
    lines.push('', 'После подтверждения операции выполняются последовательно. Ошибка одной строки не останавливает остальные.');
    lines.push('', '-# Интерфейс подтверждения действителен 24 часа.');
    return lines.join('\n').slice(0, 3900);
}

async function updateBatch(massauditId, mutator) {
    return mutateDb((db) => {
        const batch = (db.staffAuditBatches || []).find((entry) => entry.massauditId === massauditId);
        if (!batch) return null;
        mutator(batch);
        batch.updatedAt = Date.now();
        return JSON.parse(JSON.stringify(batch));
    });
}

async function executeItem(client, guild, config, actor, item, massauditId) {
    if (item.action === 'uval' && item.uvalId) {
        let operation = await invokeAction('offboarding.getOperation', item.uvalId);
        if (!operation) {
            throw new StaffAuditError('Связанная операция увольнения не найдена.', 'uval_operation_not_found');
        }
        if (operation.status === 'completed') {
            return { status: 'completed', uvalId: item.uvalId };
        }
        if (operation.status === 'pending_approval') {
            return { status: 'pending_approval', uvalId: item.uvalId };
        }
        if (operation.status === 'blocked_no_approval_config') {
            await invokeAction('offboarding.updateOperation', item.uvalId, {
                status: 'pending_approval',
                updatedAt: Date.now(),
            });
            return { status: 'pending_approval', uvalId: item.uvalId };
        }
        if (operation.status === 'rejected') {
            return { status: 'rejected', uvalId: item.uvalId };
        }
        const result = operation.status === 'failed'
            ? await invokeAction('offboarding.retryFailedOperation', client, {
                uvalId: item.uvalId,
                requester: actor,
            })
            : await invokeAction('offboarding.executeOperation', client, operation);
        return {
            status: result.status === 'pending_approval' ? 'pending_approval' : 'completed',
            uvalId: item.uvalId,
        };
    }

    let member = null;
    let target;
    if (item.memberId) {
        member = await guild.members.fetch(item.memberId).catch(() => null);
        if (!member || buildMemberStateHash(member) !== item.snapshot.stateHash) {
            return { status: 'skipped_state_changed', error: 'Состояние сотрудника изменилось после предпросмотра.' };
        }
        target = await staffAuditService.resolveMemberInput(guild, member.id, item.staticId || null);
    } else {
        target = {
            member: null,
            memberId: null,
            displayName: item.displayName,
            staticId: item.staticId,
            displayValue: item.displayName,
        };
    }
    if (item.action === 'invite') {
        const { errors, assignment } = giveRolesService.getManualAssignmentErrors(guild, config, {
            rankNumber: item.assignment.rankNumber,
            departmentId: item.assignment.departmentOverridden ? item.assignment.departmentId : null,
            reason: item.reason,
        });
        if (errors.length) throw new StaffAuditError(errors.join('\n'), 'assignment_invalid');
        if (member) {
            const baseName = staffAuditService.extractBaseName(target.displayName, target.staticId);
            await giveRolesService.applyAssignment(member, assignment, baseName, target.staticId);
        }
        await staffAuditService.sendInviteRecord(client, {
            guildId: guild.id,
            config,
            actor,
            target,
            rankNumber: assignment.rank.number,
            reason: item.reason,
            departmentName: assignment.departmentOverridden ? assignment.department.fullName : null,
            nonceSeed: `massAudit:${massauditId}:${item.lineNumber}`,
        });
        return { status: 'completed' };
    }

    if (item.action === 'rank') {
        const result = await staffAuditService.changeRank(client, {
            guild,
            config,
            actor,
            target,
            actionInput: item.actionInput,
            reason: item.reason,
            keepDepartment: item.keepDepartment,
            nonceSeed: `massAudit:${massauditId}:${item.lineNumber}`,
            currentRankConfirmed: true,
        });
        return { status: 'completed', result: result.rankAction.formattedAction };
    }

    const result = await staffAuditService.dismissMember(client, {
        guild,
        config,
        actor,
        target,
        reason: item.reason,
        source: 'mass_audit',
        expectedTargetStateHash: item.snapshot?.stateHash || null,
        nonceSeed: `massAudit:${massauditId}:${item.lineNumber}`,
        deferApprovalRequest: true,
    });
    return {
        status: result.status === 'pending_approval' ? 'pending_approval' : 'completed',
        uvalId: result.operation?.uvalId || null,
    };
}

async function executeBatch(client, { massauditId, actor }) {
    let batch = await staffAuditBatches.findOne({ massauditId });
    if (!batch) throw new StaffAuditError('Пакет массового КА не найден.', 'massaudit_not_found');
    if (String(batch.actorId) !== String(actor.id)) {
        throw new StaffAuditError('Запустить пакет может только его создатель.', 'massaudit_actor_mismatch');
    }
    if (!['awaiting_confirmation', 'partially_completed'].includes(batch.status)) {
        throw new StaffAuditError('Этот пакет уже обработан или отменён.', 'massaudit_not_executable');
    }
    if (Number(batch.expiresAt) < Date.now()) {
        await updateBatch(massauditId, (entry) => { entry.status = 'expired'; });
        throw new StaffAuditError('Срок подтверждения пакета истёк.', 'massaudit_expired');
    }

    const config = guildConfigService.get(batch.guildId);
    const guild = await client.guilds.fetch(batch.guildId);
    await updateBatch(massauditId, (entry) => { entry.status = 'processing'; });

    for (const item of batch.items) {
        if (!['pending', 'failed', 'approved'].includes(item.status)) continue;
        try {
            const result = await executeItem(client, guild, config, actor, item, massauditId);
            await updateBatch(massauditId, (entry) => {
                const current = entry.items.find((candidate) => candidate.lineNumber === item.lineNumber);
                Object.assign(current, result, { processedAt: Date.now() });
            });
        } catch (error) {
            await updateBatch(massauditId, (entry) => {
                const current = entry.items.find((candidate) => candidate.lineNumber === item.lineNumber);
                current.status = error?.batchItemStatus || 'failed';
                current.error = error?.userMessage || error?.message || String(error);
                current.uvalId = error?.uvalId || current.uvalId || null;
                current.processedAt = Date.now();
            });
        }
    }

    batch = await staffAuditBatches.findOne({ massauditId });
    const pendingApprovalIds = batch.items
        .filter((item) => item.status === 'pending_approval' && item.uvalId)
        .map((item) => item.uvalId);
    if (pendingApprovalIds.length) {
        try {
            await invokeAction('offboarding.sendPendingApprovalRequests', client, {
                uvalIds: pendingApprovalIds,
                config,
            });
        } catch (error) {
            const errorText = error?.userMessage || error?.message || String(error);
            await updateBatch(massauditId, (entry) => {
                for (const item of entry.items || []) {
                    if (!pendingApprovalIds.includes(item.uvalId)) continue;
                    if (item.status !== 'pending_approval') continue;
                    item.status = 'failed';
                    item.error = errorText;
                    item.processedAt = Date.now();
                }
            });
        }
    }

    batch = await staffAuditBatches.findOne({ massauditId });
    const retryable = batch.items.some((item) => item.status === 'failed');
    const pendingApproval = batch.items.some((item) => item.status === 'pending_approval');
    const hasIssues = batch.items.some((item) => (
        ['rejected', 'skipped_state_changed', 'cancelled_by_dismissal'].includes(item.status)
    ));
    const finalStatus = retryable
        ? 'partially_completed'
        : pendingApproval
            ? 'awaiting_approvals'
            : hasIssues
                ? 'completed_with_issues'
                : 'completed';
    await updateBatch(massauditId, (entry) => { entry.status = finalStatus; });
    return staffAuditBatches.findOne({ massauditId });
}

async function retryBatch(client, { massauditId, actor }) {
    const batch = await staffAuditBatches.findOne({ massauditId });
    if (!batch) throw new StaffAuditError('Массовый кадровый аудит не найден.', 'massaudit_not_found');
    if (String(batch.guildId) !== String(actor.guild.id)) {
        throw new StaffAuditError('Массовый кадровый аудит относится к другому серверу.', 'massaudit_wrong_guild');
    }
    if (String(batch.actorId) !== String(actor.id)) {
        throw new StaffAuditError('Повторить массовый КА может только его создатель.', 'massaudit_actor_mismatch');
    }
    if (batch.status !== 'partially_completed') {
        throw new StaffAuditError('Повторить можно только частично выполненный массовый КА.', 'massaudit_not_retryable');
    }
    return executeBatch(client, { massauditId, actor });
}

function buildResult(batch) {
    const lines = [`**Результат массового КА** · ${batch.massauditId}`, ''];
    for (const item of batch.items) {
        const labels = {
            completed: '✅ выполнено',
            pending_approval: `⏳ ожидает подтверждения увольнения${item.uvalId ? ` · ID: ${item.uvalId}` : ''}`,
            skipped_state_changed: '⏭️ пропущено: состояние изменилось',
            rejected: '🚫 увольнение отклонено',
            approved: `⏳ увольнение подтверждено, ожидает выполнения${item.uvalId ? ` · ID: ${item.uvalId}` : ''}`,
            cancelled_by_dismissal: '⏭️ отменено: сотрудник уже уволен',
            failed: `❌ ошибка: ${item.error || 'неизвестно'}${item.uvalId ? ` · ID увольнения: ${item.uvalId}` : ''}`,
            pending: '• ожидает выполнения',
        };
        lines.push(`${item.lineNumber}. ${buildTargetLabel(item)} - ${labels[item.status] || 'неизвестный статус'}`);
    }
    if (batch.status === 'partially_completed') {
        lines.push('', `Для повторения: /manualtools retry_massaudit massaudit_id:${batch.massauditId}`);
    }
    return lines.join('\n').slice(0, 3900);
}

module.exports = {
    buildPreview,
    buildResult,
    createBatch,
    executeBatch,
    retryBatch,
};
