/*
 * WN Helper Discord Bot
 * Copyright (C) 2025-2026 MilkGames
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
const {
    findExamById,
    getExams,
} = require('../settings/examsSchema');
const guildConfigService = require('../../../core/config/guildConfigService');

const logger = require('../../../core/logging/logger');
const { sendMessageWithRetry } = require('../../../core/discord/request');
const { registerWebhookHandler } = require('../../forms');
const {
    cleanupExamJobs,
    completeExamJob,
    enqueueExamJob,
    getNextDueJob,
    markFailed,
    markProcessing,
    resetStuckJobs,
} = require('../queue');
const { cleanupWebhookReceipts } = require('../../forms');
const {
    extractCorrectAnswers,
    extractRegValue,
    sendExamToChannel,
} = require('../presentation');

let registered = false;
let workerStarted = false;
let workerBusy = false;
let workerTimer = null;

const WORKER_INTERVAL_MS = 1_500;
const CLEANUP_INTERVAL_MS = 60 * 60_000;

function isExamPayload(payload) {
    return Boolean(
        payload &&
        typeof payload === 'object' &&
        typeof payload.id === 'string' &&
        typeof payload.testId === 'string' &&
        typeof payload.testName === 'string' &&
        typeof payload.url === 'string' &&
        Array.isArray(payload.regparams) &&
        Array.isArray(payload.results)
    );
}

function findExamTargets(testId) {
    const targets = [];
    for (const config of guildConfigService.getAll()) {
        if (config.features?.exams === false) continue;
        const exam = getExams(config).find((entry) => entry.testId === testId);
        if (exam) targets.push({ guildId: config.guildId, exam });
    }
    return targets;
}

function resolveJobExam(job) {
    const guildId = String(job?.guildId || '');
    const serverConfig = guildConfigService.get(guildId);
    if (!serverConfig) throw new Error(`Не настроен сервер guildId=${guildId}`);
    const exam = findExamById(serverConfig, job?.examId);

    if (!exam) {
        throw new Error(
            `Не найден экзамен для jobId=${job?.jobId}, guildId=${guildId}, ` +
            `examId=${job?.examId || '-'}, testId=${job?.payload?.testId || '-'}`
        );
    }

    return { guildId, exam };
}

async function processExamJob(client, job) {
    const { guildId, exam } = resolveJobExam(job);
    const data = job?.payload || {};

    return sendExamToChannel(client, {
        guildId,
        exam,
        testUrl: data.url,
        testMemberInput: extractRegValue(data.regparams) || '-',
        correctAnswers: extractCorrectAnswers(data.results),
    }, {
        nonceSeed: `examJob:${job.jobKey}`,
    });
}

async function notifyDeadJob(client, job, info) {
    const guildId = String(job?.guildId || '');
    const serverConfig = guildConfigService.get(guildId);
    if (!serverConfig) throw new Error(`Не настроен сервер guildId=${guildId}`);

    const examinerRoleId = serverConfig.commonRoles?.examinerRoleId;
    const examChannelId = serverConfig.channels?.examChannelId;
    if (!examinerRoleId || !examChannelId) {
        throw new Error(`Для guildId=${guildId} не настроены роль экзаменатора или канал экзаменов`);
    }

    const examChannel = await client.channels.fetch(examChannelId);
    const testUrl = typeof job?.payload?.url === 'string' ? job.payload.url : '-';
    await sendMessageWithRetry(examChannel, {
        content:
            `<@&${examinerRoleId}> Не удалось обработать сдачу экзамена после ${info.attempts} попыток. ` +
            `jobId=${job.jobId}. Ссылка на результат: ${testUrl}`,
        allowedMentions: { parse: [], roles: [examinerRoleId] },
    }, {
        nonceSeed: `exam-dead:${job.jobId}`,
    });
}

module.exports = async (client) => {
    if (!registered) {
        registerWebhookHandler({
            name: 'exams',
            canHandle: ({ payload }) => isExamPayload(payload),
            handle: async ({ payload, ip }) => {
                const testId = payload.testId.trim();
                const targets = findExamTargets(testId);

                if (!targets.length) {
                    logger.warn('Экзамен: вебхук отклонён, идентификатор теста отсутствует в настройках', {
                        testId,
                        ip,
                    });
                    return { statusCode: 400, body: 'Неизвестный testId экзамена' };
                }

                if (targets.length > 1) {
                    logger.error('Экзамен: идентификатор теста настроен на нескольких серверах', {
                        testId,
                        guildIds: targets.map((target) => target.guildId),
                    });
                    return { statusCode: 500, body: 'Неоднозначная настройка testId' };
                }

                const { guildId, exam } = targets[0];
                try {
                    const { job, deduped, dedupeSource } = await enqueueExamJob({
                        guildId,
                        examId: exam.id,
                        ip,
                        payload,
                    });

                    if (deduped) {
                        logger.info('Экзамен: получен дубликат вебхука', {
                            jobId: job.jobId,
                            guildId,
                            examId: exam.id,
                            testId,
                            dedupeSource,
                        });
                        return { statusCode: 200, body: 'Принято' };
                    }

                    logger.info('Экзамен: задача поставлена в очередь', {
                        jobId: job.jobId,
                        guildId,
                        examId: exam.id,
                        testId,
                    });
                    return { statusCode: 200, body: 'Принято' };
                } catch (error) {
                    logger.error('Экзамен: ошибка при постановке в очередь', {
                        guildId,
                        examId: exam.id,
                        testId,
                    }, error);
                    return { statusCode: 500, body: 'Ошибка постановки экзамена в очередь' };
                }
            },
        });
        registered = true;
    }

    if (workerStarted) return;
    workerStarted = true;

    try {
        await resetStuckJobs({ maxProcessingMs: 10 * 60_000 });
        const deleted = await cleanupExamJobs();
        const deletedReceipts = await cleanupWebhookReceipts();
        if (deleted > 0) {
            logger.info('Экзамен: очищены устаревшие записи очереди', { deleted });
        }
        if (deletedReceipts > 0) {
            logger.info('Вебхуки: очищены устаревшие ключи дедупликации', { deleted: deletedReceipts });
        }
    } catch (error) {
        logger.error('Экзамен: не удалось восстановить или очистить очередь', error);
    }

    workerBusy = false;
    let lastCleanupAt = Date.now();
    workerTimer = setInterval(async () => {
        if (workerBusy) return;
        workerBusy = true;

        let job = null;
        try {
            const now = Date.now();
            if (now - lastCleanupAt >= CLEANUP_INTERVAL_MS) {
                lastCleanupAt = now;
                const deleted = await cleanupExamJobs({ now });
                const deletedReceipts = await cleanupWebhookReceipts({ now });
                if (deleted > 0) {
                    logger.info('Экзамен: очищены устаревшие записи очереди', { deleted });
                }
                if (deletedReceipts > 0) {
                    logger.info('Вебхуки: очищены устаревшие ключи дедупликации', { deleted: deletedReceipts });
                }
            }

            job = await getNextDueJob();
            if (!job) return;

            await markProcessing(job);
            await processExamJob(client, job);
            await completeExamJob(job);
        } catch (error) {
            if (!job) {
                logger.error('Экзамен: ошибка воркера без выбранной задачи', error);
                return;
            }

            const info = await markFailed(job, error);
            if (info.dead) {
                logger.error('Экзамен: задача остановлена без дальнейших попыток', {
                    jobId: job.jobId,
                    guildId: job.guildId,
                    attempts: info.attempts,
                    lastError: info.lastError,
                });

                try {
                    await notifyDeadJob(client, job, info);
                } catch (notifyError) {
                    logger.error('Экзамен: не удалось отправить уведомление об остановленной задаче', {
                        jobId: job.jobId,
                        guildId: job.guildId,
                    }, notifyError);
                }
            } else {
                logger.warn('Экзамен: задача будет повторена', {
                    jobId: job.jobId,
                    guildId: job.guildId,
                    attempts: info.attempts,
                    retryAfterSeconds: Math.ceil(info.delayMs / 1000),
                    lastError: info.lastError,
                });
            }
        } finally {
            workerBusy = false;
        }
    }, WORKER_INTERVAL_MS);

    workerTimer.unref?.();
};

async function stopWebhookWorker() {
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

function getWebhookWorkerStatus() {
    return {
        registered,
        workerStarted,
        workerBusy,
    };
}

module.exports.stopWebhookWorker = stopWebhookWorker;
module.exports.getWebhookWorkerStatus = getWebhookWorkerStatus;
