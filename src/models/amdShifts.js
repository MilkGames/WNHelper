/*
 * WN Helper Discord Bot
 * Copyright (C) 2024 MilkGames
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
const { Schema, model } = require('mongoose');

const amdShiftsSchema = new Schema({
    guildId: {
        type: String,
        required: true,
    },
    messageId: {
        type: String,
        required: true,
    },
    date: {
        type: String,
        required: true,
    },
    firstHour: {
        type: String,
        default: 'Свободно',
    },
    secondHour: {
        type: String,
        default: 'Свободно',
    },
    thirdHour: {
        type: String,
        default: 'Свободно',
    },
    fourthHour: {
        type: String,
        default: 'Свободно',
    },
    fifthHour: {
        type: String,
        default: 'Свободно',
    },
    sixthHour: {
        type: String,
        default: 'Свободно',
    },
    seventhHour: {
        type: String,
        default: 'Свободно',
    },
    eighthHour: {
        type: String,
        default: 'Свободно',
    },
});

module.exports = model('amdShifts', amdShiftsSchema);