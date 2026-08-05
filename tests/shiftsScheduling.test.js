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

function shiftType(overrides = {}) {
    return {
        id: 'news',
        name: 'Смены новостей',
        headerTemplate: '✅ {name} на {date}:',
        enabled: true,
        channelId: '100000000000000001',
        color: '#F1C40F',
        publication: { mode: 'fixed', time: '21:00' },
        schedule: { startTime: '10:00', endTime: '13:00', slotDurationMinutes: 60 },
        maxSlotsPerMember: 1,
        rotateAccessDaily: false,
        accessGroups: [],
        managerRoleIds: [],
        ...overrides,
    };
}

test('случайное время публикации стабильно и остаётся внутри заданного окна', () => {
    const restore = installRuntimeStubs();
    try {
        const service = require('../src/modules/shifts/service');
        const type = shiftType({
            publication: { mode: 'random', fromTime: '20:15', toTime: '22:45' },
        });
        const first = service.getPublicationSchedule('guild-1', type, '2026-08-28');
        const repeated = service.getPublicationSchedule('guild-1', type, '2026-08-28');
        assert.deepEqual(first, repeated);
        assert.equal(first.actualDateKey, '2026-08-28');
        assert.ok(first.time >= '20:15' && first.time <= '22:45');
    } finally {
        restore();
    }
});

test('случайное окно публикации поддерживает переход через полночь', () => {
    const restore = installRuntimeStubs();
    try {
        const service = require('../src/modules/shifts/service');
        const type = shiftType({
            publication: { mode: 'random', fromTime: '23:00', toTime: '01:00' },
        });
        const schedule = service.getPublicationSchedule('guild-2', type, '2026-08-28');
        assert.ok(['2026-08-28', '2026-08-29'].includes(schedule.actualDateKey));
        assert.equal(
            schedule.time >= '23:00' || schedule.time <= '01:00',
            true
        );
    } finally {
        restore();
    }
});

test('перестройка слотов сохраняет назначения только у совпадающих интервалов', () => {
    const restore = installRuntimeStubs();
    try {
        const service = require('../src/modules/shifts/service');
        const result = service.reconcileSlots(shiftType(), [
            { id: 's1', number: 1, startTime: '10:00', endTime: '10:59', memberId: 'member-1' },
            { id: 's2', number: 2, startTime: '11:00', endTime: '11:29', memberId: 'member-2' },
        ]);
        assert.equal(result.changed, true);
        assert.equal(result.slots.length, 3);
        assert.equal(result.slots[0].memberId, 'member-1');
        assert.equal(result.slots[1].memberId, null);
    } finally {
        restore();
    }
});

