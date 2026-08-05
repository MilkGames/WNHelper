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

function loadRankCommand({ reserveOperation }) {
    class StaffAuditError extends Error {}
    const targetPath = require.resolve('../src/modules/staff-audit/commands/rank');
    const mocks = new Map();
    const install = (relativePath, exportsValue) => {
        const resolved = require.resolve(path.join(PROJECT_ROOT, relativePath));
        mocks.set(resolved, require.cache[resolved]);
        require.cache[resolved] = {
            id: resolved,
            filename: resolved,
            loaded: true,
            exports: exportsValue,
        };
    };

    let executedOperationId = null;
    install('src/core/config/guildConfigService.js', { get: () => ({ features: { staffAudit: true } }) });
    install('src/modules/staff-audit/service.js', {
        StaffAuditError,
        assertFeatureEnabled: () => undefined,
        getAuditChannel: async () => ({ id: 'channel-1' }),
        resolveMemberInput: async () => ({
            member: { id: 'member-1' },
            memberId: 'member-1',
            displayName: 'Test User | 42',
            staticId: '42',
            displayValue: '<@member-1>',
        }),
        parseRankAction: () => ({ formattedAction: '2-3' }),
    });
    install('src/modules/staff-audit/operations.js', {
        reserveOperation,
        executeOperation: async (_client, operationId) => {
            executedOperationId = operationId;
            return { channelId: 'audit-channel' };
        },
    });
    install('src/core/discord/request.js', {
        deferReplyWithRetry: async (interaction, payload) => interaction.deferReply(payload),
        editReplyWithRetry: async (interaction, payload) => interaction.editReply(payload),
    });
    install('src/core/logging/logger.js', {
        error: () => undefined,
        warn: () => undefined,
    });

    const previousTarget = require.cache[targetPath];
    delete require.cache[targetPath];
    const command = require(targetPath);

    return {
        command,
        getExecutedOperationId: () => executedOperationId,
        restore() {
            delete require.cache[targetPath];
            if (previousTarget) require.cache[targetPath] = previousTarget;
            for (const [resolved, previous] of mocks) {
                if (previous) require.cache[resolved] = previous;
                else delete require.cache[resolved];
            }
        },
    };
}

function createInteraction() {
    const state = { deferred: false, editPayload: null };
    return {
        id: 'interaction-1',
        guildId: 'guild-1',
        user: { id: 'actor-1' },
        guild: {
            members: {
                fetch: async () => ({ id: 'actor-1' }),
            },
        },
        options: {
            getString(name) {
                return {
                    member: 'member-1',
                    static: '42',
                    action: '2-3',
                    reason: 'Отчёт',
                }[name] ?? null;
            },
            getBoolean: () => false,
        },
        async deferReply() {
            state.deferred = true;
        },
        async editReply(payload) {
            state.editPayload = payload;
        },
        state,
    };
}

test('/rank вызывает persistent operation через модуль operations', async () => {
    let reservedInput = null;
    const loaded = loadRankCommand({
        reserveOperation: async (input) => {
            reservedInput = input;
            return { operationId: 'operation-1' };
        },
    });

    try {
        const interaction = createInteraction();
        await loaded.command.callback({}, interaction);

        assert.equal(interaction.state.deferred, true);
        assert.equal(reservedInput.type, 'rank');
        assert.equal(loaded.getExecutedOperationId(), 'operation-1');
        assert.match(interaction.state.editPayload.content, /обработано/u);
    } finally {
        loaded.restore();
    }
});

test('/rank показывает безопасную техническую причину неожиданной ошибки', async () => {
    const loaded = loadRankCommand({
        reserveOperation: async () => {
            throw new TypeError('reserveOperation is not a function token=very-secret');
        },
    });

    try {
        const interaction = createInteraction();
        await loaded.command.callback({}, interaction);
        const content = interaction.state.editPayload.content;

        assert.match(content, /Техническая причина/u);
        assert.match(content, /reserveOperation is not a function/u);
        assert.doesNotMatch(content, /very-secret/u);
        assert.match(content, /СКРЫТО/u);
    } finally {
        loaded.restore();
    }
});
