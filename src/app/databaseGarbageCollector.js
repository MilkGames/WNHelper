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
const { registerScheduler } = require('./schedulerRegistry');
const {
    purgeDismissedDiscipline,
    runRetentionGc,
} = require('../core/database/garbageCollector');
const logger = require('../core/logging/logger');
const { getDatabaseStatus } = require('../core/database/status');
const { invokeAction } = require('../core/integrations/actionRegistry');

const INTERVAL_MS = 60 * 60_000;

module.exports = async (client) => {
    if (getDatabaseStatus().recoveryMode) return;
    let running = false;

    const run = async () => {
        if (running) return;
        running = true;
        try {
            await runRetentionGc();
            const purgedCases = await purgeDismissedDiscipline(
                client,
                (runtimeClient, guildId, memberId, options) => invokeAction(
                    'discipline.purgeMemberDisciplineHistory',
                    runtimeClient,
                    guildId,
                    memberId,
                    { ...options, updateDiscord: true }
                )
            );
            if (purgedCases > 0) {
                logger.info('Удалена дисциплинарная история уволенных сотрудников', { cases: purgedCases });
            }
        } catch (error) {
            logger.error('Ошибка плановой очистки локальной базы данных', error);
        } finally {
            running = false;
        }
    };

    await run();
    const timer = setInterval(run, INTERVAL_MS);
    timer.unref?.();
    registerScheduler('database-garbage-collector', () => clearInterval(timer));
};
