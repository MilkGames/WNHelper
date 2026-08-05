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
const logger = require('../core/logging/logger');
const { registerAction } = require('../core/integrations/actionRegistry');

const modulePaths = [
    '../modules/channel-counters',
    '../modules/staff-lists',
    '../modules/forms',
    '../modules/give-roles',
    '../modules/shifts',
    '../modules/examination',
    '../modules/vacations',
    '../modules/staff-audit',
    '../modules/offboarding',
    '../modules/discipline',
    '../modules/settings',
    '../modules/manual-tools',
    '../modules/analytics',
    '../modules/health',
];
let modules = null;

function loadModules() {
    if (modules) return modules;
    const names = new Set();
    modules = modulePaths.map((modulePath) => {
        const descriptor = require(modulePath);
        if (!descriptor?.name) throw new Error(`Модуль ${modulePath} не содержит имя`);
        if (names.has(descriptor.name)) throw new Error(`Модуль ${descriptor.name} зарегистрирован повторно`);
        names.add(descriptor.name);
        for (const [actionName, handler] of Object.entries(descriptor.actions || {})) {
            registerAction(actionName, handler);
        }
        return descriptor;
    });
    logger.info('Модули приложения загружены', { count: modules.length, modules: [...names] });
    return modules;
}

function getModules() {
    return loadModules();
}


function getModuleCommands() {
    return getModules().flatMap((descriptor) => (
        Array.isArray(descriptor.commands) ? descriptor.commands : []
    ));
}

function getModuleEvents() {
    return getModules().flatMap((descriptor) => (
        Array.isArray(descriptor.events)
            ? descriptor.events.map((event) => ({ ...event, module: descriptor.name }))
            : []
    ));
}

async function stopModules() {
    for (const descriptor of [...getModules()].reverse()) {
        if (typeof descriptor.stop !== 'function') continue;
        try {
            await descriptor.stop();
        } catch (error) {
            logger.error('Не удалось остановить модуль', { module: descriptor.name }, error);
        }
    }
}

module.exports = {
    getModuleCommands,
    getModuleEvents,
    getModules,
    loadModules,
    stopModules,
};
