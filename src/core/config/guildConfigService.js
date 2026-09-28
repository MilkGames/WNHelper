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
const guildConfigs = require('./database');
const logger = require('../logging/logger');

let cache = new Map();
let initialized = false;

function clone(value) {
    return value == null ? value : structuredClone(value);
}

function normalizeGuildId(guildId) {
    return String(guildId || '').trim();
}

function hasMeaningfulValue(value) {
    if (value === null || value === undefined || value === '') return false;
    if (typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.values(value).some(hasMeaningfulValue);
    return true;
}

function isOperationalConfig(config) {
    if (!config) return false;

    return Object.entries(config).some(([key, value]) => {
        if (['guildId', '_serverName', 'settingsManagerRoleIds', 'botEnabled'].includes(key)) return false;
        return hasMeaningfulValue(value);
    });
}

function mergeGuildConfigDocuments(documents) {
    const merged = new Map();
    for (const document of Array.isArray(documents) ? documents : []) {
        const guildId = normalizeGuildId(document?.guildId);
        if (!guildId) continue;

        const current = merged.get(guildId);
        merged.set(guildId, current
            ? { ...current, ...document, guildId }
            : { ...document, guildId });
    }
    return merged;
}

async function reloadCache() {
    const documents = await guildConfigs.find();
    cache = mergeGuildConfigDocuments(documents);
    initialized = true;
}

async function initialize() {
    await reloadCache();
    logger.info('Динамические конфигурации серверов загружены', { count: cache.size });
}

function assertInitialized() {
    if (!initialized) {
        throw new Error('GuildConfigService не инициализирован');
    }
}

function getAny(guildId) {
    assertInitialized();
    return clone(cache.get(normalizeGuildId(guildId)) || null);
}

function isEnabled(guildId) {
    const config = getAny(guildId);
    return !config || config.botEnabled !== false;
}

function get(guildId) {
    const config = getAny(guildId);
    if (config?.botEnabled === false) return null;
    return isOperationalConfig(config) ? config : null;
}

function getAll() {
    assertInitialized();
    return [...cache.values()]
        .filter((config) => config.botEnabled !== false)
        .filter(isOperationalConfig)
        .map(clone);
}

function getAllIncludingEmpty() {
    assertInitialized();
    return [...cache.values()]
        .filter((config) => config.botEnabled !== false)
        .map(clone);
}

function getGuildIds() {
    return getAll().map((config) => config.guildId);
}

async function update(guildId, patch) {
    assertInitialized();

    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) {
        throw new Error('Не указан guildId для обновления конфигурации');
    }

    const current = cache.get(normalizedGuildId);
    if (!current) {
        throw new Error(`Конфигурация сервера ${normalizedGuildId} не найдена`);
    }

    const safePatch = { ...clone(patch) };
    delete safePatch.guildId;

    await guildConfigs.updateOne(
        { guildId: normalizedGuildId },
        safePatch
    );

    const updated = {
        ...current,
        ...safePatch,
        guildId: normalizedGuildId,
    };
    cache.set(normalizedGuildId, updated);

    return clone(updated);
}

async function replace(guildId, nextConfig) {
    assertInitialized();

    const normalizedGuildId = normalizeGuildId(guildId);
    if (!normalizedGuildId) {
        throw new Error('Не указан guildId для сохранения конфигурации');
    }

    const document = {
        ...clone(nextConfig),
        guildId: normalizedGuildId,
    };

    const existing = cache.get(normalizedGuildId);
    if (existing) {
        await guildConfigs.replaceOne({ guildId: normalizedGuildId }, document);
    } else {
        await new guildConfigs(document).save();
    }

    cache.set(normalizedGuildId, document);
    return clone(document);
}

async function ensureGuild(guild) {
    assertInitialized();

    const guildId = normalizeGuildId(guild?.id);
    if (!guildId) return null;

    const existing = cache.get(guildId);
    if (existing) return clone(existing);

    const document = {
        guildId,
        _serverName: String(guild?.name || guildId),
    };

    const result = await guildConfigs.insertOneIfAbsent({ guildId }, document);
    const saved = { ...result.document };
    cache.set(guildId, saved);

    if (result.inserted) {
        logger.info('Создана пустая конфигурация нового сервера', {
            guildId,
            serverName: document._serverName,
        });
    }

    return clone(saved);
}

module.exports = {
    initialize,
    reloadCache,
    get,
    getAny,
    isEnabled,
    getAll,
    getAllIncludingEmpty,
    getGuildIds,
    update,
    replace,
    ensureGuild,
};