test('активное сообщение смен получает актуальные настройки вместо старого snapshot', async () => {
    const restoreRuntime = installRuntimeStubs();
    const databasePath = require.resolve('../src/modules/shifts/database');
    const servicePath = require.resolve('../src/modules/shifts/service');
    const oldDatabase = require.cache[databasePath];
    const oldService = require.cache[servicePath];
    const stored = {};
    const shiftSchedules = {
        async replaceOne(_query, replacement) {
            Object.assign(stored, structuredClone(replacement));
            return { matchedCount: 1, modifiedCount: 1 };
        },
        async updateOne(_query, patch) {
            Object.assign(stored, structuredClone(patch));
            return { matchedCount: 1, modifiedCount: 1 };
        },
    };
    require.cache[databasePath] = {
        id: databasePath,
        filename: databasePath,
        loaded: true,
        exports: {
            shiftSchedules,
            shiftRotations: {},
        },
    };
    delete require.cache[servicePath];

    let editedPayload = null;
    const message = {
        id: 'message-1',
        async edit(payload) {
            editedPayload = payload;
            return this;
        },
    };
    const client = {
        channels: {
            async fetch() {
                return {
                    id: '100000000000000001',
                    messages: {
                        async fetch() {
                            return message;
                        },
                    },
                    async send() {
                        throw new Error('Сообщение не должно переноситься');
                    },
                };
            },
        },
    };
    const currentType = shiftType({ name: 'Обновлённые смены' });
    const record = {
        guildId: 'guild-1',
        typeId: 'news',
        dateKey: '2099-08-28',
        channelId: currentType.channelId,
        messageId: 'message-1',
        publishedAt: Date.now(),
        activeUntil: Date.parse('2099-08-28T13:00:00+03:00'),
        rotationIndex: 0,
        renderedStage: 0,
        notifiedStage: 0,
        typeSnapshot: shiftType({
            name: 'Старые смены',
            schedule: { startTime: '10:00', endTime: '12:00', slotDurationMinutes: 60 },
        }),
        revision: 0,
        messageRevision: 0,
        renderedTypeSignature: 'old-signature',
        status: 'active',
        slots: [
            { id: 's1', number: 1, startTime: '10:00', endTime: '10:59', memberId: 'member-1' },
            { id: 's2', number: 2, startTime: '11:00', endTime: '11:59', memberId: null },
        ],
    };

    try {
        const service = require(servicePath);
        await service.syncActiveSchedule(client, { features: { shifts: true } }, currentType, record, Date.now());
        assert.equal(stored.typeSnapshot.name, 'Обновлённые смены');
        assert.equal(stored.slots.length, 3);
        assert.equal(stored.slots[0].memberId, 'member-1');
        assert.ok(editedPayload);
    } finally {
        delete require.cache[servicePath];
        if (oldService) require.cache[servicePath] = oldService;
        if (oldDatabase) require.cache[databasePath] = oldDatabase;
        else delete require.cache[databasePath];
        restoreRuntime();
    }
});

test('изменение канала переносит активное сообщение смен и удаляет старое', async () => {
    const restoreRuntime = installRuntimeStubs();
    const databasePath = require.resolve('../src/modules/shifts/database');
    const servicePath = require.resolve('../src/modules/shifts/service');
    const oldDatabase = require.cache[databasePath];
    const oldService = require.cache[servicePath];
    const stored = {};
    const shiftSchedules = {
        async replaceOne(_query, replacement) {
            Object.assign(stored, structuredClone(replacement));
            return { matchedCount: 1, modifiedCount: 1 };
        },
        async updateOne(_query, patch) {
            Object.assign(stored, structuredClone(patch));
            return { matchedCount: 1, modifiedCount: 1 };
        },
    };
    require.cache[databasePath] = {
        id: databasePath,
        filename: databasePath,
        loaded: true,
        exports: { shiftSchedules, shiftRotations: {} },
    };
    delete require.cache[servicePath];

    let oldDeleted = false;
    let newSendCount = 0;
    const oldMessage = {
        id: 'old-message',
        async delete() {
            oldDeleted = true;
        },
    };
    const newMessage = { id: 'new-message' };
    const oldChannel = {
        id: '100000000000000001',
        messages: { async fetch() { return oldMessage; } },
    };
    const newChannel = {
        id: '100000000000000002',
        isTextBased: () => true,
        messages: {},
        async send() {
            newSendCount += 1;
            return newMessage;
        },
    };
    const client = {
        channels: {
            async fetch(channelId) {
                return channelId === oldChannel.id ? oldChannel : newChannel;
            },
        },
    };
    const currentType = shiftType({ channelId: newChannel.id });
    const record = {
        guildId: 'guild-1',
        typeId: 'news',
        dateKey: '2099-08-28',
        channelId: oldChannel.id,
        messageId: oldMessage.id,
        publishedAt: Date.now(),
        activeUntil: Date.parse('2099-08-28T13:00:00+03:00'),
        rotationIndex: 0,
        renderedStage: 0,
        notifiedStage: 0,
        typeSnapshot: shiftType({ channelId: oldChannel.id }),
        revision: 0,
        messageRevision: 0,
        renderedTypeSignature: 'old-signature',
        status: 'active',
        slots: [
            { id: 's1', number: 1, startTime: '10:00', endTime: '10:59', memberId: null },
            { id: 's2', number: 2, startTime: '11:00', endTime: '11:59', memberId: null },
            { id: 's3', number: 3, startTime: '12:00', endTime: '12:59', memberId: null },
        ],
    };

    try {
        const service = require(servicePath);
        await service.syncActiveSchedule(client, { features: { shifts: true } }, currentType, record, Date.now());
        assert.equal(newSendCount, 1);
        assert.equal(oldDeleted, true);
        assert.equal(stored.channelId, newChannel.id);
        assert.equal(stored.messageId, newMessage.id);
        assert.equal(stored.threadId, null);
    } finally {
        delete require.cache[servicePath];
        if (oldService) require.cache[servicePath] = oldService;
        if (oldDatabase) require.cache[databasePath] = oldDatabase;
        else delete require.cache[databasePath];
        restoreRuntime();
    }
});

