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
const {
    deferReplyWithRetry,
    deleteReplyWithRetry,
    editReplyWithRetry,
    replyWithRetry,
    runDiscordRequest,
    sendMessageWithRetry,
} = require('../../../utils/discordRequest');

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

    await editReplyWithRetry(interaction, {
        content: content,
        ephemeral: true, 
    });

    setTimeout(async () => {
        try {
            await deleteReplyWithRetry(interaction);
        } catch (error) {
            logger.info(`Не удалось удалить ответ: ${error}`);
        }
    }, 30000);
    return;
}

function getRankRoleIds(serverCfg) {
    return [
        null,
        serverCfg.firstRankRoleId,
        serverCfg.secondRankRoleId,
        serverCfg.thirdRankRoleId,
        serverCfg.fourthRankRoleId,
        serverCfg.fifthRankRoleId,
        serverCfg.sixthRankRoleId,
        serverCfg.seventhRankRoleId,
        serverCfg.eighthRankRoleId,
    ];
}

function getUniqueConfiguredRankRoleIds(serverCfg) {
    return [...new Set(getRankRoleIds(serverCfg).filter((roleId) => typeof roleId === 'string' && roleId.trim()))];
}

async function syncRankRoles(member, serverCfg, newRank) {
    const rankRoleIds = getRankRoleIds(serverCfg);
    const nextRoleId = rankRoleIds[newRank] || null;

    for (const roleId of getUniqueConfiguredRankRoleIds(serverCfg)) {
        if (!member.roles.cache.has(roleId)) continue;

        try {
            await runDiscordRequest(() => member.roles.remove(roleId));
        } catch (error) {
            logger.error(`Не удалось снять роль ранга ${roleId} у пользователя ${member.id}: ${error}`);
        }
    }

    if (!nextRoleId) {
        logger.warn(`Для ранга ${newRank} не настроена роль в config.json.`);
        return;
    }

    const newRole = member.guild.roles.cache.get(nextRoleId);
    if (!newRole) {
        logger.warn(`Роль ранга ${newRank} (${nextRoleId}) не найдена на сервере ${member.guild.id}.`);
        return;
    }

    await runDiscordRequest(() => member.roles.add(newRole));
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
            await deferReplyWithRetry(interaction, { ephemeral: true });

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
                await editReplyWithRetry(interaction, {
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

            // автосмена ролей/ника — только если member реально GuildMember (т.е. был пинг)
            // перед выдачей новой роли ранга снимаем все роли рангов, чтобы убрать накопившиеся дубли
            if (isGuildMember) {
                const serverCfg = config.servers[guildId];
                await syncRankRoles(member, serverCfg, rank);

                if (rank >= 2) {
                    const tdRole = member.guild.roles.cache.get(serverCfg.traineeRoleId);
                    if (tdRole && member.roles.cache.has(tdRole.id)) {
                        await runDiscordRequest(() => member.roles.remove(tdRole));
                    }
                }

                if (member.nickname && isPromotion && rank === 2) {
                    let prefix = "";
                    if (member.roles.cache.has(serverCfg.RDDRoleId)) prefix = "RDD";
                    if (member.roles.cache.has(serverCfg.AMDRoleId)) prefix = "AMD";
                    if (member.roles.cache.has(serverCfg.EDRoleId)) prefix = "ED";
                    if (member.roles.cache.has(serverCfg.JDRoleId)) prefix = "JD";

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
                        await runDiscordRequest(() => member.setNickname(`${newNickName}`));
                    } catch (error) {
                        logger.info(`Ошибка при изменении ника: ${error}`);
                    }
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

            await sendMessageWithRetry(kachannel, { embeds: [rankEmbed] }, {
                nonceSeed: `kaRank:${guildId}:${userId}:${memberId}:${staticId}:${action}`,
            });

            if (kachannel?.id === interaction.channelId) {
                await editReplyWithRetry(interaction, { content: 'Meow!', ephemeral: true });
                await deleteReplyWithRetry(interaction);
            } else {
                await editReply(3, interaction, member, kachannel);
            }
        } catch (error) {
            logger.error(`Произошла ошибка отписи изменения ранга в КА: ${error}`);

            try {
                if (interaction.deferred || interaction.replied) {
                    await editReplyWithRetry(interaction, {
                        content: `Произошла ошибка изменения ранга в КА: ${error}`,
                        ephemeral: true,
                    });
                } else {
                    await replyWithRetry(interaction, {
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
