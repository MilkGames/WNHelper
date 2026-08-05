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
const test = require('../helpers/createTest')(__filename);

const { SessionStore } = require('../../src/core/sessions/sessionStore');

test('сессия доступна по ID и дополнительному индексу', () => {
    const store = new SessionStore({ ttlMs: 60_000 });
    const session = { id: 'one', guildId: 'guild', lastActivityAt: Date.now() };
    store.set(session.id, session, { guildId: session.guildId });
    assert.equal(store.get('one'), session);
    assert.equal(store.getByIndex('guildId', 'guild'), session);
});

test('истёкшая сессия удаляется вместе с индексом', () => {
    const store = new SessionStore({ ttlMs: 10 });
    const session = { id: 'old', guildId: 'guild', lastActivityAt: Date.now() - 100 };
    store.set(session.id, session, { guildId: session.guildId });
    assert.equal(store.get('old'), null);
    assert.equal(store.getByIndex('guildId', 'guild'), null);
});
