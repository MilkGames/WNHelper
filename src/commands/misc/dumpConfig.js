/*
 * WN Helper Discord Bot
 * Copyright (C) 2024 MilkGames
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
const { PermissionFlagsBits } = require('discord.js');
const config = require('../../../config.json');

function formatValue(key, value) {
    if (!value) return '—';
    if (key.toLowerCase().includes('roleid')) return `<@&${value}> (${value})`;
    if (key.toLowerCase().includes('channelid')) return `<#${value}> (${value})`;
    return `${value}`;
}

module.exports = {
    name: 'dumpconfig',
    description: 'Выводит конфиг текущего сервера из config.json',
    permissionsRequired: [PermissionFlagsBits.Administrator],

    callback: async (client, interaction) => {
        await interaction.deferReply({ ephemeral: true });

        const guildId = interaction.guildId;
        const serverConfig = config.servers[guildId];

        if (!serverConfig) {
            await interaction.editReply({
                content: 'Для этого сервера нет записи в config.json.',
                ephemeral: true,
            });
            return;
        }

        const lines = Object.keys(serverConfig)
            .filter((key) => key !== '_comment')
            .sort()
            .map((key) => `${key}: ${formatValue(key, serverConfig[key])}`);

        const header = `Конфиг для ${interaction.guild.name} (${guildId}):\n`;
        const bodyLines = lines;
        const chunks = [];
        let current = '';

        for (const line of bodyLines) {
            const candidate = current ? `${current}\n${line}` : line;
            // оставляем запас под обрамляющие кавычки и текст заголовка
            if (candidate.length > 1700) {
                chunks.push(current);
                current = line;
            } else {
                current = candidate;
            }
        }
        if (current) chunks.push(current);

        if (chunks.length === 0) {
            chunks.push('Конфиг пуст.');
        }

        // первая часть идет в ответ, остальные — followUp
        const firstContent = `${header}\n${chunks[0]}\n`;
        await interaction.editReply({
            content: firstContent,
            ephemeral: true,
        });

        for (let i = 1; i < chunks.length; i++) {
            const content = `Продолжение конфига (${i + 1}/${chunks.length}):\n\n${chunks[i]}\n`;
            await interaction.followUp({
                content,
                ephemeral: true,
            });
        }
    },
};
