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
            content = `Вы указали пользователя, которого хотите уволить, не пингом.
Укажите переменную "static" для того, чтобы команда сработала.
Если вы используете контекстную команду, то бот не смог считать ID дискорда из сообщения.
Проверьте сообщение, которое вы используете для увольнения сотрудника.
-# Сообщение удалится через 30 секунд.`;
            break;
        case 2:
            content = `Невозможно определить статик.
Укажите переменную "static" для того, чтобы команда сработала.
Если вы используете контекстную команду, то бот не смог считать статик из никнейма сотрудника.
-# Сообщение удалится через 30 секунд.`
            break;
        case 3:
            content = `Отпись кадрового аудита на увольнение ${member} успешно создана в канале ${kachannel}!
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

module.exports = {
    name: 'uval',
    description: 'Уволить человека из фракции.',
    //devOnly: Boolean
    //testOnly: Boolean
    options: [
        {
            name: 'member',
            description: 'Тег в дискорде или никнейм игрока, которого увольняют из фракции.',
            required: true,
            type: ApplicationCommandOptionType.String,
        },
        {
            name: 'reason',
            description: 'Причина, по которой человека увольняют.',
            required: true,
            type: ApplicationCommandOptionType.String,
        },
        {
            name: 'static',
            description: 'Статик игрока, которого увольняют из фракции.',
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

                    const citizenRoleId = config.servers[guildId].citizenRoleId;
                    const rolesToRemove = member.roles.cache.filter(role =>
                        role.id !== citizenRoleId && role.id !== guildId
                    );

                    await member.roles.remove(rolesToRemove);

                    if (!member.roles.cache.has(citizenRoleId)) {
                        await member.roles.add(citizenRoleId);
                    }

                    const newNickname = memberNick.replace(/^[^|]*\s*\|\s*/, '');
                    try {
                        await member.setNickname(newNickname);
                    } catch (error) {
                        logger.error('Ошибка при изменении ника: ', error);
                    }
                } else {
                    staticId = interaction.options.getString('static') ?? null;
                    if (!staticId) {
                        await editReply(2, interaction, member, kachannel);
                        return;
                    }
                }
            }

            const reason = interaction.options.getString('reason', true);

            const uvalEmbed = new EmbedBuilder()
                .setColor(0xFF2C2C)
                .setTitle('Кадровый аудит • Увольнение')
                .addFields(
                    { name: 'Уволил(-а):', value: `${userPing} | ${userNick} | ||${userId}||` },
                )
                .setTimestamp()
                .setFooter({ text: 'WN Helper by Michael Lindberg. Discord: milkgames', iconURL: 'https://i.imgur.com/zdxWb0s.jpeg' });

            if (!memberNick) {
                uvalEmbed.addFields({ name: 'Уволен(-а):', value: `${member}` });
            } else {
                uvalEmbed.addFields({ name: 'Уволен(-а):', value: `${member} | ${memberNick} | ||${memberId}||` });
            }

            uvalEmbed.addFields(
                { name: 'Номер ID карты:', value: `${staticId}` },
                { name: 'Причина:', value: `${reason}` },
            );

            await kachannel.send({ embeds: [uvalEmbed] });

            if (kachannel?.id === interaction.channelId) {
                await interaction.editReply({ content: 'Meow!', ephemeral: true });
                await interaction.deleteReply();
            } else {
                await editReply(3, interaction, member, kachannel);
            }
        } catch (error) {
            logger.info(`Произошла ошибка при увольнении в КА: ${error}`);

            try {
                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply({
                        content: `Произошла ошибка при увольнении в КА: ${error}`,
                        ephemeral: true,
                    });
                } else {
                    await interaction.reply({
                        content: `Произошла ошибка при увольнении в КА: ${error}`,
                        ephemeral: true,
                    });
                }
            } catch (_) {
                // noop
            }
        }
    },
}
