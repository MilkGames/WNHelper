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
const { getOwnerUserIds } = require('../config/applicationConfig');
const startedAt = new Date();
const timestamp = startedAt.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const randomSuffix = crypto.randomBytes(3).toString('hex');
const instanceId = `wn-${timestamp}-${randomSuffix}`;

function isOwnerUser(userId) {
    return getOwnerUserIds().has(String(userId || ''));
}

function getPublicStatus() {
    return {
        startedAt: startedAt.getTime(),
        uptimeMs: Date.now() - startedAt.getTime(),
        pid: process.pid,
    };
}

function getPrivateStatus() {
    return {
        ...getPublicStatus(),
        instanceId,
    };
}

module.exports = {
    getOwnerUserIds,
    getPrivateStatus,
    getPublicStatus,
    instanceId,
    isOwnerUser,
    startedAt,
};
