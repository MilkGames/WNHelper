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
const { EmbedBuilder } = require('discord.js');
const { getDefaultFooter } = require('../../core/ui/defaultFooter');

function formatActor(actor) {
    return `${actor} | ${actor.displayName} | ||${actor.id}||`;
}

function formatTarget({ member, displayName, memberId }) {
    if (member) return `${member} | ${displayName} | ||${memberId}||`;
    if (memberId) return `<@${memberId}> | ${displayName} | ||${memberId}||`;
    return String(displayName);
}

function buildInviteRecordEmbed({ actor, target, rankNumber, reason, departmentName = null }) {
    const embed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle('Кадровый аудит • Принятие')
        .addFields(
            { name: 'Принял(-а):', value: formatActor(actor) },
            { name: 'Принят(-а):', value: formatTarget(target) },
            { name: 'Номер ID карты:', value: String(target.staticId), inline: true },
            { name: 'Действие:', value: `Принят на ${rankNumber}`, inline: true },
        )
        .setTimestamp()
        .setFooter(getDefaultFooter());

    if (departmentName) embed.addFields({ name: 'Отдел:', value: String(departmentName) });
    embed.addFields({ name: 'Причина:', value: String(reason) });
    return embed;
}

function buildRankRecordEmbed({ actor, target, action, reason }) {
    return new EmbedBuilder()
        .setColor(0x2ECC70)
        .setTitle('Кадровый аудит • Изменение ранга')
        .addFields(
            { name: 'Обновил(-а):', value: formatActor(actor) },
            { name: 'Обновлен(-а):', value: formatTarget(target) },
            { name: 'Номер ID карты:', value: String(target.staticId), inline: true },
            { name: 'Действие:', value: String(action), inline: true },
            { name: 'Причина:', value: String(reason) },
        )
        .setTimestamp()
        .setFooter(getDefaultFooter());
}

function buildDismissalRecordEmbed({ actor, target, reason }) {
    return new EmbedBuilder()
        .setColor(0xFF2C2C)
        .setTitle('Кадровый аудит • Увольнение')
        .addFields(
            { name: 'Уволил(-а):', value: formatActor(actor) },
            { name: 'Уволен(-а):', value: formatTarget(target) },
            { name: 'Номер ID карты:', value: String(target.staticId) },
            { name: 'Причина:', value: String(reason) },
        )
        .setTimestamp()
        .setFooter(getDefaultFooter());
}

module.exports = {
    buildDismissalRecordEmbed,
    buildInviteRecordEmbed,
    buildRankRecordEmbed,
    formatActor,
    formatTarget,
};
