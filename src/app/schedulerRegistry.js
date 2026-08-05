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
const logger = require('../core/logging/logger');

const schedulers = new Map();

function registerScheduler(name, stop) {
    if (!name || typeof stop !== 'function') throw new Error('Некорректная регистрация планировщика');
    schedulers.set(String(name), stop);
}

async function stopSchedulers() {
    for (const [name, stop] of [...schedulers.entries()].reverse()) {
        try {
            await stop(name);
        } catch (error) {
            logger.error('Не удалось остановить планировщик', { name }, error);
        }
    }
    schedulers.clear();
}

function getSchedulerStatus() {
    return {
        count: schedulers.size,
        names: [...schedulers.keys()],
    };
}

module.exports = {
    getSchedulerStatus,
    registerScheduler,
    stopSchedulers,
};
