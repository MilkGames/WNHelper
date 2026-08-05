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

function formatDate(dateKey) {
    const [year, month, day] = String(dateKey || '').split('-');
    return year && month && day ? `${day}.${month}.${year}` : String(dateKey || '');
}

function formatMember(memberId, displayName) {
    return `<@${memberId}> | ${displayName || 'Имя неизвестно'} | ||${memberId}||`;
}

function getStatusLabel(status) {
    return {
        pending: 'Ожидает рассмотрения',
        approved: 'Одобрена',
        scheduled: 'Одобрена, ожидает начала',
        active: 'Отпуск активен',
        awaiting_return: 'Ожидается возвращение',
        completed: 'Завершена',
        rejected: 'Отклонена',
        cancelled: 'Отозвана',
        overdue: 'Просрочена',
        closed_by_dismissal: 'Закрыта увольнением',
        activation_failed: 'Ошибка начала отпуска',
        return_failed: 'Ошибка завершения отпуска',
    }[status] || 'Неизвестный статус';
}

function getOverdueActionLabel(action) {
    return {
        notify: 'Уведомление',
        written: 'Письменный выговор',
        dismissal: 'Увольнение',
    }[action] || 'Неизвестное действие';
}

function buildRequestEmbed(request) {
    const fields = [
        { name: 'Сотрудник', value: formatMember(request.memberId, request.memberDisplayName) },
        { name: 'Тип отпуска', value: request.typeName, inline: true },
        { name: 'Период', value: `${formatDate(request.startDate)}-${formatDate(request.endDate)}`, inline: true },
        { name: 'Продолжительность', value: `${request.durationDays} дн.`, inline: true },
        { name: 'Причина', value: request.reason || 'Не указана' },
    ];
    if (request.status === 'completed' && request.effectiveEndDate && request.actualDurationDays) {
        fields.push({
            name: 'Фактически использовано',
            value: `${request.actualDurationDays} дн. (до ${formatDate(request.effectiveEndDate)} включительно)`,
            inline: true,
        });
    }
    if (request.departmentName) fields.push({ name: 'Основной отдел', value: request.departmentName, inline: true });
    if (request.rankNumber) fields.push({ name: 'Ранг', value: `${request.rankNumber} - ${request.rankName}`, inline: true });
    if (request.monthSlices?.length) {
        fields.push({
            name: 'Использование лимита',
            value: request.monthSlices.map((slice) => (
                `${slice.monthKey}: ${slice.usedAfter}${slice.limit > 0 ? ` из ${slice.limit}` : ' (без лимита)'}`
            )).join('\n').slice(0, 1024),
        });
    }
    if (request.exceedReasons?.length) {
        fields.push({
            name: 'Требуется исключение',
            value: request.exceedReasons.map((entry) => `• ${entry}`).join('\n').slice(0, 1024),
        });
    }
    if (request.limitExceptionReason) {
        fields.push({ name: 'Причина одобрения исключения', value: request.limitExceptionReason.slice(0, 1024) });
    }
    if (request.approvalRouteLabel) fields.push({ name: 'Маршрут согласования', value: request.approvalRouteLabel });
    fields.push({ name: 'Статус', value: getStatusLabel(request.status) });
    if (request.rejectionReason) fields.push({ name: 'Причина отклонения', value: request.rejectionReason });
    if (request.approvedBy) fields.push({ name: 'Одобрил', value: `<@${request.approvedBy}>` });
    if (request.returnConfirmedBy) fields.push({ name: 'Отпуск завершил', value: `<@${request.returnConfirmedBy}>` });
    if (request.overdueActions?.length) {
        const lines = request.overdueActions.map((entry) => {
            const icon = entry.status === 'completed'
                ? '✅'
                : entry.status === 'failed'
                    ? '⚠️'
                    : entry.status === 'cancelled'
                        ? '➖'
                        : '⏳';
            const suffix = entry.status === 'cancelled' ? ' (отменено)' : '';
            return `${icon} ${entry.afterDays} дн. - ${getOverdueActionLabel(entry.action)}${suffix}`;
        });
        fields.push({ name: 'Просрочка', value: lines.join('\n').slice(0, 1024) });
    }
    return new EmbedBuilder()
        .setColor(request.status === 'rejected' || request.status === 'overdue' ? 0xE74C3C : 0x3498DB)
        .setTitle('Заявка на отпуск')
        .addFields(fields)
        .setTimestamp(request.createdAt || Date.now())
        .setFooter(getDefaultFooter());
}

function buildRequestComponents(request) {
    const buttons = [];
    if (request.status === 'pending') {
        buttons.push(
            new ButtonBuilder().setCustomId(`vacation:approve:${request.requestId}`).setLabel('Одобрить').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`vacation:reject:${request.requestId}`).setLabel('Отклонить').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`vacation:withdraw:${request.requestId}`).setLabel('Отозвать заявку').setStyle(ButtonStyle.Secondary),
        );
    } else if (request.status === 'scheduled') {
        buttons.push(
            new ButtonBuilder().setCustomId(`vacation:self_edit:${request.requestId}`).setLabel('Изменить заявку').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`vacation:withdraw:${request.requestId}`).setLabel('Отозвать заявку').setStyle(ButtonStyle.Secondary),
        );
    } else if (['active', 'awaiting_return'].includes(request.status)) {
        buttons.push(
            new ButtonBuilder().setCustomId(`vacation:return:${request.requestId}`).setLabel('Завершить отпуск').setStyle(ButtonStyle.Success)
        );
    }
    return buttons.length ? [new ActionRowBuilder().addComponents(buttons)] : [];
}

function buildPanelPayload() {
    const embed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle('Отпуска Weazel News')
        .setDescription('Нажмите кнопку ниже, чтобы подать заявку на отпуск или открыть свою текущую заявку.')
        .setFooter(getDefaultFooter());
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('vacation:apply')
            .setLabel('Подать заявку')
            .setStyle(ButtonStyle.Primary)
    );
    return { embeds: [embed], components: [row], allowedMentions: { parse: [] } };
}

module.exports = {
    buildPanelPayload,
    buildRequestComponents,
    buildRequestEmbed,
    formatDate,
    formatMember,
    getOverdueActionLabel,
    getStatusLabel,
};
