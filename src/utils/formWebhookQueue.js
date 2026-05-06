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

const formWebhookQueue = require('../models/formWebhookQueue');
const logger = require('./logger');

const MAX_ATTEMPTS = 12;

function nowMs() {
    return Date.now();
}

function safeStringify(obj) {
    try {
        return JSON.stringify(obj);
    } catch {
        return String(obj);
    }
}

function stableHash(input) {
    return crypto.createHash('sha1').update(String(input)).digest('hex');
}

function createJobId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return `${nowMs()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
}

function buildJobKey(payload) {
    const explicitKey = typeof payload?.dedupeKey === 'string' ? payload.dedupeKey.trim() : '';
    if (explicitKey) return `form:${explicitKey}`;

    return `form:${stableHash(safeStringify(payload))}`;
}

function parseRetryAfterMs(error) {
    const ra = error?.retryAfter;
    if (Number.isFinite(ra) && ra > 0) return ra;

    const raw = error?.rawError?.retry_after;
    if (Number.isFinite(raw) && raw > 0) return raw * 1000;

    const msg = String(error?.message || error || '');
    const m = msg.match(/Retry\s+after\s+([0-9.]+)\s*seconds/i);
    if (m) {
        const s = Number(m[1]);
        if (Number.isFinite(s) && s > 0) return s * 1000;
    }

    return 0;
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
    const msg = String(error?.stack || error?.message || error || 'Неизвестная ошибка');
    return msg.length > 1800 ? `${msg.slice(0, 1800)}...` : msg;
}

async function enqueueFormWebhookJob({ ip, payload }) {
    const jobKey = buildJobKey(payload);
    const existing = await formWebhookQueue.findOne({ jobKey });
    if (existing) {
        return { job: existing, deduped: true };
    }

    const jobId = createJobId();
    const now = nowMs();

    const job = new formWebhookQueue({
        jobId,
        jobKey,
        ip: ip || 'unknown',
        payload,
        status: 'queued',
        attempts: 0,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
    });

    await job.save();
    return { job, deduped: false };
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

        logger.warn(`Формы: восстановлена зависшая задача очереди, jobId=${job.jobId}`);
    }
}

async function getNextDueFormWebhookJob() {
    const jobs = await formWebhookQueue.find({ status: 'queued' });
    const now = nowMs();

    const due = jobs
        .filter((job) => (Number(job.nextAttemptAt) || 0) <= now)
        .sort((a, b) => {
            const na = Number(a.nextAttemptAt) || 0;
            const nb = Number(b.nextAttemptAt) || 0;
            if (na !== nb) return na - nb;
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

async function markFormWebhookDelivered(job, result = {}) {
    const now = nowMs();
    await formWebhookQueue.updateOne(
        { jobId: job.jobId },
        {
            status: 'delivered',
            deliveredAt: now,
            deliveryResult: result,
            updatedAt: now,
        }
    );
}

async function deleteFormWebhookJob(job) {
    await formWebhookQueue.deleteOne({ jobId: job.jobId });
}

async function markFormWebhookFailed(job, error) {
    const attempts = (Number(job.attempts) || 0) + 1;
    const now = nowMs();
    const retryAfterMs = parseRetryAfterMs(error);
    const backoffMs = computeBackoffMs(attempts);
    const delayMs = Math.max(retryAfterMs, backoffMs);
    const lastError = normalizeErrorText(error);

    if (attempts >= MAX_ATTEMPTS) {
        await formWebhookQueue.updateOne(
            { jobId: job.jobId },
            {
                status: 'dead',
                attempts,
                lastError,
                deadAt: now,
                updatedAt: now,
            }
        );
        return { dead: true, attempts, delayMs: 0, lastError };
    }

    await formWebhookQueue.updateOne(
        { jobId: job.jobId },
        {
            status: 'queued',
            attempts,
            lastError,
            nextAttemptAt: now + delayMs,
            updatedAt: now,
        }
    );

    return { dead: false, attempts, delayMs, lastError };
}

module.exports = {
    enqueueFormWebhookJob,
    resetStuckFormWebhookJobs,
    getNextDueFormWebhookJob,
    markFormWebhookProcessing,
    markFormWebhookDelivered,
    deleteFormWebhookJob,
    markFormWebhookFailed,
};
