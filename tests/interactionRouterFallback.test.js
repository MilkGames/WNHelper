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
const nodeTest = require('node:test');
const test = require('./helpers/createTest')(__filename);
const { installRuntimeStubs } = require('./helpers/runtimeStubs');

const restoreRuntimeStubs = installRuntimeStubs();
nodeTest.after(restoreRuntimeStubs);

const { routeInteraction } = require('../src/app/interactionRouter');

function createInteraction({ deferred = false, replied = false } = {}) {
    const state = { reply: null, followUp: null };
    return {
        id: '100000000000000001',
        guildId: '100000000000000002',
        user: { id: '100000000000000003' },
        customId: 'test:button',
        deferred,
        replied,
        state,
        async reply(payload) {
            state.reply = payload;
            this.replied = true;
        },
        async followUp(payload) {
            state.followUp = payload;
            return { delete: async () => undefined };
        },
    };
}

test('неожиданная ошибка interaction handler получает безопасный резервный ответ', async () => {
    const previousSecret = process.env.TEST_KEY;
    process.env.TEST_KEY = 'router-secret-value';
    let secondCalled = false;
    try {
        const interaction = createInteraction();
        await routeInteraction({}, interaction, [
            {
                id: 'broken.handler',
                module: 'test',
                execute: async () => {
                    throw new Error('Сбой router-secret-value');
                },
            },
            {
                id: 'second.handler',
                execute: async () => {
                    secondCalled = true;
                },
            },
        ]);

        assert.equal(secondCalled, false);
        assert.equal(interaction.__wnStopPropagation, true);
        assert.match(String(interaction.state.reply?.content || ''), /Техническая причина/iu);
        assert.match(String(interaction.state.reply?.content || ''), /СКРЫТО/u);
        assert.doesNotMatch(String(interaction.state.reply?.content || ''), /router-secret-value/u);
        assert.deepEqual(interaction.state.reply?.allowedMentions, { parse: [] });
    } finally {
        if (previousSecret === undefined) delete process.env.TEST_KEY;
        else process.env.TEST_KEY = previousSecret;
    }
});

test('уже подтверждённое взаимодействие получает follow-up вместо повторного reply', async () => {
    const interaction = createInteraction({ deferred: true });
    await routeInteraction({}, interaction, [{
        id: 'broken.deferred',
        execute: async () => {
            throw new Error('Ошибка после deferUpdate');
        },
    }]);

    assert.equal(interaction.state.reply, null);
    assert.match(String(interaction.state.followUp?.content || ''), /Ошибка после deferUpdate/u);
    assert.deepEqual(interaction.state.followUp?.allowedMentions, { parse: [] });
});
