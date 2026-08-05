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
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('./helpers/createTest')(__filename);
const { writeTestConfig } = require('./helpers/testConfig');
const { installRuntimeStubs } = require('./helpers/runtimeStubs');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function createIsolatedShifts() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-helper-shifts-'));
    fs.cpSync(path.join(PROJECT_ROOT, 'src'), path.join(root, 'src'), { recursive: true });
    writeTestConfig(root);
    const database = require(path.join(root, 'src', 'core', 'database', 'localDatabase.js'));
    database.initializeDatabase();
    const shiftsDatabase = require(path.join(root, 'src', 'modules', 'shifts', 'database.js'));
    const shiftsService = require(path.join(root, 'src', 'modules', 'shifts', 'service.js'));
    return { root, database, shiftsDatabase, shiftsService };
}

function schedule(dateKey, status = 'active') {
    return {
        guildId: '1',
        typeId: `type-${dateKey}-${status}`,
        dateKey,
        status,
        revision: 0,
        slots: [
            { id: 'slot-1', number: 1, memberId: 'target' },
            { id: 'slot-2', number: 2, memberId: 'other' },
        ],
    };
}

test('отпуск освобождает только активные смены внутри включительного периода', async (context) => {
    const restore = installRuntimeStubs();
    const isolated = createIsolatedShifts();
    context.after(() => {
        restore();
        fs.rmSync(isolated.root, { recursive: true, force: true });
    });

    for (const record of [
        schedule('2026-08-01'),
        schedule('2026-08-02'),
        schedule('2026-08-03'),
        schedule('2026-08-04'),
        schedule('2026-08-02', 'closed'),
    ]) {
        await new isolated.shiftsDatabase.shiftSchedules(record).save();
    }

    const changed = await isolated.shiftsService.releaseMemberFromSchedulesInPeriod(
        null,
        '1',
        'target',
        '2026-08-02',
        '2026-08-03'
    );
    assert.equal(changed, 2);

    const records = await isolated.shiftsDatabase.shiftSchedules.find({ guildId: '1' });
    const byKey = new Map(records.map((record) => [`${record.dateKey}:${record.status}`, record]));
    assert.equal(byKey.get('2026-08-01:active').slots[0].memberId, 'target');
    assert.equal(byKey.get('2026-08-02:active').slots[0].memberId, null);
    assert.equal(byKey.get('2026-08-03:active').slots[0].memberId, null);
    assert.equal(byKey.get('2026-08-04:active').slots[0].memberId, 'target');
    assert.equal(byKey.get('2026-08-02:closed').slots[0].memberId, 'target');
    assert.equal(byKey.get('2026-08-02:active').slots[1].memberId, 'other');
});

test('автоматическое снятие из-за отпуска записывается в ветку журнала смен', async (context) => {
    const restore = installRuntimeStubs();
    const isolated = createIsolatedShifts();
    context.after(() => {
        restore();
        fs.rmSync(isolated.root, { recursive: true, force: true });
    });

    const record = {
        ...schedule('2026-08-02'),
        channelId: 'channel-1',
        messageId: 'message-1',
        threadId: 'thread-1',
        typeSnapshot: {
            id: 'news',
            name: 'Смены новостей',
            enabled: true,
            channelId: 'channel-1',
            schedule: { startTime: '10:00', endTime: '12:00', slotDurationMinutes: 60 },
            publication: { mode: 'fixed', time: '21:00' },
            accessGroups: [],
            managerRoleIds: [],
        },
    };
    await new isolated.shiftsDatabase.shiftSchedules(record).save();

    const auditMessages = [];
    const thread = {
        id: 'thread-1',
        archived: false,
        isThread: () => true,
        async send(payload) {
            auditMessages.push(payload);
            return { id: 'audit-1' };
        },
    };
    const message = { id: 'message-1', guild: { channels: null } };
    const channel = {
        id: 'channel-1',
        messages: { async fetch() { return message; } },
    };
    message.guild.channels = {
        async fetch(channelId) {
            return channelId === thread.id ? thread : channel;
        },
    };
    const client = {
        channels: {
            async fetch(channelId) {
                return channelId === thread.id ? thread : channel;
            },
        },
    };

    const changed = await isolated.shiftsService.releaseMemberFromSchedulesInPeriod(
        client,
        '1',
        'target',
        '2026-08-02',
        '2026-08-02',
        { reason: 'vacation:vac-1' }
    );

    assert.equal(changed, 1);
    assert.equal(auditMessages.length, 1);
    assert.match(auditMessages[0].content, /автоматически освободила/);
    assert.match(auditMessages[0].content, /<@target>/);
    assert.match(auditMessages[0].content, /№1/);
    assert.match(auditMessages[0].content, /Причина: Отпуск сотрудника/);
});

test('автоматическое снятие при увольнении также записывается в ветку журнала смен', async (context) => {
    const restore = installRuntimeStubs();
    const isolated = createIsolatedShifts();
    context.after(() => {
        restore();
        fs.rmSync(isolated.root, { recursive: true, force: true });
    });

    const record = {
        ...schedule('2026-08-05'),
        channelId: 'channel-dismissal',
        messageId: 'message-dismissal',
        threadId: 'thread-dismissal',
        typeSnapshot: {
            id: 'news',
            name: 'Смены новостей',
            enabled: true,
            channelId: 'channel-dismissal',
            schedule: { startTime: '10:00', endTime: '12:00', slotDurationMinutes: 60 },
            publication: { mode: 'fixed', time: '21:00' },
            accessGroups: [],
            managerRoleIds: [],
        },
    };
    await new isolated.shiftsDatabase.shiftSchedules(record).save();

    const auditMessages = [];
    const thread = {
        id: record.threadId,
        archived: false,
        isThread: () => true,
        async send(payload) {
            auditMessages.push(payload);
            return { id: 'audit-dismissal' };
        },
    };
    const message = { id: record.messageId, guild: { channels: null } };
    const channel = {
        id: record.channelId,
        messages: { async fetch() { return message; } },
    };
    message.guild.channels = {
        async fetch(channelId) {
            return channelId === thread.id ? thread : channel;
        },
    };
    const client = {
        channels: {
            async fetch(channelId) {
                return channelId === thread.id ? thread : channel;
            },
        },
    };

    const changed = await isolated.shiftsService.releaseMemberFromSchedules(
        client,
        '1',
        'target',
        { reason: 'dismissal:uval-1' }
    );

    assert.equal(changed, 1);
    assert.equal(auditMessages.length, 1);
    assert.match(auditMessages[0].content, /Причина: Увольнение сотрудника/);
});
