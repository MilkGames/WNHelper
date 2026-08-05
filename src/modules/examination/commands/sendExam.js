/*
 * WN Helper Discord Bot
 * Copyright (C) 2025-2026 MilkGames
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
const {
    ApplicationCommandOptionType,
    MessageFlags,
} = require('discord.js');
const { findExamById, getExams } = require('../settings/examsSchema');
const guildConfigService = require('../../../core/config/guildConfigService');

const logger = require('../../../core/logging/logger');
const { buildPublicErrorMessage } = require('../../../core/ui/errorMessage');
const {
    deferReplyWithRetry,
    editReplyWithRetry,
} = require('../../../core/discord/request');
const { sendExamToChannel } = require('../presentation');

function buildReply(content) {
    return {
        content,
        allowedMentions: { parse: [] },
    };
}

module.exports = {
    name: 'sendexam',
    description: 'Повторно отправить экзамен в канал экзаменаторов.',
    options: [
        {
            name: 'exam',
            description: 'Экзамен из настроек этого сервера.',
            type: ApplicationCommandOptionType.String,
            required: true,
            autocomplete: true,
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
            description: 'Количество правильных ответов для автоматического экзамена.',
            type: ApplicationCommandOptionType.Integer,
            required: false,
        },
    ],

    autocomplete: async (_client, interaction) => {
        try {
            const serverConfig = guildConfigService.get(interaction.guildId);
            const exams = serverConfig ? getExams(serverConfig) : [];
            const focused = String(interaction.options.getFocused() || '').toLocaleLowerCase('ru');
            const choices = exams
                .filter((exam) => (
                    exam.name.toLocaleLowerCase('ru').includes(focused) ||
                    exam.testId.toLocaleLowerCase('ru').includes(focused)
                ))
                .slice(0, 25)
                .map((exam) => ({
                    name: exam.name.slice(0, 100),
                    value: exam.id.slice(0, 100),
                }));

            await interaction.respond(choices);
        } catch (error) {
            logger.error('Не удалось сформировать автодополнение для команды отправки экзамена', {
                guildId: interaction.guildId,
                userId: interaction.user?.id,
            }, error);
            await interaction.respond([]).catch(() => undefined);
        }
    },

    callback: async (client, interaction) => {
        await deferReplyWithRetry(interaction, {
            flags: MessageFlags.Ephemeral,
        });

        try {
            const guildId = interaction.guildId;
            const serverConfig = guildConfigService.get(guildId);
            if (!serverConfig) {
                await editReplyWithRetry(interaction, buildReply('Для этого сервера нет настроек.'));
                return;
            }

            if (serverConfig.features?.exams === false) {
                await editReplyWithRetry(interaction, buildReply('Функция экзаменов отключена в настройках сервера.'));
                return;
            }

            const examinerRoleId = serverConfig.commonRoles?.examinerRoleId;
            if (!examinerRoleId) {
                throw new Error(`Для guildId=${guildId} не настроена роль экзаменатора`);
            }
            if (!serverConfig.channels?.examChannelId) {
                throw new Error(`Для guildId=${guildId} не настроен основной канал экзаменов`);
            }

            const guild = await client.guilds.fetch(guildId);
            const examiner = await guild.members.fetch(interaction.user.id);
            if (!examiner.roles.cache.has(examinerRoleId)) {
                await editReplyWithRetry(interaction, buildReply('Команда доступна только экзаменаторам.'));
                return;
            }

            const examId = interaction.options.getString('exam', true);
            const exam = findExamById(serverConfig, examId);
            if (!exam) {
                await editReplyWithRetry(interaction, buildReply(
                    'Выбранный экзамен больше не существует в настройках сервера. Выбери его заново из подсказки.'
                ));
                return;
            }

            const testUrl = interaction.options.getString('url', true);
            const testMemberInput = interaction.options.getString('member_input', true);
            const correctAnswers = interaction.options.getInteger('correct_answers');

            const sentMeta = await sendExamToChannel(client, {
                guildId,
                exam,
                testUrl,
                testMemberInput,
                correctAnswers,
            }, {
                nonceSeed: `manualExam:${interaction.id}`,
            });

            await editReplyWithRetry(interaction, buildReply(
                `Экзамен повторно отправлен в канал экзаменаторов. Сообщение: ${sentMeta.messageLink}`
            ));
        } catch (error) {
            logger.error('Произошла ошибка при повторной отправке экзамена', {
                guildId: interaction.guildId,
                userId: interaction.user.id,
            }, error);
            await editReplyWithRetry(interaction, buildReply(
                buildPublicErrorMessage(error, 'Произошла ошибка при повторной отправке экзамена. Ошибка записана в лог.')
            ));
        }
    },
};
