const crypto = require('crypto');

const examQueue = require('../models/examQueue');
const logger = require('./logger');

const MAX_ATTEMPTS = 10;

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

function buildJobKey(guildId, payload) {
    const url = (typeof payload?.url === 'string' && payload.url.trim().length) ? payload.url.trim() : '';
    const base = url || safeStringify(payload);
    return `exam:${guildId}:${stableHash(base)}`;
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
    // 1: 15s, 2: 30s, 3: 60s, 4: 120s, 5+: 300s
    if (attempts <= 1) return 15_000;
    if (attempts === 2) return 30_000;
    if (attempts === 3) return 60_000;
    if (attempts === 4) return 120_000;
    return 300_000;
}

function normalizeErrorText(error) {
    const msg = String(error?.stack || error?.message || error || 'Unknown error');
    return msg.length > 1800 ? `${msg.slice(0, 1800)}…` : msg;
}

async function enqueueExamJob({ guildId, ip, payload }) {
    const jobKey = buildJobKey(guildId, payload);
    const existing = await examQueue.findOne({ jobKey });
    if (existing) {
        return { job: existing, deduped: true };
    }

    const jobId = createJobId();
    const now = nowMs();

    const job = new examQueue({
        jobId,
        jobKey,
        guildId,
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

async function markDone(job, meta = {}) {
    const now = nowMs();
    await examQueue.updateOne(
        { jobId: job.jobId },
        {
            status: 'done',
            doneAt: now,
            updatedAt: now,
            resultMeta: meta,
        }
    );
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
            updatedAt: now,
        }
    );

    return { dead: false, attempts, delayMs, lastError };
}

module.exports = {
    enqueueExamJob,
    resetStuckJobs,
    getNextDueJob,
    markProcessing,
    markDone,
    markFailed,
};