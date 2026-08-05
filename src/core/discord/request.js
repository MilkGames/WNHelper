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
const { MessageFlags } = require('discord.js');

const TEMPORARY_REPLY_MS = 30_000;
const interactionDeleteTimers = new WeakMap();
const ephemeralInteractions = new WeakSet();

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(error) {
    const retryAfter = error?.retryAfter;
    if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter;

    const rawRetryAfter = error?.rawError?.retry_after;
    if (Number.isFinite(rawRetryAfter) && rawRetryAfter > 0) return rawRetryAfter * 1000;

    const message = String(error?.message || error || '');
    const match = message.match(/Retry\s+after\s+([0-9.]+)\s*seconds/i);
    if (match) {
        const seconds = Number(match[1]);
        if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    }

    return 0;
}

function isRetryableDiscordError(error) {
    const status = Number(error?.status);
    if (status === 429 || status >= 500) return true;

    const code = String(error?.code || error?.cause?.code || '').toUpperCase();
    if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
        return true;
    }

    const message = String(error?.stack || error?.message || error || '');
    return /AggregateError|Connect Timeout Error|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|fetch failed|socket hang up/i.test(message);
}

function computeDelayMs(error, attempt, baseDelayMs, maxDelayMs) {
    const retryAfterMs = parseRetryAfterMs(error);
    const backoffMs = Math.min(baseDelayMs * (2 ** Math.max(attempt - 1, 0)), maxDelayMs);
    return Math.max(retryAfterMs, backoffMs);
}

async function runDiscordRequest(request, {
    attempts = 4,
    baseDelayMs = 1_500,
    maxDelayMs = 15_000,
    shouldTreatErrorAsSuccess = null,
} = {}) {
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await request(attempt);
        } catch (error) {
            if (typeof shouldTreatErrorAsSuccess === 'function' && shouldTreatErrorAsSuccess(error)) {
                return undefined;
            }

            lastError = error;
            if (attempt >= attempts || !isRetryableDiscordError(error)) {
                throw error;
            }

            await sleep(computeDelayMs(error, attempt, baseDelayMs, maxDelayMs));
        }
    }

    throw lastError;
}

function buildMessageNonce(seed) {
    return crypto
        .createHash('sha1')
        .update(String(seed || `${Date.now()}:${Math.random()}`))
        .digest('hex')
        .slice(0, 25);
}

function withNonce(options, seed) {
    if (options?.nonce !== undefined) {
        return options;
    }

    return {
        ...options,
        nonce: buildMessageNonce(seed),
        enforceNonce: true,
    };
}

function isAlreadyAcknowledgedError(error) {
    return Number(error?.code) === 40_060;
}

function isUnknownInteractionMessage(error) {
    return [10_008, 10_015].includes(Number(error?.code));
}

function hasEphemeralFlag(flags) {
    if (flags == null) return false;
    if (typeof flags === 'number') return (flags & MessageFlags.Ephemeral) === MessageFlags.Ephemeral;
    if (typeof flags?.has === 'function') return flags.has(MessageFlags.Ephemeral);
    return false;
}

function hasActiveComponents(options) {
    return Array.isArray(options?.components) && options.components.length > 0;
}

function appendTemporaryNotice(content, seconds = 30) {
    const text = String(content || '').trim();
    const notice = `-# Это сообщение удалится через ${seconds} секунд.`;
    if (!text) return notice;
    if (/сообщение удалится через/i.test(text)) return text;
    return `${text}\n${notice}`;
}

function prepareInteractionPayload(options, { ephemeral = false } = {}) {
    const source = options && typeof options === 'object' ? options : {};
    const {
        temporary,
        deleteAfterMs,
        ...payload
    } = source;
    const shouldDelete = ephemeral && !hasActiveComponents(payload) && temporary !== false;
    const delayMs = Number.isFinite(deleteAfterMs) && deleteAfterMs > 0
        ? deleteAfterMs
        : TEMPORARY_REPLY_MS;

    if (shouldDelete) {
        payload.content = appendTemporaryNotice(payload.content, Math.round(delayMs / 1000));
    }

    return { payload, shouldDelete, delayMs };
}

function clearInteractionDeleteTimer(interaction) {
    const timer = interactionDeleteTimers.get(interaction);
    if (timer) clearTimeout(timer);
    interactionDeleteTimers.delete(interaction);
}

function scheduleInteractionReplyDeletion(interaction, delayMs = TEMPORARY_REPLY_MS) {
    if (!interaction || typeof interaction.deleteReply !== 'function') return;
    clearInteractionDeleteTimer(interaction);
    const timer = setTimeout(() => {
        interactionDeleteTimers.delete(interaction);
        runDiscordRequest(() => interaction.deleteReply(), {
            attempts: 1,
            shouldTreatErrorAsSuccess: isUnknownInteractionMessage,
        }).catch(() => undefined);
    }, delayMs);
    timer.unref?.();
    interactionDeleteTimers.set(interaction, timer);
}

