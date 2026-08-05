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
const appealService = require('../appealService');
const disciplineService = require('../service');
const logger = require('../../../core/logging/logger');
const { registerScheduler } = require('../../../app/schedulerRegistry');

const INTERVAL_MS = 60 * 60_000;

module.exports = async (client) => {
    let running = false;

    const run = async () => {
        if (running) {
            logger.warn('Плановая обработка взысканий пропущена: предыдущий запуск ещё не завершён');
            return;
        }

        running = true;
        try {
            await disciplineService.processDeadlines(client);
            await appealService.processPendingAppeals(client);
        } catch (error) {
            logger.error('Ошибка плановой обработки взысканий', error);
        } finally {
            running = false;
        }
    };

    await run();
    await disciplineService.closeInactiveDisciplineThreads(client).catch((error) => {
        logger.error('Не удалось закрыть завершённые дисциплинарные ветки при запуске', error);
    });
    await appealService.closeInactiveAppealThreads(client).catch((error) => {
        logger.error('Не удалось закрыть завершённые ветки обжалований при запуске', error);
    });
    const timer = setInterval(run, INTERVAL_MS);
    timer.unref?.();
    registerScheduler('discipline-deadlines', () => clearInterval(timer));
};
