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
const { getDepartments } = require('../../core/config/departmentSchema');
const {
    HIGH_STAFF_TITLE,
    buildDepartmentEmbeds,
    buildHighStaffEmbeds,
    getDepartmentStaffGroups,
    getLeaderTermInfo,
} = require('./presentation');
const guildConfigService = require('../../core/config/guildConfigService');
const {
    editMessageWithRetry,
    runDiscordRequest,
    sendMessageWithRetry,
} = require('../../core/discord/request');
const { ensureGuildMembersCached } = require('../../core/discord/membersCache');
const logger = require('../../core/logging/logger');

const UPDATE_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_EVENT_DELAY_MS = 10 * 1000;
const MAX_EMBEDS_PER_MESSAGE = 10;
const SAFE_EMBED_TEXT_LIMIT = 5_600;

const scheduledUpdates = new Map();
const updateQueues = new Map();
let scheduledUpdateTimer = null;

async function fetchTextChannel(guild, channelId, settingPath) {
    if (!channelId) return null;

    try {
        const channel = await runDiscordRequest(() => guild.channels.fetch(channelId));
        if (!channel?.isTextBased?.() || !channel.messages) {
            logger.warn('Для состава настроен неподходящий канал', {
                guildId: guild.id,
                channelId,
                settingPath,
            });
            return null;
        }
        return channel;
    } catch (error) {
        logger.error('Не удалось получить канал состава', {
            guildId: guild.id,
            channelId,
            settingPath,
        }, error);
        return null;
    }
}

function getEmbedTextLength(embed) {
    const data = typeof embed.toJSON === 'function' ? embed.toJSON() : embed;
    return (
        String(data.title || '').length +
        String(data.description || '').length +
        String(data.footer?.text || '').length +
        String(data.author?.name || '').length +
        (data.fields || []).reduce(
            (sum, field) => sum + String(field.name || '').length + String(field.value || '').length,
            0
        )
    );
}

function splitEmbedsIntoPayloads(embeds) {
    const payloads = [];
    let current = [];
    let currentLength = 0;

    for (const embed of embeds) {
        const embedLength = getEmbedTextLength(embed);
        if (
            current.length > 0 &&
            (current.length >= MAX_EMBEDS_PER_MESSAGE || currentLength + embedLength > SAFE_EMBED_TEXT_LIMIT)
        ) {
            payloads.push(current);
            current = [];
            currentLength = 0;
        }

        current.push(embed);
        currentLength += embedLength;
    }

    if (current.length) payloads.push(current);
    return payloads;
}

function matchesStaffMessageTitle(message, exactTitle) {
    const title = String(message.embeds?.[0]?.title || '');
    return title === exactTitle || (
        title.startsWith(`${exactTitle} `) &&
        title.endsWith(' продолжение')
    );
}

async function findStaffMessages(channel, { exactTitle }) {
    const messages = await runDiscordRequest(() => channel.messages.fetch({ limit: 100 }));
    return messages
        .filter((message) => (
            message.author?.id === channel.client.user.id &&
            matchesStaffMessageTitle(message, exactTitle)
        ))
        .sort((first, second) => first.createdTimestamp - second.createdTimestamp);
}

async function upsertStaffMessages(channel, embeds, identity, nonceSeed) {
    const foundMessages = await findStaffMessages(channel, identity);
    const existingMessages = Array.from(foundMessages.values());
    const embedPayloads = splitEmbedsIntoPayloads(embeds);
    const results = [];

    for (const [index, payloadEmbeds] of embedPayloads.entries()) {
        const payload = {
            embeds: payloadEmbeds,
            allowedMentions: { parse: [] },
        };
        const existingMessage = existingMessages[index];
        if (existingMessage) {
            results.push(await editMessageWithRetry(existingMessage, {
                ...payload,
                content: null,
            }));
        } else {
            results.push(await sendMessageWithRetry(channel, payload, {
                nonceSeed: `${nonceSeed}:${index}`,
            }));
        }
    }

    for (const redundantMessage of existingMessages.slice(embedPayloads.length)) {
        await runDiscordRequest(() => redundantMessage.delete()).catch((error) => {
            logger.error('Не удалось удалить лишнее сообщение-продолжение состава', {
                guildId: channel.guildId,
                channelId: channel.id,
                messageId: redundantMessage.id,
            }, error);
        });
    }

    return results;
}

