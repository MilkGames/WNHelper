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
const guildConfigService = require('../../core/config/guildConfigService');
const { getChannelCounterSettings } = require('./settings/schema');
const { ensureGuildMembersCached } = require('../../core/discord/membersCache');
const { runDiscordRequest } = require('../../core/discord/request');
const logger = require('../../core/logging/logger');

const UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_EVENT_DELAY_MS = 10 * 1000;
const scheduledUpdates = new Map();
const updateQueues = new Map();
let scheduledUpdateTimer = null;

async function fetchCounterChannel(guild, channelId, settingPath) {
    if (!channelId) return null;

    try {
        const channel = await runDiscordRequest(() => guild.channels.fetch(channelId));
        if (!channel?.setName) {
            logger.warn('Для счётчика настроен неподходящий канал', {
                guildId: guild.id,
                channelId,
                settingPath,
            });
            return null;
        }
        return channel;
    } catch (error) {
        logger.error('Не удалось получить канал-счётчик', {
            guildId: guild.id,
            channelId,
            settingPath,
        }, error);
        return null;
    }
}

async function renameCounter(channel, nextName, guildId, counterType) {
    if (!channel || channel.name === nextName) return;

    try {
        await runDiscordRequest(() => channel.setName(nextName));
    } catch (error) {
        logger.error('Не удалось обновить название канала-счётчика', {
            guildId,
            channelId: channel.id,
            counterType,
            nextName,
        }, error);
    }
}

async function performGuildUpdate(client, guildId, reason) {
    const serverConfig = guildConfigService.get(guildId);
    if (!serverConfig?.features?.channelCounters) return;

    const guild = client.guilds.cache.get(String(guildId));
    if (!guild) return;

    const settings = getChannelCounterSettings(serverConfig);
    if (!settings.employeesChannelId && !settings.membersChannelId) return;

    if (settings.employeesChannelId) {
        await ensureGuildMembersCached(guild);
        const channel = await fetchCounterChannel(
            guild,
            settings.employeesChannelId,
            'channelCounterSettings.employeesChannelId'
        );
        const roleId = serverConfig.commonRoles?.weazelNewsRoleId;
        const role = roleId
            ? (guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null))
            : null;
        if (!role) {
            logger.warn('Не удалось обновить счётчик сотрудников: основная роль WN не найдена', {
                guildId: guild.id,
                roleId,
            });
        } else {
            const employeeCount = role.members.filter((member) => !member.user?.bot).size;
            await renameCounter(channel, `Сотрудников: ${employeeCount}`, guild.id, 'employees');
        }
    }

    if (settings.membersChannelId) {
        const channel = await fetchCounterChannel(
            guild,
            settings.membersChannelId,
            'channelCounterSettings.membersChannelId'
        );
        await renameCounter(channel, `Участников: ${guild.memberCount}`, guild.id, 'members');
    }

    logger.debug('Счётчики сервера обновлены', { guildId: guild.id, reason });
}

function updateGuildChannelCounters(client, guildId, { reason = 'manual' } = {}) {
    const normalizedGuildId = String(guildId);
    const previous = updateQueues.get(normalizedGuildId) || Promise.resolve();
    const next = previous
        .catch(() => undefined)
        .then(() => performGuildUpdate(client, normalizedGuildId, reason))
        .finally(() => {
            if (updateQueues.get(normalizedGuildId) === next) {
                updateQueues.delete(normalizedGuildId);
            }
        });
    updateQueues.set(normalizedGuildId, next);
    return next;
}

function scheduleGuildChannelCounterUpdate(client, guildId, {
    delayMs = DEFAULT_EVENT_DELAY_MS,
    reason = 'event',
} = {}) {
    const normalizedGuildId = String(guildId || '');
    if (!normalizedGuildId) return;

    const existingTimer = scheduledUpdates.get(normalizedGuildId);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(() => {
        scheduledUpdates.delete(normalizedGuildId);
        updateGuildChannelCounters(client, normalizedGuildId, { reason }).catch((error) => {
            logger.error('Ошибка отложенного обновления счётчиков', {
                guildId: normalizedGuildId,
                reason,
            }, error);
        });
    }, Math.max(Number(delayMs) || 0, 0));
    timer.unref?.();
    scheduledUpdates.set(normalizedGuildId, timer);
}

async function updateAllGuildChannelCounters(client, { reason = 'scheduled' } = {}) {
    for (const serverConfig of guildConfigService.getAll()) {
        if (!serverConfig.features?.channelCounters) continue;
        try {
            await updateGuildChannelCounters(client, serverConfig.guildId, { reason });
        } catch (error) {
            logger.error('Не удалось обновить счётчики сервера', {
                guildId: serverConfig.guildId,
                reason,
            }, error);
        }
    }
}

function startChannelCounterScheduler(client) {
    if (scheduledUpdateTimer) return;

    scheduledUpdateTimer = setInterval(() => {
        updateAllGuildChannelCounters(client, { reason: 'hourly' }).catch((error) => {
            logger.error('Ошибка контрольного обновления счётчиков', error);
        });
    }, UPDATE_INTERVAL_MS);
    scheduledUpdateTimer.unref?.();
}

function stopChannelCounterScheduler() {
    if (scheduledUpdateTimer) {
        clearInterval(scheduledUpdateTimer);
        scheduledUpdateTimer = null;
    }
    for (const timer of scheduledUpdates.values()) clearTimeout(timer);
    scheduledUpdates.clear();
}

function getChannelCounterStatus() {
    return {
        schedulerActive: Boolean(scheduledUpdateTimer),
        scheduledGuilds: scheduledUpdates.size,
        queuedGuilds: updateQueues.size,
    };
}

module.exports = {
    getChannelCounterStatus,
    scheduleGuildChannelCounterUpdate,
    startChannelCounterScheduler,
    stopChannelCounterScheduler,
    updateAllGuildChannelCounters,
    updateGuildChannelCounters,
};
