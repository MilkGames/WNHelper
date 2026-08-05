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

function createMember(id, roleIds = [], { bot = false } = {}) {
    const roles = new Set(roleIds.map(String));
    return {
        id: String(id),
        displayName: `Сотрудник ${id}`,
        user: { bot, username: `user-${id}` },
        roles: { cache: { has: (roleId) => roles.has(String(roleId)) } },
    };
}

function createGuild(members, roleIds) {
    const memberMap = new Map(members.map((member) => [String(member.id), member]));
    return {
        roles: { cache: new Map(roleIds.map((roleId) => [String(roleId), { id: String(roleId) }])) },
        members: {
            cache: memberMap,
            fetch: async (memberId) => {
                if (memberId === undefined) return memberMap;
                const member = memberMap.get(String(memberId));
                if (!member) throw new Error('not found');
                return member;
            },
        },
    };
}

test('маршрут пропускает отсутствующего сотрудника и пустые роли', async () => {
    const restore = installRuntimeStubs();
    try {
        const appeals = require('../src/modules/discipline');
        const reviewer = createMember('reviewer', ['final-role']);
        const guild = createGuild([reviewer], ['empty-role', 'final-role']);
        const appeal = {
            applicantId: 'applicant',
            route: [
                { key: 'issuer', type: 'user', userId: 'missing' },
                { key: 'department_head', type: 'roles', roleIds: ['empty-role'] },
                { key: 'final', type: 'roles', roleIds: ['final-role'] },
            ],
        };

        const resolved = await appeals.resolveNextStage(guild, appeal, 0);
        assert.equal(resolved.index, 2);
        assert.equal(resolved.stage.key, 'final');
        assert.deepEqual(resolved.stage.reviewerUserIds, ['reviewer']);
    } finally {
        restore();
    }
});

test('заявитель и боты не могут стать рассматривающими', async () => {
    const restore = installRuntimeStubs();
    try {
        const appeals = require('../src/modules/discipline');
        const applicant = createMember('applicant', ['review-role']);
        const bot = createMember('bot', ['review-role'], { bot: true });
        const guild = createGuild([applicant, bot], ['review-role']);
        const resolved = await appeals.resolveStage(
            guild,
            { key: 'final', type: 'roles', roleIds: ['review-role'] },
            'applicant'
        );
        assert.equal(resolved, null);
    } finally {
        restore();
    }
});

test('пользовательский embed переводит статусы и сохраняет исходный timestamp', () => {
    const restore = installRuntimeStubs();
    try {
        const appeals = require('../src/modules/discipline');
        const createdAt = Date.parse('2026-08-03T10:00:00Z');
        const embed = appeals.buildAppealEmbed({
            applicantId: '100000000000000001',
            applicantDisplayName: 'Тестовый сотрудник',
            type: 'workoff_method',
            sanctionLabel: 'Письменный выговор',
            sanctionMessageLink: 'https://discord.com/channels/1/2/3',
            reason: 'Причина обращения',
            currentMethodName: 'Старый способ',
            requestedMethodName: 'Новый способ',
            approvedMethodName: 'Итоговый способ',
            threadId: '100000000000000002',
            currentStageKey: 'workoff_leadership',
            status: 'pending_review',
            createdAt,
        }).toJSON();
        const serialized = JSON.stringify(embed);

        assert.match(serialized, /Изменение способа отработки/u);
        assert.match(serialized, /Ожидает решения/u);
        assert.match(serialized, /Итоговый способ/u);
        assert.doesNotMatch(serialized, /pending_review|workoff_method|workoff_leadership/u);
        assert.equal(embed.setTimestamp[0].getTime(), createdAt);
    } finally {
        restore();
    }
});

test('отзыв остаётся доступен во всех незакрытых состояниях', () => {
    const restore = installRuntimeStubs();
    try {
        const appeals = require('../src/modules/discipline');
        for (const status of ['pending_review', 'awaiting_escalation', 'routing_failed']) {
            const rows = appeals.buildAppealComponents({
                appealId: 'appeal',
                type: 'basis',
                status,
            });
            const serialized = JSON.stringify(rows.map((row) => row.toJSON()));
            assert.match(serialized, /Отозвать обращение/u, status);
        }
        assert.deepEqual(appeals.buildAppealComponents({ appealId: 'appeal', status: 'withdrawn' }), []);
    } finally {
        restore();
    }
});

