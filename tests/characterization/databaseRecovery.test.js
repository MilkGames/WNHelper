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

const { compareDatabases, stableStringify } = require('../../src/core/database/recovery');

test('сравнение базы различает новые записи и конфликты', () => {
    const current = {
        vacationRequests: [
            { guildId: '1', requestId: 'same', status: 'active' },
            { guildId: '1', requestId: 'current', status: 'active' },
        ],
    };
    const backup = {
        vacationRequests: [
            { guildId: '1', requestId: 'same', status: 'completed' },
            { guildId: '1', requestId: 'backup', status: 'pending' },
        ],
    };
    const result = compareDatabases(current, backup);
    assert.equal(result.summary.currentOnly, 1);
    assert.equal(result.summary.backupOnly, 1);
    assert.equal(result.summary.conflicts, 1);
    assert.equal(result.conflicts[0].identity, 'guildId=1|requestId=same');
});

test('стабильная сериализация не зависит от порядка ключей', () => {
    assert.equal(stableStringify({ b: 2, a: 1 }), stableStringify({ a: 1, b: 2 }));
});

test('план восстановления отклоняется после изменения основной базы или резервной копии', () => {
    const { assertRecoveryPlanSourcesUnchanged } = require('../../src/core/database/recovery');
    const current = { vacationRequests: [{ guildId: '1', requestId: 'a', status: 'active' }] };
    const backup = { vacationRequests: [{ guildId: '1', requestId: 'b', status: 'pending' }] };
    const crypto = require('node:crypto');
    const hash = (value) => crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
    const plan = {
        currentHash: hash(current),
        backupHash: hash(backup),
    };

    assert.doesNotThrow(() => assertRecoveryPlanSourcesUnchanged(plan, current, backup));
    assert.throws(
        () => assertRecoveryPlanSourcesUnchanged(plan, { ...current, extra: [] }, backup),
        /Основная база данных изменилась/u
    );
    assert.throws(
        () => assertRecoveryPlanSourcesUnchanged(plan, current, { ...backup, extra: [] }),
        /Резервная копия изменилась/u
    );
});
