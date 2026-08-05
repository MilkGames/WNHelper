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
const config = require('../../../config.json');

const LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace']);

function normalizeIdList(values) {
    return Array.from(new Set(
        (Array.isArray(values) ? values : [])
            .map((value) => String(value || '').trim())
            .filter((value) => /^\d{17,20}$/u.test(value))
    ));
}

function normalizePositiveInteger(value, fallback) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function getClientId() {
    return String(config.clientId || '').trim();
}

function getOwnerUserIds() {
    return new Set(normalizeIdList(config.devs));
}

function getLoggingConfig() {
    const source = config.logging && typeof config.logging === 'object'
        ? config.logging
        : {};
    const level = String(source.level || 'info').trim().toLowerCase();
    return {
        level: LOG_LEVELS.has(level) ? level : 'info',
        toFile: source.toFile !== false,
    };
}

function getRulesPublicationGuildIds() {
    return new Set(normalizeIdList(config.rulesPublicationGuildIds));
}

function getWebhookServerConfig() {
    const source = config.webhookServer && typeof config.webhookServer === 'object'
        ? config.webhookServer
        : {};
    return {
        port: normalizePositiveInteger(source.port, 80),
        rateLimit: normalizePositiveInteger(source.rateLimit, 120),
        rateWindowMs: normalizePositiveInteger(source.rateWindowMs, 60_000),
    };
}

module.exports = {
    getClientId,
    getLoggingConfig,
    getOwnerUserIds,
    getRulesPublicationGuildIds,
    getWebhookServerConfig,
};
