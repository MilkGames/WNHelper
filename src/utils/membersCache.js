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
const logger = require('./logger');

const memberFetchPromises = new Map();
const lastSuccessfulFetchAt = new Map();

let globalMemberFetchQueue = Promise.resolve();

const MEMBER_CACHE_TTL_MS = 30 * 60 * 1000; // 30 минут
const MEMBER_FETCH_COOLDOWN_MS = 30 * 1000; // 30 секунд

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function enqueueMemberFetch(task) {
    const queuedTask = globalMemberFetchQueue
        .catch(() => null)
        .then(async () => {
            try {
                return await task();
            } finally {
                await sleep(MEMBER_FETCH_COOLDOWN_MS);
            }
        });

    globalMemberFetchQueue = queuedTask;

    return queuedTask;
}

async function ensureGuildMembersCached(guild) {
    const lastFetchAt = lastSuccessfulFetchAt.get(guild.id) || 0;
    const cacheIsFresh = Date.now() - lastFetchAt < MEMBER_CACHE_TTL_MS;

    if (cacheIsFresh && guild.members.cache.size > 0) {
        return guild.members.cache;
    }

    const existingPromise = memberFetchPromises.get(guild.id);
    if (existingPromise) {
        await existingPromise;
        return guild.members.cache;
    }

    const fetchPromise = enqueueMemberFetch(async () => {
        try {
            await guild.members.fetch({
                time: 120000, // 2 минуты
                withPresences: false,
                force: true,
            });

            lastSuccessfulFetchAt.set(guild.id, Date.now());
        } catch (error) {
            logger.info(`Не удалось загрузить список участников сервера ${guild.id}, используется кэш: ${error}`);
        }
    });

    memberFetchPromises.set(guild.id, fetchPromise);

    try {
        await fetchPromise;
    } finally {
        memberFetchPromises.delete(guild.id);
    }

    return guild.members.cache;
}

module.exports = {
    ensureGuildMembersCached,
};