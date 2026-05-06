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
const { ApplicationCommandOptionType } = require('discord.js');
const config = require('../../../../config.json');

const logger = require('../../../utils/logger');
const {
    deferReplyWithRetry,
    editReplyWithRetry,
} = require('../../../utils/discordRequest');
const { sendExamToChannel } = require('../../../utils/examPresentation');

module.exports = {
    name: 'sendexam',
    description: 'Повторно отправить экзамен в канал экзаменаторов.',
    options: [
        {
            name: 'exam',
            description: 'Тип экзамена.',
            type: ApplicationCommandOptionType.String,
            required: true,
            choices: [
                { name: 'Устав', value: 'Устав' },
                { name: 'ПРО (упрощённый)', value: 'ПРО (упрощённый)' },
                { name: 'ПРО (тестовый)', value: 'ПРО (тестовый)' },
                { name: 'ПРО (письменный)', value: 'ПРО (письменный)' },
            ],
        },
        {
            name: 'url',
            description: 'Ссылка на результат экзамена.',
            type: ApplicationCommandOptionType.String,
            required: true,
        },
        {
            name: 'member_input',
            description: 'Что экзаменуемый ввёл в поле имени.',
            type: ApplicationCommandOptionType.String,
            required: true,
        },
        {
            name: 'correct_answers',
            description: 'Количество правильных ответов для тестовых экзаменов.',
            type: ApplicationCommandOptionType.Integer,
            required: false,
        },
    ],

    callback: async (client, interaction) => {
        try {
            await deferReplyWithRetry(interaction, { ephemeral: true });

            const guildId = interaction.guildId;
            const guild = await client.guilds.fetch(guildId);
            const examinerRoleId = config.servers[guildId].examinerRoleId;
            const examiner = await guild.members.fetch(interaction.user.id);

            if (!examiner.roles.cache.has(examinerRoleId)) {
                await editReplyWithRetry(interaction, {
                    content: 'Команда доступна только экзаменаторам.',
                    ephemeral: true,
                });
                return;
            }

            const rawTestName = interaction.options.getString('exam', true);
            const testUrl = interaction.options.getString('url', true);
            const testMemberInput = interaction.options.getString('member_input', true);
            const correctAnswers = interaction.options.getInteger('correct_answers');

            const sentMeta = await sendExamToChannel(client, {
                guildId,
                rawTestName,
                testUrl,
                testMemberInput,
                correctAnswers,
            });

            await editReplyWithRetry(interaction, {
                content: `Экзамен повторно отправлен в канал экзаменаторов. Сообщение: ${sentMeta.messageLink}`,
                ephemeral: true,
            });
        } catch (error) {
            logger.error('Произошла ошибка при повторной отправке экзамена:', error);
            await editReplyWithRetry(interaction, {
                content: `Произошла ошибка при повторной отправке экзамена: ${error}`,
                ephemeral: true,
            });
        }
    },
};
