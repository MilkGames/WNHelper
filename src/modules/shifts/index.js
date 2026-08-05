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
const events = require('./events');
const presentation = require('./presentation');
const service = require('./service');
const schema = require('./settings/schema');
const renderer = require('./settings/renderer');
const modalHandlers = require('./settings/modalHandlers');

module.exports = {
    name: 'shifts',
    events,
    ...service,
    ...schema,
    ...renderer,
    ...modalHandlers,
};
