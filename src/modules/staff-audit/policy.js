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
const StaffAuditError = require('./error');
const { getMemberRankMatches, getRank } = require('./ranks');
const { mutateDatabase: mutateDb, readDatabase: readDb } = require('./database');

const COUNTED_DISMISSAL_STATUSES = new Set([
    'reserved',
    'processing',
    'completed',
    'pending_approval',
    'approved',
]);

const ACTIVE_DISMISSAL_STATUSES = new Set([
    'reserved',
    'processing',
    'pending_approval',
    'approved',
]);

function createId(prefix) {
    if (typeof crypto.randomUUID === 'function') return `${prefix}-${crypto.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function buildMemberStateHash(member) {
    const roleIds = member?.roles?.cache?.keys
        ? [...member.roles.cache.keys()].map(String).sort()
        : [];
    return crypto.createHash('sha1')
        .update(JSON.stringify({
            displayName: String(member?.displayName || ''),
            roleIds,
        }))
        .digest('hex');
}

function memberHasAnyRole(member, roleIds) {
    return (Array.isArray(roleIds) ? roleIds : [])
        .some((roleId) => member?.roles?.cache?.has?.(roleId));
}

function getStrictMemberRank(member, config, label) {
    const matches = getMemberRankMatches(member, config);
    if (!matches.length) {
        throw new StaffAuditError(
            `У ${label} не найдена настроенная роль ранга.`,
            `${label}_rank_missing`
        );
    }
    if (matches.length > 1) {
        throw new StaffAuditError(
            `У ${label} найдено несколько ролей рангов: ${matches.map((rank) => rank.number).join(', ')}.`,
            `${label}_multiple_ranks`
        );
    }
    return matches[0];
}

function assertCanManageTarget(actor, targetMember, config, {
    currentTargetRankNumber = null,
    targetRankNumber = null,
    actionLabel = 'выполнить кадровое действие',
} = {}) {
    if (!actor || !targetMember) {
        throw new StaffAuditError('Для проверки иерархии нужны оба участника.', 'hierarchy_member_missing');
    }
    if (actor.id === targetMember.id) {
        throw new StaffAuditError(`Нельзя ${actionLabel} в отношении самого себя.`, 'self_action_denied');
    }

    const actorRank = getStrictMemberRank(actor, config, 'исполнителя');
    const targetRank = currentTargetRankNumber === null
        ? getStrictMemberRank(targetMember, config, 'сотрудника')
        : getRank(config, currentTargetRankNumber);
    if (!targetRank) {
        throw new StaffAuditError(
            `Текущий ранг ${currentTargetRankNumber} отсутствует в настройках.`,
            'current_rank_not_found'
        );
    }

    if (targetRank.number >= actorRank.number) {
        throw new StaffAuditError(
            `Нельзя ${actionLabel} сотрудника с рангом выше или равным вашему ` +
            `(${targetRank.number} >= ${actorRank.number}).`,
            'hierarchy_denied'
        );
    }

    if (targetRankNumber !== null) {
        const destinationRank = getRank(config, targetRankNumber);
        if (!destinationRank) {
            throw new StaffAuditError(`Целевой ранг ${targetRankNumber} отсутствует в настройках.`, 'rank_not_found');
        }
        if (destinationRank.number >= actorRank.number) {
            throw new StaffAuditError(
                `Нельзя выдать ранг ${destinationRank.number}, который выше или равен вашему рангу ${actorRank.number}.`,
                'destination_rank_hierarchy_denied'
            );
        }
    }

    return { actorRank, targetRank };
}

function assertCanDismissTarget(actor, targetMember, config, {
    savedTargetRankNumber = null,
    actionLabel = 'уволить',
} = {}) {
    if (!actor || !targetMember) {
        throw new StaffAuditError('Для проверки увольнения нужны оба участника.', 'hierarchy_member_missing');
    }
    if (actor.id === targetMember.id) {
        throw new StaffAuditError(`Нельзя ${actionLabel} самого себя.`, 'self_action_denied');
    }

    const matches = getMemberRankMatches(targetMember, config);
    if (matches.length > 1) {
        throw new StaffAuditError(
            `У сотрудника найдено несколько ролей рангов: ${matches.map((rank) => rank.number).join(', ')}.`,
            'target_multiple_ranks'
        );
    }

    let targetRank = matches[0] || null;
    if (!targetRank && Number.isSafeInteger(savedTargetRankNumber)) {
        targetRank = getRank(config, savedTargetRankNumber);
    }

    if (!targetRank) {
        return { actorRank: null, targetRank: null, hierarchySkipped: true };
    }

    const actorRank = getStrictMemberRank(actor, config, 'исполнителя');
    if (targetRank.number >= actorRank.number) {
        throw new StaffAuditError(
            `Нельзя ${actionLabel} сотрудника с рангом выше или равным вашему ` +
            `(${targetRank.number} >= ${actorRank.number}).`,
            'hierarchy_denied'
        );
    }

    return { actorRank, targetRank, hierarchySkipped: false };
}


function findDismissalConflict(guildId, { memberId = null, staticId = null } = {}) {
    const db = readDb();
    const sameTarget = (operation) => {
        if (String(operation.guildId) !== String(guildId)) return false;
        if (memberId) return String(operation.targetMemberId || '') === String(memberId);
        return Boolean(staticId && String(operation.targetStaticId || '') === String(staticId));
    };
    const active = (db.uvalOperations || []).find((operation) => (
        sameTarget(operation) && ACTIVE_DISMISSAL_STATUSES.has(operation.status)
    ));
    if (active) return { type: 'active', operation: { ...active } };
    const recoverable = (db.uvalOperations || []).find((operation) => (
        sameTarget(operation) && operation.status === 'failed' &&
        Array.isArray(operation.completedSteps) && operation.completedSteps.length > 0
    ));
    return recoverable ? { type: 'recoverable', operation: { ...recoverable } } : null;
}

function assertNoDismissalConflict(guildId, target) {
    const conflict = findDismissalConflict(guildId, target);
    if (!conflict) return null;
    const uvalId = conflict.operation.uvalId;
    if (conflict.type === 'recoverable') {
        throw new StaffAuditError(
            `У сотрудника есть незавершённое увольнение ${uvalId}. Продолжите его через /manualtools retry_uval.`,
            'dismissal_retry_required'
        );
    }
    throw new StaffAuditError(
        `Для сотрудника уже выполняется увольнение (${uvalId}).`,
        'dismissal_already_pending'
    );
}

async function reserveDismissal({
    guildId,
    actor,
    target,
    config,
    source,
    reason,
    nonceSeed,
    hierarchy = null,
    sourceAck = null,
    expectedTargetStateHash = null,
    bypassActiveDiscipline = false,
    forceApproval = false,
    executeAsApprover = false,
    bypassLimitApproval = false,
}) {
    const settings = getStaffAuditSettings(config);
    const now = Date.now();
    const exempt = memberHasAnyRole(actor, settings.dismissalLimitExemptRoleIds);
    const cutoff = now - settings.dismissalLimitWindowMinutes * 60_000;
    const uvalId = createId('uval');

    return mutateDb((db) => {
        db.uvalOperations ||= [];
        const sameTarget = (operation) => {
            if (String(operation.guildId) !== String(guildId)) return false;
            if (target.memberId) {
                return String(operation.targetMemberId || '') === String(target.memberId);
            }
            return Boolean(
                target.staticId &&
                String(operation.targetStaticId || '') === String(target.staticId)
            );
        };
        const activeOperation = db.uvalOperations.find((operation) => (
            sameTarget(operation) && ACTIVE_DISMISSAL_STATUSES.has(operation.status)
        ));
        if (activeOperation) {
            throw new StaffAuditError(
                `Для сотрудника уже выполняется увольнение (${activeOperation.uvalId}).`,
                'dismissal_already_pending'
            );
        }
        const recoverableOperation = db.uvalOperations.find((operation) => (
            sameTarget(operation) &&
            operation.status === 'failed' &&
            Array.isArray(operation.completedSteps) &&
            operation.completedSteps.length > 0
        ));
        if (recoverableOperation) {
            throw new StaffAuditError(
                `У сотрудника есть незавершённое увольнение ${recoverableOperation.uvalId}. ` +
                'Продолжите его через /manualtools retry_uval.',
                'dismissal_retry_required'
            );
        }

        const recentCount = exempt
            ? 0
            : db.uvalOperations.filter((operation) => (
                String(operation.guildId) === String(guildId) &&
                String(operation.actorId) === String(actor.id) &&
                Boolean(operation.targetMemberId) &&
                Number(operation.createdAt) >= cutoff &&
                COUNTED_DISMISSAL_STATUSES.has(operation.status)
            )).length;

        const requiresApproval = Boolean(target.memberId) && (
            forceApproval === true || (
                bypassLimitApproval !== true &&
                !exempt &&
                recentCount >= settings.dismissalLimitCount
            )
        );
        const record = {
            uvalId,
            guildId: String(guildId),
            actorId: String(actor.id),
            targetMemberId: target.memberId ? String(target.memberId) : null,
            targetDisplayName: String(target.displayName || ''),
            targetStaticId: String(target.staticId || ''),
            actorRankNumber: hierarchy?.actorRank?.number || null,
            targetRankNumber: hierarchy?.targetRank?.number || null,
            source: String(source || 'unknown'),
            reason: String(reason || ''),
            nonceSeed: String(nonceSeed || uvalId),
            sourceAck: sourceAck && typeof sourceAck === 'object' ? {
                channelId: sourceAck.channelId ? String(sourceAck.channelId) : null,
                messageId: sourceAck.messageId ? String(sourceAck.messageId) : null,
                emoji: String(sourceAck.emoji || '✅'),
            } : null,
            expectedTargetStateHash: expectedTargetStateHash ? String(expectedTargetStateHash) : null,
            bypassActiveDiscipline: bypassActiveDiscipline === true,
            executeAsApprover: executeAsApprover === true,
            status: requiresApproval ? 'pending_approval' : 'reserved',
            requiresApproval,
            approvalMessageId: null,
            approvalChannelId: null,
            approvedBy: null,
            approvedAt: null,
            rejectedBy: null,
            rejectedAt: null,
            completedSteps: [],
            createdAt: now,
            updatedAt: now,
        };
        db.uvalOperations.push(record);
        return { ...record, recentCount };
    });
}

function canApproveDismissal(member, config) {
    const settings = getStaffAuditSettings(config);
    return memberHasAnyRole(member, settings.dismissalApprovalRoleIds);
}

module.exports = {
    ACTIVE_DISMISSAL_STATUSES,
    COUNTED_DISMISSAL_STATUSES,
    assertCanDismissTarget,
    assertCanManageTarget,
    assertNoDismissalConflict,
    buildMemberStateHash,
    canApproveDismissal,
    findDismissalConflict,
    getStrictMemberRank,
    memberHasAnyRole,
    reserveDismissal,
};
