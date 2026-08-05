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
const logger = require('../logging/logger');

const DEFAULT_TIMEOUT_MS = 20_000;
const handlers = [];
let shuttingDown = false;
let shutdownReason = null;
let shutdownStartedAt = null;
let shutdownPromise = null;

function normalizeShutdownOrder(order) {
    const numericOrder = Number(order);
    return Number.isFinite(numericOrder) ? numericOrder : 100;
}

function registerShutdownHandler(name, handler, { order = 100 } = {}) {
    if (!name || typeof handler !== 'function') throw new Error('Некорректный обработчик завершения работы');
    handlers.push({
        name: String(name),
        handler,
        order: normalizeShutdownOrder(order),
    });
    handlers.sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
}

function getShutdownStatus() {
    return {
        shuttingDown,
        reason: shutdownReason,
        startedAt: shutdownStartedAt,
        handlerCount: handlers.length,
    };
}

async function runHandlers() {
    for (const item of handlers) {
        try {
            logger.info('Выполняется этап завершения работы', { stage: item.name });
            await item.handler();
        } catch (error) {
            logger.error('Ошибка этапа завершения работы', { stage: item.name }, error);
        }
    }
}

function requestShutdown(reason, { exitCode = 0, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownReason = String(reason || 'Запрошено завершение работы');
    shutdownStartedAt = Date.now();
    logger.warn('Начато корректное завершение работы бота', { reason: shutdownReason, exitCode });

    shutdownPromise = new Promise((resolve) => {
        const forcedTimer = setTimeout(() => {
            logger.fatal('Корректное завершение работы превысило допустимое время. Процесс остановлен принудительно.', {
                timeoutMs,
            });
            process.exit(exitCode || 1);
        }, Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
        forcedTimer.unref?.();

        setImmediate(async () => {
            await runHandlers();
            clearTimeout(forcedTimer);
            resolve();
            process.exit(exitCode);
        });
    });

    return shutdownPromise;
}

module.exports = {
    getShutdownStatus,
    normalizeShutdownOrder,
    registerShutdownHandler,
    requestShutdown,
};
