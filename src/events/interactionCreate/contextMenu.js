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
const { Client, Interaction, IntentsBitField, ActivityType, EmbedBuilder, MessageReaction, ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle, ActionRow } = require('discord.js');
const rankCommand = require('../../commands/wn/ka/rank');

module.exports = async (client, interaction) => {
    try {
        if (!interaction.isMessageContextMenuCommand()) return;
        if (interaction.commandName === 'Повысить по отчёту') {
            const targetMessage = interaction.targetMessage;

            const modal = new ModalBuilder()
                .setTitle('Повысить сотрудника по отчёту')
                .setCustomId(`rank-${interaction.user.id}`);

            const textInput = new TextInputBuilder()
                .setCustomId('rank-update')
                .setLabel('Введите изменение ранга:')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setPlaceholder('3-4')
                .setMinLength(3)
                .setMaxLength(5);

            const actionRow = new ActionRowBuilder().addComponents(textInput);

            modal.addComponents(actionRow);
  
            await interaction.showModal(modal);

            const filter = (i) => i.customId === `rank-${interaction.user.id}`;

            const modalInteraction = await interaction.awaitModalSubmit({filter, time: 1000 * 60 * 3});

            await modalInteraction.deferReply({ ephemeral: true });

            modalInteraction.deleteReply();

            const action = `Повышен ${modalInteraction.fields.getTextInputValue(`rank-update`)}`;

            const channel = interaction.channel;

            const member = interaction.member.user;
            const memberId = `<@${targetMessage.author.id}>`;

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
                reply: async (message) => {
                    await interaction.followUp(message);
                },
                deleteReply: async () => {
                    await interaction.deleteReply();
                }
            }
            await rankCommand.callback(client, mockInteraction);
        }
    } catch (error) {
        console.log(`Произошла ошибка при взаимодействии с контекстным меню: ${error}`);
    }
}