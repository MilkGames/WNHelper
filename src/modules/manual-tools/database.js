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
const { readDb } = require('../../core/database/localDatabase');

function recordsForGuild(records, guildId, { allowGlobal = false } = {}) {
    return (Array.isArray(records) ? records : []).filter((record) => {
        if (!record || typeof record !== 'object') return false;
        if (record.guildId === undefined || record.guildId === null || record.guildId === '') {
            return allowGlobal;
        }
        return String(record.guildId) === String(guildId);
    });
}

function countStatuses(records, statuses) {
    const allowed = new Set(statuses);
    return records.filter((record) => allowed.has(String(record?.status || ''))).length;
}

function summarizeQueue(records) {
    const list = Array.isArray(records) ? records : [];
    const queued = countStatuses(list, ['queued']);
    const processing = countStatuses(list, ['processing']);
    const dead = countStatuses(list, ['dead']);
    const active = list
        .filter((record) => ['queued', 'processing'].includes(String(record?.status || '')))
        .sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0));
    const failed = list
        .filter((record) => record?.lastError)
        .sort((left, right) => Number(right.updatedAt || right.deadAt || 0) - Number(left.updatedAt || left.deadAt || 0));
    return {
        total: list.length,
        queued,
        processing,
        dead,
        oldestActiveAt: active[0]?.createdAt || null,
        lastError: failed[0]?.lastError || null,
        lastErrorAt: failed[0]?.updatedAt || failed[0]?.deadAt || null,
    };
}

function getWebhookQueueSummary(guildId) {
    const db = readDb();
    return {
        forms: summarizeQueue(db.formWebhookQueue || []),
        examination: summarizeQueue(recordsForGuild(db.examQueue, guildId)),
    };
}

const PENDING_DEFINITIONS = [
    {
        key: 'giveRoles',
        label: 'Заявки выдачи ролей',
        statuses: ['creating', 'pending', 'processing'],
    },
    {
        key: 'offboardingOperations',
        label: 'Общие операции увольнения',
        statuses: ['pending_approval', 'processing', 'failed', 'blocked_no_approval_config'],
    },
    {
        key: 'uvalOperations',
        label: 'Увольнения',
        statuses: ['pending_approval', 'processing', 'failed', 'blocked_no_approval_config'],
    },
    {
        key: 'staffAuditBatches',
        label: 'Массовый кадровый аудит',
        statuses: ['awaiting_confirmation', 'processing', 'awaiting_approvals', 'completed_with_issues'],
    },
    {
        key: 'staffAuditOperations',
        label: 'Кадровые операции',
        statuses: ['reserved', 'running', 'failed'],
    },
    {
        key: 'disciplineCases',
        label: 'Дисциплинарные дела',
        statuses: ['active', 'processing', 'dismissal_pending', 'failed'],
    },
    {
        key: 'disciplineAppeals',
        label: 'Обжалования взысканий',
        statuses: ['creating', 'pending_review', 'routing_failed', 'publication_failed'],
    },
    {
        key: 'disciplineRemovalRequests',
        label: 'Запросы снятия взысканий',
        statuses: ['creating', 'pending', 'failed'],
    },
    {
        key: 'massDisciplineBatches',
        label: 'Массовые взыскания',
        statuses: ['awaiting_confirmation', 'awaiting_approval', 'executing', 'partially_completed'],
    },
    {
        key: 'examinationRequests',
        label: 'Заявки экзаменации',
        statuses: [
            'publishing',
            'pending',
            'approved',
            'waiting_for_voice',
            'in_progress',
            'completing',
            'failed_publication',
            'completion_failed',
        ],
    },
    {
        key: 'vacationRequests',
        label: 'Заявки на отпуск',
        statuses: ['pending', 'active', 'awaiting_return', 'activation_failed', 'return_failed'],
    },
];

function getPendingOperationsSummary(guildId) {
    const db = readDb();
    const groups = PENDING_DEFINITIONS.map((definition) => {
        const records = recordsForGuild(db[definition.key], guildId);
        const statuses = new Map();
        for (const record of records) {
            const status = String(record?.status || 'unknown');
            if (!definition.statuses.includes(status)) continue;
            statuses.set(status, (statuses.get(status) || 0) + 1);
        }
        return {
            key: definition.key,
            label: definition.label,
            total: [...statuses.values()].reduce((sum, value) => sum + value, 0),
            statuses: Object.fromEntries(statuses),
        };
    });
    const webhook = {
        forms: summarizeQueue(db.formWebhookQueue || []),
        examination: summarizeQueue(recordsForGuild(db.examQueue, guildId)),
    };
    const total = groups.reduce((sum, group) => sum + group.total, 0) +
        webhook.forms.queued + webhook.forms.processing + webhook.forms.dead +
        webhook.examination.queued + webhook.examination.processing + webhook.examination.dead;
    return { groups, webhook, total };
}

module.exports = {
    PENDING_DEFINITIONS,
    countStatuses,
    getPendingOperationsSummary,
    getWebhookQueueSummary,
    recordsForGuild,
    summarizeQueue,
};
