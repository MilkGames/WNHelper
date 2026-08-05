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
const logger = require('../../core/logging/logger');
const { registerWebhookHandler } = require('./server');
const {
    cleanupFormWebhookJobs,
    completeFormWebhookJob,
    enqueueFormWebhookJob,
    getNextDueFormWebhookJob,
    markFormWebhookFailed,
    markFormWebhookProcessing,
    resetStuckFormWebhookJobs,
} = require('./queue');
const { cleanupWebhookReceipts } = require('./receipts');
const {
    PermanentFormWebhookError,
    sendFormWebhookToChannel,
    validateFormWebhookPayload,
} = require('./delivery');

const WORKER_INTERVAL_MS = 1_000;
const MAX_JOBS_PER_TICK = 10;
const CLEANUP_INTERVAL_MS = 60 * 60_000;

let registered = false;
let workerStarted = false;
let workerTimer = null;
let workerBusy = false;
let lastCleanupAt = null;

function isFormsPayload(payload) {
    if (!payload || typeof payload !== 'object') return false;
    if (payload.kind === 'discord-forward') return true;
    if (payload.route === 'forms') return true;
    if (payload.source === 'google-form') return true;

    const message = payload?.message;
    if (typeof payload?.channelId === 'string' && (typeof payload?.content === 'string' || Array.isArray(payload?.embeds))) {
        return true;
    }
    if (typeof message?.channelId === 'string' && (typeof message?.content === 'string' || Array.isArray(message?.embeds))) {
        return true;
    }

    return false;
}

async function processFormWebhookJob(client, job) {
    return sendFormWebhookToChannel(client, job?.payload || {}, {
        nonceSeed: `formWebhook:${job.jobKey}`,
    });
}

async function processOneQueuedJob(client) {
    const job = await getNextDueFormWebhookJob();
    if (!job) return false;

    try {
        await markFormWebhookProcessing(job);
        const deliveryResult = await processFormWebhookJob(client, job);
        await completeFormWebhookJob(job);

        logger.info('Формы: задача доставлена в Discord', {
            jobId: job.jobId,
            channelId: deliveryResult.sentChannelId,
            guildId: deliveryResult.sentGuildId,
            messageCount: deliveryResult.messageCount,
            attempts: Number(job.attempts) || 0,
        });
    } catch (error) {
        const info = await markFormWebhookFailed(job, error);
        if (info.dead) {
            logger.error('Формы: задача остановлена без дальнейших попыток', {
                jobId: job.jobId,
                attempts: info.attempts,
                retryable: info.retryable,
                lastError: info.lastError,
            });
        } else {
            logger.warn('Формы: доставка не удалась, задача возвращена в очередь', {
                jobId: job.jobId,
                attempts: info.attempts,
                retryAfterSeconds: Math.ceil(info.delayMs / 1_000),
                lastError: info.lastError,
            });
        }
    }

    return true;
}

async function startFormWorker(client) {
    if (!registered) {
        registerWebhookHandler({
            name: 'forms',
            canHandle: ({ payload }) => isFormsPayload(payload),
            handle: async ({ payload, ip }) => {
                try {
                    validateFormWebhookPayload(payload);
                } catch (error) {
                    const validationError = error instanceof PermanentFormWebhookError
                        ? error
                        : new PermanentFormWebhookError('Некорректный payload формы', error);

                    logger.warn('Формы: отклонён некорректный вебхук', {
                        ip,
                        error: validationError.message,
                    });
                    return { statusCode: 400, body: 'Некорректный payload формы' };
                }

                try {
                    const { job, deduped, dedupeSource } = await enqueueFormWebhookJob({ ip, payload });
                    if (deduped) {
                        logger.info('Формы: получен дубликат вебхука', {
                            jobId: job.jobId,
                            status: job.status,
                            dedupeSource,
                            ip,
                        });
                        return { statusCode: 200, body: 'Принято' };
                    }

                    logger.info('Формы: задача поставлена в очередь', {
                        jobId: job.jobId,
                        ip,
                    });
                    return { statusCode: 200, body: 'Принято' };
                } catch (error) {
                    logger.error('Формы: ошибка при постановке задачи в очередь', { ip }, error);
                    return { statusCode: 500, body: 'Не удалось принять форму' };
                }
            },
        });
        registered = true;
    }

    if (workerStarted) return;
    workerStarted = true;

    try {
        await resetStuckFormWebhookJobs({ maxProcessingMs: 10 * 60_000 });
        const deleted = await cleanupFormWebhookJobs();
        const deletedReceipts = await cleanupWebhookReceipts();
        if (deleted > 0) {
            logger.info('Формы: очищены устаревшие записи очереди', { deleted });
        }
        if (deletedReceipts > 0) {
            logger.info('Вебхуки: очищены устаревшие ключи дедупликации', { deleted: deletedReceipts });
        }
    } catch (error) {
        logger.error('Формы: не удалось восстановить или очистить очередь', error);
    }

    workerBusy = false;
    lastCleanupAt = Date.now();

    workerTimer = setInterval(async () => {
        if (workerBusy) return;
        workerBusy = true;

        try {
            for (let index = 0; index < MAX_JOBS_PER_TICK; index += 1) {
                const processed = await processOneQueuedJob(client);
                if (!processed) break;
            }

            const now = Date.now();
            if (now - lastCleanupAt >= CLEANUP_INTERVAL_MS) {
                lastCleanupAt = now;
                const deleted = await cleanupFormWebhookJobs({ now });
                const deletedReceipts = await cleanupWebhookReceipts({ now });
                if (deleted > 0) {
                    logger.info('Формы: очищены устаревшие записи очереди', { deleted });
                }
                if (deletedReceipts > 0) {
                    logger.info('Вебхуки: очищены устаревшие ключи дедупликации', { deleted: deletedReceipts });
                }
            }
        } catch (error) {
            logger.error('Формы: необработанная ошибка воркера очереди', error);
        } finally {
            workerBusy = false;
        }
    }, WORKER_INTERVAL_MS);

    workerTimer.unref?.();
}

async function stopFormWorker() {
    if (workerTimer) {
        clearInterval(workerTimer);
        workerTimer = null;
    }
    const deadline = Date.now() + 10_000;
    while (workerBusy && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    workerStarted = false;
}

function getFormWorkerStatus() {
    return {
        registered,
        workerStarted,
        workerBusy,
        lastCleanupAt,
    };
}

module.exports = {
    getFormWorkerStatus,
    startFormWorker,
    stopFormWorker,
};

