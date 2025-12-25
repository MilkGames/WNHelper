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
const path = require('path');
const getAllFiles = require('../utils/getAllFiles');
const logger = require('../utils/logger');

module.exports = async (client) => {
    const eventFolders = getAllFiles(path.join(__dirname, '..', 'events'), true);

    for (const eventFolder of eventFolders) {
        const eventFiles = getAllFiles(eventFolder);
        eventFiles.sort((a, b) => a.localeCompare(b));

        const eventName = eventFolder.replace(/\\/g, '/').split('/').pop();

        logger.info('Подключаю обработчики событий', { event: eventName, handlers: eventFiles.length });

        client.on(eventName, async (...args) => {
            for (const eventFile of eventFiles) {
                try {
                    const eventFunction = require(eventFile);
                    await eventFunction(client, ...args);
                } catch (error) {
                    logger.error('Обработчик события крашнулся', { event: eventName, file: eventFile }, error);
                }
            }
        });
    }
};
