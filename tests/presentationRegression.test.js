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

test('представление смен удаляет повторяющиеся роли в описании доступа', () => {
    const restore = installRuntimeStubs();
    try {
        const { createShiftPresentation } = require('../src/modules/shifts/presentation');
        const presentation = createShiftPresentation({
            getCurrentAccessState: () => ({
                unrestricted: false,
                firstGroup: null,
                stageIndex: 0,
                currentGroups: [{
                    name: 'Старший состав',
                    roleIds: ['100000000000000001', '100000000000000001', '100000000000000002'],
                }],
                nextStage: null,
                elapsedMinutes: 0,
            }),
            normalizeShiftType: (value) => value,
            renderShiftHeader: () => 'Расписание',
        });

        const lines = presentation.buildAccessLines({ rotateAccessDaily: false }, {});
        assert.equal(lines.length, 1);
        assert.equal(
            lines[0],
            'Сейчас доступ открыт для: **Старший состав** (<@&100000000000000001> <@&100000000000000002>).'
        );
    } finally {
        restore();
    }
});

test('сообщения состава получают timestamp при каждой новой сборке', () => {
    const restore = installRuntimeStubs();
    try {
        const { buildDepartmentEmbeds } = require('../src/modules/staff-lists/presentation');
        const department = {
            id: 'rdd',
            shortName: 'RDD',
            fullName: 'Recruitment & Disciplinary Department',
            curatorsEnabled: false,
            roles: {},
            limits: { heads: 0, deputyHeads: 0 },
        };
        const embeds = buildDepartmentEmbeds(new Map(), { ranks: [], departments: [department] }, department);

        assert.ok(embeds.length > 0);
        for (const embed of embeds) {
            assert.ok(Object.prototype.hasOwnProperty.call(embed.data, 'setTimestamp'));
        }
    } finally {
        restore();
    }
});
