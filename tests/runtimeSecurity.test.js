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

const applicationConfig = require('../config.json');
const { installRuntimeStubs } = require('./helpers/runtimeStubs');

const OWNER_ID = applicationConfig.devs[0];

function createInteraction({ subcommand, userId, instanceId = '', mode = 'graceful' }) {
    const state = {
        deferred: false,
        replied: false,
        replyPayload: null,
        editPayload: null,
    };
    return {
        guildId: '100000000000000001',
        user: { id: userId },
        get deferred() { return state.deferred; },
        get replied() { return state.replied; },
        options: {
            getSubcommand: () => subcommand,
            getString: (name) => {
                if (name === 'instance_id') return instanceId;
                if (name === 'mode') return mode;
                return null;
            },
        },
        async deferReply() {
            state.deferred = true;
        },
        async reply(payload) {
            state.replied = true;
            state.replyPayload = payload;
        },
        async editReply(payload) {
            state.editPayload = payload;
        },
        state,
    };
}

test('публичное состояние процесса не раскрывает Instance ID', () => {
    const instance = require('../src/core/runtime/instance');
    const publicStatus = instance.getPublicStatus();
    assert.equal(Object.prototype.hasOwnProperty.call(publicStatus, 'instanceId'), false);
    assert.equal(typeof instance.getPrivateStatus().instanceId, 'string');
});

test('instance_status не содержит Instance ID', async () => {
    const restore = installRuntimeStubs();
    try {
        const command = require('../src/modules/manual-tools/command');
        const interaction = createInteraction({
            subcommand: 'instance_status',
            userId: OWNER_ID,
        });
        await command.callback({}, interaction);
        const content = String(interaction.state.editPayload?.content || '');
        const privateId = require('../src/core/runtime/instance').getPrivateStatus().instanceId;
        assert.equal(interaction.state.deferred, true);
        assert.doesNotMatch(content, /Instance ID|instanceId/iu);
        assert.equal(content.includes(privateId), false);
    } finally {
        restore();
    }
});

test('инстанс с несовпадающим ID молча игнорирует команду остановки', async () => {
    const restore = installRuntimeStubs();
    try {
        const commandPath = require.resolve('../src/modules/manual-tools/command');
        delete require.cache[commandPath];
        const command = require(commandPath);
        const interaction = createInteraction({
            subcommand: 'shutdown_instance',
            userId: OWNER_ID,
            instanceId: 'wn-другой-инстанс',
        });
        await command.callback({}, interaction);
        assert.equal(interaction.state.deferred, false);
        assert.equal(interaction.state.replied, false);
        assert.equal(interaction.state.editPayload, null);
    } finally {
        restore();
    }
});

test('внутренний лог сохраняет диагностические значения без маскировки', () => {
    const loggerPath = require.resolve('../src/core/logging/logger');
    const previousLogging = structuredClone(applicationConfig.logging);
    applicationConfig.logging = { level: 'info', toFile: false };
    delete require.cache[loggerPath];
    const loggerModule = require(loggerPath);
    const originalWrite = process.stdout.write;
    let output = '';
    process.stdout.write = (chunk) => {
        output += String(chunk);
        return true;
    };
    try {
        const logger = loggerModule.createLogger({ module: 'test' });
        logger.info('token=very-secret', {
            authorization: 'Bearer hidden',
            nested: { webhookKey: 'another-secret' },
        });
    } finally {
        process.stdout.write = originalWrite;
        applicationConfig.logging = previousLogging;
        delete require.cache[loggerPath];
    }
    assert.match(output, /very-secret/u);
    assert.match(output, /another-secret/u);
    assert.match(output, /Bearer hidden/u);
    assert.doesNotMatch(output, /СКРЫТО/u);
});

test('публичная причина ошибки сохраняет диагностику, но скрывает секреты', () => {
    const { buildPublicErrorMessage } = require('../src/core/ui/errorMessage');
    const previousTestKey = process.env.TEST_KEY;
    process.env.TEST_KEY = 'exact-environment-secret';
    let message;
    try {
        message = buildPublicErrorMessage(
            new Error(
                'authorization=Bearer hidden token=very-secret ' +
                'webhook_key=another-secret exact-environment-secret'
            ),
            'Не удалось выполнить действие.'
        );
    } finally {
        if (previousTestKey === undefined) delete process.env.TEST_KEY;
        else process.env.TEST_KEY = previousTestKey;
    }

    assert.match(message, /Не удалось выполнить действие/u);
    assert.match(message, /Техническая причина/u);
    assert.doesNotMatch(message, /very-secret|another-secret|Bearer hidden|exact-environment-secret/u);
    assert.match(message, /СКРЫТО/u);
});

test('ожидаемая бизнес-ошибка показывает подготовленное сообщение без технического дополнения', () => {
    const { buildPublicErrorMessage } = require('../src/core/ui/errorMessage');
    const error = new Error('Внутренняя деталь');
    error.userMessage = 'Пользовательское объяснение.';

    assert.equal(
        buildPublicErrorMessage(error, 'Резервное сообщение.'),
        'Пользовательское объяснение.'
    );
});


test('порядок завершения принимает нулевой приоритет и отклоняет некорректный', () => {
    const { normalizeShutdownOrder } = require('../src/core/runtime/shutdown');
    assert.equal(normalizeShutdownOrder(0), 0);
    assert.equal(normalizeShutdownOrder('15'), 15);
    assert.equal(normalizeShutdownOrder('не число'), 100);
});
