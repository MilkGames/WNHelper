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
const settings = require('./settings/schema');
const integrations = require('./integrations');

module.exports = {
    name: 'give-roles',
    ...settings,
    ...integrations,
};

const customId = require('./customId');
const database = require('./database');
const request = require('./request');
const service = require('./service');
const events = require('./events');

Object.assign(module.exports, {
    events,
    ...customId,
    ...database,
    ...request,
    ...service,
});
