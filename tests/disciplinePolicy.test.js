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

const policy = require('../src/modules/discipline/policy');

function createMember(id, roleIds = [], guild = null) {
    const roles = new Set(roleIds.map(String));
    return {
        id,
        guild,
        roles: {
            cache: {
                has: (roleId) => roles.has(String(roleId)),
            },
        },
    };
}

function createConfig(overrides = {}) {
    return {
        departments: [{
            id: 'rdd',
            shortName: 'RDD',
            fullName: 'Recruitment & Disciplinary Department',
            roles: {
                memberRoleId: 'rdd-member',
                partTimeRoleId: 'rdd-part-time',
                headRoleId: 'rdd-head',
                deputyHeadRoleId: 'rdd-deputy',
            },
        }],
        disciplineSettings: {
            issuePolicy: {
                enabled: true,
                leadershipRoleIds: ['leadership'],
                examinerRoleIds: ['examiner'],
                departmentLeadershipEnabled: true,
                fallbackPermissionMode: 'unconditional',
                ...overrides,
            },
        },
    };
}

test('отключённая политика сохраняет старое разрешающее поведение', () => {
    const decision = policy.evaluateIssuePermission(null, null, createConfig({ enabled: false }));
    assert.deepEqual(decision, { allowed: true, reason: 'policy_disabled' });
});

test('руководство может выдать взыскание любому сотруднику', () => {
    const decision = policy.evaluateIssuePermission(
        createMember('actor', ['leadership']),
        createMember('target', ['rdd-member']),
        createConfig()
    );
    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, 'leadership');
});

test('экзаменатор не может выдать взыскание руководящему составу', () => {
    const decision = policy.evaluateIssuePermission(
        createMember('actor', ['examiner']),
        createMember('target', ['leadership']),
        createConfig()
    );
    assert.deepEqual(decision, { allowed: false, reason: 'examiner_cannot_target_leadership' });
});

test('экзаменатор может выдать взыскание обычному сотруднику', () => {
    const decision = policy.evaluateIssuePermission(
        createMember('actor', ['examiner']),
        createMember('target', ['rdd-member']),
        createConfig()
    );
    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, 'examiner');
});

test('глава и заместитель отдела ограничены своим основным составом и подработкой', () => {
    const config = createConfig();
    const ownMember = policy.evaluateIssuePermission(
        createMember('actor', ['rdd-head']),
        createMember('target', ['rdd-member']),
        config
    );
    const partTimeMember = policy.evaluateIssuePermission(
        createMember('actor', ['rdd-deputy']),
        createMember('target', ['rdd-part-time']),
        config
    );
    const otherMember = policy.evaluateIssuePermission(
        createMember('actor', ['rdd-head']),
        createMember('target', ['other-department']),
        config
    );

    assert.equal(ownMember.reason, 'department_leadership');
    assert.equal(partTimeMember.reason, 'department_leadership');
    assert.deepEqual(otherMember, { allowed: false, reason: 'no_matching_authority' });
});

test('режим fallback с проверкой повторно применяет матрицу полномочий', () => {
    const target = createMember('target', ['rdd-member']);
    const memberMap = new Map([['target', target]]);
    const guild = { members: { cache: memberMap } };
    const actor = createMember('actor', ['rdd-head'], guild);
    const outsider = createMember('outsider', [], guild);
    const config = createConfig({ fallbackPermissionMode: 'policy' });
    const caseRecord = { memberId: 'target' };

    assert.equal(policy.canUseFallbackPermission(actor, caseRecord, config), true);
    assert.equal(policy.canUseFallbackPermission(outsider, caseRecord, config), false);
    assert.equal(policy.canUseFallbackPermission(outsider, caseRecord, createConfig()), true);
});
