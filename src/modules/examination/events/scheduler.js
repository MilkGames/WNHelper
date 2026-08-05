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
const examinationService = require('../service');
const logger = require('../../../core/logging/logger');
const { registerScheduler } = require('../../../app/schedulerRegistry');

const INTERVAL_MS = 30_000;
let started = false;

module.exports = async (client) => {
    if (started) return;
    started = true;
    let running = false;

    const run = async () => {
        if (running) return;
        running = true;
        try {
            await examinationService.processWaitingVoiceRequests(client);
            await examinationService.processPendingRequestReminders(client);
        } catch (error) {
            logger.error('Ошибка проверки ожидания голосового канала в экзаменации', error);
        } finally {
            running = false;
        }
    };

    await run();
    const timer = setInterval(run, INTERVAL_MS);
    timer.unref?.();
    registerScheduler('examination-voice', () => {
        clearInterval(timer);
        started = false;
    });
};
