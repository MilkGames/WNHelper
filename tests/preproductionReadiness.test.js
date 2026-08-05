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
const path = require('node:path');
const test = require('./helpers/createTest')(__filename);
const { installRuntimeStubs } = require('./helpers/runtimeStubs');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function createCommandInteraction(commandName, userId) {
    const state = {
        callbackCalled: false,
        replyPayload: null,
        editPayload: null,
    };
    return {
        commandName,
        channelId: '100000000000000001',
        guildId: '100000000000000002',
        user: { id: userId },
        deferred: false,
        replied: false,
        options: { data: [] },
        isAutocomplete: () => false,
        isChatInputCommand: () => true,
        inGuild: () => true,
        async reply(payload) {
            state.replyPayload = payload;
            this.replied = true;
        },
        async editReply(payload) {
            state.editPayload = payload;
        },
        state,
    };
}

async function withCommandHandler(command, callback) {
    const restoreStubs = installRuntimeStubs();
    const registryPath = require.resolve('../src/app/commandRegistry');
    const handlerPath = require.resolve('../src/app/commandHandler');
    const previousRegistry = require.cache[registryPath];
    const previousHandler = require.cache[handlerPath];

    require.cache[registryPath] = {
        id: registryPath,
        filename: registryPath,
        loaded: true,
        exports: { getCommand: () => command },
        children: [],
        paths: [],
    };
    delete require.cache[handlerPath];

    try {
        const commandHandler = require(handlerPath);
        await callback(commandHandler);
    } finally {
        if (previousRegistry) require.cache[registryPath] = previousRegistry;
        else delete require.cache[registryPath];
        if (previousHandler) require.cache[handlerPath] = previousHandler;
        else delete require.cache[handlerPath];
        restoreStubs();
    }
}

test('owner-only команда не доходит до callback обычного пользователя', async () => {
    let callbackCalled = false;
    const command = {
        name: 'owner_test',
        ownerOnly: true,
        callback: async () => {
            callbackCalled = true;
        },
    };

    await withCommandHandler(command, async (commandHandler) => {
        const interaction = createCommandInteraction('owner_test', '999999999999999999');
        await commandHandler({}, interaction);
        assert.equal(callbackCalled, false);
        assert.match(String(interaction.state.replyPayload?.content || ''), /только владельцу/iu);
        assert.deepEqual(interaction.state.replyPayload?.allowedMentions, { parse: [] });
    });
});

test('неожиданная ошибка общего command handler показывает безопасную причину', async () => {
    const previousTestKey = process.env.TEST_KEY;
    process.env.TEST_KEY = 'preproduction-secret';
    try {
        const command = {
            name: 'broken_test',
            callback: async () => {
                throw new Error('Сбой preproduction-secret');
            },
        };

        await withCommandHandler(command, async (commandHandler) => {
            const interaction = createCommandInteraction('broken_test', '999999999999999999');
            await commandHandler({}, interaction);
            const content = String(interaction.state.replyPayload?.content || '');
            assert.match(content, /Техническая причина/iu);
            assert.match(content, /СКРЫТО/u);
            assert.doesNotMatch(content, /preproduction-secret/u);
            assert.deepEqual(interaction.state.replyPayload?.allowedMentions, { parse: [] });
        });
    } finally {
        if (previousTestKey === undefined) delete process.env.TEST_KEY;
        else process.env.TEST_KEY = previousTestKey;
    }
});

test('полный скан сообщений помечен owner-only и не допускает параллельные запуски', () => {
    const restore = installRuntimeStubs();
    try {
        const command = require('../src/modules/analytics/command');
        const source = fs.readFileSync(
            path.join(PROJECT_ROOT, 'src/modules/analytics/command.js'),
            'utf8'
        );
        assert.equal(command.ownerOnly, true);
        assert.match(source, /if \(running\.size > 0\)/u);
        assert.doesNotMatch(source, /if \(running\.has\(guildId\)\)/u);
        assert.doesNotMatch(source, /Данные сохранены в \$\{DATA_FILE\}/u);
    } finally {
        restore();
    }
});

test('воркер экзаменационных вебхуков участвует в остановке модуля', async () => {
    const restore = installRuntimeStubs();
    try {
        const webhookWorker = require('../src/modules/examination/events/webhook');
        const examination = require('../src/modules/examination');
        assert.equal(typeof webhookWorker.stopWebhookWorker, 'function');
        assert.equal(typeof webhookWorker.getWebhookWorkerStatus, 'function');
        assert.equal(typeof examination.stop, 'function');
        await examination.stop();
        assert.equal(webhookWorker.getWebhookWorkerStatus().workerStarted, false);
    } finally {
        restore();
    }
});

test('сравнение slash-команд учитывает числовые, строковые и канальные ограничения', () => {
    const areCommandsDifferent = require('../src/core/discord/areCommandsDifferent');
    const baseOption = {
        name: 'value',
        description: 'Значение',
        type: 4,
        required: true,
        minValue: 1,
        maxValue: 10,
        minLength: 2,
        maxLength: 20,
        channelTypes: [0, 5],
    };
    const existing = { description: 'Тест', options: [baseOption] };

    assert.equal(areCommandsDifferent(existing, {
        description: 'Тест',
        options: [{ ...baseOption, channelTypes: [5, 0] }],
    }), false);
    assert.equal(areCommandsDifferent(existing, {
        description: 'Тест',
        options: [{ ...baseOption, minValue: 2 }],
    }), true);
    assert.equal(areCommandsDifferent(existing, {
        description: 'Тест',
        options: [{ ...baseOption, maxLength: 30 }],
    }), true);
    assert.equal(areCommandsDifferent(existing, {
        description: 'Тест',
        options: [{ ...baseOption, channelTypes: [0] }],
    }), true);
});
