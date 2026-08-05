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

test('условное снятие ролей отпуска срабатывает на настроенном пороге', () => {
    const restore = installRuntimeStubs();
    try {
        const { getActivationRoleIdsToRemove } = require('../src/modules/vacations');
        const type = {
            removeRoleIdsOnStart: ['100', '200'],
            conditionalRemoveMinDurationDays: 4,
            conditionalRemoveRoleIdsOnStart: ['200', '300'],
        };

        assert.deepEqual(getActivationRoleIdsToRemove(type, 3), ['100', '200']);
        assert.deepEqual(getActivationRoleIdsToRemove(type, 4), ['100', '200', '300']);
        assert.deepEqual(getActivationRoleIdsToRemove(type, 7), ['100', '200', '300']);
    } finally {
        restore();
    }
});

test('повторный пинг экзаменации учитывает статус, срок и уже отправленное уведомление', () => {
    const restore = installRuntimeStubs();
    try {
        const { isPendingReminderDue } = require('../src/modules/examination');
        const now = Date.UTC(2026, 7, 3, 12, 0, 0);
        const request = {
            status: 'pending',
            createdAt: now - 61 * 60_000,
            publishedAt: now - 30 * 60_000,
            pendingReminderAt: null,
        };

        assert.equal(isPendingReminderDue(request, 60, now), false);
        assert.equal(isPendingReminderDue({ ...request, publishedAt: now - 60 * 60_000 }, 60, now), true);
        assert.equal(isPendingReminderDue({ ...request, status: 'waiting_for_voice' }, 10, now), false);
        assert.equal(isPendingReminderDue({ ...request, pendingReminderAt: now - 1_000 }, 10, now), false);
        assert.equal(isPendingReminderDue(request, 0, now), false);
    } finally {
        restore();
    }
});