async function performGuildUpdate(client, guildId, reason) {
    const serverConfig = guildConfigService.get(guildId);
    if (!serverConfig?.features?.staffLists) return;

    const guild = client.guilds.cache.get(String(guildId));
    if (!guild) return;

    const settings = getStaffListSettings(serverConfig);
    const departments = getDepartments(serverConfig);
    const configuredDepartments = departments.filter((department) => department.staffChannelId);
    if (!settings.highStaffChannelId && !configuredDepartments.length) return;

    const members = await ensureGuildMembersCached(guild);
    const updateTasks = [];

    for (const [index, department] of departments.entries()) {
        if (!department.staffChannelId) continue;
        const channel = await fetchTextChannel(
            guild,
            department.staffChannelId,
            `departments.${department.id}.staffChannelId`
        );
        if (!channel) continue;

        updateTasks.push(upsertStaffMessages(
            channel,
            buildDepartmentEmbeds(members, serverConfig, department, index, guild.id),
            { exactTitle: `Состав отдела ${department.fullName}` },
            `staff-list:${guild.id}:${department.id}:${channel.id}`
        ));
    }

    if (settings.highStaffChannelId) {
        const channel = await fetchTextChannel(
            guild,
            settings.highStaffChannelId,
            'staffListSettings.highStaffChannelId'
        );
        if (channel) {
            updateTasks.push(upsertStaffMessages(
                channel,
                buildHighStaffEmbeds(members, serverConfig, guild.id),
                {
                    exactTitle: HIGH_STAFF_TITLE,
                    titlePrefix: HIGH_STAFF_TITLE,
                },
                `staff-list:${guild.id}:high:${channel.id}`
            ));
        }
    }

    const results = await Promise.allSettled(updateTasks);
    results.forEach((result) => {
        if (result.status === 'rejected') {
            logger.error('Не удалось обновить сообщение состава', {
                guildId: guild.id,
                reason,
            }, result.reason);
        }
    });
}

function updateGuildStaffLists(client, guildId, { reason = 'manual' } = {}) {
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

function scheduleGuildStaffListUpdate(client, guildId, {
    delayMs = DEFAULT_EVENT_DELAY_MS,
    reason = 'event',
} = {}) {
    const normalizedGuildId = String(guildId || '');
    if (!normalizedGuildId) return;

    const existingTimer = scheduledUpdates.get(normalizedGuildId);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(() => {
        scheduledUpdates.delete(normalizedGuildId);
        updateGuildStaffLists(client, normalizedGuildId, { reason }).catch((error) => {
            logger.error('Ошибка отложенного обновления составов', {
                guildId: normalizedGuildId,
                reason,
            }, error);
        });
    }, Math.max(Number(delayMs) || 0, 0));
    timer.unref?.();
    scheduledUpdates.set(normalizedGuildId, timer);
}

async function updateAllGuildStaffLists(client, { reason = 'scheduled' } = {}) {
    for (const serverConfig of guildConfigService.getAll()) {
        if (!serverConfig.features?.staffLists) continue;
        try {
            await updateGuildStaffLists(client, serverConfig.guildId, { reason });
        } catch (error) {
            logger.error('Не удалось обновить составы сервера', {
                guildId: serverConfig.guildId,
                reason,
            }, error);
        }
    }
}

function startStaffListScheduler(client) {
    if (scheduledUpdateTimer) return;

    scheduledUpdateTimer = setInterval(() => {
        updateAllGuildStaffLists(client, { reason: 'hourly' }).catch((error) => {
            logger.error('Ошибка контрольного обновления составов', error);
        });
    }, UPDATE_INTERVAL_MS);
    scheduledUpdateTimer.unref?.();
}

function stopStaffListScheduler() {
    if (scheduledUpdateTimer) {
        clearInterval(scheduledUpdateTimer);
        scheduledUpdateTimer = null;
    }
    for (const timer of scheduledUpdates.values()) clearTimeout(timer);
    scheduledUpdates.clear();
}

function getStaffListStatus() {
    return {
        schedulerActive: Boolean(scheduledUpdateTimer),
        scheduledGuilds: scheduledUpdates.size,
        queuedGuilds: updateQueues.size,
    };
}

module.exports = {
    getStaffListStatus,
    scheduleGuildStaffListUpdate,
    startStaffListScheduler,
    stopStaffListScheduler,
    updateAllGuildStaffLists,
    updateGuildStaffLists,
};
