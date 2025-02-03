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
const config = require('../../../../config.json');
const { ApplicationCommandOptionType, PermissionFlagsBits, EmbedBuilder } = require('discord.js');

async function editReply(type, interaction, member, kachannel) {
    let content;
    switch(type) {
        case 1:
            content = `Вы указали пользователя, которому хотите изменить ранг, не пингом.
Укажите переменную "static" для того, чтобы команда сработала.
Если вы используете контекстную команду, то бот не смог считать ID дискорда из сообщения.
Проверьте сообщение, которое вы используете для отписи изменения ранга.
-# Сообщение удалится через 30 секунд.`;
            break;
        case 2:
            content = `Невозможно определить статик.
Укажите переменную "static" для того, чтобы команда сработала.
Если вы используете контекстную команду, то бот не смог считать статик из никнейма сотрудника.
-# Сообщение удалится через 30 секунд.`
            break;
        case 3:
            content = `Отпись кадрового аудита на изменение ранга ${member} успешно создана в канале ${kachannel}!
-# Сообщение удалится через 30 секунд.`
            break;
        case 4:
            content = `Повышение на старший состав оформляют исключительно лидер и заместитель лидера фракции.
-# Сообщение удалится через 30 секунд.`
            break;
    }

    await interaction.editReply({
        content: content,
        ephemeral: true, 
    });

    setTimeout(async () => {
        try {
            await interaction.deleteReply();
        } catch (error) {
            console.log(`Не удалось удалить ответ: ${error}`);
        }
    }, 30000);
    return;
}

async function changeRank(member, oldRank, newRank) {
    const newRole = member.guild.roles.cache.get(newRank);
    if (newRole) await member.roles.add(newRole);
    const oldRole = member.guild.roles.cache.get(oldRank);
    if (oldRole) await member.roles.remove(oldRole);
    return;
}

