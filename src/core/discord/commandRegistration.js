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
const { getClientId } = require('../config/applicationConfig');
const { ContextMenuCommandBuilder, ApplicationCommandType, REST, Routes } = require('discord.js');
const areCommandsDifferent = require('./areCommandsDifferent');
const getApplicationCommands = require('./getApplicationCommands');
const { getCommands } = require('../../app/commandRegistry');

const logger = require('../logging/logger');

module.exports = async (client) => {
    const clientId = getClientId();
    const commandsData = [
        new ContextMenuCommandBuilder()
            .setName('Повысить по отчёту')
            .setType(ApplicationCommandType.Message),
        new ContextMenuCommandBuilder()
            .setName('Уволить по заявлению')
            .setType(ApplicationCommandType.Message),
        new ContextMenuCommandBuilder()
            .setName('Принять сотрудника')
            .setType(ApplicationCommandType.User),
        new ContextMenuCommandBuilder()
            .setName('Изменить ранг')
            .setType(ApplicationCommandType.User),
        new ContextMenuCommandBuilder()
            .setName('Уволить сотрудника')
            .setType(ApplicationCommandType.User),
    ];

    const rest = new REST().setToken(process.env.token);

    try {
        logger.info('Перезагружаю контекстные команды на всех серверах...');

        await rest.put(
            Routes.applicationCommands(clientId),
            { body: commandsData },
        );

        logger.info('Контекстные команды зарегистрированы глобально.');
    } catch (error) {
        logger.error('Ошибка регистрации глобальных контекстных команд', error);
    }

    const localCommands = getCommands();

    for (const guild of client.guilds.cache.values()) {
        const serverId = guild.id;
        const serverName = guild.name || serverId;
        let applicationCommands;
        try {
            applicationCommands = await getApplicationCommands(client, serverId);
        } catch (error) {
            logger.error('Не удалось получить команды сервера', {
                guildId: serverId,
                serverName,
            }, error);
            continue;
        }

        const activeLocalCommandNames = new Set(localCommands.map((command) => command.name));

        for (const existingCommand of applicationCommands.cache.values()) {
            if (activeLocalCommandNames.has(existingCommand.name)) continue;

            try {
                await applicationCommands.delete(existingCommand.id);
                logger.info(`Удалена устаревшая команда "${existingCommand.name}" на сервере ${serverName}.`);
            } catch (error) {
                logger.error('Не удалось удалить устаревшую команду', {
                    guildId: serverId,
                    serverName,
                    command: existingCommand.name,
                }, error);
            }
        }

        for (const localCommand of localCommands) {
            const { name, description, options } = localCommand;
            const commandOptions = Array.isArray(options) ? options : [];
            logger.info(`Обрабатываю команду "${name}" на сервере ${serverName}...`);

            try {
                const existingCommand = applicationCommands.cache.find(
                    (cmd) => cmd.name === name
                );


                if (existingCommand) {
                    if (areCommandsDifferent(existingCommand, localCommand)) {
                        await applicationCommands.edit(existingCommand.id, {
                            description,
                            options: commandOptions,
                        });

                        logger.info(`Изменена команда "${name}" на сервере ${serverName}.`);
                    }
                    continue;
                }


                await applicationCommands.create({
                    name,
                    description,
                    options: commandOptions,
                });

                logger.info(`Успешно зарегистрирована команда "${name}" на сервере ${serverName}.`);
            } catch (error) {
                logger.error('Ошибка регистрации отдельной команды', {
                    guildId: serverId,
                    serverName,
                    command: name,
                }, error);
            }
        }
    }
};