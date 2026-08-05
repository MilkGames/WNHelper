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
const StaffAuditError = require('./error');
const { readDatabase, mutateDatabase } = require('./database');
const { getStaffAuditSettings } = require('./settings/schema');
const {
    getMoscowDateKey,
    isLeaderOpenDoorPeriod,
    isLeaderTermDay,
} = require('../staff-lists');

function memberHasAnyRole(member, roleIds) {
    return (Array.isArray(roleIds) ? roleIds : [])
        .some((roleId) => member?.roles?.cache?.has?.(roleId));
}

function getPromotionLimitDecision({ actor, config, timestamp = Date.now() }) {
    const settings = getStaffAuditSettings(config);
    if (memberHasAnyRole(actor, settings.promotionLimitBypassRoleIds)) {
        return { bypassed: true, reason: 'Роль исполнителя отключает дневной лимит повышений.' };
    }
    if (isLeaderOpenDoorPeriod(config, timestamp)) {
        return { bypassed: true, reason: 'Сегодня действует период открытых дверей.' };
    }
    return { bypassed: false, reason: null };
}

function findPromotionBySource(guildId, sourceId) {
    if (!sourceId) return null;
    const db = readDatabase();
    return (db.staffPromotionHistory || []).find((record) => (
        String(record.guildId) === String(guildId) &&
        String(record.sourceId) === String(sourceId)
    )) || null;
}

function assertPromotionDailyLimit({
    guildId,
    targetMemberId,
    actor,
    config,
    sourceId = null,
    timestamp = Date.now(),
}) {
    if (!targetMemberId) return { bypassed: true, reason: 'Сотрудник указан без Discord ID.' };
    const existing = findPromotionBySource(guildId, sourceId);
    if (existing) return { bypassed: true, idempotent: true, existing };

    const decision = getPromotionLimitDecision({ actor, config, timestamp });
    if (decision.bypassed) return decision;

    const dateKey = getMoscowDateKey(timestamp);
    const db = readDatabase();
    const count = (db.staffPromotionHistory || []).filter((record) => (
        String(record.guildId) === String(guildId) &&
        String(record.targetMemberId) === String(targetMemberId) &&
        record.dateKey === dateKey &&
        record.status === 'completed'
    )).length;

    if (count >= 1) {
        throw new StaffAuditError(
            'Сотрудник уже получал повышение сегодня. Следующее повышение доступно после полуночи по московскому времени.',
            'promotion_daily_limit'
        );
    }
    return { bypassed: false, dateKey, count };
}

async function reservePromotion({
    guildId,
    targetMemberId,
    actor,
    config,
    fromRankNumber,
    toRankNumber,
    sourceId,
    timestamp = Date.now(),
}) {
    if (!targetMemberId) return null;
    const decision = getPromotionLimitDecision({ actor, config, timestamp });
    const dateKey = getMoscowDateKey(timestamp);

    return mutateDatabase((db) => {
        if (!Array.isArray(db.staffPromotionHistory)) db.staffPromotionHistory = [];
        const existing = sourceId
            ? db.staffPromotionHistory.find((record) => (
                String(record.guildId) === String(guildId) &&
                String(record.sourceId) === String(sourceId)
            ))
            : null;
        if (existing) return { ...existing, idempotent: true };

        if (!decision.bypassed) {
            const occupied = db.staffPromotionHistory.find((record) => (
                String(record.guildId) === String(guildId) &&
                String(record.targetMemberId) === String(targetMemberId) &&
                record.dateKey === dateKey &&
                ['reserved', 'completed'].includes(record.status)
            ));
            if (occupied) {
                throw new StaffAuditError(
                    'Сотрудник уже получал повышение сегодня или для него уже выполняется повышение. Следующее повышение доступно после полуночи по московскому времени.',
                    'promotion_daily_limit'
                );
            }
        }

        const record = {
            promotionId: `promotion:${guildId}:${targetMemberId}:${timestamp}:${Math.random().toString(36).slice(2, 8)}`,
            guildId: String(guildId),
            targetMemberId: String(targetMemberId),
            actorId: actor?.id ? String(actor.id) : null,
            fromRankNumber: Number(fromRankNumber),
            toRankNumber: Number(toRankNumber),
            sourceId: sourceId ? String(sourceId) : null,
            dateKey,
            status: 'reserved',
            bypassed: decision.bypassed === true,
            bypassReason: decision.reason || null,
            createdAt: timestamp,
            completedAt: null,
        };
        db.staffPromotionHistory.push(record);
        return { ...record };
    });
}

async function recordPromotion({
    guildId,
    targetMemberId,
    actorId,
    fromRankNumber,
    toRankNumber,
    sourceId,
    timestamp = Date.now(),
}) {
    if (!targetMemberId) return null;
    return mutateDatabase((db) => {
        if (!Array.isArray(db.staffPromotionHistory)) db.staffPromotionHistory = [];
        const existing = sourceId
            ? db.staffPromotionHistory.find((record) => (
                String(record.guildId) === String(guildId) &&
                String(record.sourceId) === String(sourceId)
            ))
            : null;
        if (existing) {
            existing.actorId = actorId ? String(actorId) : existing.actorId || null;
            existing.fromRankNumber = Number(fromRankNumber);
            existing.toRankNumber = Number(toRankNumber);
            existing.status = 'completed';
            existing.completedAt = existing.completedAt || timestamp;
            return { ...existing };
        }
        const record = {
            promotionId: `promotion:${guildId}:${targetMemberId}:${timestamp}:${Math.random().toString(36).slice(2, 8)}`,
            guildId: String(guildId),
            targetMemberId: String(targetMemberId),
            actorId: actorId ? String(actorId) : null,
            fromRankNumber: Number(fromRankNumber),
            toRankNumber: Number(toRankNumber),
            sourceId: sourceId ? String(sourceId) : null,
            dateKey: getMoscowDateKey(timestamp),
            status: 'completed',
            createdAt: timestamp,
            completedAt: timestamp,
        };
        db.staffPromotionHistory.push(record);
        return { ...record };
    });
}

module.exports = {
    assertPromotionDailyLimit,
    getMoscowDateKey,
    getPromotionLimitDecision,
    isLeaderOpenDoorPeriod,
    isLeaderTermDay,
    recordPromotion,
    reservePromotion,
};
