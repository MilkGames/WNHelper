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
const { getWebhookServerConfig } = require('../../core/config/applicationConfig');
const { sanitizePublicText } = require('../../core/ui/errorMessage');
const examinationModule = require('../examination');
const formsModule = require('../forms');
const {
    getPendingOperationsSummary,
    getWebhookQueueSummary,
} = require('./database');

const STATUS_LABELS = {
    active: 'активно',
    activation_failed: 'ошибка активации',
    approved: 'одобрено, процесс не завершён',
    awaiting_approval: 'ожидает одобрения',
    awaiting_approvals: 'ожидает одобрений',
    awaiting_confirmation: 'ожидает подтверждения',
    awaiting_return: 'ожидает подтверждения возвращения',
    blocked_no_approval_config: 'заблокировано из-за отсутствия настройки одобрения',
    completed_with_issues: 'завершено с проблемами',
    completing: 'завершается',
    creating: 'создаётся',
    dead: 'остановлено после ошибок',
    dismissal_pending: 'увольнение ожидает подтверждения',
    executing: 'выполняется',
    failed: 'ошибка',
    failed_publication: 'ошибка публикации',
    completion_failed: 'ошибка завершения',
    in_progress: 'выполняется',
    partially_completed: 'выполнено частично',
    pending: 'ожидает обработки',
    pending_approval: 'ожидает одобрения',
    pending_review: 'ожидает рассмотрения',
    processing: 'обрабатывается',
    publication_failed: 'ошибка публикации',
    publishing: 'публикуется',
    queued: 'в очереди',
    reserved: 'зарезервировано',
    return_failed: 'ошибка возвращения',
    routing_failed: 'ошибка маршрутизации',
    running: 'выполняется',
    waiting_for_voice: 'ожидает голосового канала',
};

function formatTimestamp(value) {
    const timestamp = Number(value);
    return Number.isFinite(timestamp) && timestamp > 0
        ? `<t:${Math.floor(timestamp / 1000)}:R>`
        : 'нет';
}

function formatError(value) {
    if (!value) return 'нет';
    const safe = sanitizePublicText(value).replace(/\s+/gu, ' ').trim();
    return safe.length > 250 ? `${safe.slice(0, 249)}...` : safe;
}

function formatQueueLine(label, queue) {
    return `${label}: в очереди ${queue.queued}, обрабатывается ${queue.processing}, остановлено ${queue.dead}`;
}

function buildWebhookStatus(guildId) {
    const server = formsModule.getWebhookServerStatus();
    const formWorker = formsModule.getFormWorkerStatus();
    const examWorker = examinationModule.getWebhookWorkerStatus();
    const queues = getWebhookQueueSummary(guildId);
    const config = getWebhookServerConfig();
    return {
        lines: [
            'Состояние webhook:',
            `- HTTP-сервер: ${server.started && server.listening ? 'работает' : 'остановлен'}`,
            `- Порт: ${config.port}`,
            `- Обработчиков: ${server.handlerCount}`,
            `- WEBHOOK_KEY: ${process.env.WEBHOOK_KEY ? 'задан' : 'не задан'}`,
            `- TEST_KEY: ${process.env.TEST_KEY ? 'задан' : 'не задан'}`,
            `- Воркер форм: ${formWorker.workerStarted ? (formWorker.workerBusy ? 'обрабатывает задачу' : 'ожидает') : 'остановлен'}`,
            `- Обработчик форм: ${formWorker.registered ? 'зарегистрирован' : 'не зарегистрирован'}`,
            `- ${formatQueueLine('Формы', queues.forms)}`,
            `- Старейшая активная форма: ${formatTimestamp(queues.forms.oldestActiveAt)}`,
            `- Последняя ошибка формы: ${formatError(queues.forms.lastError)}`,
            `- Воркер экзаменов: ${examWorker.workerStarted ? (examWorker.workerBusy ? 'обрабатывает задачу' : 'ожидает') : 'остановлен'}`,
            `- Обработчик экзаменов: ${examWorker.registered ? 'зарегистрирован' : 'не зарегистрирован'}`,
            `- ${formatQueueLine('Экзамены этого сервера', queues.examination)}`,
            `- Старейший активный экзамен: ${formatTimestamp(queues.examination.oldestActiveAt)}`,
            `- Последняя ошибка экзамена: ${formatError(queues.examination.lastError)}`,
        ],
        server,
        formWorker,
        examWorker,
        queues,
    };
}

function formatStatusBreakdown(statuses) {
    return Object.entries(statuses)
        .map(([status, count]) => `${STATUS_LABELS[status] || 'другое состояние'}: ${count}`)
        .join(', ');
}

function buildPendingStatus(guildId, recoveryPlan = null) {
    const summary = getPendingOperationsSummary(guildId);
    const lines = ['Незавершённые и проблемные операции:'];
    for (const group of summary.groups) {
        if (!group.total) continue;
        lines.push(`- ${group.label}: ${group.total} (${formatStatusBreakdown(group.statuses)})`);
    }
    const formIssues = summary.webhook.forms.queued + summary.webhook.forms.processing + summary.webhook.forms.dead;
    const examIssues = summary.webhook.examination.queued + summary.webhook.examination.processing + summary.webhook.examination.dead;
    if (formIssues) lines.push(`- Webhook форм: ${formatStatusBreakdown({
        queued: summary.webhook.forms.queued,
        processing: summary.webhook.forms.processing,
        dead: summary.webhook.forms.dead,
    })}`);
    if (examIssues) lines.push(`- Webhook экзаменов: ${formatStatusBreakdown({
        queued: summary.webhook.examination.queued,
        processing: summary.webhook.examination.processing,
        dead: summary.webhook.examination.dead,
    })}`);
    if (recoveryPlan) {
        lines.push(`- Активный план восстановления: конфликтов без решения ${recoveryPlan.unresolvedConflicts}`);
    }
    if (lines.length === 1) lines.push('- Незавершённых операций не найдено.');
    lines.push(`- Всего записей, требующих внимания: ${summary.total + Number(recoveryPlan?.unresolvedConflicts || 0)}`);
    return { lines, summary };
}

module.exports = {
    buildPendingStatus,
    buildWebhookStatus,
    formatError,
    formatQueueLine,
    formatTimestamp,
};
