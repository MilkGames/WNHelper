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
const { getStaffListSettings } = require('./settings/schema');

const MOSCOW_TIME_ZONE = 'Europe/Moscow';
const DAY_MS = 24 * 60 * 60 * 1000;

function getMoscowDateKey(timestamp = Date.now()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: MOSCOW_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(new Date(timestamp));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}

function parseDateKey(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(value || '').trim());
    if (!match) return null;
    const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    const date = new Date(timestamp);
    if (
        date.getUTCFullYear() !== Number(match[1]) ||
        date.getUTCMonth() !== Number(match[2]) - 1 ||
        date.getUTCDate() !== Number(match[3])
    ) return null;
    return timestamp;
}

function getLeaderTermOffset(config, timestamp = Date.now()) {
    const settings = getStaffListSettings(config);
    const appointmentTimestamp = parseDateKey(settings.leaderAppointmentDate);
    if (appointmentTimestamp === null) return null;
    const currentTimestamp = parseDateKey(getMoscowDateKey(timestamp));
    if (currentTimestamp === null || currentTimestamp < appointmentTimestamp) return null;
    const daysPassed = Math.floor((currentTimestamp - appointmentTimestamp) / DAY_MS);
    return daysPassed % settings.leaderTermDays;
}

function isLeaderTermDay(config, timestamp = Date.now()) {
    return getLeaderTermOffset(config, timestamp) === 0;
}

function isLeaderOpenDoorPeriod(config, timestamp = Date.now()) {
    const offset = getLeaderTermOffset(config, timestamp);
    return offset === 0 || offset === 1;
}

module.exports = {
    getMoscowDateKey,
    isLeaderOpenDoorPeriod,
    isLeaderTermDay,
};
