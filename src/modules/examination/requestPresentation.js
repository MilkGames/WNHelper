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

function formatMember(memberId, displayName) {
    return `<@${memberId}> | ${String(displayName || memberId).slice(0, 200)} | ||${memberId}||`;
}

function statusLabel(request) {
    const labels = {
        publishing: 'Публикуется',
        failed_publication: 'Ошибка публикации',
        pending: 'Ожидает рассмотрения',
        waiting_for_voice: 'Ожидает входа в голосовой канал',
        in_progress: request.type === 'lecture' ? 'Лекция проводится' : 'Пересдача проводится',
        completing: request.type === 'lecture'
            ? 'Публикуется итог лекции'
            : 'Публикуется итог пересдачи',
        completion_failed: request.type === 'lecture'
            ? 'Ошибка публикации итога лекции'
            : 'Ошибка публикации итога пересдачи',
        completed: request.type === 'retest'
            ? (request.retestPassed === false ? 'Не сдана' : 'Сдана')
            : 'Завершена',
        rejected: 'Отклонена',
        cancelled: 'Отозвана',
        cancelled_by_handler: request.type === 'lecture' ? 'Лекция отменена' : 'Пересдача отменена',
        expired: 'Отменена: время ожидания истекло',
        closed_by_dismissal: 'Закрыта увольнением',
    };
    return labels[request.status] || 'Неизвестный статус';
}

function requestColor(request) {
    if (request.status === 'completed') {
        return request.type === 'retest' && request.retestPassed === false
            ? 0xE74C3C
            : 0x2ECC71;
    }
    if (['rejected', 'closed_by_dismissal', 'expired'].includes(request.status)) return 0xE74C3C;
    if (['cancelled', 'cancelled_by_handler'].includes(request.status)) return 0x95A5A6;
    if (['waiting_for_voice', 'in_progress', 'completing'].includes(request.status)) return 0x3498DB;
    if (['failed_publication', 'completion_failed'].includes(request.status)) return 0xE67E22;
    return 0xF1C40F;
}

function buildRequestEmbed(request) {
    const isLecture = request.type === 'lecture';
    const embed = new EmbedBuilder()
        .setColor(requestColor(request))
        .setTitle(isLecture ? 'Запрос на проведение лекции' : 'Запрос на пересдачу')
        .addFields(
            {
                name: 'Сотрудник:',
                value: formatMember(request.memberId, request.memberDisplayName),
            },
            ...(isLecture ? [
                { name: 'Лекция:', value: request.lectureTypeName || request.lectureTypeId || '-' },
                ...(request.departmentName ? [{ name: 'Отдел:', value: request.departmentName }] : []),
            ] : [
                { name: 'Экзамен:', value: request.examName || request.examId || '-' },
                {
                    name: 'Обычные попытки:',
                    value: `${Number(request.attemptsUsed || 0)} из ${Number(request.maxAttempts || 0)}`,
                },
            ]),
            {
                name: 'Комментарий:',
                value: request.comment || 'Не указан.',
            },
            {
                name: 'Статус:',
                value: statusLabel(request),
            },
        )
        .setTimestamp(request.createdAt || Date.now())
        .setFooter(getDefaultFooter());

    if (request.lectureResultMessageLink) {
        embed.addFields({ name: 'Итог лекции:', value: request.lectureResultMessageLink });
    }
    if (request.retestResultMessageLink) {
        embed.addFields({ name: 'Итог экзамена:', value: request.retestResultMessageLink });
    }
    if (request.handledBy) {
        const handlerLabel = request.status === 'rejected'
            ? 'Отклонил:'
            : (isLecture ? 'Лектор:' : 'Экзаменатор:');
        embed.addFields({
            name: handlerLabel,
            value: formatMember(
                request.handledBy,
                request.handledByDisplayName || request.handledBy
            ),
        });
    }
    if (request.status === 'waiting_for_voice' && request.voiceJoinDeadlineAt) {
        embed.addFields({
            name: 'Ожидание до:',
            value: `<t:${Math.floor(request.voiceJoinDeadlineAt / 1000)}:F> (<t:${Math.floor(request.voiceJoinDeadlineAt / 1000)}:R>)`,
        });
    }
    if (request.rejectionReason) {
        embed.addFields({ name: 'Причина отклонения:', value: String(request.rejectionReason).slice(0, 1024) });
    }
    if (request.requestId) {
        embed.addFields({ name: 'ID заявки:', value: request.requestId });
    }
    return embed;
}

function buildRequestComponents(request) {
    const row = new ActionRowBuilder();
    if (request.status === 'pending') {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`examreq:accept:${request.requestId}`)
                .setLabel('Принять')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`examreq:reject:${request.requestId}`)
                .setLabel('Отклонить')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(`examreq:cancel:${request.requestId}`)
                .setLabel('Отозвать заявку')
                .setStyle(ButtonStyle.Secondary),
        );
    } else if (request.status === 'in_progress') {
        if (request.type === 'lecture') {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`examreq:complete:${request.requestId}`)
                    .setLabel('Лекция проведена')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`examreq:cancel_procedure:${request.requestId}`)
                    .setLabel('Отменить лекцию')
                    .setStyle(ButtonStyle.Danger),
            );
        } else {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(`examreq:pass:${request.requestId}`)
                    .setLabel('Сдал')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`examreq:fail:${request.requestId}`)
                    .setLabel('Не сдал')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setCustomId(`examreq:cancel_procedure:${request.requestId}`)
                    .setLabel('Отменить пересдачу')
                    .setStyle(ButtonStyle.Secondary),
            );
        }
    }
    return row.components.length ? [row] : [];
}

module.exports = {
    buildRequestComponents,
    buildRequestEmbed,
    formatMember,
    requestColor,
    statusLabel,
};
