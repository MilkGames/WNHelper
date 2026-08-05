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
} = require('discord.js');

const { getDefaultFooter } = require('../../core/ui/defaultFooter');

const TERMINAL_STATUSES = new Set(['satisfied', 'rejected_final', 'withdrawn']);
const STATUS_LABELS = {
    creating: 'Создаётся',
    publication_failed: 'Не удалось опубликовать обращение',
    pending_review: 'Ожидает решения',
    awaiting_escalation: 'Ожидает передачи выше',
    routing_failed: 'Не удалось определить рассматривающего',
    satisfied: 'Удовлетворено',
    rejected_final: 'Отклонено окончательно',
    withdrawn: 'Отозвано сотрудником',
};
const TYPE_LABELS = {
    basis: 'Обжалование основания взыскания',
    workoff_method: 'Изменение способа отработки',
};
const STAGE_LABELS = {
    issuer: 'Выдавший взыскание',
    department_head: 'Глава отдела',
    curator: 'Куратор отдела',
    final: 'Окончательное решение',
    workoff_issuer: 'Выдавший взыскание',
    workoff_leadership: 'Руководство',
};

function formatMember(memberId, displayName) {
    const id = String(memberId || '');
    const name = String(displayName || id || 'неизвестно');
    return id ? `<@${id}> | ${name} | ||${id}||` : name;
}

function buildAppealEmbed(appeal) {
    const fields = [
        { name: 'Сотрудник', value: formatMember(appeal.applicantId, appeal.applicantDisplayName) },
        { name: 'Тип обращения', value: TYPE_LABELS[appeal.type] || 'Неизвестный тип обращения' },
        { name: 'Взыскание', value: appeal.sanctionLabel },
        { name: 'Ссылка на взыскание', value: appeal.sanctionMessageLink || 'ссылка недоступна' },
        { name: 'Причина обращения', value: appeal.reason.slice(0, 1024) },
    ];
    if (appeal.type === 'workoff_method') {
        fields.push(
            { name: 'Текущий способ', value: appeal.currentMethodName || 'не указан', inline: true },
            { name: 'Желаемый способ', value: appeal.requestedMethodName || 'не указан', inline: true },
        );
        if (appeal.approvedMethodName) {
            fields.push({ name: 'Итоговый способ', value: appeal.approvedMethodName, inline: true });
        }
    }
    fields.push(
        {
            name: 'Доказательства',
            value: appeal.threadId
                ? `Представлены в ветке <#${appeal.threadId}>`
                : 'Ветка доказательств ещё не создана.',
        },
        {
            name: 'Текущий этап',
            value: appeal.currentStageKey
                ? STAGE_LABELS[appeal.currentStageKey] || 'Неизвестный этап'
                : 'Маршрут не определён',
            inline: true,
        },
        {
            name: 'Статус',
            value: STATUS_LABELS[appeal.status] || 'Неизвестный статус',
            inline: true,
        },
    );
    if (appeal.lastDecisionReason) {
        fields.push({ name: 'Последнее решение', value: appeal.lastDecisionReason.slice(0, 1024) });
    }
    if (appeal.decidedById) {
        fields.push({ name: 'Решение принял(-а)', value: formatMember(appeal.decidedById, appeal.decidedByDisplayName) });
    }
    return new EmbedBuilder()
        .setColor(
            appeal.status === 'satisfied' ? 0x2ECC71 :
                appeal.status === 'rejected_final' ? 0xE74C3C :
                    appeal.status === 'withdrawn' ? 0x95A5A6 : 0x5865F2
        )
        .setTitle('Обжалование взыскания')
        .addFields(fields)
        .setFooter(getDefaultFooter())
        .setTimestamp(new Date(appeal.createdAt));
}

function buildAppealComponents(appeal) {
    if (TERMINAL_STATUSES.has(appeal.status)) return [];
    const buttons = [];
    if (appeal.status === 'pending_review') {
        buttons.push(
            new ButtonBuilder()
                .setCustomId(`disciplineAppeal:approve:${appeal.appealId}`)
                .setLabel(appeal.type === 'workoff_method' ? 'Одобрить изменение' : 'Удовлетворить')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`disciplineAppeal:reject:${appeal.appealId}`)
                .setLabel('Отклонить')
                .setStyle(ButtonStyle.Danger),
        );
    } else if (appeal.status === 'awaiting_escalation') {
        buttons.push(
            new ButtonBuilder()
                .setCustomId(`disciplineAppeal:escalate:${appeal.appealId}`)
                .setLabel('Передать выше')
                .setStyle(ButtonStyle.Primary)
        );
    } else if (appeal.status === 'routing_failed') {
        buttons.push(
            new ButtonBuilder()
                .setCustomId(`disciplineAppeal:reroute:${appeal.appealId}`)
                .setLabel('Повторить маршрутизацию')
                .setStyle(ButtonStyle.Primary)
        );
    }
    buttons.push(
        new ButtonBuilder()
            .setCustomId(`disciplineAppeal:withdraw:${appeal.appealId}`)
            .setLabel('Отозвать обращение')
            .setStyle(ButtonStyle.Secondary)
    );
    return buttons.length ? [new ActionRowBuilder().addComponents(buttons.slice(0, 5))] : [];
}

module.exports = {
    STATUS_LABELS,
    STAGE_LABELS,
    TERMINAL_STATUSES,
    TYPE_LABELS,
    buildAppealComponents,
    buildAppealEmbed,
    formatMember,
};
