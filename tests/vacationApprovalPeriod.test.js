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

test('дни ожидания одобрения исключаются из фактического периода отпуска', () => {
    const restore = installRuntimeStubs();
    try {
        const { getEffectiveApprovalPeriod } = require('../src/modules/vacations');
        assert.deepEqual(
            getEffectiveApprovalPeriod({
                startDate: '2026-08-05',
                endDate: '2026-08-21',
            }, '2026-08-06'),
            {
                requestedStartDate: '2026-08-05',
                requestedEndDate: '2026-08-21',
                startDate: '2026-08-06',
                endDate: '2026-08-21',
                durationDays: 16,
                approvalWaitDays: 1,
            }
        );
    } finally {
        restore();
    }
});

test('будущий период при раннем одобрении не сдвигается', () => {
    const restore = installRuntimeStubs();
    try {
        const { getEffectiveApprovalPeriod } = require('../src/modules/vacations');
        assert.deepEqual(
            getEffectiveApprovalPeriod({
                requestedStartDate: '2026-08-10',
                requestedEndDate: '2026-08-12',
                startDate: '2026-08-10',
                endDate: '2026-08-12',
            }, '2026-08-06'),
            {
                requestedStartDate: '2026-08-10',
                requestedEndDate: '2026-08-12',
                startDate: '2026-08-10',
                endDate: '2026-08-12',
                durationDays: 3,
                approvalWaitDays: 0,
            }
        );
    } finally {
        restore();
    }
});

test('полностью закончившийся период нельзя одобрить', () => {
    const restore = installRuntimeStubs();
    try {
        const { getEffectiveApprovalPeriod } = require('../src/modules/vacations');
        assert.throws(
            () => getEffectiveApprovalPeriod({
                startDate: '2026-08-05',
                endDate: '2026-08-05',
            }, '2026-08-06'),
            (error) => error?.code === 'vacation_period_expired'
        );
    } finally {
        restore();
    }
});

test('embed показывает запрошенный и фактический периоды после позднего одобрения', () => {
    const restore = installRuntimeStubs();
    try {
        const { buildRequestEmbed } = require('../src/modules/vacations/presentation');
        const embed = buildRequestEmbed({
            memberId: '100000000000000001',
            memberDisplayName: 'Igor Akulich',
            typeName: 'Неоплачиваемый отпуск',
            requestedStartDate: '2026-08-05',
            requestedEndDate: '2026-08-21',
            startDate: '2026-08-06',
            endDate: '2026-08-21',
            durationDays: 16,
            approvalWaitDays: 1,
            reason: 'Причина',
            status: 'active',
            createdAt: 1,
            overdueActions: [],
        });
        const fields = embed.data.addFields[0];
        const values = Object.fromEntries(fields.map((field) => [field.name, field.value]));

        assert.equal(values['Запрошенный период'], '05.08.2026-21.08.2026');
        assert.equal(values['Фактический период'], '06.08.2026-21.08.2026');
        assert.equal(values['Фактическая продолжительность'], '16 дн.');
        assert.equal(values['Не учтено из-за ожидания рассмотрения'], '1 дн.');
    } finally {
        restore();
    }
});
