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
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    StringSelectMenuBuilder,
} = require('discord.js');
const { DISCIPLINE_STAGES } = require('./settings/schema');
const { getDefaultFooter } = require('../../core/ui/defaultFooter');

const SANCTION_LABELS = {
    conversation: 'Беседа',
    oral: 'Устный выговор',
    written: 'Письменный выговор',
    demotion: 'Понижение',
    recertification: 'Переаттестация',
    dismissal: 'Увольнение',
    dismissal_blacklist: 'Увольнение с ЧС',
};
const BATCH_STATUS_LABELS = {
    awaiting_confirmation: 'Ожидает подтверждения инициатором',
    awaiting_approval: 'Ожидает подтверждения руководством',
    executing: 'Выполняется',
    partially_completed: 'Выполнено частично',
    completed: 'Выполнено',
    cancelled: 'Отменено',
    expired: 'Срок подтверждения истёк',
    rejected: 'Отклонено',
};
const ITEM_STATUS_LABELS = {
    invalid: 'Исключён из выполнения',
    pending: 'Ожидает выполнения',
    executing: 'Выполняется',
    completed: 'Выполнено',
    failed: 'Ошибка выполнения',
    skipped_state_changed: 'Пропущено: состояние изменилось',
};

function getBatchStatusLabel(status) {
    return BATCH_STATUS_LABELS[status] || 'Неизвестный статус';
}

function getItemStatusLabel(status) {
    return ITEM_STATUS_LABELS[status] || 'Неизвестный статус';
}

function getSelectionSummary(selection) {
    return selection.map((entry) => {
        const label = SANCTION_LABELS[entry.type] || 'Неизвестное взыскание';
        return DISCIPLINE_STAGES.includes(entry.type) && entry.count > 1 ? `${label} × ${entry.count}` : label;
    }).join(', ');
}

function chunkFieldLines(lines, maxLength = 1000) {
    const chunks = [];
    let current = [];
    let length = 0;
    for (const line of lines) {
        const text = String(line || '');
        const extra = text.length + (current.length ? 1 : 0);
        if (current.length && length + extra > maxLength) {
            chunks.push(current.join('\n'));
            current = [];
            length = 0;
        }
        current.push(text.slice(0, maxLength));
        length += text.length + (current.length > 1 ? 1 : 0);
    }
    if (current.length) chunks.push(current.join('\n'));
    return chunks.length ? chunks : ['Нет сотрудников.'];
}

