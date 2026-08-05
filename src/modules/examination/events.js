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
const examResults = require('./events/examResults');
const interactions = require('./events/interactions');
const scheduler = require('./events/scheduler');
const voice = require('./events/voice');
const webhook = require('./events/webhook');

module.exports = [
    { event: 'clientReady', id: 'examinationScheduler.js', order: 80, execute: scheduler },
    { event: 'clientReady', id: 'getExams.js', order: 90, execute: webhook },
    { event: 'interactionCreate', id: 'examinationInteractions.js', order: 50, execute: interactions },
    { event: 'interactionCreate', id: 'sendExams.js', order: 110, execute: examResults },
    { event: 'voiceStateUpdate', id: 'examinationVoice.js', order: 100, execute: voice },
];
