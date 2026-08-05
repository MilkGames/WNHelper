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

function buildCustomId(action, uvalId) {
    return `uvalApproval:${action}:${uvalId}`;
}

function truncate(value, maxLength) {
    const text = String(value || '').trim();
    if (text.length <= maxLength) return text;
    return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function buildApprovalEmbed(operations) {
    const list = Array.isArray(operations) ? operations : [];
    const first = list[0];
    if (list.length === 1) {
        return new EmbedBuilder()
            .setColor(0xF1C40F)
            .setTitle('Требуется подтверждение увольнения')
            .addFields(
                { name: 'Исполнитель', value: `<@${first.actorId}>` },
                { name: 'Сотрудник', value: first.targetMemberId ? `<@${first.targetMemberId}>` : first.targetDisplayName },
                { name: 'Источник', value: first.source },
                { name: 'Причина', value: truncate(first.reason || 'Не указана', 1024) },
            )
            .setFooter(getDefaultFooter())
            .setTimestamp(new Date(Number(first.createdAt) || Date.now()));
    }

    const lines = list.map((operation, index) => {
        const target = operation.targetMemberId
            ? `<@${operation.targetMemberId}>`
            : truncate(operation.targetDisplayName || 'Неизвестный сотрудник', 60);
        return `${index + 1}. ${target} - ${truncate(operation.reason || 'Причина не указана', 96)}`;
    });
    const sources = [...new Set(list.map((operation) => String(operation.source || 'unknown')))];
    return new EmbedBuilder()
        .setColor(0xF1C40F)
        .setTitle('Требуется подтверждение увольнений')
        .setDescription(`**Сотрудники (${list.length})**\n${lines.join('\n')}`)
        .addFields(
            { name: 'Исполнитель', value: `<@${first.actorId}>`, inline: true },
            { name: 'Источник', value: sources.length === 1 ? sources[0] : 'Несколько источников', inline: true },
        )
        .setFooter(getDefaultFooter())
        .setTimestamp(new Date(Number(first.createdAt) || Date.now()));
}

function buildApprovalComponents(approvalKey) {
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(buildCustomId('approve', approvalKey))
            .setLabel('Подтвердить')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(buildCustomId('reject', approvalKey))
            .setLabel('Отклонить')
            .setStyle(ButtonStyle.Secondary),
    )];
}

module.exports = {
    buildApprovalComponents,
    buildApprovalEmbed,
    buildCustomId,
    truncate,
};
