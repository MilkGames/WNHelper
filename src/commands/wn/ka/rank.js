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

const logger = require('../../../utils/logger');

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
            logger.info(`Не удалось удалить ответ: ${error}`);
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

            const testmember = interaction.options.getString('member', true);
            const memberId = testmember.replace(/[<@!>]/g, '');

            const kachannel = await client.channels.fetch(config.servers[guildId].kaChannelId);

            let memberNick;
            let member;
            let staticId;

            if (testmember === memberId) {
                member = testmember;
                staticId = interaction.options.getString('static') ?? null;
                memberNick = null;

                if (!staticId) {
                    await editReply(1, interaction, member, kachannel);
                    return;
                }
            } else {
                member = await guild.members.fetch(memberId);
                memberNick = member.displayName;

                const match = memberNick.match(/(\d+)$/);
                if (match) {
                    staticId = match[1];
                } else {
                    staticId = interaction.options.getString('static') ?? null;
                    if (!staticId) {
                        await editReply(2, interaction, member, kachannel);
                        return;
                    }
                }
            }

            const action = interaction.options.getString('action', true);
            const isPromotion = action.toLowerCase().includes('повышен');
            const reason = interaction.options.getString('reason', true);

            const rankMatch = action.match(/(\d+)\s*$/);
            const rank = rankMatch ? parseInt(rankMatch[1], 10) : NaN;

            if (!Number.isFinite(rank) || rank < 1 || rank > 8) {
                await interaction.editReply({
                    content: 'Запрошенный ранг выше, чем доступно в текущем конфиге (максимум 8).',
                    ephemeral: true,
                });
                return;
            }

            // 6+ только лидер/зам
            if (rank >= 6) {
                const leaderRoleId = config.servers[guildId].leaderRoleId;
                const depLeaderRoleId = config.servers[guildId].depLeaderRoleId;

                const isLeader =
                    (leaderRoleId && userPing.roles.cache.has(leaderRoleId)) ||
                    (depLeaderRoleId && userPing.roles.cache.has(depLeaderRoleId));

                if (!isLeader) {
                    await editReply(4, interaction, member, kachannel);
                    return;
                }
            }

            const isGuildMember = member && typeof member === 'object' && member.roles && member.guild;

            // Автосмена ролей/ника — только если member реально GuildMember (т.е. был пинг)
            // Понижения редки, но бывают, сделаем на всякий проверку
            // Если пишут вручную... пусть учатся правильно писать нужное в поле action!!!
            if (isGuildMember && member.nickname && isPromotion) {
                switch (rank) {
                    case 2: {
                        await changeRank(
                            member,
                            config.servers[guildId].firstRankRoleId,
                            config.servers[guildId].secondRankRoleId
                        );

                        const tdRole = member.guild.roles.cache.get(config.servers[guildId].traineeRoleId);
                        if (tdRole) await member.roles.remove(tdRole);

                        let prefix = "";
                        if (member.roles.cache.has(config.servers[guildId].RDDRoleId)) prefix = "RDD";
                        if (member.roles.cache.has(config.servers[guildId].AMDRoleId)) prefix = "AMD";
                        if (member.roles.cache.has(config.servers[guildId].EDRoleId)) prefix = "ED";
                        if (member.roles.cache.has(config.servers[guildId].JDRoleId)) prefix = "JD";

                        let baseNickName = memberNick.split('|')[1]?.trim() ?? memberNick;
                        let preNickName = `${prefix} | ${baseNickName} | ${staticId}`;

                        let newNickName = preNickName;
                        if (preNickName.length > 32) {
                            for (let i = 0; i < baseNickName.length; i++) {
                                if (baseNickName[i] === ' ') {
                                    newNickName = `${prefix} | ${baseNickName.slice(0, i + 2)}. | ${staticId}`;
                                    break;
                                }
                            }
                        }

                        try {
                            await member.setNickname(`${newNickName}`);
                        } catch (error) {
                            logger.info(`Ошибка при изменении ника: ${error}`);
                        }
                        break;
                    }
                    case 3:
                        await changeRank(member, config.servers[guildId].firstRankRoleId, config.servers[guildId].thirdRankRoleId);
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
                }
            }

            const rankEmbed = new EmbedBuilder()
                .setColor(0x2ECC70)
                .setTitle('Кадровый аудит • Изменение ранга')
                .addFields({ name: 'Обновил(-а):', value: `${userPing} | ${userNick} | ||${userId}||` })
                .setTimestamp()
                .setFooter({ text: 'WN Helper by Michael Lindberg. Discord: milkgames', iconURL: 'https://i.imgur.com/zdxWb0s.jpeg' });

            if (!memberNick) {
                rankEmbed.addFields({ name: 'Обновлен(-а):', value: `${member}` });
            } else {
                rankEmbed.addFields({ name: 'Обновлен(-а):', value: `${member} | ${memberNick} | ||${memberId}||` });
            }

            rankEmbed.addFields(
                { name: 'Номер ID карты:', value: `${staticId}`, inline: true },
                { name: 'Действие:', value: `${action}`, inline: true },
                { name: 'Причина:', value: `${reason}` }
            );

            await kachannel.send({ embeds: [rankEmbed] });

            if (kachannel?.id === interaction.channelId) {
                await interaction.editReply({ content: 'Meow!', ephemeral: true });
                await interaction.deleteReply();
            } else {
                await editReply(3, interaction, member, kachannel);
            }
        } catch (error) {
            logger.error(`Произошла ошибка отписи изменения ранга в КА: ${error}`);

            try {
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply({
                        content: `Произошла ошибка изменения ранга в КА: ${error}`,
                        ephemeral: true,
                    });
                } else {
                    await interaction.reply({
                        content: `Произошла ошибка изменения ранга в КА: ${error}`,
                        ephemeral: true,
                    });
                }
            } catch (_) {
                // noop
            }
        }
    },
}
