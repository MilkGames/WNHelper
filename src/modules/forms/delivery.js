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
const { sendMessageWithRetry } = require('../../core/discord/request');
const { getDefaultFooter } = require('../../core/ui/defaultFooter');

const LIMITS = {
    content: 2_000,
    embedTitle: 256,
    embedDescription: 4_096,
    embedFieldName: 256,
    embedFieldValue: 1_024,
    embedFields: 25,
    embedCharacters: 6_000,
};

class PermanentFormWebhookError extends Error {
    constructor(message, cause = null) {
        super(message);
        this.name = 'PermanentFormWebhookError';
        this.retryable = false;
        if (cause) this.cause = cause;
    }
}

function asString(value) {
    if (value === null || value === undefined) return '';
    return String(value);
}

function splitText(value, maxLength) {
    const source = asString(value);
    if (!source) return [];

    const chunks = [];
    let remaining = source;

    while (remaining.length > maxLength) {
        let splitAt = remaining.lastIndexOf('\n', maxLength);
        if (splitAt < Math.floor(maxLength * 0.5)) {
            splitAt = remaining.lastIndexOf(' ', maxLength);
        }
        if (splitAt < Math.floor(maxLength * 0.5)) {
            splitAt = maxLength;
        }

        const chunk = remaining.slice(0, splitAt).trimEnd();
        chunks.push(chunk || remaining.slice(0, maxLength));
        remaining = remaining.slice(splitAt);
        if (remaining.startsWith('\n') || remaining.startsWith(' ')) {
            remaining = remaining.slice(1);
        }
    }

    if (remaining.length) chunks.push(remaining);
    return chunks;
}

function clampText(value, maxLength) {
    return asString(value).slice(0, maxLength);
}

function normalizeColor(value) {
    const color = Number(value);
    if (!Number.isInteger(color) || color < 0 || color > 0xFFFFFF) return null;
    return color;
}

function normalizeTimestamp(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const timestamp = new Date(value);
    if (Number.isNaN(timestamp.getTime())) return null;
    return timestamp.toISOString();
}

function buildContinuationTitle(title, index) {
    const base = title || 'Результат формы';
    if (index === 0) return clampText(base, LIMITS.embedTitle);
    return clampText(`${base} - продолжение ${index + 1}`, LIMITS.embedTitle);
}

function buildFieldParts(field, index) {
    const rawName = asString(field?.name || `Поле ${index + 1}`) || `Поле ${index + 1}`;
    const name = clampText(rawName, LIMITS.embedFieldName) || `Поле ${index + 1}`;
    const nameOverflow = rawName.slice(LIMITS.embedFieldName);
    const rawValue = asString(field?.value || '-') || '-';
    const combinedValue = nameOverflow
        ? `${nameOverflow}\n${rawValue}`
        : rawValue;
    const values = splitText(combinedValue, LIMITS.embedFieldValue);

    return (values.length ? values : ['-']).map((value, partIndex) => ({
        name: partIndex === 0
            ? name
            : clampText(`${name.replace(/:$/, '')} - продолжение`, LIMITS.embedFieldName),
        value: value || '-',
        inline: field?.inline === true,
    }));
}

function countEmbedCharacters(embed) {
    let count = 0;
    count += asString(embed?.title).length;
    count += asString(embed?.description).length;
    count += asString(embed?.author?.name).length;
    count += asString(embed?.footer?.text).length;

    for (const field of embed?.fields || []) {
        count += asString(field?.name).length;
        count += asString(field?.value).length;
    }

    return count;
}

function createEmbedShell(source, continuationIndex) {
    const embed = {
        title: buildContinuationTitle(asString(source?.title), continuationIndex),
        footer: getDefaultFooter(),
    };

    const color = normalizeColor(source?.color);
    if (color !== null) embed.color = color;

    const timestamp = normalizeTimestamp(source?.timestamp);
    if (timestamp) embed.timestamp = timestamp;

    const authorName = clampText(source?.author?.name, LIMITS.embedTitle);
    if (authorName) embed.author = { name: authorName };

    return embed;
}

