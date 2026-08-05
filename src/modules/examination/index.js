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
const attempts = require('./attempts');
const ExaminationError = require('./error');
const memberResolver = require('./memberResolver');
const interactionService = require('./interactionService');
const events = require('./events');
const presentation = require('./presentation');
const requestPresentation = require('./requestPresentation');
const queue = require('./queue');
const service = require('./service');
const examsSchema = require('./settings/examsSchema');
const settingsSchema = require('./settings/schema');
const sendExam = require('./commands/sendExam');
const webhookWorker = require('./events/webhook');

async function stop() {
    await webhookWorker.stopWebhookWorker();
}

module.exports = {
    name: 'examination',
    commands: [sendExam],
    ExaminationError,
    events,
    stop,
    getWebhookWorkerStatus: webhookWorker.getWebhookWorkerStatus,
    ...attempts,
    ...memberResolver,
    ...interactionService,
    ...presentation,
    ...requestPresentation,
    ...queue,
    ...service,
    ...examsSchema,
    ...settingsSchema,
};
