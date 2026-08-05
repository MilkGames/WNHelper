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

test('срок лидера рассчитывается по настроенной длительности без ошибки области видимости', () => {
    const restore = installRuntimeStubs();
    try {
        const { getLeaderTermInfo } = require('../src/modules/staff-lists/presentation');
        const result = getLeaderTermInfo(
            '2026-01-01',
            30,
            new Date(Date.UTC(2026, 0, 31))
        );
        assert.equal(result.appointmentDate, '01.01.2026');
        assert.match(result.term, /^2-й срок/u);
        assert.equal(result.termEndDate, '01.03.2026');
    } finally {
        restore();
    }
});
