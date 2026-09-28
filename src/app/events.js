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
const commandHandler = require('./commandHandler');
const recoveryAccess = require('./recoveryAccess');
const registerCommands = require('../core/discord/commandRegistration');
const readyLog = require('../core/runtime/readyLog');
const { getApplicationReadinessStatus } = require('./readiness');
const status = require('../core/runtime/status');
const databaseGarbageCollector = require('./databaseGarbageCollector');

module.exports = [
    {
        event: 'interactionCreate',
        id: 'app.recoveryAccess',
        order: 0,
        recoverySafe: true,
        execute: recoveryAccess,
    },
    {
        event: 'clientReady',
        id: 'app.registerCommands',
        order: 20,
        recoverySafe: true,
        execute: async (client) => {
            await databaseGarbageCollector(client);
            await registerCommands(client);
        },
    },
    {
        event: 'clientReady',
        id: 'app.readyLog',
        order: 1000,
        recoverySafe: true,
        execute: async (client) => readyLog(client, getApplicationReadinessStatus(client)),
    },
    {
        event: 'clientReady',
        id: 'app.status',
        order: 40,
        recoverySafe: true,
        execute: status.startStatusRotation,
    },
    {
        event: 'interactionCreate',
        id: 'app.commandHandler',
        order: 70,
        recoverySafe: true,
        execute: commandHandler,
    },
];
