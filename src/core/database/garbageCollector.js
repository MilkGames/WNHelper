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
const { mutateDb, readDb } = require('./localDatabase');
const logger = require('../logging/logger');

const DAY_MS = 86_400_000;
const DISCORD_UNKNOWN_MEMBER = 10_007;
const DISCORD_UNKNOWN_GUILD = 10_004;

const EXAMINATION_TERMINAL_STATUSES = new Set([
    'completed',
    'rejected',
    'expired',
    'cancelled',
    'cancelled_by_handler',
    'closed_by_dismissal',
]);
const UVAL_TERMINAL_STATUSES = new Set([
    'completed',
    'rejected',
    'cancelled',
    'cancelled_state_changed',
]);
const VACATION_IMMEDIATE_TERMINAL_STATUSES = new Set([
    'rejected',
    'cancelled',
]);
const VACATION_USAGE_STATUSES = new Set([
    'completed',
    'closed_by_dismissal',
]);

function getTimestamp(record, fields) {
    for (const field of fields) {
        const value = Number(record?.[field]);
        if (Number.isFinite(value) && value > 0) return value;
    }
    return null;
}

function olderThan(record, cutoff, fields) {
    const timestamp = getTimestamp(record, fields);
    return timestamp !== null && timestamp <= cutoff;
}

function getMoscowDateKey(timestamp = Date.now()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Moscow',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(new Date(timestamp));
    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;
    const day = parts.find((part) => part.type === 'day')?.value;
    return year && month && day ? `${year}-${month}-${day}` : null;
}

function getMoscowMonthKey(timestamp = Date.now()) {
    return getMoscowDateKey(timestamp)?.slice(0, 7) || null;
}

function getDateMonthKey(value) {
    const match = /^(\d{4})-(\d{2})-\d{2}$/u.exec(String(value || ''));
    return match ? `${match[1]}-${match[2]}` : null;
}

function compactStaffAuditOperation(operation) {
    if (!operation?.sourceId || !String(operation.sourceId).startsWith('messageContextRank:')) return null;
    return {
        operationId: operation.operationId,
        type: operation.type,
        guildId: operation.guildId,
        sourceId: operation.sourceId,
        status: 'completed',
        compacted: true,
        completedAt: operation.completedAt || operation.updatedAt || operation.createdAt || Date.now(),
        updatedAt: operation.updatedAt || operation.completedAt || Date.now(),
    };
}

function mergeGuildConfigDocuments(documents) {
    const order = [];
    const merged = new Map();
    for (const document of Array.isArray(documents) ? documents : []) {
        const guildId = String(document?.guildId || '').trim();
        if (!guildId) continue;
        if (!merged.has(guildId)) {
            order.push(guildId);
            merged.set(guildId, { ...document, guildId });
            continue;
        }
        merged.set(guildId, { ...merged.get(guildId), ...document, guildId });
    }
    return order.map((guildId) => merged.get(guildId));
}

