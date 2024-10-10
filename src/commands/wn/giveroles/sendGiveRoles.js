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
const { Client, Interaction, ApplicationCommandOptionType, EmbedBuilder, PermissionFlagsBits, ButtonBuilder, ActionRowBuilder, ButtonStyle } = require('discord.js');
const config = require('../../../../config.json');
const giveRoles = require('../../../models/giveRoles');
const blackListGiveRoles = require('../../../models/blackListGiveRoles');

module.exports = {
    name: 'sendgr',
    description: 'Отправляет заявку на выдачу ролей стажировки.',
    //devOnly: Boolean
    //testOnly: Boolean
    options: [
        {
            name: 'nickname',
            description: 'Имя Фамилия вашего персонажа, к примеру: Michael Lindberg. Ники по-русски не принимаются.',
            required: true,
            type: ApplicationCommandOptionType.String,
        },
        {
            name: 'static',
            description: 'Статик вашего персонажа, к примеру: 7658.',
            required: true,
            type: ApplicationCommandOptionType.String,
        },
        {
            name: 'invite-nick',
            description: 'Тег сотрудника, который вас принимал.',
            required: true,
            type: ApplicationCommandOptionType.Mentionable,
        },
    ],
    permissionsRequired: [],
    botPermissions: [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ChangeNickname],

    callback: async (client, interaction) => {
        const guildId = interaction.guildId;
        const userId = interaction.user.id;
        const userPing = await client.users.fetch(userId);
        const nickname = interaction.options.getString('nickname');
        const static = interaction.options.getString('static');
        const inviteUserMention = interaction.options.getUser('invite-nick');
        const inviteUserId = inviteUserMention.id;

        const channel = await client.channels.fetch(config.servers[guildId].confirmRoleChannelId);
        const query = {
            guildId: guildId,
            userId: userId,
        };

        try {
            const ifGiveRoles = await giveRoles.findOne(query);
            const ifBlackListGiveRoles = await blackListGiveRoles.findOne(query);
            if (ifBlackListGiveRoles) {
                await interaction.reply({
                    content: 'Действие невозможно. Вы попали в чёрный список выдачи ролей.',
                    ephemeral: true,
                });
                return;
            }
            if (ifGiveRoles) {
                await interaction.reply({
                    content: `${userPing}, вы уже отправляли заявку!
Ожидайте, пока сотрудник Weazel News её примет.
Вы получите оповещение как только получите роли.`,
                    ephemeral: true,
                });
                return;
            }
            else {
                const embed = new EmbedBuilder()
                    .setColor(0x3498DB)
                    .setTitle('Заявка на выдачу ролей - НА РАССМОТРЕНИИ')
                    .setDescription(`Заявка от ${userPing}. Discord ID: ${userId}.
Уважаемый сотрудник Weazel News!
Обратите внимание на то, как записаны Имя Фамилия и статик персонажа!
Проверьте данные дважды перед тем, как одобрять заявку!
Пользователь оставил следующие данные:`)
                    .addFields(
                        { name: 'Имя Фамилия:', value: nickname },
                        { name: 'Статик:', value: static },
                    )
                    .setTimestamp()
                    .setFooter({ text: 'WN Helper by Michael Lindberg. Discord: milkgames', iconURL: 'https://i.imgur.com/zdxWb0s.jpeg' });

                const row = new ActionRowBuilder();

                row.components.push(
                    new ButtonBuilder()
                        .setCustomId('role-confirm')
                        .setLabel('Одобрить')
                        .setStyle(ButtonStyle.Success)
                );

                row.components.push(
                    new ButtonBuilder()
                        .setCustomId('role-db')
                        .setLabel('Одобрить (ДБ)')
                        .setStyle(ButtonStyle.Success)
                );

                row.components.push(
                    new ButtonBuilder()
                        .setCustomId('role-decline')
                        .setLabel('Отклонить')
                        .setStyle(ButtonStyle.Danger)
                );

                row.components.push(
                    new ButtonBuilder()
                        .setCustomId('role-block')
                        .setLabel('Заблокировать')
                        .setStyle(ButtonStyle.Danger)
                );

                const sentMessage = await channel.send({
                    content: `${inviteUserMention}`,
                    embeds: [embed],
                    components: [row],
                });

                const messageId = sentMessage.id;
                const newGiveRoles = new giveRoles({
                    guildId: guildId,
                    messageId: messageId,
                    userId: interaction.user.id,
                    nickname: interaction.options.getString('nickname'),
                    static: interaction.options.getString('static'),
                    invite_nick: inviteUserId,
                });

                await newGiveRoles.save();

                await interaction.reply({
                    content: `Спасибо, ${userPing}, ваша заявка принята!
Ожидайте, пока сотрудник ${inviteUserMention} её примет.
Вы получите оповещение как только получите роли.`,
                    ephemeral: true,
                });
                return;
            }
        } catch (error) {
            console.log(`Произошла ошибка при публикации заявки для выдачей ролей: ${error}.`);
            await interaction.reply({
                content: `Произошла ошибка при публикации заявки для выдачей ролей: ${error}.`,
                ephemeral: true,
            });
        }
    },
};