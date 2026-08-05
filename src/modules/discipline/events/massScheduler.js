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
const massService = require('../massService');
const logger = require('../../../core/logging/logger');
const { registerScheduler } = require('../../../app/schedulerRegistry');

let started = false;

module.exports = async (client) => {
    if (started) return;
    started = true;

    await massService.recoverInterruptedBatches()
        .then((count) => {
            if (count > 0) {
                logger.warn('Восстановлены прерванные массовые взыскания', { count });
            }
        })
        .catch((error) => {
            logger.error('Не удалось восстановить прерванные массовые взыскания при запуске', error);
        });

    await massService.expirePendingBatches(client).catch((error) => {
        logger.error('Не удалось обработать истёкшие массовые взыскания при запуске', error);
    });
    await massService.closeInactiveMassThreads(client).catch((error) => {
        logger.error('Не удалось закрыть завершённые ветки массовых взысканий при запуске', error);
    });

    const timer = setInterval(() => {
        massService.expirePendingBatches(client).catch((error) => {
            logger.error('Ошибка проверки сроков массовых взысканий', error);
        });
    }, 60_000);
    timer.unref?.();
    registerScheduler('mass-discipline-expiration', () => {
        clearInterval(timer);
        started = false;
    });
};
