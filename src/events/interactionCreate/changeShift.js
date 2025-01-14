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
const { Client, Interaction, IntentsBitField, ActivityType, EmbedBuilder, MessageReaction, ActionRowBuilder, ThreadAutoArchiveDuration } = require('discord.js');
const config = require('../../../config.json');
const amdShifts = require('../../models/amdShifts');

async function editReply(interaction, shiftNumber, currentMember, currentMemberMention, userId, userIdMention, deleted, badRequest) {
    let content;
    if (badRequest) {
        content = `${userIdMention}, вы не являетесь человеком в смене или <@&${headAMDRoleId}> для того, чтобы убрать ${currentMemberMention} смены!
-# Сообщение удалится через 30 секунд.`;
    }
    if (deleted) {
        if (currentMember === userId) {
            content = `${userIdMention}, вы успешно удалили себя со смены №${shiftNumber}!
-# Сообщение удалится через 30 секунд.`;
        }
        else {
            content = `${userIdMention}, вы успешно удалили сотрудника ${currentMemberMention} со смены №${shiftNumber}!
-# Сообщение удалится через 30 секунд.`;
        }
    }
    else {
        content = `${userIdMention}, вы успешно заняли смену №${shiftNumber}!
-# Сообщение удалится через 30 секунд.`;
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

async function threadEdit(message, shiftNumber, formattedDate, currentMember, currentMemberMention, userId, userIdMention, deleted) {
    const existingThread = message.channel.threads.cache.find(thread => thread.name === `Логи ${formattedDate}`);

    let thread;
    if (existingThread) thread = existingThread;
    else {
        thread = await message.startThread({
            name: `Логи ${formattedDate}`,
            autoArchiveDuration: 60,
        });
    }

    if (deleted) {
        if (currentMember === userId) {
            await thread.send(`${userIdMention} удалил себя со смены №${shiftNumber}!`);
        }
        else {
            await thread.send(`${userIdMention} удалил сотрудника ${currentMemberMention} со смены №${shiftNumber}!`);
        }
    }
    else {
        await thread.send(`${userIdMention} занял смену №${shiftNumber}!`);
    }
    return;
}

async function enableButtons(message) {
    const updatedComponents = message.components.map(row => {
        const actionRow = ActionRowBuilder.from(row);
        actionRow.components.forEach(button => button.setDisabled(false));
        return actionRow;
    });

    await message.edit({ components: updatedComponents });
}

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

        await interaction.deferReply({ ephemeral: true });

        const guildId = interaction.guildId;
        const guild = await client.guilds.fetch(guildId);
        const channel = await client.channels.fetch(config.servers[guildId].amdShiftsChannelId);
        const messageId = interaction.message.id;
        const message = await channel.messages.fetch(messageId);
        const userId = interaction.user.id;
        const userIdMention = await client.users.fetch(userId);
        const member = await guild.members.fetch(userId);

        const components = message.components.map(row => {
            const actionRow = ActionRowBuilder.from(row);
            actionRow.components.forEach(button => button.setDisabled(true));
            return actionRow;
        });
        message.edit({ components: components });

        const query = {
            guildId: guildId,
            messageId: messageId,
        };

        let amdShiftsList = await amdShifts.findOne(query);

        const formattedDate = amdShiftsList.date;

        let currentMember;
        let currentMemberMention = '';
        let canDelete;
        let shiftNumber;
        let deleted = false;
        let badRequest = false;

        const headAMDRoleId = config.servers[guildId].headAMDRoleId;
        const AMDRoleId = config.servers[guildId].AMDRoleId;
        const partWorkAMDRoleId = config.servers[guildId].partWorkAMDRoleId;

        if (member.roles.cache.has(headAMDRoleId)) canDelete = true;
        else canDelete = false;

        switch (interaction.customId) {
            case 'shift-one':
                shiftNumber = 1;
                currentMember = amdShiftsList.firstHour;
                if (currentMember === 'Свободно') {
                    await amdShifts.updateOne(query, { firstHour: userId });
                    break;
                }
                currentMemberMention = await client.users.fetch(currentMember);
                if (currentMember === userId || canDelete) {
                    await amdShifts.updateOne(query, { firstHour: 'Свободно' });
                    deleted = true;
                    break;
                }
                badRequest = true;
                editReply(interaction, shiftNumber, currentMember, currentMemberMention, userId, userIdMention, deleted, badRequest);
                enableButtons(message);
                return;
            case 'shift-two':
                shiftNumber = 2;
                currentMember = amdShiftsList.secondHour;
                if (currentMember === 'Свободно') {
                    await amdShifts.updateOne(query, { secondHour: userId });
                    break;
                }
                currentMemberMention = await client.users.fetch(currentMember);
                if (currentMember === userId || canDelete) {
                    await amdShifts.updateOne(query, { secondHour: 'Свободно' });
                    deleted = true;
                    break;
                }
                badRequest = true;
                editReply(interaction, shiftNumber, currentMember, currentMemberMention, userId, userIdMention, deleted, badRequest);
                enableButtons(message);
                return;
            case 'shift-three':
                shiftNumber = 3;
                currentMember = amdShiftsList.thirdHour;
                if (currentMember === 'Свободно') {
                    await amdShifts.updateOne(query, { thirdHour: userId });
                    break;
                }
                currentMemberMention = await client.users.fetch(currentMember);
                if (currentMember === userId || canDelete) {
                    await amdShifts.updateOne(query, { thirdHour: 'Свободно' });
                    deleted = true;
                    break;
                }
                badRequest = true;
                editReply(interaction, shiftNumber, currentMember, currentMemberMention, userId, userIdMention, deleted, badRequest);
                enableButtons(message);
                return;
            case 'shift-four':
                shiftNumber = 4;
                currentMember = amdShiftsList.fourthHour;
                if (currentMember === 'Свободно') {
                    await amdShifts.updateOne(query, { fourthHour: userId });
                    break;
                }
                currentMemberMention = await client.users.fetch(currentMember);
                if (currentMember === userId || canDelete) {
                    await amdShifts.updateOne(query, { fourthHour: 'Свободно' });
                    deleted = true;
                    break;
                }
                badRequest = true;
                editReply(interaction, shiftNumber, currentMember, currentMemberMention, userId, userIdMention, deleted, badRequest);
                enableButtons(message);
                return;
            case 'shift-five':
                shiftNumber = 5;
                currentMember = amdShiftsList.fifthHour;
                if (currentMember === 'Свободно') {
                    await amdShifts.updateOne(query, { fifthHour: userId });
                    break;
                }
                currentMemberMention = await client.users.fetch(currentMember);
                if (currentMember === userId || canDelete) {
                    await amdShifts.updateOne(query, { fifthHour: 'Свободно' });
                    deleted = true;
                    break;
                }
                badRequest = true;
                editReply(interaction, shiftNumber, currentMember, currentMemberMention, userId, userIdMention, deleted, badRequest);
                enableButtons(message);
                return;
            case 'shift-six':
                shiftNumber = 6;
                currentMember = amdShiftsList.sixthHour;
                if (currentMember === 'Свободно') {
                    await amdShifts.updateOne(query, { sixthHour: userId });
                    break;
                }
                currentMemberMention = await client.users.fetch(currentMember);
                if (currentMember === userId || canDelete) {
                    await amdShifts.updateOne(query, { sixthHour: 'Свободно' });
                    deleted = true;
                    break;
                }
                badRequest = true;
                editReply(interaction, shiftNumber, currentMember, currentMemberMention, userId, userIdMention, deleted, badRequest);
                enableButtons(message);
                return;
            case 'shift-seven':
                shiftNumber = 7;
                currentMember = amdShiftsList.seventhHour;
                if (currentMember === 'Свободно') {
                    await amdShifts.updateOne(query, { seventhHour: userId });
                    break;
                }
                currentMemberMention = await client.users.fetch(currentMember);
                if (currentMember === userId || canDelete) {
                    await amdShifts.updateOne(query, { seventhHour: 'Свободно' });
                    deleted = true;
                    break;
                }
                badRequest = true;
                editReply(interaction, shiftNumber, currentMember, currentMemberMention, userId, userIdMention, deleted, badRequest);
                enableButtons(message);
                return;
            case 'shift-eight':
                shiftNumber = 8;
                currentMember = amdShiftsList.eighthHour;
                if (currentMember === 'Свободно') {
                    await amdShifts.updateOne(query, { eighthHour: userId });
                    break;
                }
                currentMemberMention = await client.users.fetch(currentMember);
                if (currentMember === userId || canDelete) {
                    await amdShifts.updateOne(query, { eighthHour: 'Свободно' });
                    deleted = true;
                    break;
                }
                badRequest = true;
                editReply(interaction, shiftNumber, currentMember, currentMemberMention, userId, userIdMention, deleted, badRequest);
                enableButtons(message);
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

        let pingRoles;
        if (partWorkAMDRoleId) pingRoles = `<@&${partWorkAMDRoleId}>
<@&${AMDRoleId}>`;
        else pingRoles = `<@&${AMDRoleId}>`;

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
В очень редких случаях кнопки могут оставаться неактивными после того, как вы на них нажали.
Это визуальный баг, используйте Ctrl+R, чтобы перезапустить Discord и кнопки вновь будут активными.
${pingRoles}
-# WN Helper by Michael Lindberg. Discord: milkgames`;

        const updatedComponents = message.components.map(row => {
            const actionRow = ActionRowBuilder.from(row);
            actionRow.components.forEach(button => button.setDisabled(false));
            return actionRow;
        });

        await message.edit({ content: content });

        threadEdit(message, shiftNumber, formattedDate, currentMember, currentMemberMention, userId, userIdMention, deleted);
        editReply(interaction, shiftNumber, currentMember, currentMemberMention, userId, userIdMention, deleted, badRequest);
        enableButtons(message);
        return;
    } catch (error) {
        console.log(`Произошла ошибка при нажатии на кнопку, связанную с изменением смен: ${error}`);
        if (!interaction.replied){
            await interaction.editReply({
                content: `Произошла ошибка при нажатии на кнопку, связанную с изменениям смен: ${error}`,
                ephemeral: true,
            });
        }
        try {
            const updatedComponents = message.components.map(row => {
                const actionRow = ActionRowBuilder.from(row);
                actionRow.components.forEach(button => button.setDisabled(false));
                return actionRow;
            });
            enableButtons(message);
        } catch (error) {
            console.log(`Произошла ошибка при включении кнопок: ${error}`);
        }
    }
}