function createMassDisciplinePresentation({ formatGroupLinks, formatItemTarget, getItemTargetKey }) {
    function buildPreviewPayload(batch) {
        const valid = (batch.items || []).filter((item) => item.status !== 'invalid');
        const invalid = (batch.items || []).filter((item) => item.status === 'invalid');
        const validFields = chunkFieldLines(valid.map((item) => {
            const extra = item.outcome?.willDismiss ? ' · приведёт к увольнению' : '';
            return `✅ ${formatItemTarget(item)} - готово${extra}`;
        })).map((value, index) => ({
            name: index === 0 ? `К исполнению (${valid.length})` : `К исполнению - продолжение ${index + 1}`,
            value,
        }));
        const invalidFields = invalid.length
            ? chunkFieldLines(invalid.map((item) => `❌ ${formatItemTarget(item)} - ${String(item.error || 'ошибка').slice(0, 70)}`)).map((value, index) => ({
                name: index === 0 ? `Требуют исправления (${invalid.length})` : `Требуют исправления - продолжение ${index + 1}`,
                value,
            }))
            : [];
        const embed = new EmbedBuilder()
            .setColor(invalid.length ? 0xE74C3C : 0xE67E22)
            .setTitle('Предпросмотр массового дисциплинарного дела')
            .addFields(
                { name: 'Причина', value: batch.payload.reason.slice(0, 1024) },
                ...validFields,
                ...invalidFields,
            )
            .setFooter(getDefaultFooter())
            .setTimestamp(batch.createdAt);
        return {
            content: [
                `ID пакета: ${batch.massdisciplineId}`,
                `Дата нарушения: ${batch.payload.violationDate}`,
                `Санкции: ${getSelectionSummary(batch.payload.selection)}`,
                `Нарушенные пункты:\n${batch.payload.violatedRules}`,
                'Можно вернуться к редактированию параметров или сразу изменить список сотрудников.',
                invalid.length ? 'Ошибочных сотрудников можно быстро удалить меню ниже.' : '',
                '-# После подтверждения пакет изменить нельзя. Состояние сотрудников повторно проверяется перед публикацией.',
            ].filter(Boolean).join('\n\n'),
            embeds: [embed],
            components: buildPreviewComponents(batch),
            allowedMentions: { parse: [] },
            temporary: false,
        };
    }

    function buildPreview(batch) {
        return buildPreviewPayload(batch).content;
    }

    function buildConfirmationRow(batchId, { allowBack = true } = {}) {
        const buttons = [];
        if (allowBack) {
            buttons.push(new ButtonBuilder()
                .setCustomId(`massDiscipline:back:${batchId}`)
                .setLabel('Назад к редактированию')
                .setStyle(ButtonStyle.Secondary));
            buttons.push(new ButtonBuilder()
                .setCustomId(`massDiscipline:targets:${batchId}`)
                .setLabel('Изменить сотрудников')
                .setStyle(ButtonStyle.Secondary));
        }
        buttons.push(
            new ButtonBuilder()
                .setCustomId(`massDiscipline:confirm:${batchId}`)
                .setLabel('Подтвердить')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`massDiscipline:cancel:${batchId}`)
                .setLabel('Отменить')
                .setStyle(ButtonStyle.Secondary)
        );
        return new ActionRowBuilder().addComponents(buttons);
    }

    function buildPreviewComponents(batch) {
        const rows = [buildConfirmationRow(batch.massdisciplineId)];
        const invalid = (batch.items || []).filter((item) => item.status === 'invalid').slice(0, 25);
        if (invalid.length) {
            rows.push(new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`massDiscipline:remove:${batch.massdisciplineId}`)
                    .setPlaceholder('Удалить ошибочных сотрудников')
                    .setMinValues(1)
                    .setMaxValues(invalid.length)
                    .addOptions(invalid.map((item) => ({
                        label: String(formatItemTarget(item, { mention: false })).slice(0, 100),
                        description: String(item.error || 'Ошибка проверки').slice(0, 100),
                        value: getItemTargetKey(item),
                    })))
            ));
        }
        return rows;
    }

    function buildApprovalRow(batchId, disabled = false) {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`massDisciplineApproval:approve:${batchId}`)
                .setLabel('Одобрить')
                .setStyle(ButtonStyle.Success)
                .setDisabled(disabled),
            new ButtonBuilder()
                .setCustomId(`massDisciplineApproval:reject:${batchId}`)
                .setLabel('Отклонить')
                .setStyle(ButtonStyle.Danger)
                .setDisabled(disabled)
        );
    }

    function buildApprovalEmbed(batch, statusText = 'Ожидает подтверждения') {
        const valid = (batch.items || []).filter((item) => item.status !== 'invalid');
        const employeeFields = chunkFieldLines(valid.map((item) => formatItemTarget(item))).map((value, index) => ({
            name: index === 0
                ? `Сотрудники (${valid.length})`
                : `Сотрудники (${valid.length}) - продолжение ${index + 1}`,
            value,
        }));
        return new EmbedBuilder()
            .setColor(statusText === 'Ожидает подтверждения' ? 0xF39C12 : 0x3498DB)
            .setTitle('Подтверждение массового дисциплинарного дела')
            .addFields(
                { name: 'ID пакета', value: batch.massdisciplineId },
                { name: 'Инициатор', value: `<@${batch.actorId}> | ${batch.actorDisplayName} | ||${batch.actorId}||` },
                { name: 'Дата нарушения', value: batch.payload.violationDate },
                { name: 'Санкции', value: getSelectionSummary(batch.payload.selection) },
                ...employeeFields,
                { name: 'Нарушенные пункты', value: batch.payload.violatedRules.slice(0, 1024) },
                { name: 'Причина', value: batch.payload.reason.slice(0, 1024) },
                { name: 'Статус', value: statusText },
            )
            .setFooter(getDefaultFooter())
            .setTimestamp(batch.createdAt);
    }

    function getGroupLabel(group) {
        if (group.key === 'dismissal') return 'Увольнение';
        return group.entries.map((entry) => {
            const label = SANCTION_LABELS[entry.type] || 'Неизвестное взыскание';
            return DISCIPLINE_STAGES.includes(entry.type) && entry.count > 1 ? `${label} × ${entry.count}` : label;
        }).join(', ');
    }

    function buildGroupEmbed(batch, group, itemStatuses = null) {
        const items = (batch.items || []).filter((item) => item.status !== 'invalid');
        const lines = items.map((item) => {
            const current = itemStatuses?.find((entry) => getItemTargetKey(entry) === getItemTargetKey(item)) || item;
            const icon = current.status === 'completed' ? '✅' : current.status === 'failed' ? '❌' : current.status === 'skipped_state_changed' ? '⏭️' : '⏳';
            const link = current.status === 'completed' ? formatGroupLinks(current, group.key) : '';
            const error = current.status === 'failed' ? ` - ${String(current.error || 'ошибка').slice(0, 60)}` : '';
            return `${icon} ${formatItemTarget(item)}${link}${error}`;
        });
        const employeeFields = chunkFieldLines(lines).map((value, index) => ({
            name: index === 0 ? 'Сотрудники' : 'Сотрудники (продолжение)',
            value,
        }));
        return new EmbedBuilder()
            .setColor(0xE67E22)
            .setTitle(`Массовое взыскание • ${getGroupLabel(group)}`)
            .addFields(
                { name: 'ID пакета', value: batch.massdisciplineId },
                ...employeeFields,
            )
            .setFooter(getDefaultFooter())
            .setTimestamp(batch.createdAt);
    }

    function buildResultPayload(batch) {
        const lines = [];
        for (const item of batch.items || []) {
            const target = formatItemTarget(item);
            if (item.status === 'invalid') {
                lines.push(`➖ ${target} - исключён: ${String(item.error || 'ошибка').slice(0, 80)}`);
            } else if (item.status === 'completed') {
                lines.push(`✅ ${target} - выполнено${item.caseLink ? ` · ${item.caseLink}` : ''}`);
            } else if (item.status === 'skipped_state_changed') {
                lines.push(`⏭️ ${target} - состояние изменилось`);
            } else if (item.status === 'failed') {
                const caseId = item.disciplineCaseId ? ` · дело ${item.disciplineCaseId}` : '';
                lines.push(`❌ ${target} - ${String(item.error || 'ошибка').slice(0, 80)}${caseId}`);
            } else {
                lines.push(`⏳ ${target} - ${getItemStatusLabel(item.status)}`);
            }
        }
        const resultFields = chunkFieldLines(lines).map((value, index) => ({
            name: index === 0 ? `Результаты (${lines.length})` : `Результаты - продолжение ${index + 1}`,
            value,
        }));
        const embed = new EmbedBuilder()
            .setColor(batch.status === 'completed' ? 0x2ECC71 : 0xE67E22)
            .setTitle('Результат массового дисциплинарного дела')
            .addFields(
                { name: 'ID пакета', value: batch.massdisciplineId },
                { name: 'Статус', value: getBatchStatusLabel(batch.status) },
                ...(batch.executionError ? [{ name: 'Ошибка исполнения', value: String(batch.executionError).slice(0, 300) }] : []),
                ...resultFields,
            )
            .setFooter(getDefaultFooter())
            .setTimestamp(batch.createdAt || Date.now());
        return {
            content: batch.status === 'partially_completed'
                ? `Для повторения: /manualtools retry_massdiscipline massdiscipline_id:${batch.massdisciplineId}`
                : '',
            embeds: [embed],
            allowedMentions: { parse: [] },
        };
    }

    function buildResult(batch) {
        const payload = buildResultPayload(batch);
        return [payload.content, `Массовое дисциплинарное дело ${batch.massdisciplineId}: ${getBatchStatusLabel(batch.status)}`]
            .filter(Boolean)
            .join('\n');
    }

    return {
        buildApprovalEmbed,
        buildApprovalRow,
        buildConfirmationRow,
        buildGroupEmbed,
        buildPreview,
        buildPreviewComponents,
        buildPreviewPayload,
        buildResult,
        buildResultPayload,
        chunkFieldLines,
        getGroupLabel,
    };
}

module.exports = {
    BATCH_STATUS_LABELS,
    ITEM_STATUS_LABELS,
    SANCTION_LABELS,
    createMassDisciplinePresentation,
    getBatchStatusLabel,
    getItemStatusLabel,
    getSelectionSummary,
};
