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
require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const eventHandler = require('./handlers/eventHandler');
const kaDelete = require('./events/kaDelete');
const { ensureDatabase } = require('./utils/localDb');

const logger = require('./utils/logger');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent,
    ],
    partials: [
        Partials.Message,
        Partials.Reaction,
        Partials.Channel,
    ],
});

async function main() {
    process.on('unhandledRejection', (reason) => {
        logger.error('Необработанное отклонение промиса:', reason);
    });
    process.on('uncaughtException', (err) => {
        logger.fatal('Непойманное исключение:', err);
        process.exit(1);
    });

    const token = process.env.token;
    if (!token) {
        logger.fatal('Не задана переменная окружения "token". Укажи её в .env (token=...)');
        process.exit(1);
    }

    ensureDatabase();
    logger.info('Локальная база данных готова.');

    await eventHandler(client);

    client.on(kaDelete.name, kaDelete.execute);

    await client.login(token);
}

main().catch((error) => {
    logger.fatal('Ошибка при запуске бота:', error);
    process.exit(1);
});
