/*
 * WN Helper Discord Bot
 * Copyright (C) 2025 MilkGames
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
const { ModalBuilder, EmbedBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const config = require('../../../config.json');

async function editReply(type, interaction) {
    let content;
    switch(type) {
        case 1:
            content = `Экзамен отписан в итогах экзамена.
Результат экзамена: Сдано.
-# Сообщение удалится через 30 секунд.`;
            break;
        case 2:
            content = `Экзамен отписан в итогах экзамена.
Результат экзамена: Не сдано.
-# Сообщение удалится через 30 секунд.`;
            break;
        case 3:
            content = `Экзамен помечен как брак.
-# Сообщение удалится через 30 секунд.`;
            break;
        case 4:
            content = `Вы не являетесь экзаменатором.
-# Сообщение удалится через 30 секунд.`;
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

module.exports = async (client, interaction) => {
    if (!interaction.isButton()) return;
    if (!(interaction.customId === 'exam-confirm' ||
        interaction.customId === 'exam-decline' ||
        interaction.customId === 'exam-spam')) return;
    if (interaction.isModalSubmit()) {
        console.log(interaction);
        return;
    }
    try {

        const guildId = interaction.guildId;
        const guild = await client.guilds.fetch(guildId);
        const examResultChannelId = config.servers[guildId].examResultChannelId;
        const examResultChannel = await client.channels.fetch(examResultChannelId);
        const examinerRoleId = config.servers[guildId].examinerRoleId;
        const message = interaction.message;
        const memberId = interaction.user.id;
        const member = await guild.members.fetch(memberId);
        const examEmbed = new EmbedBuilder(message.embeds[0]);

        const testName = message.embeds[0].fields[0].value;
        const examineePing = message.embeds[0].fields[3].value;
        let result = message.embeds[0].fields[4].value;
        const channelId = message.channelId;
        const messageId = message.id;
        const messageLink = `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
        let modalInteraction;

        if (testName !== "ПРО и ППО (письменный)" || interaction.customId === 'exam-spam') await interaction.deferReply({ ephemeral: true });

        if (!member.roles.cache.has(examinerRoleId)) {
            editReply(4, interaction);
            return;
        }

        if (interaction.customId === 'exam-confirm' ||
            interaction.customId === 'exam-decline') {
            if (testName === "ПРО и ППО (письменный)") {
                const modal = new ModalBuilder()
                    .setTitle('Проверка ПРО и ППО (письменный):')
                    .setCustomId(`exam-${memberId}`);

                const textInput = new TextInputBuilder()
                    .setCustomId('exam-result')
                    .setLabel('Введите результат экзамена:')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setPlaceholder('10')
                    .setMinLength(1)
                    .setMaxLength(2);

                const actionRow = new ActionRowBuilder().addComponents(textInput);
                modal.addComponents(actionRow);
                await interaction.showModal(modal);
                const filter = (i) => i.customId === `exam-${memberId}`;
                modalInteraction = await interaction.awaitModalSubmit({filter, time: 1000 * 60 * 3});
                await modalInteraction.deferReply({ ephemeral: true });

                const preResult = modalInteraction.fields.getTextInputValue(`exam-result`);
                if (preResult > 7) result = `${preResult} / 10 - СДАНО ✅`;
                else result = `${preResult} / 10 - НЕ СДАНО ❌`;
            }
            const examResults = `Экзаменатор: ${member}
Экзаменуемый: ${examineePing}
Ссылка на сдачу экзамена: ${messageLink}
Тип экзамена: ${testName}
Результат: ${result}`;
            examResultChannel.send(examResults);
        }

        if (interaction.customId === 'exam-confirm') {
            examEmbed.setTitle("Новая сдача экзамена! - СДАНО");
            examEmbed.setColor(0x00FF00)
            if (testName === "ПРО и ППО (письменный)") editReply(1, modalInteraction);
            else editReply(1, interaction);
        }

        if (interaction.customId === 'exam-decline') {
            examEmbed.setTitle("Новая сдача экзамена! - НЕ СДАНО");
            examEmbed.setColor(0xFF0000);
            if (testName === "ПРО и ППО (письменный)") editReply(2, modalInteraction);
            else editReply(2, interaction);
        }

        if (interaction.customId === 'exam-spam') {
            examEmbed.setTitle("Новая сдача экзамена! - БРАК");
            examEmbed.setColor(0xFF0000);
            editReply(3, interaction);
        }

        await message.edit({
            content: "",
            embeds: [examEmbed], 
            components: []
        });
    } catch (error) {
        console.log(`Произошла ошибка при нажатии на кнопку, связанную с итогами экзамена: ${error}.`);
        if (!interaction.replied){
            await interaction.editReply({
                content: `Произошла ошибка при нажатии на кнопку, связанную с итогами экзамена: ${error}`,
                ephemeral: true,
            });
        }
    }
}