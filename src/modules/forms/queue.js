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

const { formWebhookQueue } = require('./database');
const logger = require('../../core/logging/logger');
const {
    completeWebhookJob,
    enqueueWebhookJob,
} = require('./receipts');

const MAX_ATTEMPTS = 12;
const DEAD_RETENTION_MS = 7 * 24 * 60 * 60_000;

function nowMs() {
    return Date.now();
}

function stableSerialize(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableSerialize).join(',')}]`;
    }

    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
}

function stableHash(input) {
    return crypto.createHash('sha1').update(String(input)).digest('hex');
}

function createJobId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return `${nowMs()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
}

function getExplicitDedupeKey(payload) {
    const candidates = [
        payload?.dedupeKey,
        payload?.eventId,
        payload?.submissionId,
        payload?.message?.dedupeKey,
        payload?.message?.eventId,
        payload?.message?.submissionId,
    ];

    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim();
        }
    }

    return '';
}

function hasStablePayloadTimestamp(payload) {
    const message = payload?.message && typeof payload.message === 'object'
        ? payload.message
        : payload;
    const candidates = [
        payload?.timestamp,
        message?.timestamp,
        ...(Array.isArray(message?.embeds) ? message.embeds.map((embed) => embed?.timestamp) : []),
    ];

    return candidates.some((candidate) => (
        typeof candidate === 'string' &&
        candidate.trim() &&
        !Number.isNaN(new Date(candidate).getTime())
    ));
}

function buildJobIdentity(payload, jobId) {
    const explicitKey = getExplicitDedupeKey(payload);
    if (explicitKey) {
        return {
            jobKey: `form:${explicitKey}`,
            dedupeMode: 'explicit',
        };
    }

    if (hasStablePayloadTimestamp(payload)) {
        return {
            jobKey: `form:${stableHash(stableSerialize(payload))}`,
            dedupeMode: 'payload',
        };
    }

    return {
        jobKey: `form:unique:${jobId}`,
        dedupeMode: 'none',
    };
}

function parseRetryAfterMs(error) {
    const retryAfter = error?.retryAfter;
    if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter;

    const rawRetryAfter = error?.rawError?.retry_after;
    if (Number.isFinite(rawRetryAfter) && rawRetryAfter > 0) return rawRetryAfter * 1000;

    const message = String(error?.message || error || '');
    const match = message.match(/Retry\s+after\s+([0-9.]+)\s*seconds/i);
    if (!match) return 0;

    const seconds = Number(match[1]);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

function computeBackoffMs(attempts) {
    if (attempts <= 1) return 15_000;
    if (attempts === 2) return 30_000;
    if (attempts === 3) return 60_000;
    if (attempts === 4) return 120_000;
    if (attempts <= 8) return 300_000;
    return 600_000;
}

function normalizeErrorText(error) {
    const message = String(error?.stack || error?.message || error || 'Неизвестная ошибка');
    return message.length > 1_800 ? `${message.slice(0, 1_800)}...` : message;
}

function isRetryableFormWebhookError(error) {
    if (error?.retryable === false) return false;

    const status = Number(error?.status);
    if (status === 429 || status >= 500) return true;
    if ([400, 401, 403, 404].includes(status)) return false;

    const discordCode = Number(error?.code);
    if ([10_003, 50_001, 50_013, 50_035].includes(discordCode)) return false;

    const networkCode = String(error?.code || error?.cause?.code || '').toUpperCase();
    if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'].includes(networkCode)) {
        return true;
    }

    return true;
}

async function enqueueFormWebhookJob({ ip, payload }) {
    const jobId = createJobId();
    const { jobKey, dedupeMode } = buildJobIdentity(payload, jobId);
    const now = nowMs();
    const document = {
        jobId,
        jobKey,
        dedupeMode,
        ip: ip || 'unknown',
        payload,
        status: 'queued',
        attempts: 0,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
    };

    const result = await enqueueWebhookJob({
        collectionName: 'formWebhookQueue',
        source: 'form',
        job: document,
    });
    return {
        job: result.document,
        deduped: !result.inserted,
        dedupeSource: result.dedupeSource,
    };
}

