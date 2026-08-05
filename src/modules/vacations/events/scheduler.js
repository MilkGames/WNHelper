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
const vacationService = require('../service');
const logger = require('../../../core/logging/logger');
const { registerScheduler } = require('../../../app/schedulerRegistry');

const INTERVAL_MS = 5 * 60_000;

module.exports = async (client) => {
    let running = false;
    const run = async () => {
        if (running) return;
        running = true;
        try {
            await vacationService.processSchedules(client);
        } catch (error) {
            logger.error('Ошибка плановой обработки отпусков', error);
        } finally {
            running = false;
        }
    };
    await run();
    const timer = setInterval(run, INTERVAL_MS);
    timer.unref?.();
    registerScheduler('vacation-schedules', () => clearInterval(timer));
};
