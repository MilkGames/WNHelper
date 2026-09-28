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
const path = require('node:path');
const nodeTest = require('node:test');
const test = require('./helpers/createTest')(__filename);
const { installRuntimeStubs } = require('./helpers/runtimeStubs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const restoreRuntimeStubs = installRuntimeStubs();
nodeTest.after(restoreRuntimeStubs);

function loadWithMocks(relativeTarget, mocks) {
    const targetPath = require.resolve(path.join(PROJECT_ROOT, relativeTarget));
    const savedEntries = new Map();

    for (const [relativeMockPath, exportsValue] of Object.entries(mocks)) {
        const mockPath = require.resolve(path.join(PROJECT_ROOT, relativeMockPath));
        savedEntries.set(mockPath, require.cache[mockPath]);
        require.cache[mockPath] = {
            id: mockPath,
            filename: mockPath,
            loaded: true,
            exports: exportsValue,
        };
    }

    const previousTarget = require.cache[targetPath];
    delete require.cache[targetPath];
    const loaded = require(targetPath);

    return {
        loaded,
        restore() {
            delete require.cache[targetPath];
            if (previousTarget) require.cache[targetPath] = previousTarget;
            for (const [mockPath, entry] of savedEntries) {
                if (entry) require.cache[mockPath] = entry;
                else delete require.cache[mockPath];
            }
        },
    };
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

test('массовый КА выполняет invite, rank и uval для текстовых сотрудников', async () => {
    const db = { staffAuditBatches: [] };
    const calls = {
        assignments: 0,
        invites: [],
        ranks: [],
        dismissals: [],
    };
    const config = { features: { staffAudit: true } };
    const guild = {
        id: 'guild-1',
        members: {
            fetch: async () => null,
        },
    };
    const actor = { id: 'actor-1', guild };

    class StaffAuditBatchModel {
        constructor(record) {
            Object.assign(this, clone(record));
        }

        async save() {
            db.staffAuditBatches.push(clone(this));
            return this;
        }

        static async findOne(query) {
            const record = db.staffAuditBatches.find((entry) => entry.massauditId === query.massauditId);
            return record ? clone(record) : null;
        }
    }

    const mocked = loadWithMocks('src/modules/staff-audit/batchService.js', {
        'src/modules/staff-audit/settings/schema.js': {
            getStaffAuditSettings: () => ({ massAuditMaxItems: 25 }),
        },
        'src/modules/staff-audit/database.js': {
            staffAuditBatches: StaffAuditBatchModel,
            mutateDatabase: async (mutator) => mutator(db),
        },
        'src/modules/give-roles/index.js': {
            getManualAssignmentErrors: (_guild, _config, options) => ({
                errors: [],
                assignment: {
                    rank: { number: Number(options.rankNumber || 1) },
                    department: null,
                    departmentOverridden: false,
                },
            }),
            getMemberAssignmentErrors: () => [],
            applyAssignment: async () => { calls.assignments += 1; },
        },
        'src/core/config/guildConfigService.js': {
            get: () => config,
        },
        'src/modules/staff-audit/ranks.js': {
            getGrantDecision: () => ({ allowed: true }),
            getMemberRankMatches: () => [],
        },
        'src/modules/staff-audit/policy.js': {
            assertCanDismissTarget: () => ({ targetRank: null }),
            assertCanManageTarget: () => undefined,
            buildMemberStateHash: () => 'state',
        },
        'src/modules/staff-audit/service.js': {
            assertFeatureEnabled: () => undefined,
            resolveMemberInput: async (_guild, memberInput, staticId) => ({
                member: null,
                memberId: null,
                displayName: memberInput,
                staticId,
                displayValue: memberInput,
            }),
            parseRankAction: (actionInput) => {
                const [fromNumber, toNumber] = actionInput.split('-').map(Number);
                return {
                    fromNumber,
                    toNumber,
                    promotion: toNumber > fromNumber,
                    formattedAction: `${toNumber > fromNumber ? 'Повышен' : 'Понижен'} ${fromNumber}-${toNumber}`,
                };
            },
            extractBaseName: (name) => name,
            sendInviteRecord: async (_client, payload) => { calls.invites.push(payload); },
            changeRank: async (_client, payload) => {
                calls.ranks.push(payload);
                return { rankAction: { formattedAction: 'Повышен 1-2' } };
            },
            dismissMember: async (_client, payload) => {
                calls.dismissals.push(payload);
                return { status: 'completed', operation: { uvalId: 'uval-1' } };
            },
        },
        'src/core/integrations/actionRegistry.js': {
            invokeAction: async () => undefined,
        },
    });

    try {
        const batch = await mocked.loaded.createBatch(null, {
            guild,
            config,
            actor,
            text: [
                'invite member:Michael Lindberg static:7658 rank:1',
                'rank member:Anna Smith static:7659 action:1-2 reason:"Повышение"',
                'uval member:John Doe static:7660 reason:"ПСЖ"',
            ].join('\n'),
        });

        assert.equal(batch.items.length, 3);
        assert.equal(batch.items.every((item) => item.memberId === null), true);
        assert.match(mocked.loaded.buildPreview(batch), /Michael Lindberg \| 7658/u);
        assert.doesNotMatch(mocked.loaded.buildPreview(batch), /<@null>/u);

        const client = { guilds: { fetch: async () => guild } };
        const result = await mocked.loaded.executeBatch(client, {
            massauditId: batch.massauditId,
            actor,
        });

        assert.equal(result.status, 'completed');
        assert.equal(calls.assignments, 0);
        assert.equal(calls.invites.length, 1);
        assert.equal(calls.invites[0].target.displayName, 'Michael Lindberg');
        assert.equal(calls.ranks.length, 1);
        assert.equal(calls.ranks[0].actionInput, '1-2');
        assert.equal(calls.ranks[0].target.member, null);
        assert.equal(calls.dismissals.length, 1);
        assert.equal(calls.dismissals[0].target.displayName, 'John Doe');
    } finally {
        mocked.restore();
    }
});
