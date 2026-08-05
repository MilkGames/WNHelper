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

function replaceModule(modulePath, exports) {
    const resolved = require.resolve(modulePath);
    const previous = require.cache[resolved];
    require.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        exports,
        children: [],
        paths: [],
    };
    return () => {
        if (previous) require.cache[resolved] = previous;
        else delete require.cache[resolved];
    };
}

test('webhook_status показывает сервер, воркеры, очереди и последние ошибки без значений ключей', () => {
    const previousWebhookKey = process.env.WEBHOOK_KEY;
    const previousTestKey = process.env.TEST_KEY;
    process.env.WEBHOOK_KEY = 'webhook-secret';
    process.env.TEST_KEY = 'test-secret';
    const restores = [
        replaceModule('../src/modules/forms', {
            getWebhookServerStatus: () => ({ started: true, listening: true, handlerCount: 2 }),
            getFormWorkerStatus: () => ({ registered: true, workerStarted: true, workerBusy: false }),
        }),
        replaceModule('../src/modules/examination', {
            getWebhookWorkerStatus: () => ({ registered: true, workerStarted: true, workerBusy: true }),
        }),
        replaceModule('../src/modules/manual-tools/database', {
            getWebhookQueueSummary: () => ({
                forms: { queued: 2, processing: 0, dead: 1, oldestActiveAt: 1_700_000_000_000, lastError: 'token=webhook-secret' },
                examination: { queued: 1, processing: 1, dead: 0, oldestActiveAt: null, lastError: null },
            }),
            getPendingOperationsSummary: () => ({ groups: [], webhook: { forms: {}, examination: {} }, total: 0 }),
        }),
    ];
    const statusPath = require.resolve('../src/modules/manual-tools/status');
    const previousStatus = require.cache[statusPath];
    delete require.cache[statusPath];
    try {
        const { buildWebhookStatus } = require(statusPath);
        const result = buildWebhookStatus('100000000000000001');
        const text = result.lines.join('\n');
        assert.match(text, /HTTP-сервер: работает/u);
        assert.match(text, /Формы: в очереди 2/u);
        assert.match(text, /Экзамены этого сервера: в очереди 1/u);
        assert.match(text, /СКРЫТО/u);
        assert.doesNotMatch(text, /webhook-secret/u);
        assert.doesNotMatch(text, /test-secret/u);
    } finally {
        if (previousStatus) require.cache[statusPath] = previousStatus;
        else delete require.cache[statusPath];
        restores.reverse().forEach((restore) => restore());
        if (previousWebhookKey === undefined) delete process.env.WEBHOOK_KEY;
        else process.env.WEBHOOK_KEY = previousWebhookKey;
        if (previousTestKey === undefined) delete process.env.TEST_KEY;
        else process.env.TEST_KEY = previousTestKey;
    }
});

test('pending_status сводит незавершённые операции и конфликты восстановления', () => {
    const restoreDatabase = replaceModule('../src/modules/manual-tools/database', {
        getWebhookQueueSummary: () => ({ forms: {}, examination: {} }),
        getPendingOperationsSummary: () => ({
            groups: [
                { label: 'Кадровые операции', total: 3, statuses: { failed: 2, running: 1 } },
                { label: 'Заявки на отпуск', total: 1, statuses: { awaiting_return: 1 } },
            ],
            webhook: {
                forms: { queued: 1, processing: 0, dead: 1 },
                examination: { queued: 0, processing: 1, dead: 0 },
            },
            total: 7,
        }),
    });
    const statusPath = require.resolve('../src/modules/manual-tools/status');
    const previousStatus = require.cache[statusPath];
    delete require.cache[statusPath];
    try {
        const { buildPendingStatus } = require(statusPath);
        const result = buildPendingStatus('100000000000000001', {
            planId: 'plan-test',
            unresolvedConflicts: 2,
        });
        const text = result.lines.join('\n');
        assert.match(text, /Кадровые операции: 3/u);
        assert.match(text, /Заявки на отпуск: 1/u);
        assert.match(text, /Webhook форм/u);
        assert.match(text, /Активный план восстановления/u);
        assert.doesNotMatch(text, /plan-test/u);
        assert.match(text, /ошибка: 2/u);
        assert.doesNotMatch(text, /awaiting_return/u);
        assert.match(text, /требующих внимания: 9/u);
    } finally {
        if (previousStatus) require.cache[statusPath] = previousStatus;
        else delete require.cache[statusPath];
        restoreDatabase();
    }
});
