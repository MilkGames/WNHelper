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
const {} = require('discord.js');
const inviteCommand = require('../../commands/wn/ka/invite');

module.exports = async (client, interaction) => {
    try {
        if (!interaction.isButton()) return;
        if (!(interaction.customId === 'mass-ka')) return;

        const channel = interaction.channel;

        const member = interaction.user;
        const memberId = `<@${member.id}>`;

        const mockInteraction = {
            user: member,
            channel: channel,
            options: {
                getString: () => memberId,
                get: (name) => {
                    if (name === 'static') return { value: "7658" };
                    if (name === 'rank') return { value: "1" };
                    if (name === 'reason') return { value: "Собеседование" };
                    return null;
                },
            },
            reply: async (message) => {
                await interaction.reply(message);
            },
            deleteReply: async () => {
                await interaction.deleteReply();
            }
        }

        await inviteCommand.callback(client, mockInteraction);
    } catch (error) {
        console.log(`Произошла ошибка при нажатии на кнопку, связанную с массовым кадровым аудитом: ${error}`);
        await interaction.reply({
            content: `Произошла ошибка при нажатии на кнопку, связанную с массовым кадровым аудитом: ${error}`,
            ephemeral: true,
        });
    }
}