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

const { installRuntimeStubs } = require('./helpers/runtimeStubs');

function createMember(roleIds = []) {
    const roles = new Set(roleIds.map(String));
    return {
        roles: {
            cache: {
                has: (roleId) => roles.has(String(roleId)),
            },
        },
    };
}

function loadPolicy(fakeDatabase) {
    const restoreRuntime = installRuntimeStubs();
    const databasePath = require.resolve('../src/modules/staff-audit/database');
    const policyPath = require.resolve('../src/modules/staff-audit/promotionPolicy');
    const oldDatabaseCache = require.cache[databasePath];
    const oldPolicyCache = require.cache[policyPath];

    require.cache[databasePath] = {
        id: databasePath,
        filename: databasePath,
        loaded: true,
        exports: {
            readDatabase: () => fakeDatabase,
            mutateDatabase: async (mutator) => mutator(fakeDatabase),
        },
    };
    delete require.cache[policyPath];
    const policy = require(policyPath);

    return {
        policy,
        restore() {
            delete require.cache[policyPath];
            if (oldPolicyCache) require.cache[policyPath] = oldPolicyCache;
            if (oldDatabaseCache) require.cache[databasePath] = oldDatabaseCache;
            else delete require.cache[databasePath];
            restoreRuntime();
        },
    };
}

function createConfig({ termDays = 30, bypassRoleIds = [] } = {}) {
    return {
        staffListSettings: {
            leaderAppointmentDate: '2026-08-01',
            leaderTermDays: termDays,
        },
        staffAuditSettings: {
            promotionLimitBypassRoleIds: bypassRoleIds,
        },
    };
}

test('московская дата переключается в московскую полночь', () => {
    const loaded = loadPolicy({ staffPromotionHistory: [] });
    try {
        assert.equal(loaded.policy.getMoscowDateKey(Date.parse('2026-08-01T20:59:59Z')), '2026-08-01');
        assert.equal(loaded.policy.getMoscowDateKey(Date.parse('2026-08-01T21:00:00Z')), '2026-08-02');
    } finally {
        loaded.restore();
    }
});

test('день назначения и кратные сроку дни определяются отдельно от продлённого периода ДБ', () => {
    const loaded = loadPolicy({ staffPromotionHistory: [] });
    try {
        const config30 = createConfig({ termDays: 30 });
        assert.equal(loaded.policy.isLeaderTermDay(config30, Date.parse('2026-08-01T12:00:00Z')), true);
        assert.equal(loaded.policy.isLeaderTermDay(config30, Date.parse('2026-08-30T12:00:00Z')), false);
        assert.equal(loaded.policy.isLeaderTermDay(config30, Date.parse('2026-08-31T12:00:00Z')), true);
        assert.equal(loaded.policy.isLeaderOpenDoorPeriod(config30, Date.parse('2026-08-01T12:00:00Z')), true);
        assert.equal(loaded.policy.isLeaderOpenDoorPeriod(config30, Date.parse('2026-08-02T12:00:00Z')), true);
        assert.equal(loaded.policy.isLeaderOpenDoorPeriod(config30, Date.parse('2026-08-03T12:00:00Z')), false);
        assert.equal(loaded.policy.isLeaderOpenDoorPeriod(config30, Date.parse('2026-09-01T12:00:00Z')), true);

        const config31 = createConfig({ termDays: 31 });
        assert.equal(loaded.policy.isLeaderTermDay(config31, Date.parse('2026-09-01T12:00:00Z')), true);
    } finally {
        loaded.restore();
    }
});

test('роль обхода и день открытых дверей отключают дневной лимит', () => {
    const loaded = loadPolicy({ staffPromotionHistory: [] });
    try {
        const roleDecision = loaded.policy.getPromotionLimitDecision({
            actor: createMember(['leader']),
            config: createConfig({ bypassRoleIds: ['leader'] }),
            timestamp: Date.parse('2026-08-02T12:00:00Z'),
        });
        assert.equal(roleDecision.bypassed, true);

        const termDecision = loaded.policy.getPromotionLimitDecision({
            actor: createMember(),
            config: createConfig(),
            timestamp: Date.parse('2026-08-31T12:00:00Z'),
        });
        assert.equal(termDecision.bypassed, true);
    } finally {
        loaded.restore();
    }
});

