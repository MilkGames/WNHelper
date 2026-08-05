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
const readyHandlers = new Map();
let configuredAt = null;
let lastReport = null;

function configureClientReadyHandlers(handlers = []) {
    readyHandlers.clear();
    configuredAt = Date.now();
    for (const handler of handlers) {
        if (!handler?.id || handler.id === 'app.readyLog') continue;
        readyHandlers.set(handler.id, {
            id: handler.id,
            module: handler.module || null,
            status: 'pending',
            startedAt: null,
            completedAt: null,
            error: null,
        });
    }
}

function updateReadyHandler(handler, status, error = null) {
    if (!handler?.id || handler.id === 'app.readyLog') return;
    const previous = readyHandlers.get(handler.id) || {
        id: handler.id,
        module: handler.module || null,
        status: 'pending',
        startedAt: null,
        completedAt: null,
        error: null,
    };
    const now = Date.now();
    readyHandlers.set(handler.id, {
        ...previous,
        module: handler.module || previous.module || null,
        status,
        startedAt: previous.startedAt || now,
        completedAt: status === 'running' ? null : now,
        error: error ? String(error?.message || error) : null,
    });
}

function markReadyHandlerStarted(handler) {
    updateReadyHandler(handler, 'running');
}

function markReadyHandlerSucceeded(handler) {
    updateReadyHandler(handler, 'succeeded');
}

function markReadyHandlerFailed(handler, error) {
    updateReadyHandler(handler, 'failed', error);
}

function getReadyHandlerStatus() {
    const handlers = [...readyHandlers.values()];
    return {
        configuredAt,
        total: handlers.length,
        pending: handlers.filter((item) => item.status === 'pending' || item.status === 'running').length,
        succeeded: handlers.filter((item) => item.status === 'succeeded').length,
        failed: handlers.filter((item) => item.status === 'failed').length,
        failures: handlers
            .filter((item) => item.status === 'failed')
            .map((item) => ({
                id: item.id,
                module: item.module,
                error: item.error,
            })),
    };
}

function getApplicationReadinessStatus(client) {
    const { getCommandRegistryStatus } = require('./commandRegistry');
    const { getSchedulerStatus } = require('./schedulerRegistry');
    const { getDatabaseStatus } = require('../core/database/status');
    const { getLeaseStatus } = require('../core/runtime/lease');
    const formsModule = require('../modules/forms');
    const examinationModule = require('../modules/examination');
    const channelCounters = require('../modules/channel-counters');
    const staffLists = require('../modules/staff-lists');

    const handlers = getReadyHandlerStatus();
    const commands = getCommandRegistryStatus();
    const schedulers = getSchedulerStatus();
    const database = getDatabaseStatus();
    const lease = getLeaseStatus();
    const webhook = formsModule.getWebhookServerStatus();
    const formsWorker = formsModule.getFormWorkerStatus();
    const examWorker = examinationModule.getWebhookWorkerStatus();
    const counters = channelCounters.getChannelCounterStatus();
    const lists = staffLists.getStaffListStatus();
    const problems = [];

    if (!client?.user?.id) problems.push('Discord-клиент не готов.');
    if (handlers.pending > 0) problems.push(`Не завершено обработчиков запуска: ${handlers.pending}.`);
    if (handlers.failed > 0) problems.push(`Обработчиков запуска с ошибкой: ${handlers.failed}.`);
    if (!commands.loaded || commands.count <= 0) problems.push('Реестр команд не загружен.');
    if (database.recoveryMode) problems.push('База данных работает в режиме восстановления.');
    if (database.maintenance) problems.push('Изменения базы данных заблокированы.');
    if (database.lastWriteError) problems.push('Зафиксирована ошибка записи базы данных.');
    if (!lease.acquired || !lease.heartbeatFresh) problems.push('Блокировка единственного инстанса не подтверждена.');
    if (!webhook.started || !webhook.listening) problems.push('HTTP webhook-сервер не слушает порт.');
    if (webhook.handlerCount < 2) problems.push(`Зарегистрировано обработчиков webhook: ${webhook.handlerCount}.`);
    if (!formsWorker.registered || !formsWorker.workerStarted) problems.push('Воркер форм не готов.');
    if (!examWorker.registered || !examWorker.workerStarted) problems.push('Воркер экзаменов не готов.');
    if (!counters.schedulerActive) problems.push('Планировщик счётчиков каналов не запущен.');
    if (!lists.schedulerActive) problems.push('Планировщик составов не запущен.');
    if (schedulers.count <= 0) problems.push('Общие планировщики не зарегистрированы.');

    const report = {
        ready: problems.length === 0,
        checkedAt: Date.now(),
        discord: Boolean(client?.user?.id),
        handlers,
        commands,
        database: {
            recoveryMode: database.recoveryMode,
            maintenance: database.maintenance,
            pendingMutations: database.pendingMutations,
            lastWriteError: database.lastWriteError,
        },
        lease: {
            acquired: lease.acquired,
            heartbeatFresh: lease.heartbeatFresh,
        },
        webhook,
        workers: {
            forms: formsWorker,
            examination: examWorker,
        },
        schedulers: {
            count: schedulers.count,
            names: schedulers.names,
            channelCounters: counters.schedulerActive,
            staffLists: lists.schedulerActive,
        },
        problems,
    };
    lastReport = report;
    return report;
}

function getLastReadinessReport() {
    return lastReport ? JSON.parse(JSON.stringify(lastReport)) : null;
}

module.exports = {
    configureClientReadyHandlers,
    getApplicationReadinessStatus,
    getLastReadinessReport,
    getReadyHandlerStatus,
    markReadyHandlerFailed,
    markReadyHandlerStarted,
    markReadyHandlerSucceeded,
};
