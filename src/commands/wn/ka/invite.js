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
const { Client, Interaction, ApplicationCommandOptionType, PermissionFlagsBits, EmbedBuilder } = require('discord.js');

module.exports = {
    name: 'invite',
    description: 'Принять игрока во фракцию.',
    //devOnly: Boolean
    //testOnly: Boolean
    deletedBoston: true,
    options: [
        {
            name: 'member',
            description: 'Игрок, которого приняли во фракцию.',
            required: true,
            type: ApplicationCommandOptionType.String,
        },
        {
            name: 'static',
            description: 'Статик игрока, которого приняли во фракцию.',
            type: ApplicationCommandOptionType.String,
        },
        {
            name: 'rank',
            description: 'Ранг, на который принимают игрока.',
            type: ApplicationCommandOptionType.String,
        },
        {
            name: 'reason',
            description: 'Причина, по которой человека приняли.',
            type: ApplicationCommandOptionType.String,
        }
    ],
    permissionsRequired: [],
    botPermissions: [PermissionFlagsBits.ManageRoles],

    callback: async (client, interaction) => {
        const guildId = interaction.guildId;
        const guild = await client.guilds.fetch(guildId);
        const userId = interaction.user.id;
        const userPing = await guild.members.fetch(userId);
        const userNick = userPing.displayName;
        const testmember = interaction.options.getString('member');
        const memberId = testmember.replace(/[<@!>]/g, '');
        let memberNick;
        let member;
        if (testmember === memberId) {
            member = testmember;
            static = interaction.options.get('static')?.value || 'Null';
            memberNick = 'Null';
            if (static === 'Null') {
                await interaction.reply({
                    content: `Вы указали пользователя на которого хотите отписать инвайт не пингом.
Укажите переменную "static" для того, чтобы команда сработала.`,
                    ephemeral: true,
                });
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
                    await interaction.reply({
                        content: `Невозможно определить статик.
Укажите переменную "static" для того, чтобы команда сработала.`,
                        ephemeral: true,
                    });
                    return;
                }
            }
        }
        const rank = `Принят на ${interaction.options.get('rank')?.value || "1"}`;
        const reason = interaction.options.get('reason')?.value || "Собеседование";
        const kachannel = await client.channels.fetch(config.servers[guildId].kaChannelId);
        const channel = interaction.channel;
        const inviteEmbed = new EmbedBuilder()
            .setColor(0x3498DB)
            .setTitle('Кадровый аудит • Принятие')
            .addFields(
                { name: 'Принял(-а):', value: `${userPing} | ${userNick} | ||${userId}||` },
            )
            .setTimestamp()
            .setFooter({ text: 'WN Helper by Michael Lindberg. Discord: milkgames', iconURL: 'https://i.imgur.com/zdxWb0s.jpeg' });
        if (memberNick === 'Null') {
            inviteEmbed.addFields(
                { name: 'Принят(-а):', value: `${member}` },
            )
        }
        else {
            inviteEmbed.addFields(
                { name: 'Принят(-а):', value: `${member} | ${memberNick} | ||${memberId}||` },
            )
        }
        inviteEmbed.addFields(
            { name: 'Номер ID карты:', value: `${static}`, inline: true },
            { name: 'Действие:', value: `${rank}`, inline: true },
            { name: 'Причина:', value: `${reason}` },
        )
        kachannel.send({ embeds: [inviteEmbed] });
        if (kachannel === channel) {
            await interaction.reply({
                content: 'Meow!',
                ephemeral: true,
            });
            await interaction.deleteReply();
        } else {
            await interaction.reply({
                content: `Отпись кадрового аудита на принятие ${member} успешно создана в канале ${kachannel}!`,
                ephemeral: true,
            });
        }
        return;
    },
}