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

const readiness = require('../src/app/readiness');

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

test('итоговая готовность учитывает все обработчики и критические компоненты', () => {
    const restores = [
        replaceModule('../src/app/commandRegistry', { getCommandRegistryStatus: () => ({ loaded: true, count: 11 }) }),
        replaceModule('../src/app/schedulerRegistry', { getSchedulerStatus: () => ({ count: 5, names: ['a', 'b', 'c', 'd', 'e'] }) }),
        replaceModule('../src/core/database/status', { getDatabaseStatus: () => ({ recoveryMode: false, maintenance: false, pendingMutations: 0, lastWriteError: null }) }),
        replaceModule('../src/core/runtime/lease', { getLeaseStatus: () => ({ acquired: true, heartbeatFresh: true }) }),
        replaceModule('../src/modules/forms', {
            getWebhookServerStatus: () => ({ started: true, listening: true, handlerCount: 2 }),
            getFormWorkerStatus: () => ({ registered: true, workerStarted: true, workerBusy: false }),
        }),
        replaceModule('../src/modules/examination', {
            getWebhookWorkerStatus: () => ({ registered: true, workerStarted: true, workerBusy: false }),
        }),
        replaceModule('../src/modules/channel-counters', {
            getChannelCounterStatus: () => ({ schedulerActive: true }),
        }),
        replaceModule('../src/modules/staff-lists', {
            getStaffListStatus: () => ({ schedulerActive: true }),
        }),
    ];
    try {
        const first = { id: 'first', module: 'test' };
        const second = { id: 'second', module: 'test' };
        readiness.configureClientReadyHandlers([first, second]);
        readiness.markReadyHandlerStarted(first);
        readiness.markReadyHandlerSucceeded(first);
        readiness.markReadyHandlerStarted(second);
        readiness.markReadyHandlerSucceeded(second);

        const report = readiness.getApplicationReadinessStatus({ user: { id: '100000000000000001' } });
        assert.equal(report.ready, true);
        assert.equal(report.handlers.succeeded, 2);
        assert.deepEqual(report.problems, []);

        readiness.markReadyHandlerFailed(second, new Error('startup failed'));
        const failed = readiness.getApplicationReadinessStatus({ user: { id: '100000000000000001' } });
        assert.equal(failed.ready, false);
        assert.equal(failed.handlers.failed, 1);
        assert.ok(failed.problems.some((problem) => /ошибкой/iu.test(problem)));
    } finally {
        restores.reverse().forEach((restore) => restore());
    }
});

test('финальный ready log зарегистрирован последним clientReady handler', () => {
    const { groupEvents } = require('../src/app/eventRegistry');
    const handlers = groupEvents().get('clientReady');
    assert.equal(handlers.at(-1).id, 'app.readyLog');
});
