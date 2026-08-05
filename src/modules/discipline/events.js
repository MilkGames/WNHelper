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
const appeals = require('./events/appeals');
const interactions = require('./events/interactions');
const massApproval = require('./events/massApproval');
const massInteractions = require('./events/massInteractions');
const massScheduler = require('./events/massScheduler');
const scheduler = require('./events/scheduler');

module.exports = [
    { event: 'clientReady', id: 'disciplineScheduler.js', order: 60, execute: scheduler },
    { event: 'clientReady', id: 'massDisciplineScheduler.js', order: 110, execute: massScheduler },
    { event: 'interactionCreate', id: 'disciplineInteractions.js', order: 40, execute: interactions },
    { event: 'interactionCreate', id: 'disciplineAppeals.js', order: 45, execute: appeals },
    { event: 'interactionCreate', id: 'massDisciplineApproval.js', order: 80, execute: massApproval },
    { event: 'interactionCreate', id: 'massDisciplineInteractions.js', order: 90, execute: massInteractions },
];
