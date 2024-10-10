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
const config = require('../../../config.json');
const amdShifts = require('../../models/amdShifts');

module.exports = async (client, interaction) => {
    try {
        if (!interaction.isButton()) return;
        if (!(interaction.customId === 'shift-one' ||
            interaction.customId === 'shift-two' ||
            interaction.customId === 'shift-three' ||
            interaction.customId === 'shift-four' ||
            interaction.customId === 'shift-five' ||
            interaction.customId === 'shift-six' ||
            interaction.customId === 'shift-seven' ||
            interaction.customId === 'shift-eight'
        )) return;

        const guildId = interaction.guildId;
        const guild = await client.guilds.fetch(guildId);
        const channel = await client.channels.fetch(config.servers[guildId].amdShiftsChannelId);
        const messageId = interaction.message.id;
        const message = await channel.messages.fetch(messageId);
        const userId = interaction.user.id;
        const userIdMention = await client.users.fetch(userId);
        const member = await guild.members.fetch(userId);

        const query = {
            guildId: guildId,
            messageId: messageId,
        };

        let amdShiftsList = await amdShifts.findOne(query);

        const formattedDate = amdShiftsList.date;

        let currentMember;
        let canDelete;

        const headAMDRoleId = config.servers[guildId].headAMDRoleId;
        const AMDRoleId = config.servers[guildId].AMDRoleId;

        if (member.roles.cache.has(headAMDRoleId)) canDelete = true;
        else canDelete = false;

        switch (interaction.customId) {
            case 'shift-one':
                currentMember = amdShiftsList.firstHour;
                if (currentMember === 'Свободно') {
                    await amdShifts.updateOne(query, { firstHour: userId });
                    break;
                }
                if (currentMember === userId || canDelete) {
                    await amdShifts.updateOne(query, { firstHour: 'Свободно' });
                    break;
                }
                interaction.reply({
                    content: `${userIdMention}, вы не являетесь человеком в смене или <@&${headAMDRoleId}> для того, чтобы убрать его из смены!`,
                    ephemeral: true, 
                });
                return;
            case 'shift-two':
                currentMember = amdShiftsList.secondHour;
                if (currentMember === 'Свободно') {
                    await amdShifts.updateOne(query, { secondHour: userId });
                    break;
                }
                if (currentMember === userId || canDelete) {
                    await amdShifts.updateOne(query, { secondHour: 'Свободно' });
                    break;
                }
                interaction.reply({
                    content: `${userIdMention}, вы не являетесь человеком в смене или <@&${headAMDRoleId}> для того, чтобы убрать его из смены!`,
                    ephemeral: true, 
                });
                return;
            case 'shift-three':
                currentMember = amdShiftsList.thirdHour;
                if (currentMember === 'Свободно') {
                    await amdShifts.updateOne(query, { thirdHour: userId });
                    break;
                }
                if (currentMember === userId || canDelete) {
                    await amdShifts.updateOne(query, { thirdHour: 'Свободно' });
                    break;
                }
                interaction.reply({
                    content: `${userIdMention}, вы не являетесь человеком в смене или <@&${headAMDRoleId}> для того, чтобы убрать его из смены!`,
                    ephemeral: true, 
                });
                return;
            case 'shift-four':
                currentMember = amdShiftsList.fourthHour;
                if (currentMember === 'Свободно') {
                    await amdShifts.updateOne(query, { fourthHour: userId });
                    break;
                }
                if (currentMember === userId || canDelete) {
                    await amdShifts.updateOne(query, { fourthHour: 'Свободно' });
                    break;
                }
                interaction.reply({
                    content: `${userIdMention}, вы не являетесь человеком в смене или <@&${headAMDRoleId}> для того, чтобы убрать его из смены!`,
                    ephemeral: true, 
                });
                return;
            case 'shift-five':
                currentMember = amdShiftsList.fifthHour;
                if (currentMember === 'Свободно') {
                    await amdShifts.updateOne(query, { fifthHour: userId });
                    break;
                }
                if (currentMember === userId || canDelete) {
                    await amdShifts.updateOne(query, { fifthHour: 'Свободно' });
                    break;
                }
                interaction.reply({
                    content: `${userIdMention}, вы не являетесь человеком в смене или <@&${headAMDRoleId}> для того, чтобы убрать его из смены!`,
                    ephemeral: true, 
                });
                return;
            case 'shift-six':
                currentMember = amdShiftsList.sixthHour;
                if (currentMember === 'Свободно') {
                    await amdShifts.updateOne(query, { sixthHour: userId });
                    break;
                }
                if (currentMember === userId || canDelete) {
                    await amdShifts.updateOne(query, { sixthHour: 'Свободно' });
                    break;
                }
                interaction.reply({
                    content: `${userIdMention}, вы не являетесь человеком в смене или <@&${headAMDRoleId}> для того, чтобы убрать его из смены!`,
                    ephemeral: true, 
                });
                return;
            case 'shift-seven':
                currentMember = amdShiftsList.seventhHour;
                if (currentMember === 'Свободно') {
                    await amdShifts.updateOne(query, { seventhHour: userId });
                    break;
                }
                if (currentMember === userId || canDelete) {
                    await amdShifts.updateOne(query, { seventhHour: 'Свободно' });
                    break;
                }
                interaction.reply({
                    content: `${userIdMention}, вы не являетесь человеком в смене или <@&${headAMDRoleId}> для того, чтобы убрать его из смены!`,
                    ephemeral: true, 
                });
                return;
            case 'shift-eight':
                currentMember = amdShiftsList.eighthHour;
                if (currentMember === 'Свободно') {
                    await amdShifts.updateOne(query, { eighthHour: userId });
                    break;
                }
                if (currentMember === userId || canDelete) {
                    await amdShifts.updateOne(query, { eighthHour: 'Свободно' });
                    break;
                }
                interaction.reply({
                    content: `${userIdMention}, вы не являетесь человеком в смене или <@&${headAMDRoleId}> для того, чтобы убрать его из смены!`,
                    ephemeral: true, 
                });
                return;
        }
        amdShiftsList = await amdShifts.findOne(query);

        let firstHour = amdShiftsList.firstHour;
        if (!(firstHour === 'Свободно')) firstHour = await client.users.fetch(firstHour);
        let secondHour = amdShiftsList.secondHour;
        if (!(secondHour === 'Свободно')) secondHour = await client.users.fetch(secondHour);
        let thirdHour = amdShiftsList.thirdHour;
        if (!(thirdHour === 'Свободно')) thirdHour = await client.users.fetch(thirdHour);
        let fourthHour = amdShiftsList.fourthHour;
        if (!(fourthHour === 'Свободно')) fourthHour = await client.users.fetch(fourthHour);
        let fifthHour = amdShiftsList.fifthHour;
        if (!(fifthHour === 'Свободно')) fifthHour = await client.users.fetch(fifthHour);
        let sixthHour = amdShiftsList.sixthHour;
        if (!(sixthHour === 'Свободно')) sixthHour = await client.users.fetch(sixthHour);
        let seventhHour = amdShiftsList.seventhHour;
        if (!(seventhHour === 'Свободно')) seventhHour = await client.users.fetch(seventhHour);
        let eighthHour = amdShiftsList.eighthHour;
        if (!(eighthHour === 'Свободно')) eighthHour = await client.users.fetch(eighthHour);

        const content = `:white_check_mark: Смены на ${formattedDate}:

:one: 14:00 - 14:55: ${firstHour}
:two: 15:00 - 15:55: ${secondHour}
:three: 16:00 - 16:55: ${thirdHour}
:four: 17:00 - 17:55: ${fourthHour}
:five: 18:00 - 18:55: ${fifthHour}
:six: 19:00 - 19:55: ${sixthHour}
:seven: 20:00 - 20:55: ${seventhHour}
:eight: 21:00 - 22:00: ${eighthHour}

**Нажмите на кнопку, соответствующую времени смены, чтобы занять текущее время в холле и для отправления объявлений.**
Пользователи с ролью <@&${headAMDRoleId}> также могут нажать на кнопку, чтобы убрать сотрудника из списка.
<@&${AMDRoleId}>
-# WN Helper by Michael Lindberg. Discord: milkgames`;

        await message.edit({ content: content });
        await interaction.reply({
            content: `Вы успешно зарезервировали/удалили сотрудника для смены!`,
            ephemeral: true,
        });
        return;
    } catch (error) {
        console.log(`Произошла ошибка при нажатии на кнопку, связанную с изменением смен: ${error}`);
        await interaction.reply({
            content: `Произошла ошибка при нажатии на кнопку, связанную с изменениям смен: ${error}`,
            ephemeral: true,
        });
    }
}