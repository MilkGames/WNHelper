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
const logger = require('../../utils/logger');
const { registerWebhookHandler } = require('../../utils/webhookServer');
const {
    enqueueFormWebhookJob,
    resetStuckFormWebhookJobs,
    getNextDueFormWebhookJob,
    markFormWebhookProcessing,
    markFormWebhookDelivered,
    deleteFormWebhookJob,
    markFormWebhookFailed,
} = require('../../utils/formWebhookQueue');
const { sendFormWebhookToChannel } = require('../../utils/formWebhookDelivery');

let registered = false;
let workerStarted = false;

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
    return sendFormWebhookToChannel(client, job?.payload || {});
}

module.exports = async (client) => {
    if (!registered) {
        registerWebhookHandler({
            name: 'forms',
            canHandle: ({ payload }) => isFormsPayload(payload),
            handle: async ({ payload, ip }) => {
                try {
                    const { job, deduped } = await enqueueFormWebhookJob({ ip, payload });
                    if (deduped) {
                        logger.info(`Формы: получен дубликат вебхука, jobId=${job.jobId}`);
                        return { statusCode: 200, body: 'Принято' };
                    }

                    logger.info(`Формы: задача поставлена в очередь, jobId=${job.jobId}`);
                    return { statusCode: 200, body: 'Принято' };
                } catch (error) {
                    logger.error(`Формы: ошибка при постановке задачи в очередь: ${error}`);
                    return { statusCode: 500, body: 'Ошибка постановки формы в очередь' };
                }
            },
        });
        registered = true;
    }

    if (workerStarted) return;
    workerStarted = true;

    try {
        await resetStuckFormWebhookJobs({ maxProcessingMs: 10 * 60_000 });
    } catch (error) {
        logger.error(`Формы: не удалось восстановить зависшие задачи очереди: ${error}`);
    }

    let workerBusy = false;
    setInterval(async () => {
        if (workerBusy) return;
        workerBusy = true;

        let job = null;
        try {
            job = await getNextDueFormWebhookJob();
            if (!job) return;

            await markFormWebhookProcessing(job);
            const deliveryResult = await processFormWebhookJob(client, job);
            await markFormWebhookDelivered(job, deliveryResult);

            try {
                await deleteFormWebhookJob(job);
            } catch (cleanupError) {
                logger.error(
                    `Формы: задача уже отправлена в Discord, но не удалось удалить её из очереди jobId=${job.jobId}: ${cleanupError}`
                );
            }
        } catch (error) {
            if (!job) {
                logger.error(`Формы: ошибка воркера без активной задачи: ${error}`);
                return;
            }

            const info = await markFormWebhookFailed(job, error);
            if (info.dead) {
                logger.error(
                    `Формы: задача помечена как dead после ${info.attempts} попыток, jobId=${job.jobId}: ${info.lastError}`
                );
            } else {
                logger.warn(
                    `Формы: ошибка обработки jobId=${job.jobId} (attempt=${info.attempts}), повтор через ${Math.ceil(info.delayMs / 1000)}s: ${info.lastError}`
                );
            }
        } finally {
            workerBusy = false;
        }
    }, 1500);
};
