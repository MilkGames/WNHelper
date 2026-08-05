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
const {
    syncAllShiftSchedules,
} = require('../service');
const logger = require('../../../core/logging/logger');
const { registerScheduler } = require('../../../app/schedulerRegistry');

let schedulerTimer = null;

module.exports = async (client) => {
    await syncAllShiftSchedules(client, { reason: 'startup' }).catch((error) => {
        logger.error('Не удалось выполнить стартовую синхронизацию смен', error);
    });

    if (schedulerTimer) clearInterval(schedulerTimer);
    schedulerTimer = setInterval(() => {
        syncAllShiftSchedules(client, { reason: 'minute-scheduler' }).catch((error) => {
            logger.error('Не удалось выполнить плановую синхронизацию смен', error);
        });
    }, 60_000);
    schedulerTimer.unref?.();
    registerScheduler('shift-schedules', () => {
        if (schedulerTimer) clearInterval(schedulerTimer);
        schedulerTimer = null;
    });
};