function applyRetention(db, now = Date.now()) {
    const cutoff = now - DAY_MS;
    const currentMonth = getMoscowMonthKey(now);
    const currentDate = getMoscowDateKey(now);
    const stats = {};

    const beforeGuildConfigs = (db.guildConfigs || []).length;
    db.guildConfigs = mergeGuildConfigDocuments(db.guildConfigs);
    stats.guildConfigs = beforeGuildConfigs - db.guildConfigs.length;

    const beforeShifts = (db.shiftSchedules || []).length;
    db.shiftSchedules = (db.shiftSchedules || []).filter((record) => (
        record.status !== 'closed' || !olderThan(record, cutoff, ['closedAt', 'updatedAt', 'activeUntil'])
    ));
    stats.shiftSchedules = beforeShifts - db.shiftSchedules.length;

    let compactedAudit = 0;
    let deletedAudit = 0;
    const nextAudit = [];
    for (const record of db.staffAuditOperations || []) {
        if (record.compacted === true) {
            nextAudit.push(record);
            continue;
        }
        if (record.status === 'completed' && olderThan(record, cutoff, ['completedAt', 'updatedAt'])) {
            const compacted = compactStaffAuditOperation(record);
            if (compacted) {
                nextAudit.push(compacted);
                compactedAudit += 1;
            } else {
                deletedAudit += 1;
            }
            continue;
        }
        if (
            record.status === 'failed' &&
            (!Array.isArray(record.completedSteps) || record.completedSteps.length === 0) &&
            olderThan(record, cutoff, ['updatedAt', 'createdAt'])
        ) {
            deletedAudit += 1;
            continue;
        }
        nextAudit.push(record);
    }
    db.staffAuditOperations = nextAudit;
    stats.staffAuditOperations = deletedAudit;
    stats.staffAuditOperationsCompacted = compactedAudit;

    const beforeUval = (db.uvalOperations || []).length;
    db.uvalOperations = (db.uvalOperations || []).filter((record) => {
        if (record.status === 'failed') {
            return Array.isArray(record.completedSteps) && record.completedSteps.length > 0
                ? true
                : !olderThan(record, cutoff, ['updatedAt', 'createdAt']);
        }
        if (!UVAL_TERMINAL_STATUSES.has(record.status)) return true;
        return !olderThan(record, cutoff, ['completedAt', 'cancelledAt', 'rejectedAt', 'updatedAt']);
    });
    stats.uvalOperations = beforeUval - db.uvalOperations.length;

    const beforePromotions = (db.staffPromotionHistory || []).length;
    db.staffPromotionHistory = (db.staffPromotionHistory || []).filter((record) => {
        if (record.status === 'reserved') return true;
        if (record.status !== 'completed') return true;
        if (record.dateKey && currentDate) return String(record.dateKey) === currentDate;
        return !olderThan(record, cutoff, ['completedAt', 'updatedAt', 'createdAt']);
    });
    stats.staffPromotionHistory = beforePromotions - db.staffPromotionHistory.length;

    const beforeExamination = (db.examinationRequests || []).length;
    db.examinationRequests = (db.examinationRequests || []).filter((record) => (
        !EXAMINATION_TERMINAL_STATUSES.has(record.status) ||
        !olderThan(record, cutoff, ['completedAt', 'closedAt', 'cancelledAt', 'rejectedAt', 'expiredAt', 'updatedAt'])
    ));
    stats.examinationRequests = beforeExamination - db.examinationRequests.length;

    const beforeVacations = (db.vacationRequests || []).length;
    db.vacationRequests = (db.vacationRequests || []).filter((record) => {
        if (VACATION_IMMEDIATE_TERMINAL_STATUSES.has(record.status)) {
            return !olderThan(record, cutoff, ['closedAt', 'cancelledAt', 'rejectedAt', 'updatedAt']);
        }
        if (!VACATION_USAGE_STATUSES.has(record.status)) return true;
        const usageEndDate = record.status === 'completed' && record.effectiveEndDate
            ? record.effectiveEndDate
            : record.endDate;
        const usageMonth = getDateMonthKey(usageEndDate);
        if (!usageMonth || !currentMonth) return true;
        return usageMonth >= currentMonth;
    });
    stats.vacationRequests = beforeVacations - db.vacationRequests.length;

    return stats;
}

async function runRetentionGc({ now = Date.now() } = {}) {
    const stats = await mutateDb((db) => applyRetention(db, now));
    const changed = Object.values(stats).some((value) => Number(value) > 0);
    if (changed) logger.info('Очистка локальной базы данных завершена', stats);
    return stats;
}

function isUnknownMemberError(error) {
    return Number(error?.code) === DISCORD_UNKNOWN_MEMBER;
}

async function getDismissedMemberKeys(client) {
    const db = readDb();
    const candidates = new Map();
    for (const record of db.disciplineCases || []) {
        if (record.targetType && record.targetType !== 'member') continue;
        const guildId = String(record.guildId || '');
        const memberId = String(record.memberId || '');
        if (!guildId || !memberId) continue;
        candidates.set(`${guildId}:${memberId}`, { guildId, memberId });
    }

    const dismissed = [];
    for (const candidate of candidates.values()) {
        let guild;
        try {
            guild = client.guilds.cache?.get?.(candidate.guildId) || await client.guilds.fetch(candidate.guildId);
        } catch (error) {
            if (Number(error?.code) !== DISCORD_UNKNOWN_GUILD) {
                logger.warn('GC не смог проверить сервер для истории взысканий', candidate, error);
            }
            continue;
        }
        try {
            await guild.members.fetch(candidate.memberId);
        } catch (error) {
            if (isUnknownMemberError(error)) dismissed.push(candidate);
            else logger.warn('GC не смог проверить сотрудника для истории взысканий', candidate, error);
        }
    }
    return dismissed;
}

async function purgeDismissedDiscipline(client, purgeMember) {
    const dismissed = await getDismissedMemberKeys(client);
    let purged = 0;
    for (const { guildId, memberId } of dismissed) {
        try {
            const result = await purgeMember(client, guildId, memberId, { updateDiscord: false });
            purged += Number(result?.cases || 0);
        } catch (error) {
            logger.error('Не удалось удалить историю взысканий уволенного сотрудника', { guildId, memberId }, error);
        }
    }
    return purged;
}

module.exports = {
    DAY_MS,
    applyRetention,
    compactStaffAuditOperation,
    mergeGuildConfigDocuments,
    purgeDismissedDiscipline,
    runRetentionGc,
};