test('существующая ветка доказательств восстанавливается по сообщению после сбоя сохранения ID', async () => {
    const restore = installRuntimeStubs();
    try {
        const appeals = require('../src/modules/discipline');
        const thread = { id: 'thread-1' };
        const client = {
            channels: {
                fetch: async (channelId) => String(channelId) === 'message-1' ? thread : null,
            },
        };
        const message = { id: 'message-1', hasThread: true, thread: null };
        const resolved = await appeals.findAppealThread(client, message, { threadId: null });
        assert.equal(resolved, thread);
    } finally {
        restore();
    }
});

test('пересекающиеся паузы продлевают срок только на объединённый интервал', () => {
    const restore = installRuntimeStubs();
    try {
        const discipline = require('../src/modules/discipline/service');

        for (const finishOrder of [['vacation', 'appeal'], ['appeal', 'vacation']]) {
            const part = { status: 'pending', deadlineAt: 1_000 };
            assert.equal(discipline.startWorkoffDeadlinePause(part, 'vacation', 'vac-1', 100), true);
            assert.equal(discipline.startWorkoffDeadlinePause(part, 'appeal', 'appeal-1', 150), true);

            const firstReason = finishOrder[0];
            const firstId = firstReason === 'vacation' ? 'vac-1' : 'appeal-1';
            const secondReason = finishOrder[1];
            const secondId = secondReason === 'vacation' ? 'vac-1' : 'appeal-1';
            const first = discipline.finishWorkoffDeadlinePause(part, firstReason, firstId, 200);
            assert.equal(first.extension, 0);
            assert.equal(part.deadlineAt, 1_000);

            const second = discipline.finishWorkoffDeadlinePause(part, secondReason, secondId, 250);
            assert.equal(second.extension, 150);
            assert.equal(part.deadlineAt, 1_150);
            assert.equal(part.deadlinePauseStartedAt, null);
        }
    } finally {
        restore();
    }
});

test('непересекающиеся паузы продлевают срок отдельно', () => {
    const restore = installRuntimeStubs();
    try {
        const discipline = require('../src/modules/discipline/service');
        const part = { status: 'pending', deadlineAt: 1_000 };

        discipline.startWorkoffDeadlinePause(part, 'vacation', 'vac-1', 100);
        discipline.finishWorkoffDeadlinePause(part, 'vacation', 'vac-1', 150);
        discipline.startWorkoffDeadlinePause(part, 'appeal', 'appeal-1', 200);
        discipline.finishWorkoffDeadlinePause(part, 'appeal', 'appeal-1', 250);

        assert.equal(part.deadlineAt, 1_100);
    } finally {
        restore();
    }
});

test('один и тот же сотрудник не рассматривает обращение на двух уровнях подряд', async () => {
    const restore = installRuntimeStubs();
    try {
        const appeals = require('../src/modules/discipline');
        const previousReviewer = createMember('reviewer-1', ['head-role', 'final-role']);
        const nextReviewer = createMember('reviewer-2', ['head-role']);
        const guild = createGuild([previousReviewer, nextReviewer], ['head-role', 'final-role']);
        const appeal = {
            applicantId: 'applicant',
            route: [
                { key: 'issuer', type: 'user', userId: 'reviewer-1' },
                { key: 'department_head', type: 'roles', roleIds: ['head-role'] },
                { key: 'final', type: 'roles', roleIds: ['final-role'] },
            ],
            history: [{
                action: 'routed',
                routeIndex: 0,
                reviewerUserIds: ['reviewer-1'],
            }],
        };

        const resolved = await appeals.resolveNextStage(guild, appeal, 1);
        assert.equal(resolved.index, 1);
        assert.deepEqual(resolved.stage.reviewerUserIds, ['reviewer-2']);

        appeal.history.push({
            action: 'routed',
            routeIndex: 1,
            reviewerUserIds: ['reviewer-2'],
        });
        const finalStage = await appeals.resolveNextStage(guild, appeal, 2);
        assert.equal(finalStage, null);
    } finally {
        restore();
    }
});

test('повторное изменение способа доступно только после удовлетворённого предыдущего обращения', () => {
    const restore = installRuntimeStubs();
    try {
        const appeals = require('../src/modules/discipline');
        const base = {
            caseId: 'case-1',
            sanctionId: 'sanction-1',
            type: 'workoff_method',
        };
        assert.equal(appeals.findBlockingAppeal([{ ...base, status: 'withdrawn' }], base)?.status, 'withdrawn');
        assert.equal(appeals.findBlockingAppeal([{ ...base, status: 'rejected_final' }], base)?.status, 'rejected_final');
        assert.equal(appeals.findBlockingAppeal([{ ...base, status: 'satisfied' }], base), null);

        const basis = { ...base, type: 'basis', status: 'satisfied' };
        assert.equal(appeals.findBlockingAppeal([basis], basis)?.status, 'satisfied');
    } finally {
        restore();
    }
});