function scheduleFollowUpDeletion(message, delayMs = TEMPORARY_REPLY_MS) {
    if (!message || typeof message.delete !== 'function') return;
    const timer = setTimeout(() => {
        runDiscordRequest(() => message.delete(), {
            attempts: 1,
            shouldTreatErrorAsSuccess: isUnknownInteractionMessage,
        }).catch(() => undefined);
    }, delayMs);
    timer.unref?.();
}

async function sendMessageWithRetry(target, options, {
    attempts = 4,
    nonceSeed = '',
} = {}) {
    const sendOptions = withNonce(options, nonceSeed || `${target?.id || 'message'}:${Date.now()}:${Math.random()}`);
    return runDiscordRequest(() => target.send(sendOptions), { attempts });
}

async function editMessageWithRetry(message, options, {
    attempts = 4,
} = {}) {
    return runDiscordRequest(() => message.edit(options), { attempts });
}

async function startThreadWithRetry(message, options, {
    attempts = 4,
} = {}) {
    return runDiscordRequest(() => message.startThread(options), {
        attempts,
        shouldTreatErrorAsSuccess: isAlreadyAcknowledgedError,
    });
}

async function closeThreadWithRetry(thread, {
    attempts = 3,
    lock = true,
    reason = 'WN Helper: процесс завершён',
} = {}) {
    if (!thread) return { locked: false, archived: false };

    let locked = Boolean(thread.locked);
    let archived = Boolean(thread.archived);

    let lockError = null;
    if (!archived && lock && !locked && typeof thread.setLocked === 'function') {
        try {
            await runDiscordRequest(() => thread.setLocked(true, reason), { attempts });
            locked = true;
        } catch (error) {
            lockError = error;
        }
    }

    if (!archived && typeof thread.setArchived === 'function') {
        await runDiscordRequest(() => thread.setArchived(true, reason), { attempts });
        archived = true;
    }

    return { locked, archived, lockError };
}

async function deferReplyWithRetry(interaction, options, {
    attempts = 3,
} = {}) {
    if (hasEphemeralFlag(options?.flags)) ephemeralInteractions.add(interaction);
    clearInteractionDeleteTimer(interaction);
    return runDiscordRequest(() => interaction.deferReply(options), {
        attempts,
        shouldTreatErrorAsSuccess: isAlreadyAcknowledgedError,
    });
}

async function editReplyWithRetry(interaction, options, {
    attempts = 4,
} = {}) {
    const ephemeral = ephemeralInteractions.has(interaction) ||
        interaction?.ephemeral === true ||
        interaction?.message?.flags?.has?.(MessageFlags.Ephemeral) === true;
    const { payload, shouldDelete, delayMs } = prepareInteractionPayload(options, { ephemeral });
    const result = await runDiscordRequest(() => interaction.editReply(payload), {
        attempts,
        shouldTreatErrorAsSuccess: ephemeral ? isUnknownInteractionMessage : null,
    });
    if (result && shouldDelete) scheduleInteractionReplyDeletion(interaction, delayMs);
    else clearInteractionDeleteTimer(interaction);
    return result;
}

async function replyWithRetry(interaction, options, {
    attempts = 3,
} = {}) {
    const ephemeral = hasEphemeralFlag(options?.flags);
    if (ephemeral) ephemeralInteractions.add(interaction);
    const { payload, shouldDelete, delayMs } = prepareInteractionPayload(options, { ephemeral });
    const result = await runDiscordRequest(() => interaction.reply(payload), {
        attempts,
        shouldTreatErrorAsSuccess: isAlreadyAcknowledgedError,
    });
    if (shouldDelete) scheduleInteractionReplyDeletion(interaction, delayMs);
    return result;
}

async function followUpWithRetry(interaction, options, {
    attempts = 3,
} = {}) {
    const ephemeral = hasEphemeralFlag(options?.flags);
    const { payload, shouldDelete, delayMs } = prepareInteractionPayload(options, { ephemeral });
    const message = await runDiscordRequest(() => interaction.followUp(payload), { attempts });
    if (shouldDelete) scheduleFollowUpDeletion(message, delayMs);
    return message;
}

async function deleteReplyWithRetry(interaction, {
    attempts = 3,
} = {}) {
    clearInteractionDeleteTimer(interaction);
    return runDiscordRequest(() => interaction.deleteReply(), {
        attempts,
        shouldTreatErrorAsSuccess: isUnknownInteractionMessage,
    });
}

async function showModalWithRetry(interaction, modal, {
    attempts = 3,
} = {}) {
    clearInteractionDeleteTimer(interaction);
    return runDiscordRequest(() => interaction.showModal(modal), {
        attempts,
        shouldTreatErrorAsSuccess: isAlreadyAcknowledgedError,
    });
}

module.exports = {
    TEMPORARY_REPLY_MS,
    closeThreadWithRetry,
    deferReplyWithRetry,
    deleteReplyWithRetry,
    editMessageWithRetry,
    editReplyWithRetry,
    followUpWithRetry,
    replyWithRetry,
    runDiscordRequest,
    sendMessageWithRetry,
    showModalWithRetry,
    startThreadWithRetry,
};