function splitEmbed(source, sourceIndex) {
    const normalizedSource = source && typeof source === 'object' ? source : {};
    const allFields = Array.isArray(normalizedSource.fields)
        ? normalizedSource.fields.flatMap(buildFieldParts)
        : [];
    const descriptionParts = splitText(normalizedSource.description, LIMITS.embedDescription);
    const chunks = [];
    let continuationIndex = 0;
    let current = createEmbedShell(normalizedSource, continuationIndex);

    function hasBody(embed) {
        return Boolean(embed.description || embed.fields?.length);
    }

    function pushCurrent() {
        if (!hasBody(current)) return;
        chunks.push(current);
        continuationIndex += 1;
        current = createEmbedShell(normalizedSource, continuationIndex);
    }

    for (const descriptionPart of descriptionParts) {
        const candidate = { ...current, description: descriptionPart };
        if (countEmbedCharacters(candidate) <= LIMITS.embedCharacters && !current.description) {
            current = candidate;
        } else {
            pushCurrent();
            current.description = descriptionPart;
        }
    }

    for (const field of allFields) {
        const fields = [...(current.fields || []), field];
        const candidate = { ...current, fields };
        const tooManyFields = fields.length > LIMITS.embedFields;
        const tooManyCharacters = countEmbedCharacters(candidate) > LIMITS.embedCharacters;

        if (tooManyFields || tooManyCharacters) {
            pushCurrent();
            current.fields = [field];
        } else {
            current = candidate;
        }
    }

    if (!hasBody(current) && chunks.length === 0) {
        current.description = `Результат формы ${sourceIndex + 1}`;
    }
    pushCurrent();

    return chunks;
}

function extractAllowedMentions(content) {
    const roles = new Set();
    const users = new Set();

    for (const match of asString(content).matchAll(/<@&(\d{17,20})>/g)) {
        roles.add(match[1]);
    }
    for (const match of asString(content).matchAll(/<@!?(\d{17,20})>/g)) {
        users.add(match[1]);
    }

    return {
        parse: [],
        roles: [...roles],
        users: [...users],
        repliedUser: false,
    };
}

function buildFormMessages(payload) {
    const topLevelChannelId = typeof payload?.channelId === 'string' ? payload.channelId.trim() : '';
    const message = payload?.message && typeof payload.message === 'object' ? payload.message : payload;
    const channelId = topLevelChannelId || (typeof message?.channelId === 'string' ? message.channelId.trim() : '');

    if (!/^\d{17,20}$/.test(channelId)) {
        throw new PermanentFormWebhookError('Payload форм должен содержать корректный channelId');
    }

    const contentParts = splitText(message?.content, LIMITS.content);
    const embedParts = Array.isArray(message?.embeds)
        ? message.embeds.flatMap(splitEmbed)
        : [];

    if (!contentParts.length && !embedParts.length) {
        throw new PermanentFormWebhookError('Payload форм должен содержать content или embeds');
    }

    const messageCount = Math.max(contentParts.length, embedParts.length, 1);
    const messages = [];

    for (let index = 0; index < messageCount; index += 1) {
        const content = contentParts[index] || '';
        const embed = embedParts[index] || null;
        const options = {
            allowedMentions: extractAllowedMentions(content),
        };

        if (content) options.content = content;
        if (embed) options.embeds = [embed];
        messages.push(options);
    }

    return { channelId, messages };
}

function buildFormMessageOptions(payload) {
    const { channelId, messages } = buildFormMessages(payload);
    return {
        channelId,
        options: messages[0],
        messages,
    };
}

function validateFormWebhookPayload(payload) {
    buildFormMessages(payload);
}

async function sendFormWebhookToChannel(client, payload, { nonceSeed = '' } = {}) {
    const { channelId, messages } = buildFormMessages(payload);
    const channel = await client.channels.fetch(channelId);

    if (!channel || typeof channel.send !== 'function' || channel.isTextBased?.() === false) {
        throw new PermanentFormWebhookError(`Канал ${channelId} не поддерживает отправку сообщений`);
    }

    const sentMessages = [];
    for (let index = 0; index < messages.length; index += 1) {
        const sent = await sendMessageWithRetry(channel, messages[index], {
            nonceSeed: `${nonceSeed || `formWebhook:${channelId}`}:${index}`,
        });
        sentMessages.push(sent);
    }

    return {
        sentChannelId: channelId,
        sentGuildId: sentMessages[0]?.guildId || channel.guildId || null,
        sentMessageIds: sentMessages.map((message) => message.id),
        messageLinks: sentMessages.map((message) => (
            `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`
        )),
        messageCount: sentMessages.length,
    };
}

module.exports = {
    PermanentFormWebhookError,
    buildFormMessageOptions,
    buildFormMessages,
    sendFormWebhookToChannel,
    validateFormWebhookPayload,
};
