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

const examQueue = require('./database').examQueue;
const logger = require('../../core/logging/logger');
const {
    completeWebhookJob,
    enqueueWebhookJob,
} = require('../forms');

const MAX_ATTEMPTS = 10;
const DEAD_RETENTION_MS = 7 * 24 * 60 * 60_000;

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

function buildJobHash(payload) {
    const url = (typeof payload?.url === 'string' && payload.url.trim().length) ? payload.url.trim() : '';
    return stableHash(url || safeStringify(payload));
}

function buildJobKey(guildId, examId, payload) {
    return `exam:${guildId}:${examId}:${buildJobHash(payload)}`;
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
    return 300_000;
}

function normalizeErrorText(error) {
    const msg = String(error?.stack || error?.message || error || 'Неизвестная ошибка');
    return msg.length > 1800 ? `${msg.slice(0, 1800)}…` : msg;
}

async function enqueueExamJob({ guildId, examId, ip, payload }) {
    if (!examId) throw new Error('Для задачи экзамена не указан examId');

    const jobKey = buildJobKey(guildId, examId, payload);
    const jobId = createJobId();
    const now = nowMs();
    const document = {
        jobId,
        jobKey,
        guildId,
        examId,
        ip: ip || 'unknown',
        payload,
        status: 'queued',
        attempts: 0,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
    };

    const result = await enqueueWebhookJob({
        collectionName: 'examQueue',
        source: 'exam',
        job: document,
    });
    return {
        job: result.document,
        deduped: !result.inserted,
        dedupeSource: result.dedupeSource,
    };
}

async function resetStuckJobs({ maxProcessingMs = 10 * 60_000 } = {}) {
    const jobs = await examQueue.find({ status: 'processing' });
    const now = nowMs();
    for (const j of jobs) {
        const started = Number(j.processingStartedAt) || 0;
        if (started && now - started < maxProcessingMs) continue;

        await examQueue.updateOne(
            { jobId: j.jobId },
            {
                status: 'queued',
                nextAttemptAt: now,
                updatedAt: now,
                lastError: 'Recovered stuck processing job',
            }
        );

        logger.warn(`Восстановил зависшую задачу очереди экзаменов jobId=${j.jobId}`);
    }
}


async function cleanupExamJobs({ now = nowMs() } = {}) {
    const jobs = await examQueue.find({ status: { $in: ['delivered', 'dead'] } });
    let deleted = 0;

    for (const job of jobs) {
        if (job.status === 'dead') {
            const referenceTime = Number(job.deadAt) || Number(job.updatedAt) || 0;
            if (!referenceTime || now - referenceTime < DEAD_RETENTION_MS) continue;
        }

        const result = await examQueue.deleteOne({ jobId: job.jobId });
        deleted += Number(result.deletedCount) || 0;
    }

    return deleted;
}

async function getNextDueJob() {
    const jobs = await examQueue.find({ status: 'queued' });
    const now = nowMs();
    const due = jobs
        .filter((j) => (Number(j.nextAttemptAt) || 0) <= now)
        .sort((a, b) => {
            const na = Number(a.nextAttemptAt) || 0;
            const nb = Number(b.nextAttemptAt) || 0;
            if (na !== nb) return na - nb;
            return (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0);
        });
    return due[0] || null;
}

async function markProcessing(job) {
    const now = nowMs();
    await examQueue.updateOne(
        { jobId: job.jobId },
        {
            status: 'processing',
            processingStartedAt: now,
            updatedAt: now,
        }
    );
}

async function completeExamJob(job) {
    return completeWebhookJob({
        collectionName: 'examQueue',
        source: 'exam',
        jobId: job.jobId,
        jobKey: job.jobKey,
    });
}


async function markFailed(job, error) {
    const attempts = (Number(job.attempts) || 0) + 1;
    const now = nowMs();
    const retryAfterMs = parseRetryAfterMs(error);
    const backoffMs = computeBackoffMs(attempts);
    const delayMs = Math.max(retryAfterMs, backoffMs);

    const lastError = normalizeErrorText(error);

    if (attempts >= MAX_ATTEMPTS) {
        await examQueue.updateOne(
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
        return { dead: true, attempts, delayMs: 0, lastError };
    }

    await examQueue.updateOne(
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

    return { dead: false, attempts, delayMs, lastError };
}


async function closeMemberQueueJobs(guildId, memberId) {
    const jobs = await examQueue.find({ guildId: String(guildId) });
    let changed = 0;
    for (const job of jobs) {
        const linkedMemberId = job.memberId || job.userId || job.resolvedMemberId || job.payload?.memberId;
        if (String(linkedMemberId || '') !== String(memberId)) continue;
        if (['dead', 'delivered', 'cancelled_by_dismissal'].includes(job.status)) continue;
        await examQueue.updateOne({ jobId: job.jobId }, {
            status: 'cancelled_by_dismissal',
            cancelledAt: Date.now(),
            updatedAt: Date.now(),
        });
        changed += 1;
    }
    return changed;
}

module.exports = {
    cleanupExamJobs,
    closeMemberQueueJobs,
    enqueueExamJob,
    getNextDueJob,
    completeExamJob,
    markFailed,
    markProcessing,
    resetStuckJobs,
};
