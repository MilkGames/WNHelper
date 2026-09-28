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

function loadService(documents) {
    const databasePath = require.resolve('../src/core/config/database');
    const servicePath = require.resolve('../src/core/config/guildConfigService');
    const oldDatabase = require.cache[databasePath];
    const oldService = require.cache[servicePath];

    class FakeGuildConfigs {
        static async find() { return documents.map((entry) => ({ ...entry })); }
    }
    require.cache[databasePath] = {
        id: databasePath,
        filename: databasePath,
        loaded: true,
        exports: FakeGuildConfigs,
    };
    delete require.cache[servicePath];
    const service = require(servicePath);

    return {
        service,
        restore() {
            delete require.cache[servicePath];
            if (oldService) require.cache[servicePath] = oldService;
            if (oldDatabase) require.cache[databasePath] = oldDatabase;
            else delete require.cache[databasePath];
        },
    };
}

test('botEnabled=false скрывает сервер от runtime, но getAny сохраняет JSON-конфигурацию', async () => {
    const loaded = loadService([
        { guildId: '1', _serverName: 'Enabled', features: { shifts: true } },
        { guildId: '2', _serverName: 'Disabled', botEnabled: false, features: { shifts: true } },
    ]);
    try {
        await loaded.service.initialize();
        assert.equal(loaded.service.isEnabled('1'), true);
        assert.equal(loaded.service.isEnabled('2'), false);
        assert.equal(loaded.service.get('1').guildId, '1');
        assert.equal(loaded.service.get('2'), null);
        assert.equal(loaded.service.getAny('2').botEnabled, false);
        assert.deepEqual(loaded.service.getAll().map((entry) => entry.guildId), ['1']);
        assert.deepEqual(loaded.service.getAllIncludingEmpty().map((entry) => entry.guildId), ['1']);
    } finally {
        loaded.restore();
    }
});

test('поздний пустой duplicate не включает сервер с botEnabled=false', async () => {
    const loaded = loadService([
        {
            guildId: '2',
            _serverName: 'Disabled',
            botEnabled: false,
            features: { shifts: true },
        },
        { guildId: '2', _serverName: 'Disabled' },
    ]);
    try {
        await loaded.service.initialize();
        assert.equal(loaded.service.isEnabled('2'), false);
        assert.equal(loaded.service.get('2'), null);
        assert.equal(loaded.service.getAny('2').botEnabled, false);
        assert.deepEqual(loaded.service.getAny('2').features, { shifts: true });
    } finally {
        loaded.restore();
    }
});
