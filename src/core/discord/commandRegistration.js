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
const { getClientId } = require('../config/applicationConfig');
const { ContextMenuCommandBuilder, ApplicationCommandType, REST, Routes } = require('discord.js');
const { getCommands } = require('../../app/commandRegistry');
const guildConfigService = require('../config/guildConfigService');
const { getDatabaseStatus } = require('../database/status');
const logger = require('../logging/logger');

function getContextCommands() {
    return [
        new ContextMenuCommandBuilder()
            .setName('Повысить по отчёту')
            .setType(ApplicationCommandType.Message)
            .toJSON(),
        new ContextMenuCommandBuilder()
            .setName('Уволить по заявлению')
            .setType(ApplicationCommandType.Message)
            .toJSON(),
        new ContextMenuCommandBuilder()
            .setName('Принять сотрудника')
            .setType(ApplicationCommandType.User)
            .toJSON(),
        new ContextMenuCommandBuilder()
            .setName('Изменить ранг')
            .setType(ApplicationCommandType.User)
            .toJSON(),
        new ContextMenuCommandBuilder()
            .setName('Уволить сотрудника')
            .setType(ApplicationCommandType.User)
            .toJSON(),
    ];
}

function getSlashCommands() {
    return getCommands().map((command) => ({
        name: command.name,
        description: command.description,
        options: Array.isArray(command.options) ? command.options : [],
    }));
}

module.exports = async (client) => {
    const clientId = getClientId();
    const rest = new REST().setToken(process.env.token);

    try {
        await rest.put(Routes.applicationCommands(clientId), { body: [] });
        logger.info('Глобальные команды очищены: команды WN Helper регистрируются только на включённых серверах.');
    } catch (error) {
        logger.error('Не удалось очистить глобальные команды', error);
    }

    const enabledCommands = [...getSlashCommands(), ...getContextCommands()];
    const recoveryMode = getDatabaseStatus().recoveryMode;

    for (const guild of client.guilds.cache.values()) {
        const guildId = String(guild.id);
        const serverName = guild.name || guildId;
        const enabled = recoveryMode ? true : guildConfigService.isEnabled(guildId);
        const body = enabled ? enabledCommands : [];
        try {
            await rest.put(
                Routes.applicationGuildCommands(clientId, guildId),
                { body },
            );
            logger.info(enabled
                ? `Команды зарегистрированы на сервере ${serverName}.`
                : `Команды удалены с отключённого сервера ${serverName}.`, {
                guildId,
                count: body.length,
            });
        } catch (error) {
            logger.error('Не удалось синхронизировать команды сервера', {
                guildId,
                serverName,
                enabled,
            }, error);
        }
    }
};
