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
const accessGuard = require('./accessGuard');
const VacationError = require('./error');
const events = require('./events');
const service = require('./service');
const handlers = require('./settings/handlers');
const presentation = require('./presentation');
const renderer = require('./settings/renderer');
const schema = require('./settings/schema');

module.exports = {
    name: 'vacations',
    events,
    VacationError,
    ...accessGuard,
    ...service,
    ...handlers,
    ...presentation,
    ...renderer,
    ...schema,
};
