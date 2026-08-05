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
const access = require('./access');
const command = require('./command');
const databaseRecoveryConfirmationHandler = require('./databaseRecoveryConfirmationHandler');
const shutdownConfirmation = require('./shutdownConfirmation');

module.exports = {
    ...access,
    name: 'manual-tools',
    commands: [command],
    events: [
        {
            event: 'interactionCreate',
            id: 'manual-tools.shutdownConfirmation',
            order: 75,
            recoverySafe: true,
            execute: shutdownConfirmation,
        },
        {
            event: 'interactionCreate',
            id: 'manual-tools.databaseRecoveryConfirmation',
            order: 76,
            recoverySafe: true,
            execute: databaseRecoveryConfirmationHandler,
        },
    ],
};
