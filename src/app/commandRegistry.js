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
const logger = require('../core/logging/logger');
const { getModuleCommands } = require('./moduleRegistry');

let commands = null;
let commandMap = null;

function loadCommands() {
    if (commands) return commands;
    commandMap = new Map();
    commands = [];

    const allCommands = getModuleCommands();

    for (const command of allCommands) {
        if (!command?.name || typeof command.callback !== 'function') {
            throw new Error(`Команда ${command?.__file || command?.name || 'без имени'} содержит некорректный объект`);
        }
        if (commandMap.has(command.name)) {
            throw new Error(`Команда "${command.name}" зарегистрирована повторно`);
        }
        commandMap.set(command.name, command);
        commands.push(command);
    }

    logger.info('Команды загружены в реестр', { count: commands.length });
    return commands;
}

function getCommands(exceptions = []) {
    const excluded = new Set(exceptions.map(String));
    return loadCommands().filter((command) => !excluded.has(command.name));
}

function getCommand(name) {
    loadCommands();
    return commandMap.get(String(name || '')) || null;
}

function getCommandRegistryStatus() {
    return {
        loaded: Boolean(commands),
        count: commands?.length || 0,
    };
}

module.exports = {
    getCommand,
    getCommandRegistryStatus,
    getCommands,
    loadCommands,
};
