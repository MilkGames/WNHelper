/*
 * WN Helper Discord Bot
 * Copyright (C) 2024-2026 MilkGames
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
const logger = require('../logging/logger');
module.exports = async (client, report = null) => {
    logger.info(`Бот ${client.user.username} онлайн!`);
    if (!report) return;
    const context = {
        ready: report.ready,
        discord: report.discord,
        commands: report.commands.count,
        readyHandlers: `${report.handlers.succeeded}/${report.handlers.total}`,
        failedReadyHandlers: report.handlers.failed,
        webhookListening: report.webhook.listening,
        webhookHandlers: report.webhook.handlerCount,
        formsWorker: report.workers.forms.workerStarted,
        examinationWorker: report.workers.examination.workerStarted,
        schedulers: report.schedulers.names,
        recoveryMode: report.database.recoveryMode,
        maintenance: report.database.maintenance,
        problems: report.problems,
    };
    if (report.ready) logger.info('WN Helper полностью готов', context);
    else logger.warn('WN Helper запущен с проблемами готовности', context);
};
