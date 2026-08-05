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
const crypto = require('crypto');

const REQUEST_TTL_MS = 2 * 60 * 1000;
const requests = new Map();

function pruneRequests(now = Date.now()) {
    for (const [token, request] of requests.entries()) {
        if (request.expiresAt <= now) requests.delete(token);
    }
}

function createShutdownConfirmation({ actorId, guildId = null, mode }) {
    pruneRequests();
    const token = crypto.randomBytes(12).toString('hex');
    const request = {
        token,
        actorId: String(actorId),
        guildId: guildId ? String(guildId) : null,
        mode: mode === 'force' ? 'force' : 'graceful',
        createdAt: Date.now(),
        expiresAt: Date.now() + REQUEST_TTL_MS,
    };
    requests.set(token, request);
    return { ...request };
}

function consumeShutdownConfirmation(token, actorId) {
    pruneRequests();
    const request = requests.get(String(token || ''));
    if (!request || request.actorId !== String(actorId || '')) return null;
    requests.delete(request.token);
    return { ...request };
}

function cancelShutdownConfirmation(token, actorId) {
    return Boolean(consumeShutdownConfirmation(token, actorId));
}

module.exports = {
    REQUEST_TTL_MS,
    cancelShutdownConfirmation,
    consumeShutdownConfirmation,
    createShutdownConfirmation,
    pruneRequests,
};
