/*
 * WN Helper Discord Bot
 * Copyright (C) 2025 MilkGames
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
const config = require('../../../config.json');

const logger = require('../../utils/logger');
const { sendMessageWithRetry } = require('../../utils/discordRequest');
const { registerWebhookHandler } = require('../../utils/webhookServer');
const {
    enqueueExamJob,
    resetStuckJobs,
    getNextDueJob,
    markProcessing,
    markDelivered,
    deleteJob,
    markFailed,
} = require('../../utils/examQueue');
const {
    extractRegValue,
    extractCorrectAnswers,
    sendExamToChannel,
} = require('../../utils/examPresentation');

let registered = false;
let workerStarted = false;

function resolveExamGuildId() {
    const env = (process.env.EXAM_GUILD_ID || '').trim();
    if (env && config?.servers?.[env]) return env;

    const fallback = String(config?.testServer || '').trim();
    if (fallback && config?.servers?.[fallback]) return fallback;

    const keys = Object.keys(config?.servers || {});
    if (keys.length) return keys[0];

    throw new Error('config.json: список серверов пустой, нельзя определить guildId для экзаменов');
}

function isExamPayload(payload) {
    if (!payload || typeof payload !== 'object') return false;

    return (
        typeof payload.testId === 'string' ||
        typeof payload.testName === 'string' ||
        typeof payload.url === 'string' ||
        Array.isArray(payload.regparams) ||
        Array.isArray(payload.results)
    );
}

async function processExamJob(client, job, guildId) {
    const data = job?.payload || {};

    const testId = typeof data.testId === 'string' ? data.testId : null;
    const rawTestName = typeof data.testName === 'string' ? data.testName : '—';
    const testUrl = typeof data.url === 'string' ? data.url : '—';
    const testMemberInput = extractRegValue(data.regparams) || '—';
    const correctAnswers = extractCorrectAnswers(data.results);

    return await sendExamToChannel(client, {
        guildId,
        testId,
        rawTestName,
        testUrl,
        testMemberInput,
        correctAnswers,
    });
}

module.exports = async (client) => {
    const guildId = resolveExamGuildId();
    if (!config?.servers?.[guildId]) {
        throw new Error(`config.json: no server config for guildId=${guildId}`);
    }

    if (!registered) {
        registerWebhookHandler({
            name: 'exams',
            canHandle: ({ payload }) => isExamPayload(payload),
            handle: async ({ payload, ip }) => {
                try {
                    const { job, deduped } = await enqueueExamJob({ guildId, ip, payload });
                    if (deduped) {
                        logger.info(`Экзамен: дубликат вебхука, jobId=${job.jobId}`);
                        return { statusCode: 200, body: 'Принято' };
                    }

                    logger.info(`Экзамен: задача поставлена в очередь, jobId=${job.jobId}`);
                    return { statusCode: 200, body: 'Принято' };
                } catch (error) {
                    logger.error(`Экзамен: ошибка при постановке в очередь: ${error}`);
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
    } catch (error) {
        logger.error(`Экзамен: не удалось восстановить зависшие задачи очереди: ${error}`);
    }

    let workerBusy = false;
    setInterval(async () => {
        if (workerBusy) return;
        workerBusy = true;

        let job = null;
        try {
            job = await getNextDueJob();
            if (!job) return;

            await markProcessing(job);
            const deliveryResult = await processExamJob(client, job, guildId);
            await markDelivered(job, deliveryResult);

            try {
                await deleteJob(job);
            } catch (cleanupError) {
                logger.error(
                    `Экзамен: задача уже отправлена в Discord, но не удалось удалить её из очереди jobId=${job.jobId}: ${cleanupError}`
                );
            }
        } catch (error) {
            if (!job) {
                logger.error(`Экзамен: ошибка воркера (без job): ${error}`);
                return;
            }

            const info = await markFailed(job, error);
            if (info.dead) {
                logger.error(
                    `Экзамен: задача помечена как dead после ${info.attempts} попыток jobId=${job.jobId}: ${info.lastError}`
                );

                try {
                    const examinerRoleId = config.servers[guildId].examinerRoleId;
                    const examChannelId = config.servers[guildId].examChannelId;
                    const examChannel = await client.channels.fetch(examChannelId);

                    const testUrl = typeof job?.payload?.url === 'string' ? job.payload.url : '—';
                    await sendMessageWithRetry(
                        examChannel,
                        {
                            content:
                                `<@&${examinerRoleId}> Не удалось обработать сдачу экзамена после ${info.attempts} попыток. ` +
                                `jobId=${job.jobId}. Ссылка на результат: ${testUrl}`,
                        },
                        { nonceSeed: `exam-dead:${job.jobId}` }
                    );
                } catch (notifyErr) {
                    logger.error(`Экзамен: не удалось отправить уведомление о dead задаче: ${notifyErr}`);
                }
            } else {
                logger.warn(
                    `Экзамен: ошибка обработки jobId=${job.jobId} (attempt=${info.attempts}), retry через ${Math.ceil(info.delayMs / 1000)}s: ${info.lastError}`
                );
            }
        } finally {
            workerBusy = false;
        }
    }, 1500);
};
