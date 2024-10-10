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
const { Client, Interaction, IntentsBitField, ActivityType, EmbedBuilder, MessageReaction } = require('discord.js');
const giveRoles = require('../../models/giveRoles');
const blackListGiveRoles = require('../../models/blackListGiveRoles');
const config = require('../../../config.json');

module.exports = async (client, interaction) => {
    try {
        if (!interaction.isButton()) return;
        if (!(interaction.customId === 'role-confirm' ||
            interaction.customId === 'role-db' ||
            interaction.customId === 'role-decline' ||
            interaction.customId === 'role-block')) return;
        const guildId = interaction.guildId;
        const channel = await client.channels.fetch(config.servers[guildId].confirmRoleChannelId);
        const kachannel = await client.channels.fetch(config.servers[guildId].kaChannelId);
        const messageId = interaction.message.id;
        const message = await channel.messages.fetch(messageId);
        const confirmUserId = interaction.user.id;
        const confirmUserIdMention = await client.users.fetch(confirmUserId);

        const query = {
            guildId: guildId,
            messageId: messageId,
        };

        const guild = await client.guilds.fetch(guildId);
        const giveRolesList = await giveRoles.findOne(query);
        const userId = giveRolesList.userId;
        const userPing = await client.users.fetch(userId);
        const nickname = giveRolesList.nickname;
        const static = giveRolesList.static;
        const invite_nick = giveRolesList.invite_nick;
        const invite_nick_mention = await client.users.fetch(invite_nick);
        const invite_nick_fetch = await guild.members.fetch(invite_nick);
        const invite_nick_nickname = invite_nick_fetch.displayName;
        const member = await guild.members.fetch(userId);
        const weazelNewsRoleId = config.servers[guildId].weazelNewsRoleId;
        const traineeRoleId = config.servers[guildId].traineeRoleId;
        const firstRankRoleId = config.servers[guildId].firstRankRoleId;
        const thirdRankRoleId = config.servers[guildId].thirdRankRoleId;
        const retestingRoleId = config.servers[guildId].retestingRoleId;
        const leaderRoleId = config.servers[guildId].leaderRoleId;
        let isLeader;

        if (member.roles.cache.has(leaderRoleId)) isLeader = true;
        else isLeader = false;

        if (interaction.customId === 'role-confirm' || interaction.customId === 'role-db') {
            if (confirmUserId === invite_nick || isLeader || config.devs.includes(confirmUserId)) {
                await giveRoles.deleteOne(query);
                const editedEmbed = new EmbedBuilder()
                    .setColor(0x008000)
                    .setTitle('Заявка на выдачу ролей - ОДОБРЕНА')
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
                message.edit({ embeds: [editedEmbed], components: [] });
                const roleIds = [weazelNewsRoleId, traineeRoleId];
                if (interaction.customId === 'role-confirm' && guildId !== Object.keys(config.servers)[2]) roleIds.push(firstRankRoleId);
                if (interaction.customId === 'role-db') {
                    if (guildId !== Object.keys(config.servers)[2]) roleIds.push(retestingRoleId, thirdRankRoleId);
                    else roleIds.push(retestingRoleId);
                }
                for (const roleId of roleIds) {
                    const role = guild.roles.cache.get(roleId);
                    if (role) {
                        await member.roles.add(role);
                    } else {
                        await interaction.reply({
                            content: `Роль ${roleId} испарилась с лица земли.`,
                            ephemeral: true,
                        });
                    }
                }
                let preNickName;
                if (guildId === Object.keys(config.servers)[2]) preNickName = `Стажер | ${nickname} | ${static}`;
                else preNickName = `TD | ${nickname} | ${static}`;
                let newNickName;
                if (preNickName.length > 32) {
                    let firstSpace;
                    for (let i = 0; i < nickname.length; i++) {
                        if (nickname[i] === ' ') {
                            firstSpace = i;
                            if (guildId === Object.keys(config.servers)[2]) preNickName = `Стажер | ${nickname.slice(0, i+2)} | ${static}`;
                            else newNickName = `TD | ${nickname.slice(0, i+2)}. | ${static}`;
                            break;
                        }
                    }
                }
                else {
                    newNickName = preNickName;
                }
                try {
                    member.setNickname(`${newNickName}`);
                } catch (error) {
                    console.log(`Ещё один чел поставил ник больше 32 символов. ${error}`);
                }
                let rank;
                let reason;
                if (interaction.customId === 'role-confirm') {
                    rank = '1';
                    reason = 'Собеседование';
                }
                else {
                    rank = '3';
                    reason = 'ДБ';
                }
                const kainviteEmbed = new EmbedBuilder()
                    .setColor(0x3498DB)
                    .setTitle('Кадровый аудит • Принятие')
                    .addFields(
                        { name: 'Принял(-а):', value: `${invite_nick_mention} | ${invite_nick_nickname} | ||${invite_nick}||` },
                        { name: 'Принят(-а):', value: `${userPing} | ${preNickName} | ||${userId}||` },
                        { name: 'Номер ID карты:', value: `${static}`, inline: true },
                        { name: 'Действие:', value: `Принят на ${rank}`, inline: true },
                        { name: 'Причина:', value: `${reason}` },
                    )
                    .setTimestamp()
                    .setFooter({ text: 'WN Helper by Michael Lindberg. Discord: milkgames', iconURL: 'https://i.imgur.com/zdxWb0s.jpeg' });
                if (guildId !== Object.keys(config.servers)[2]) kachannel.send({ embeds: [kainviteEmbed] });
                await interaction.reply({
                    content: `Заявка ${userPing} одобрена.`,
                    ephemeral: true,
                });
                await member.send(`${userPing}, ${invite_nick_mention} одобрил вашу заявку!
Добро пожаловать в Weazel News!`);
                return;
            }
            else {
                await interaction.reply({
                    content: `${confirmUserIdMention}, вы не являетесь ${invite_nick_mention} для того, чтобы принять заявку!`,
                    ephemeral: true,
                });
                return;
            }
        }

        if (interaction.customId === 'role-decline') {
            if (confirmUserId === invite_nick || isLeader || config.devs.includes(confirmUserId)) {
                await giveRoles.deleteOne(query);
                const editedEmbed = new EmbedBuilder()
                    .setColor(0xFF2C2C)
                    .setTitle('Заявка на выдачу ролей - ОТКЛОНЕНА')
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
                message.edit({ embeds: [editedEmbed], components: [] });
                await interaction.reply({
                    content: `Заявка ${userPing} отклонена.`,
                    ephemeral: true,
                });
                await member.send(`${userPing}, к сожалению, ${invite_nick_mention} отклонил вашу заявку.
Свяжитесь с сотрудником, чтобы выяснить причину.`);
                return;
            }
            else {
                await interaction.reply({
                    content: `${confirmUserIdMention}, вы не являетесь лидером фракции или ${invite_nick_mention} для того, чтобы отклонить заявку!`,
                    ephemeral: true,
                });
                return;
            }
        }

        if (interaction.customId === 'role-block') {
            if (isLeader || config.devs.includes(confirmUserId)) {
                const newBlackListGiveRoles = new blackListGiveRoles({
                    guildId: guildId,
                    userId: userId,
                });
                newBlackListGiveRoles.save();
                await giveRoles.deleteOne(query);
                const editedEmbed = new EmbedBuilder()
                    .setColor(0xFF2C2C)
                    .setTitle('Заявка на выдачу ролей - ПОЛЬЗОВАТЕЛЬ ЗАБЛОКИРОВАН')
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
                message.edit({ embeds: [editedEmbed], components: [] });
                await interaction.reply({
                    content: `Пользователь ${userPing} успешно заблокирован!`,
                });
                await member.send(`${userPing}, вы были заблокированы за злоупотребление функционалом бота!`);
                return;
            }
            else {
                await interaction.reply({
                    content: `${confirmUserIdMention}, вы не являетесь лидером фракции для того, чтобы заблокировать пользователя!`,
                    ephemeral: true,
                })
                return;
            }
        }
    } catch (error) {
        console.log(`Произошла ошибка при нажатии на кнопку, связанную с выдачей ролей: ${error}.`);
        await interaction.reply({
            content: `Произошла ошибка при нажатии на кнопку, связанную с выдачей ролей: ${error}.`,
            ephemeral: true,
        });
    }
};