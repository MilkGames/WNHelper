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

const guildConfigService = require('../../core/config/guildConfigService');
const { runDiscordRequest } = require('../../core/discord/request');
const logger = require('../../core/logging/logger');
const giveRoles = require('../give-roles');
const StaffAuditError = require('./error');
const { mutateDatabase, readDatabase } = require('./database');
const { getGrantDecision } = require('./ranks');
const { recordPromotion } = require('./promotionPolicy');
const service = require('./service');

const ACTIVE_STATUSES = new Set(['reserved', 'running', 'failed']);

function createOperationId(type) {
    return `staff-${type}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createInviteAssignmentSnapshot(assignment) {
    return {
        rankNumber: assignment.rank?.number || null,
        departmentName: assignment.departmentOverridden ? assignment.department?.fullName || null : null,
        departmentOverridden: assignment.departmentOverridden === true,
        roleIds: [...(assignment.roleIds || [])],
        roleIdsToRemove: [...(assignment.roleIdsToRemove || [])],
        reason: String(assignment.reason || ''),
        department: assignment.department ? {
            id: assignment.department.id,
            shortName: assignment.department.shortName,
            fullName: assignment.department.fullName,
        } : null,
    };
}

function getInviteAssignmentFromSnapshot(snapshot) {
    if (!snapshot) throw new StaffAuditError('Не найден снимок назначения сотрудника.', 'staff_operation_snapshot_missing');
    return {
        roleIds: [...(snapshot.roleIds || [])],
        roleIdsToRemove: [...(snapshot.roleIdsToRemove || [])],
        reason: snapshot.reason,
        department: snapshot.department ? { ...snapshot.department } : null,
    };
}

function getOperation(operationId) {
    const db = readDatabase();
    const record = (db.staffAuditOperations || [])
        .find((operation) => operation.operationId === String(operationId));
    return record ? clone(record) : null;
}

async function updateOperation(operationId, updater) {
    return mutateDatabase((db) => {
        if (!Array.isArray(db.staffAuditOperations)) db.staffAuditOperations = [];
        const operation = db.staffAuditOperations
            .find((entry) => entry.operationId === String(operationId));
        if (!operation) throw new StaffAuditError('Операция кадрового аудита не найдена.', 'staff_operation_not_found');
        const result = updater(operation) || operation;
        operation.updatedAt = Date.now();
        return clone(result);
    });
}

async function reserveOperation({ type, guildId, actorId, target, payload, sourceId }) {
    if (!['invite', 'rank'].includes(type)) {
        throw new StaffAuditError('Неизвестный тип операции кадрового аудита.', 'staff_operation_type_invalid');
    }
    return mutateDatabase((db) => {
        if (!Array.isArray(db.staffAuditOperations)) db.staffAuditOperations = [];
        const existing = sourceId
            ? db.staffAuditOperations.find((operation) => (
                String(operation.guildId) === String(guildId) &&
                String(operation.sourceId) === String(sourceId)
            ))
            : null;
        if (existing) return clone(existing);

        const now = Date.now();
        const record = {
            operationId: createOperationId(type),
            type,
            guildId: String(guildId),
            actorId: String(actorId),
            target: {
                memberId: target.memberId ? String(target.memberId) : null,
                displayName: String(target.displayName || ''),
                staticId: String(target.staticId || ''),
            },
            payload: clone(payload || {}),
            sourceId: sourceId ? String(sourceId) : null,
            status: 'reserved',
            completedSteps: [],
            lastError: null,
            createdAt: now,
            updatedAt: now,
            completedAt: null,
        };
        db.staffAuditOperations.push(record);
        return clone(record);
    });
}

async function markStep(operationId, step, extra = {}) {
    return updateOperation(operationId, (operation) => {
        if (!operation.completedSteps.includes(step)) operation.completedSteps.push(step);
        Object.assign(operation, extra);
        return operation;
    });
}

async function buildRuntimeContext(client, operation) {
    const config = guildConfigService.get(operation.guildId);
    service.assertFeatureEnabled(config);
    const guild = client.guilds.cache?.get?.(operation.guildId) || await client.guilds.fetch(operation.guildId);
    const actor = await guild.members.fetch(operation.actorId).catch(() => null);
    if (!actor) throw new StaffAuditError('Исполнитель операции больше не найден на сервере.', 'staff_operation_actor_missing');
    const member = operation.target.memberId
        ? await guild.members.fetch(operation.target.memberId).catch(() => null)
        : null;
    if (operation.target.memberId && !member) {
        throw new StaffAuditError('Сотрудник операции больше не найден на сервере.', 'staff_operation_target_missing');
    }
    const target = {
        member,
        memberId: member?.id || operation.target.memberId || null,
        displayName: member?.displayName || operation.target.displayName,
        staticId: operation.target.staticId,
        displayValue: member ? `${member}` : operation.target.displayName,
    };
    return { config, guild, actor, target };
}

async function executeInviteOperation(client, operation) {
    const context = await buildRuntimeContext(client, operation);
    const { config, guild, actor, target } = context;
    const payload = operation.payload;
    let assignmentSnapshot = operation.assignmentSnapshot || null;

    if (!assignmentSnapshot) {
        const { errors, assignment } = giveRoles.getManualAssignmentErrors(guild, config, {
            rankNumber: payload.rankNumber,
            departmentId: payload.departmentId,
            reason: payload.reason,
        });
        if (errors.length) throw new StaffAuditError(errors.join('\n'), 'assignment_invalid');
        const grantDecision = getGrantDecision(actor, config, assignment.rank.number);
        if (!grantDecision.allowed) throw new StaffAuditError(grantDecision.reason, 'rank_access_denied');
        assignmentSnapshot = createInviteAssignmentSnapshot(assignment);
        operation = await updateOperation(operation.operationId, (record) => {
            record.assignmentSnapshot = clone(assignmentSnapshot);
            return record;
        });
    }

    const assignment = getInviteAssignmentFromSnapshot(assignmentSnapshot);
    if (!operation.completedSteps.includes('discord_started')) {
        if (target.member) {
            const memberErrors = giveRoles.getMemberAssignmentErrors(target.member, assignment);
            if (memberErrors.length) throw new StaffAuditError(memberErrors.join('\n'), 'member_assignment_invalid');
        }
        operation = await markStep(operation.operationId, 'discord_started');
    }

    if (!operation.completedSteps.includes('discord_applied')) {
        if (target.member) {
            const memberErrors = giveRoles.getMemberAssignmentErrors(target.member, assignment);
            if (memberErrors.length) throw new StaffAuditError(memberErrors.join('\n'), 'member_assignment_invalid');
            const baseName = service.extractBaseName(operation.target.displayName, operation.target.staticId);
            await giveRoles.applyAssignment(target.member, assignment, baseName, operation.target.staticId);
        }
        operation = await markStep(operation.operationId, 'discord_applied');
    }

    let channelId = operation.channelId || null;
    if (!operation.completedSteps.includes('audit_published')) {
        const channel = await service.sendInviteRecord(client, {
            guildId: guild.id,
            config,
            actor,
            target,
            rankNumber: assignmentSnapshot.rankNumber,
            reason: payload.reason,
            departmentName: assignmentSnapshot.departmentName,
            nonceSeed: `staffOperation:${operation.operationId}:audit`,
        });
        channelId = channel.id;
        operation = await markStep(operation.operationId, 'audit_published', { channelId });
    }

    return updateOperation(operation.operationId, (record) => {
        record.status = 'completed';
        record.lastError = null;
        record.completedAt = Date.now();
        return record;
    });
}


async function acknowledgeSourceMessage(client, sourceAck) {
    if (!sourceAck?.channelId || !sourceAck?.messageId || !sourceAck?.emoji) return 'not_configured';

    try {
        const channel = await client.channels.fetch(String(sourceAck.channelId));
        if (!channel?.messages?.fetch) return 'missing';
        const message = await channel.messages.fetch(String(sourceAck.messageId));
        await runDiscordRequest(() => message.react(String(sourceAck.emoji)));
        return 'completed';
    } catch (error) {
        if ([10_003, 10_008, 50_001].includes(Number(error?.code))) return 'missing';
        throw error;
    }
}

async function executeRankOperation(client, operation) {
    const context = await buildRuntimeContext(client, operation);
    const { config, guild, actor, target } = context;
    const payload = operation.payload;
    const sourceId = `staffOperation:${operation.operationId}`;

    if (!operation.completedSteps.includes('discord_applied')) {
        if (operation.completedSteps.includes('discord_started')) {
            if (!operation.rankSnapshot) {
                throw new StaffAuditError('Не найден снимок изменения ранга.', 'staff_operation_snapshot_missing');
            }
            if (target.member) {
                await service.applyRankOperationSnapshot(target.member, operation.rankSnapshot);
            }
            operation = await markStep(operation.operationId, 'discord_applied');
        } else if (target.member) {
            await service.changeRank(client, {
                guild,
                config,
                actor,
                target,
                actionInput: payload.actionInput,
                reason: payload.reason,
                keepDepartment: payload.keepDepartment === true,
                nonceSeed: `${sourceId}:discord`,
                currentRankConfirmed: true,
                promotionSourceId: sourceId,
                skipAudit: true,
                skipPromotionRecord: true,
                beforeDiscordApply: async (snapshot) => {
                    operation = await markStep(operation.operationId, 'discord_started', {
                        rankSnapshot: clone(snapshot),
                        promotion: snapshot.promotion,
                        fromRankNumber: snapshot.fromRankNumber,
                        toRankNumber: snapshot.toRankNumber,
                    });
                },
            });
            operation = await markStep(operation.operationId, 'discord_applied');
        } else {
            const rankAction = service.parseRankAction(payload.actionInput, config);
            const grantDecision = getGrantDecision(actor, config, rankAction.toNumber);
            if (!grantDecision.allowed) throw new StaffAuditError(grantDecision.reason, 'rank_access_denied');
            const snapshot = service.createRankOperationSnapshot(config, rankAction, null);
            operation = await markStep(operation.operationId, 'discord_started', {
                rankSnapshot: clone(snapshot),
                promotion: snapshot.promotion,
                fromRankNumber: snapshot.fromRankNumber,
                toRankNumber: snapshot.toRankNumber,
            });
            operation = await markStep(operation.operationId, 'discord_applied');
        }
    }

    if (operation.promotion && !operation.completedSteps.includes('promotion_recorded') && target.memberId) {
        await recordPromotion({
            guildId: guild.id,
            targetMemberId: target.memberId,
            actorId: actor.id,
            fromRankNumber: operation.fromRankNumber,
            toRankNumber: operation.toRankNumber,
            sourceId,
        });
        operation = await markStep(operation.operationId, 'promotion_recorded');
    }

    let channelId = operation.channelId || null;
    if (!operation.completedSteps.includes('audit_published')) {
        const snapshot = operation.rankSnapshot;
        if (!snapshot) throw new StaffAuditError('Не найден снимок изменения ранга.', 'staff_operation_snapshot_missing');
        const channel = await service.sendRankRecord(client, {
            guildId: guild.id,
            config,
            actor,
            target,
            action: snapshot.formattedAction,
            reason: payload.reason,
            nonceSeed: `${sourceId}:audit`,
        });
        channelId = channel.id;
        operation = await markStep(operation.operationId, 'audit_published', { channelId });
    }

    if (payload.sourceAck && !operation.completedSteps.includes('source_acknowledged')) {
        const sourceAckStatus = await acknowledgeSourceMessage(client, payload.sourceAck);
        operation = await markStep(operation.operationId, 'source_acknowledged', { sourceAckStatus });
    }

    return updateOperation(operation.operationId, (record) => {
        record.status = 'completed';
        record.lastError = null;
        record.completedAt = Date.now();
        return record;
    });
}

async function executeOperation(client, operationId) {
    let operation = getOperation(operationId);
    if (!operation) throw new StaffAuditError('Операция кадрового аудита не найдена.', 'staff_operation_not_found');
    if (operation.status === 'completed') return operation;
    if (!ACTIVE_STATUSES.has(operation.status)) {
        throw new StaffAuditError('Операция кадрового аудита не может быть продолжена.', 'staff_operation_not_retryable');
    }

    operation = await updateOperation(operation.operationId, (record) => {
        record.status = 'running';
        record.lastError = null;
        return record;
    });

    try {
        return operation.type === 'invite'
            ? await executeInviteOperation(client, operation)
            : await executeRankOperation(client, operation);
    } catch (error) {
        await updateOperation(operation.operationId, (record) => {
            record.status = 'failed';
            record.lastError = {
                message: error?.userMessage || error?.message || 'Неизвестная ошибка',
                code: error?.code || null,
                at: Date.now(),
            };
            return record;
        }).catch(() => undefined);
        logger.error('Операция кадрового аудита завершилась с ошибкой', {
            operationId: operation.operationId,
            type: operation.type,
            guildId: operation.guildId,
        }, error);
        throw error;
    }
}

module.exports = {
    executeOperation,
    getOperation,
    reserveOperation,
    updateOperation,
};