test('отключение типа смен закрывает уже опубликованное расписание', async () => {
    const restoreRuntime = installRuntimeStubs();
    const databasePath = require.resolve('../src/modules/shifts/database');
    const servicePath = require.resolve('../src/modules/shifts/service');
    const oldDatabase = require.cache[databasePath];
    const oldService = require.cache[servicePath];
    const stored = {};
    const shiftSchedules = {
        async replaceOne(_query, replacement) {
            Object.assign(stored, structuredClone(replacement));
            return { matchedCount: 1, modifiedCount: 1 };
        },
        async updateOne(_query, patch) {
            Object.assign(stored, structuredClone(patch));
            return { matchedCount: 1, modifiedCount: 1 };
        },
    };
    require.cache[databasePath] = {
        id: databasePath,
        filename: databasePath,
        loaded: true,
        exports: { shiftSchedules, shiftRotations: {} },
    };
    delete require.cache[servicePath];

    let edited = false;
    let threadLocked = false;
    let threadArchived = false;
    const message = {
        id: 'message-1',
        async edit() {
            edited = true;
            return this;
        },
    };
    const thread = {
        id: 'thread-1',
        archived: false,
        locked: false,
        isThread: () => true,
        async setLocked(value) {
            threadLocked = value;
            this.locked = value;
            return this;
        },
        async setArchived(value) {
            threadArchived = value;
            this.archived = value;
            return this;
        },
    };
    const channel = {
        id: '100000000000000001',
        messages: { async fetch() { return message; } },
    };
    const client = {
        channels: {
            async fetch(channelId) {
                return channelId === thread.id ? thread : channel;
            },
        },
    };
    const record = {
        guildId: 'guild-1',
        typeId: 'news',
        dateKey: '2099-08-28',
        channelId: '100000000000000001',
        messageId: message.id,
        threadId: thread.id,
        publishedAt: Date.now(),
        activeUntil: Date.parse('2099-08-28T13:00:00+03:00'),
        rotationIndex: 0,
        renderedStage: 0,
        notifiedStage: 0,
        typeSnapshot: shiftType(),
        revision: 0,
        messageRevision: 0,
        renderedTypeSignature: 'signature',
        status: 'active',
        slots: [],
    };

    try {
        const service = require(servicePath);
        await service.syncActiveSchedule(
            client,
            { features: { shifts: true } },
            shiftType({ enabled: false }),
            record,
            Date.now()
        );
        assert.equal(stored.status, 'closed');
        assert.equal(stored.closeReason, 'type-disabled');
        assert.equal(stored.typeSnapshot.enabled, false);
        assert.equal(edited, true);
        assert.equal(threadLocked, true);
        assert.equal(threadArchived, true);
    } finally {
        delete require.cache[servicePath];
        if (oldService) require.cache[servicePath] = oldService;
        if (oldDatabase) require.cache[databasePath] = oldDatabase;
        else delete require.cache[databasePath];
        restoreRuntime();
    }
});
