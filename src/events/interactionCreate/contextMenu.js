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
const rankCommand = require('../../commands/wn/ka/rank');
const uvalCommand = require('../../commands/wn/ka/uval');

module.exports = async (client, interaction) => {
    try {
        if (!interaction.isMessageContextMenuCommand()) return;
        if (interaction.commandName === 'Повысить по отчёту') {
            const targetMessage = interaction.targetMessage;

            const channel = interaction.channel;

            const member = interaction.member.user;
            const memberId = targetMessage.embeds[0].data.fields[targetMessage.embeds[0].data.fields.length - 1].value;

            const targetRank = targetMessage.embeds[0].data.fields[1].value;
            const action = `Повышен ${targetRank - 1}-${targetRank}`;

            const guildId = targetMessage.guildId;
            const targetChannelId = targetMessage.channelId;
            const messageId = targetMessage.id;
            const messageLink = `https://discord.com/channels/${guildId}/${targetChannelId}/${messageId}`;
            const mockInteraction = {
                guildId: guildId,
                user: member,
                channel: channel,
                options: {
                    getString: (name) => {
                        if (name === 'member') return memberId;
                        if (name === 'action') return action;
                        if (name === 'reason') return messageLink;
                    },
                    get: (name) => {
                        if (name === 'static') return { value: "Null" };
                        return null;
                },
                },
                deferReply: async (message) => {
                    await interaction.deferReply(message);
                },
                editReply: async (message) => {
                    await interaction.editReply(message);
                },
                deleteReply: async () => {
                    await interaction.deleteReply();
                }
            }
            await rankCommand.callback(client, mockInteraction);
            await targetMessage.react('✅');
        }
        if (interaction.commandName === 'Уволить по заявлению') {
            const targetMessage = interaction.targetMessage;

            const channel = interaction.channel;

            const member = interaction.member.user;
            const memberId = targetMessage.embeds[0].data.fields[targetMessage.embeds[0].data.fields.length - 1].value;

            const guildId = targetMessage.guildId;
            const targetChannelId = targetMessage.channelId;
            const messageId = targetMessage.id;
            const messageLink = `https://discord.com/channels/${guildId}/${targetChannelId}/${messageId}`;
            const mockInteraction = {
                guildId: guildId,
                user: member,
                channel: channel,
                options: {
                    getString: (name) => {
                        if (name === 'member') return memberId;
                        if (name === 'reason') return messageLink;
                    },
                    get: (name) => {
                        if (name === 'static') return { value: "Null" };
                        return null;
                },
                },
                deferReply: async (message) => {
                    await interaction.deferReply(message);
                },
                editReply: async (message) => {
                    await interaction.editReply(message);
                },
                deleteReply: async () => {
                    await interaction.deleteReply();
                }
            }
            await uvalCommand.callback(client, mockInteraction);
            await targetMessage.react('✅');
        }
    } catch (error) {
        console.log(`Произошла ошибка при взаимодействии с контекстным меню: ${error}`);
    }
}