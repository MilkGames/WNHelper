/*
 * WN Helper Discord Bot
 * Copyright (C) 2024-2026 MilkGames
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
const { Client, GatewayIntentBits, Partials } = require('discord.js');

const { startBackupScheduler, stopBackupScheduler } = require('../core/database/backup');
const {
    initializeDatabase,
    registerRecoveryHandler,
    waitForIdle,
} = require('../core/database/localDatabase');
const logger = require('../core/logging/logger');
const { getPrivateStatus } = require('../core/runtime/instance');
const { acquireInstanceLease, releaseInstanceLease } = require('../core/runtime/lease');
const { registerShutdownHandler, requestShutdown } = require('../core/runtime/shutdown');
const guildConfigService = require('../core/config/guildConfigService');
const giveRoles = require('../modules/give-roles');
const { loadCommands } = require('./commandRegistry');
const { registerEvents } = require('./eventRegistry');
const { loadModules, stopModules } = require('./moduleRegistry');
const { stopStatusRotation } = require('../core/runtime/status');
const { stopSchedulers } = require('./schedulerRegistry');

function createDiscordClient() {
    return new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildMessageReactions,
            GatewayIntentBits.GuildVoiceStates,
            GatewayIntentBits.MessageContent,
        ],
        partials: [
            Partials.Message,
            Partials.Reaction,
            Partials.Channel,
        ],
    });
}

function registerProcessErrorHandlers() {
    process.on('unhandledRejection', (reason) => {
        logger.error('Необработанное отклонение промиса', reason);
    });
    process.on('uncaughtException', (error) => {
        logger.fatal('Непойманное исключение', error);
        requestShutdown('Непойманное исключение', { exitCode: 1 }).catch(() => process.exit(1));
    });
}

function registerSignalHandlers() {
    process.once('SIGTERM', () => {
        requestShutdown('Получен сигнал SIGTERM', { exitCode: 0 }).catch(() => process.exit(1));
    });
    process.once('SIGINT', () => {
        requestShutdown('Получен сигнал SIGINT', { exitCode: 0 }).catch(() => process.exit(1));
    });
}

function registerShutdownSequence(client) {
    registerShutdownHandler('Остановка статуса', async () => stopStatusRotation(), { order: 1 });
    registerShutdownHandler('Остановка планировщиков', stopSchedulers, { order: 5 });
    registerShutdownHandler('Остановка модулей', stopModules, { order: 10 });
    registerShutdownHandler('Остановка резервного копирования', async () => stopBackupScheduler(), { order: 20 });
    registerShutdownHandler('Ожидание операций базы данных', waitForIdle, { order: 30 });
    registerShutdownHandler('Отключение Discord-клиента', async () => client.destroy(), { order: 40 });
    registerShutdownHandler('Освобождение блокировки инстанса', async () => releaseInstanceLease(), { order: 50 });
    registerShutdownHandler('Закрытие лог-файла', logger.closeLogger, { order: 1000 });
}

async function bootstrap() {
    registerProcessErrorHandlers();
    registerSignalHandlers();

    const token = process.env.token;
    if (!token) throw new Error('Не задана переменная окружения "token"');

    acquireInstanceLease();

    try {
        const databaseResult = initializeDatabase();

        logger.info('Запускается WN Helper', getPrivateStatus());
        logger.info('Локальная база данных проверена', {
            recoveryMode: databaseResult.recoveryMode,
            created: databaseResult.created,
        });

        if (!databaseResult.recoveryMode) startBackupScheduler();

        registerRecoveryHandler(async () => {
            stopBackupScheduler();
            stopSchedulers();
        });

        loadModules();
        loadCommands();
        const staffAudit = require('../modules/staff-audit');
        giveRoles.registerInviteAuditHandler(staffAudit.sendInviteRecord);
        if (!databaseResult.recoveryMode) await guildConfigService.initialize();

        const client = createDiscordClient();
        registerShutdownSequence(client);
        registerEvents(client, { recoveryMode: databaseResult.recoveryMode });

        await client.login(token);
        return client;
    } catch (error) {
        stopBackupScheduler();
        await stopModules().catch(() => undefined);
        releaseInstanceLease();
        throw error;
    }
}

module.exports = {
    bootstrap,
    createDiscordClient,
};
