/*
 * WN Helper Discord Bot
 * Copyright (C) 2024 MilkGames
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
const cron = require('node-cron');

const config = require('../../../config.json');
const logger = require('../../utils/logger');
const { sendAmdScheduleNow } = require('../../utils/amdScheduleSender');

module.exports = async (client) => {
    for (const guildId of Object.keys(config.servers)) {
        if (guildId !== '1249711898744848415') continue;

        const serverName = client.guilds.cache.get(guildId)?.name || guildId;
        const serverConfig = config.servers[guildId];

        try {
            await client.channels.fetch(serverConfig.amdShiftsChannelId);
        } catch (error) {
            logger.info(`AMD смены: не удалось получить канал для сервера ${serverName}: ${error}`);
            continue;
        }

        logger.info(`Смены для AMD успешно запланированы на сервере ${serverName}.`);

        cron.schedule(
            '0 22 * * *', // 22:00
            async () => {
                try {
                    await sendAmdScheduleNow({
                        client,
                        guildId,
                        serverConfig,
                        reason: 'по cron',
                    });
                } catch (error) {
                    logger.info(`AMD смены: не удалось отправить расписание для сервера ${serverName}: ${error}`);
                }
            },
            {
                scheduled: true,
                timezone: 'Europe/Moscow',
            }
        );
    }
};