async function resetStuckFormWebhookJobs({ maxProcessingMs = 10 * 60_000 } = {}) {
    const jobs = await formWebhookQueue.find({ status: 'processing' });
    const now = nowMs();

    for (const job of jobs) {
        const started = Number(job.processingStartedAt) || 0;
        if (started && now - started < maxProcessingMs) continue;

        await formWebhookQueue.updateOne(
            { jobId: job.jobId },
            {
                status: 'queued',
                nextAttemptAt: now,
                updatedAt: now,
                lastError: 'Восстановлена зависшая задача в обработке',
            }
        );

        logger.warn('Формы: восстановлена зависшая задача очереди', {
            jobId: job.jobId,
        });
    }
}

async function cleanupFormWebhookJobs({ now = nowMs() } = {}) {
    const jobs = await formWebhookQueue.find({ status: 'dead' });
    let deleted = 0;

    for (const job of jobs) {
        const referenceTime = Number(job.deadAt) || Number(job.updatedAt) || 0;
        if (!referenceTime || now - referenceTime < DEAD_RETENTION_MS) continue;
        const result = await formWebhookQueue.deleteOne({ jobId: job.jobId });
        deleted += Number(result?.deletedCount) || 0;
    }

    return deleted;
}

async function getNextDueFormWebhookJob() {
    const jobs = await formWebhookQueue.find({ status: 'queued' });
    const now = nowMs();

    const due = jobs
        .filter((job) => (Number(job.nextAttemptAt) || 0) <= now)
        .sort((a, b) => {
            const nextA = Number(a.nextAttemptAt) || 0;
            const nextB = Number(b.nextAttemptAt) || 0;
            if (nextA !== nextB) return nextA - nextB;
            return (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0);
        });

    return due[0] || null;
}

async function markFormWebhookProcessing(job) {
    const now = nowMs();
    await formWebhookQueue.updateOne(
        { jobId: job.jobId },
        {
            status: 'processing',
            processingStartedAt: now,
            updatedAt: now,
        }
    );
}

async function completeFormWebhookJob(job) {
    return completeWebhookJob({
        collectionName: 'formWebhookQueue',
        source: 'form',
        jobId: job.jobId,
        jobKey: job.jobKey,
    });
}

async function markFormWebhookFailed(job, error) {
    const attempts = (Number(job.attempts) || 0) + 1;
    const now = nowMs();
    const retryable = isRetryableFormWebhookError(error);
    const lastError = normalizeErrorText(error);

    if (!retryable || attempts >= MAX_ATTEMPTS) {
        await formWebhookQueue.updateOne(
            { jobId: job.jobId },
            {
                status: 'dead',
                attempts,
                lastError,
                deadAt: now,
                processingStartedAt: null,
                updatedAt: now,
            }
        );
        return {
            dead: true,
            retryable,
            attempts,
            delayMs: 0,
            lastError,
        };
    }

    const retryAfterMs = parseRetryAfterMs(error);
    const backoffMs = computeBackoffMs(attempts);
    const delayMs = Math.max(retryAfterMs, backoffMs);

    await formWebhookQueue.updateOne(
        { jobId: job.jobId },
        {
            status: 'queued',
            attempts,
            lastError,
            nextAttemptAt: now + delayMs,
            processingStartedAt: null,
            updatedAt: now,
        }
    );

    return {
        dead: false,
        retryable: true,
        attempts,
        delayMs,
        lastError,
    };
}

module.exports = {
    cleanupFormWebhookJobs,
    completeFormWebhookJob,
    enqueueFormWebhookJob,
    getNextDueFormWebhookJob,
    markFormWebhookFailed,
    markFormWebhookProcessing,
    resetStuckFormWebhookJobs,
};
