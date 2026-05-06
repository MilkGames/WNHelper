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
const DEFAULT_FOOTER = {
    text: 'WN Helper by Michael Lindberg. Discord: milkgames',
    iconURL: 'https://i.imgur.com/zdxWb0s.jpeg',
};
const { sendMessageWithRetry } = require('./discordRequest');

function clampString(value, maxLength) {
    if (value === null || value === undefined) return '';
    return String(value).slice(0, maxLength);
}

function normalizeField(field, index) {
    return {
        name: clampString(field?.name || `Field ${index + 1}`, 256) || `Field ${index + 1}`,
        value: clampString(field?.value || '—', 1024) || '—',
        inline: field?.inline === true,
    };
}

function normalizeEmbed(embed, index) {
    const fields = Array.isArray(embed?.fields) ? embed.fields.slice(0, 25).map(normalizeField) : undefined;
    const normalized = {};

    const title = clampString(embed?.title, 256);
    if (title) normalized.title = title;

    const description = clampString(embed?.description, 4096);
    if (description) normalized.description = description;

    if (Number.isFinite(embed?.color)) normalized.color = embed.color;

    if (fields && fields.length) normalized.fields = fields;

    if (typeof embed?.timestamp === 'string' && embed.timestamp.trim()) {
        normalized.timestamp = embed.timestamp;
    }

    const authorName = clampString(embed?.author?.name, 256);
    if (authorName) {
        normalized.author = { name: authorName };
    }

    if (Object.keys(normalized).length === 0) {
        normalized.description = `Form embed ${index + 1}`;
    }

    normalized.footer = DEFAULT_FOOTER;

    return normalized;
}

function buildFormMessageOptions(payload) {
    const topLevelChannelId = typeof payload?.channelId === 'string' ? payload.channelId.trim() : '';
    const message = payload?.message && typeof payload.message === 'object' ? payload.message : payload;

    const channelId = topLevelChannelId || (typeof message?.channelId === 'string' ? message.channelId.trim() : '');
    if (!channelId) {
        throw new Error('Payload форм должен содержать channelId');
    }

    const content = clampString(message?.content, 2000);
    const embeds = Array.isArray(message?.embeds) ? message.embeds.slice(0, 10).map(normalizeEmbed) : [];

    if (!content && embeds.length === 0) {
        throw new Error('Payload форм должен содержать content или embeds');
    }

    const options = {};
    if (content) options.content = content;
    if (embeds.length) options.embeds = embeds;
    options.allowedMentions = {
        parse: ['roles', 'users'],
    };

    return {
        channelId,
        options,
    };
}

async function sendFormWebhookToChannel(client, payload) {
    const { channelId, options } = buildFormMessageOptions(payload);
    const channel = await client.channels.fetch(channelId);
    const sent = await sendMessageWithRetry(channel, options, {
        nonceSeed: `formWebhook:${channelId}:${JSON.stringify(options)}`,
    });

    return {
        sentChannelId: sent.channelId,
        sentMessageId: sent.id,
        messageLink: `https://discord.com/channels/${sent.guildId}/${sent.channelId}/${sent.id}`,
    };
}

module.exports = {
    buildFormMessageOptions,
    sendFormWebhookToChannel,
};
