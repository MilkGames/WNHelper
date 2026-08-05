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
const configSession = require('./session');
const settingsCommand = require('./commands/settings');
const events = require('./events');
const presentation = require('./presentation');
const publication = require('./publication');

module.exports = {
    name: 'settings',
    commands: [settingsCommand],
    events,
    actions: {
        'settings.forceCloseSession': configSession.forceCloseByUser,
    },
    ...presentation,
    ...publication,
};
