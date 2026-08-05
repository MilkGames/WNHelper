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
const batch = require('./events/batch');
const contextMenu = require('./events/contextMenu');
const kaDelete = require('./events/kaDelete');
const userContext = require('./events/userContext');

module.exports = [
    { event: 'interactionCreate', id: 'contextMenu.js', order: 30, execute: contextMenu },
    { event: 'interactionCreate', id: 'staffAuditBatch.js', order: 130, execute: batch },
    { event: 'interactionCreate', id: 'userContextStaffAudit.js', order: 140, execute: userContext },
    {
        event: kaDelete.name,
        id: 'kaDelete.js',
        order: 100,
        execute: async (_client, reaction, user) => kaDelete.execute(reaction, user),
    },
];
