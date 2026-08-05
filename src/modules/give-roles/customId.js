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
const REQUEST_ACTIONS = new Set([
    'role-confirm',
    'role-db',
    'role-decline',
    'role-block',
]);

function buildGiveRolesRequestCustomId(action, requestId) {
    const normalizedAction = String(action || '');
    const normalizedRequestId = String(requestId || '');
    if (!REQUEST_ACTIONS.has(normalizedAction)) {
        throw new Error(`Неизвестное действие заявки выдачи ролей: ${normalizedAction || '-'}`);
    }
    if (!normalizedRequestId) {
        throw new Error('Для кнопки заявки выдачи ролей не указан requestId');
    }
    return `${normalizedAction}:${normalizedRequestId}`;
}

function parseGiveRolesRequestCustomId(customId) {
    const value = String(customId || '');
    const separatorIndex = value.indexOf(':');
    if (separatorIndex <= 0 || separatorIndex === value.length - 1) return null;

    const action = value.slice(0, separatorIndex);
    const requestId = value.slice(separatorIndex + 1);
    if (!REQUEST_ACTIONS.has(action) || !requestId) return null;
    return { action, requestId };
}

module.exports = {
    REQUEST_ACTIONS,
    buildGiveRolesRequestCustomId,
    parseGiveRolesRequestCustomId,
};