module.exports = {
    name: 'rank',
    description: 'Изменение ранга игроку во фракции.',
    //devOnly: Boolean
    //testOnly: Boolean
    options: [
        {
            name: 'member',
            description: 'Игрок, которому изменяют ранг.',
            required: true,
            type: ApplicationCommandOptionType.String,
        },
        {
            name: 'action',
            description: 'Действие, которое производят с игроком, к примеру: Повышен 2-3.',
            required: true,
            type: ApplicationCommandOptionType.String,
        },
        {
            name: 'reason',
            description: 'Причина, по которой человеку изменяют ранг.',
            required: true,
            type: ApplicationCommandOptionType.String,
        },
        {
            name: 'static',
            description: 'Статик игрока, которому изменяют ранг.',
            type: ApplicationCommandOptionType.String,
        },
    ],
    permissionsRequired: [PermissionFlagsBits.ManageRoles],
    botPermissions: [PermissionFlagsBits.ManageRoles],

    callback: async (client, interaction) => {
        try {
            await interaction.deferReply({ ephemeral: true });
            const guildId = interaction.guildId;

            const guild = await client.guilds.fetch(guildId);

            const userId = interaction.user.id;
            const userPing = await guild.members.fetch(userId);

            const userNick = userPing.displayName;
            const testmember = interaction.options.getString('member');
            const memberId = testmember.replace(/[<@!>]/g, '');
            const kachannel = await client.channels.fetch(config.servers[guildId].kaChannelId);

            let memberNick;
            let member;
            if (testmember === memberId) {
                member = testmember;
                static = interaction.options.get('static')?.value || 'Null';
                memberNick = 'Null';
                if (static === 'Null') {
                    editReply(1, interaction, member, kachannel);
                    return;
                }
            }
            else {
                member = await guild.members.fetch(memberId);

                memberNick = member.displayName;
                const match = memberNick.match(/(\d+)$/);
                if (match) static = match[1];
                else {
                    static = interaction.options.get('static')?.value || 'Null';
                    if (static === 'Null') {
                        editReply(2, interaction, member, kachannel);
                        return;
                    }
                }
            }
            const action = interaction.options.getString('action');
            const reason = interaction.options.getString('reason');
            const rank = parseInt(action.match(/\d$/));

            const depLeaderRoleId = config.servers[guildId].depLeaderRoleId;
            const leaderRoleId = config.servers[guildId].leaderRoleId;
            if ((rank > 7 && !userPing.roles.cache.has(depLeaderRoleId)) || userPing.roles.cache.has(leaderRoleId)) {
                editReply(4, interaction, member, kachannel);
                return;
            }
            if (member.nickname && guildId == Object.keys(config.servers)[2]) {
                switch (rank) {
                    case 2:
                        await changeRank(member, config.servers[guildId].firstRankRoleId, config.servers[guildId].secondRankRoleId);
                        break;
                    case 3:
                        await changeRank(member, config.servers[guildId].secondRankRoleId, config.servers[guildId].thirdRankRoleId);
                        const TDRole = member.guild.roles.cache.get(config.servers[guildId].traineeRoleId);
                        if (TDRole) await member.roles.remove(TDRole);
                        let prefix = "";
                        if (member.roles.cache.has(config.servers[guildId].RDDRoleId)) prefix = "RD";
                        if (member.roles.cache.has(config.servers[guildId].AMDRoleId)) prefix = "AMD";
                        if (member.roles.cache.has(config.servers[guildId].EDRoleId)) prefix = "ED";
                        if (member.roles.cache.has(config.servers[guildId].JDRoleId)) prefix = "JD";
                        let baseNickName = memberNick.split('|')[1].trim();
                        let preNickName = `${prefix} | ${baseNickName} | ${static}`;
                        let newNickName;
                        if (preNickName.length > 32) {
                            let firstSpace;
                            for (let i = 0; i < baseNickName.length; i++) {
                                if (baseNickName[i] === ' ') {
                                    firstSpace = i;
                                    newNickName = `${prefix} | ${baseNickName.slice(0, i+2)}. | ${static}`;
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
                        break;
                    case 4:
                        await changeRank(member, config.servers[guildId].thirdRankRoleId, config.servers[guildId].fourthRankRoleId);
                        break;
                    case 5:
                        await changeRank(member, config.servers[guildId].fourthRankRoleId, config.servers[guildId].fifthRankRoleId);
                        break;
                    case 6:
                        await changeRank(member, config.servers[guildId].fifthRankRoleId, config.servers[guildId].sixthRankRoleId);
                        break;
                    case 7:
                        await changeRank(member, config.servers[guildId].sixthRankRoleId, config.servers[guildId].seventhRankRoleId);
                        break;
                    case 8:
                        await changeRank(member, config.servers[guildId].seventhRankRoleId, config.servers[guildId].eighthRankRoleId);
                        break;
                    case 9:
                        await changeRank(member, config.servers[guildId].eighthRankRoleId, config.servers[guildId].depLeaderRoleId);
                        break;
                }
            }

            const channel = interaction.channel;
            const rankEmbed = new EmbedBuilder()
                .setColor(0x2ECC70)
                .setTitle('Кадровый аудит • Изменение ранга')
                .addFields(
                    { name: 'Обновил(-а):', value: `${userPing} | ${userNick} | ||${userId}||` },
                )
                .setTimestamp()
                .setFooter({ text: 'WN Helper by Michael Lindberg. Discord: milkgames', iconURL: 'https://i.imgur.com/zdxWb0s.jpeg' });
            if (memberNick === 'Null') {
                rankEmbed.addFields(
                    { name: 'Обновлен(-а):', value: `${member}` },
                )
            }
            else {
                rankEmbed.addFields(
                    { name: 'Обновлен(-а):', value: `${member} | ${memberNick} | ||${memberId}||` },
                )
            }
            rankEmbed.addFields(
                { name: 'Номер ID карты:', value: `${static}`, inline: true },
                { name: 'Действие:', value: `${action}`, inline: true },
                { name: 'Причина:', value: `${reason}`},
            )
            kachannel.send({ embeds: [rankEmbed] });

            if (kachannel === channel) {
                await interaction.editReply({
                    content: 'Meow!',
                    ephemeral: true,
                });
                await interaction.deleteReply();
            } else {
                editReply(3, interaction, member, kachannel);
            }
            return;
        } catch (error) {
            console.log(`Произошла ошибка отписи изменения ранга в КА: ${error}`);
            if (!interaction.replied) {
                await interaction.editReply({
                    content: `Произошла ошибка изменения ранга в КА: ${error}`,
                    ephemeral: true,
                });
            }
        }
    },
}