test('второе повышение сотрудника за московский день блокируется', () => {
    const timestamp = Date.parse('2026-08-03T12:00:00Z');
    const fakeDatabase = {
        staffPromotionHistory: [{
            guildId: 'guild',
            targetMemberId: 'member',
            dateKey: '2026-08-03',
            status: 'completed',
            sourceId: 'first',
        }],
    };
    const loaded = loadPolicy(fakeDatabase);
    try {
        assert.throws(() => loaded.policy.assertPromotionDailyLimit({
            guildId: 'guild',
            targetMemberId: 'member',
            actor: createMember(),
            config: createConfig(),
            sourceId: 'second',
            timestamp,
        }), (error) => error?.code === 'promotion_daily_limit');

        const repeated = loaded.policy.assertPromotionDailyLimit({
            guildId: 'guild',
            targetMemberId: 'member',
            actor: createMember(),
            config: createConfig(),
            sourceId: 'first',
            timestamp,
        });
        assert.equal(repeated.idempotent, true);
    } finally {
        loaded.restore();
    }
});

test('запись повышения идемпотентна по sourceId', async () => {
    const fakeDatabase = { staffPromotionHistory: [] };
    const loaded = loadPolicy(fakeDatabase);
    try {
        const input = {
            guildId: 'guild',
            targetMemberId: 'member',
            actorId: 'actor',
            fromRankNumber: 1,
            toRankNumber: 2,
            sourceId: 'operation:1',
            timestamp: Date.parse('2026-08-02T12:00:00Z'),
        };
        const first = await loaded.policy.recordPromotion(input);
        const second = await loaded.policy.recordPromotion(input);
        assert.equal(fakeDatabase.staffPromotionHistory.length, 1);
        assert.equal(first.promotionId, second.promotionId);
        assert.equal(first.dateKey, '2026-08-02');
    } finally {
        loaded.restore();
    }
});

test('резерв повышения атомарно занимает дневной лимит до изменения ролей', async () => {
    const timestamp = Date.parse('2026-08-03T12:00:00Z');
    const fakeDatabase = { staffPromotionHistory: [] };
    const loaded = loadPolicy(fakeDatabase);
    try {
        const reservation = await loaded.policy.reservePromotion({
            guildId: 'guild',
            targetMemberId: 'member',
            actor: createMember(),
            config: createConfig(),
            fromRankNumber: 1,
            toRankNumber: 2,
            sourceId: 'operation:1',
            timestamp,
        });
        assert.equal(reservation.status, 'reserved');

        const repeated = await loaded.policy.reservePromotion({
            guildId: 'guild',
            targetMemberId: 'member',
            actor: createMember(),
            config: createConfig(),
            fromRankNumber: 1,
            toRankNumber: 2,
            sourceId: 'operation:1',
            timestamp,
        });
        assert.equal(repeated.idempotent, true);
        assert.equal(fakeDatabase.staffPromotionHistory.length, 1);

        await assert.rejects(loaded.policy.reservePromotion({
            guildId: 'guild',
            targetMemberId: 'member',
            actor: createMember(),
            config: createConfig(),
            fromRankNumber: 2,
            toRankNumber: 3,
            sourceId: 'operation:2',
            timestamp,
        }), (error) => error?.code === 'promotion_daily_limit');

        const completed = await loaded.policy.recordPromotion({
            guildId: 'guild',
            targetMemberId: 'member',
            actorId: 'actor',
            fromRankNumber: 1,
            toRankNumber: 2,
            sourceId: 'operation:1',
            timestamp,
        });
        assert.equal(completed.status, 'completed');
        assert.equal(fakeDatabase.staffPromotionHistory[0].status, 'completed');
        assert.equal(fakeDatabase.staffPromotionHistory.length, 1);
    } finally {
        loaded.restore();
    }
});
