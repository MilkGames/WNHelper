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
function formatMemberIdentity({ userId, displayName }) {
    const normalizedUserId = String(userId || '').trim();
    const normalizedDisplayName = String(displayName || 'Имя не определено').trim();
    if (!normalizedUserId) return normalizedDisplayName;
    return `<@${normalizedUserId}> | ${normalizedDisplayName} | ||${normalizedUserId}||`;
}

function formatBreadcrumb(parts) {
    return parts
        .map((part) => String(part || '').trim())
        .filter(Boolean)
        .join(' -> ');
}

function quote(value) {
    return `"${String(value ?? '')}"`;
}

module.exports = {
    formatBreadcrumb,
    formatMemberIdentity,
    quote,
};
