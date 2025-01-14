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
const { MessageActionRow, PermissionFlagsBits, ButtonBuilder, ActionRowBuilder, ButtonStyle } = require('discord.js');

module.exports = {
    name: 'createmasska',
    description: 'Добавляет сообщение c массовой отписью кадрового аудита по кнопке.',
    devOnly: true,
    testOnly: true,
    deleted: true,
    permissionsRequired: [PermissionFlagsBits.Administrator],
    botPermissions: [PermissionFlagsBits.ManageRoles],

    callback: async (client, interaction) => {
        const channel = await client.channels.fetch('1293910674283696169');
        
        const row = new ActionRowBuilder();

        row.components.push(
            new ButtonBuilder()
                .setCustomId('mass-ka')
                .setLabel('Отправить')
                .setStyle(ButtonStyle.Primary)
        );

        await channel.send({
            content: `Нажмите на кнопку для того, чтобы отправить массовый кадровый аудит!`,
            components: [row],
        });
    }
}