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

const { SessionStore } = require('../../core/sessions/sessionStore');

const REQUEST_TTL_MS = 2 * 60 * 1000;
const requests = new SessionStore({
    ttlMs: REQUEST_TTL_MS,
    getLastActivity: (request) => request?.createdAt,
});

function createDatabaseRecoveryConfirmation({ actorId, guildId = null, planId }) {
    const token = crypto.randomBytes(12).toString('hex');
    const request = {
        token,
        actorId: String(actorId),
        guildId: guildId ? String(guildId) : null,
        planId: String(planId),
        createdAt: Date.now(),
    };
    requests.set(token, request, { actorId: request.actorId });
    return { ...request };
}

function consumeDatabaseRecoveryConfirmation(token, actorId) {
    const request = requests.get(token);
    if (!request || request.actorId !== String(actorId || '')) return null;
    requests.delete(token);
    return { ...request };
}

function cancelDatabaseRecoveryConfirmation(token, actorId) {
    return Boolean(consumeDatabaseRecoveryConfirmation(token, actorId));
}

module.exports = {
    REQUEST_TTL_MS,
    cancelDatabaseRecoveryConfirmation,
    consumeDatabaseRecoveryConfirmation,
    createDatabaseRecoveryConfirmation,
};
