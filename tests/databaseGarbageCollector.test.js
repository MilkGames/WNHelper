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
const assert = require('node:assert/strict');
const test = require('./helpers/createTest')(__filename);

const { applyRetention, DAY_MS } = require('../src/core/database/garbageCollector');

function createDb(overrides = {}) {
    return {
        guildConfigs: [],
        shiftSchedules: [],
        staffAuditOperations: [],
        uvalOperations: [],
        staffPromotionHistory: [],
        examinationRequests: [],
        vacationRequests: [],
        ...overrides,
    };
}

test('GC удаляет только старые закрытые смены и terminal операции', () => {
    const now = Date.parse('2026-09-28T12:00:00Z');
    const old = now - DAY_MS - 1;
    const recent = now - DAY_MS + 1;
    const db = createDb({
        shiftSchedules: [
            { id: 'active', status: 'active', updatedAt: old },
            { id: 'old', status: 'closed', closedAt: old },
            { id: 'recent', status: 'closed', closedAt: recent },
        ],
        uvalOperations: [
            { uvalId: 'done', status: 'completed', completedAt: old },
            { uvalId: 'partial', status: 'failed', completedSteps: ['roles'], updatedAt: old },
            { uvalId: 'empty-failed', status: 'failed', completedSteps: [], updatedAt: old },
        ],
        examinationRequests: [
            { requestId: 'done', status: 'completed', completedAt: old },
            { requestId: 'recovery', status: 'completion_failed', updatedAt: old },
        ],
    });

    applyRetention(db, now);

    assert.deepEqual(db.shiftSchedules.map((entry) => entry.id), ['active', 'recent']);
    assert.deepEqual(db.uvalOperations.map((entry) => entry.uvalId), ['partial']);
    assert.deepEqual(db.examinationRequests.map((entry) => entry.requestId), ['recovery']);
});

test('GC сохраняет idempotency для старого message context rank без тяжёлого payload', () => {
    const now = Date.parse('2026-09-28T12:00:00Z');
    const db = createDb({
        staffAuditOperations: [{
            operationId: 'staff-rank-1',
            type: 'rank',
            guildId: '1',
            actorId: '2',
            target: { memberId: '3', displayName: 'User', staticId: '123' },
            payload: { huge: 'payload' },
            rankSnapshot: { huge: 'snapshot' },
            sourceId: 'messageContextRank:1:999',
            status: 'completed',
            completedSteps: ['discord_applied', 'audit_published'],
            completedAt: now - DAY_MS - 1,
            updatedAt: now - DAY_MS - 1,
        }],
    });

    applyRetention(db, now);

    assert.equal(db.staffAuditOperations.length, 1);
    assert.equal(db.staffAuditOperations[0].compacted, true);
    assert.equal(db.staffAuditOperations[0].sourceId, 'messageContextRank:1:999');
    assert.equal('payload' in db.staffAuditOperations[0], false);
    assert.equal('rankSnapshot' in db.staffAuditOperations[0], false);
});

test('promotion history хранит текущий московский день и незавершённые reservations', () => {
    const now = Date.parse('2026-09-28T21:30:00Z'); // 2026-09-29 00:30 MSK
    const db = createDb({
        staffPromotionHistory: [
            { promotionId: 'yesterday', status: 'completed', dateKey: '2026-09-28', completedAt: now - 60_000 },
            { promotionId: 'today', status: 'completed', dateKey: '2026-09-29', completedAt: now - 30_000 },
            { promotionId: 'reserved', status: 'reserved', dateKey: '2026-09-28', createdAt: now - DAY_MS * 10 },
        ],
    });

    applyRetention(db, now);
    assert.deepEqual(db.staffPromotionHistory.map((entry) => entry.promotionId), ['today', 'reserved']);
});

test('отпуск через границу месяца хранится пока его последний учитываемый месяц актуален', () => {
    const september = Date.parse('2026-09-28T12:00:00Z');
    const october = Date.parse('2026-10-02T12:00:00Z');
    const record = {
        requestId: 'cross-month',
        status: 'completed',
        startDate: '2026-08-29',
        endDate: '2026-09-03',
        effectiveEndDate: '2026-09-03',
    };

    const septemberDb = createDb({ vacationRequests: [{ ...record }] });
    applyRetention(septemberDb, september);
    assert.equal(septemberDb.vacationRequests.length, 1);

    const octoberDb = createDb({ vacationRequests: [{ ...record }] });
    applyRetention(octoberDb, october);
    assert.equal(octoberDb.vacationRequests.length, 0);
});

test('дубликаты guild config объединяются без потери полного раннего документа', () => {
    const db = createDb({
        guildConfigs: [
            { guildId: '1', _serverName: 'Server', features: { shifts: true }, botEnabled: false },
            { guildId: '1', _serverName: 'Server' },
        ],
    });

    applyRetention(db, Date.now());
    assert.deepEqual(db.guildConfigs, [{
        guildId: '1',
        _serverName: 'Server',
        features: { shifts: true },
        botEnabled: false,
    }]);
});
