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
const { ModalBuilder, EmbedBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const config = require('../../../config.json');

const {
    deferReplyWithRetry,
    deleteReplyWithRetry,
    editMessageWithRetry,
    editReplyWithRetry,
    followUpWithRetry,
    replyWithRetry,
    sendMessageWithRetry,
    showModalWithRetry,
} = require('../../utils/discordRequest');
const logger = require('../../utils/logger');
const { extractDiscordId } = require('../../utils/resolveExamMember');
const {
    EXAM_TITLES,
    EXAM_COLORS,
    buildSelectionButtonsRow,
    buildReviewButtonsRow,
    upsertField,
    getFieldValue,
} = require('../../utils/examPresentation');

async function sendTemporaryReply(interaction, content) {
    if (interaction.deferred || interaction.replied) {
        await editReplyWithRetry(interaction, { content });
    } else {
        await replyWithRetry(interaction, { content, ephemeral: true });
    }

    setTimeout(async () => {
        try {
            await deleteReplyWithRetry(interaction);
        } catch (error) {
            logger.info(`Не удалось удалить ответ: ${error}`);
        }
    }, 30_000);
}

async function editReply(type, interaction) {
    let content;
    switch (type) {
        case 1:
            content = `Экзамен отписан в итогах экзамена.\nРезультат экзамена: Сдано.\n-# Сообщение удалится через 30 секунд.`;
            break;
        case 2:
            content = `Экзамен отписан в итогах экзамена.\nРезультат экзамена: Не сдано.\n-# Сообщение удалится через 30 секунд.`;
            break;
        case 3:
            content = `Экзамен помечен как брак.\n-# Сообщение удалится через 30 секунд.`;
            break;
        case 4:
            content = `Вы не являетесь экзаменатором.\n-# Сообщение удалится через 30 секунд.`;
            break;
        default:
            content = `Готово.\n-# Сообщение удалится через 30 секунд.`;
            break;
    }

    await sendTemporaryReply(interaction, content);
}

async function getExaminerData(client, interaction) {
    const guildId = interaction.guildId;
    const guild = await client.guilds.fetch(guildId);
    const examinerRoleId = config.servers[guildId].examinerRoleId;
    const examiner = await guild.members.fetch(interaction.user.id);

    return {
        guild,
        examiner,
        examinerRoleId,
        hasAccess: examiner.roles.cache.has(examinerRoleId),
    };
}


function hasExaminerAccessFromInteraction(interaction) {
    const examinerRoleId = config.servers[interaction.guildId]?.examinerRoleId;
    if (!examinerRoleId) return false;

    const roles = interaction.member?.roles;
    if (roles?.cache && typeof roles.cache.has === 'function') {
        return roles.cache.has(examinerRoleId);
    }

    if (Array.isArray(roles)) {
        return roles.includes(examinerRoleId);
    }

    return false;
}

async function replyNoExaminerAccess(interaction) {
    await replyWithRetry(interaction, {
        content: `Вы не являетесь экзаменатором.
-# Сообщение удалится через 30 секунд.`,
        ephemeral: true,
    });

    setTimeout(async () => {
        try {
            await deleteReplyWithRetry(interaction);
        } catch (error) {
            logger.info(`Не удалось удалить ответ: ${error}`);
        }
    }, 30_000);
}

function parseCandidateItems(searchResultValue) {
    const txt = String(searchResultValue || '');
    const lines = txt.split('\n').map((l) => l.trim()).filter(Boolean);

    let candidateLines = lines;
    const idx = lines.findIndex((line) => line.toLowerCase().startsWith('кандидаты'));
    if (idx !== -1) candidateLines = lines.slice(idx + 1);

    const items = [];
    const seen = new Set();

    for (const line of candidateLines) {
        const match = line.match(/<@!?(\d{17,20})>/);
        if (!match) continue;

        const id = match[1];
        if (seen.has(id)) continue;
        seen.add(id);

        const displayName = (line.match(/\(([^)]+)\)\s*$/) || [])[1] || id;
        items.push({ id, displayName });
    }

    if (items.length === 0) {
        const reId = /<@!?(\d{17,20})>/g;
        let match;
        while ((match = reId.exec(txt))) {
            const id = match[1];
            if (seen.has(id)) continue;
            seen.add(id);
            items.push({ id, displayName: id });
            if (items.length >= 10) break;
        }
    }

    return items;
}

async function moveExamToReview(message, chosenMember) {
    const examEmbed = new EmbedBuilder(message.embeds[0]);
    examEmbed.setTitle(EXAM_TITLES.review);
    examEmbed.setColor(EXAM_COLORS.review);
    upsertField(examEmbed, 'Результат поиска пользователя:', `${chosenMember} (${chosenMember.displayName})`, false);

    await editMessageWithRetry(message, {
        embeds: [examEmbed],
        components: [buildReviewButtonsRow()],
    });
}

module.exports = async (client, interaction) => {
    const isExamAction = interaction.isButton() && ['exam-confirm', 'exam-decline', 'exam-spam'].includes(interaction.customId);
    const isChooseButton = interaction.isButton() && interaction.customId === 'exam-choose-candidate';
    const isSetMemberIdButton = interaction.isButton() && interaction.customId === 'exam-set-member-id';
    const isCandidateSelect = interaction.isStringSelectMenu() && interaction.customId === 'exam-candidate-select';

    if (!isExamAction && !isChooseButton && !isSetMemberIdButton && !isCandidateSelect) return;

    let modalInteraction;
    let usedModal = false;

    try {
        if (isChooseButton) {
            await deferReplyWithRetry(interaction, { ephemeral: true });

            const { hasAccess } = await getExaminerData(client, interaction);
            if (!hasAccess) {
                await editReply(4, interaction);
                return;
            }

            const message = interaction.message;
            const title = String(message.embeds?.[0]?.title || '');
            if (!title.includes('НУЖЕН ВЫБОР')) {
                await sendTemporaryReply(interaction, 'Выбор кандидата больше не требуется.');
                return;
            }

            const alreadyOpen = Array.isArray(message.components) && message.components.some((row) =>
                Array.isArray(row.components) && row.components.some((component) => component.customId === 'exam-candidate-select')
            );
            if (alreadyOpen) {
                await sendTemporaryReply(interaction, 'Меню выбора кандидата уже открыто.');
                return;
            }

            const searchResultValue = getFieldValue(message.embeds?.[0], 'Результат поиска пользователя:', '');
            const candidates = parseCandidateItems(searchResultValue);

            if (!candidates.length) {
                await sendTemporaryReply(interaction, 'Не удалось извлечь кандидатов. Используйте кнопку для вставки Discord ID.');
                return;
            }

            const options = candidates.slice(0, 25).map((candidate) => ({
                label: String(candidate.displayName || candidate.id).slice(0, 100) || candidate.id,
                value: candidate.id,
            }));

            const select = new StringSelectMenuBuilder()
                .setCustomId('exam-candidate-select')
                .setPlaceholder('Выберите кандидата')
                .addOptions(options);

            const selectRow = new ActionRowBuilder().addComponents(select);
            const buttonsRow = buildSelectionButtonsRow({ chooseDisabled: true });

            await editMessageWithRetry(message, { components: [buttonsRow, selectRow] });
            await sendTemporaryReply(interaction, 'Выберите кандидата из списка под сообщением.');
            return;
        }

        if (isSetMemberIdButton) {
            if (!hasExaminerAccessFromInteraction(interaction)) {
                await replyNoExaminerAccess(interaction);
                return;
            }

            const message = interaction.message;
            const title = String(message.embeds?.[0]?.title || '');
            if (!title.includes('НУЖЕН ВЫБОР')) {
                await sendTemporaryReply(interaction, 'Выбор сдающего больше не требуется.');
                return;
            }

            const modalId = `exam-set-member-id-${interaction.user.id}`;
            const modal = new ModalBuilder()
                .setTitle('Укажите Discord ID сдающего')
                .setCustomId(modalId);

            const textInput = new TextInputBuilder()
                .setCustomId('exam-member-id')
                .setLabel('Discord ID или @пинг')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setPlaceholder('123456789012345678');

            modal.addComponents(new ActionRowBuilder().addComponents(textInput));
            await showModalWithRetry(interaction, modal);
            usedModal = true;

            try {
                modalInteraction = await interaction.awaitModalSubmit({
                    filter: (i) => i.customId === modalId && i.user.id === interaction.user.id,
                    time: 1000 * 60 * 3,
                });
            } catch (error) {
                if (error?.name === 'InteractionCollectorError') {
                    await followUpWithRetry(interaction, {
                        content: 'Время на ввод Discord ID истекло (3 минуты). Нажми кнопку ещё раз.',
                        ephemeral: true,
                    });
                    return;
                }
                throw error;
            }

            await deferReplyWithRetry(modalInteraction, { ephemeral: true });

            const rawId = modalInteraction.fields.getTextInputValue('exam-member-id');
            const memberId = extractDiscordId(rawId);
            if (!memberId) {
                await sendTemporaryReply(modalInteraction, 'Не удалось извлечь Discord ID. Введите ID или @пинг.');
                return;
            }

            const { guild, hasAccess } = await getExaminerData(client, modalInteraction);
            if (!hasAccess) {
                await editReply(4, modalInteraction);
                return;
            }

            const chosenMember = await guild.members.fetch(memberId).catch(() => null);
            if (!chosenMember) {
                await sendTemporaryReply(modalInteraction, 'Не удалось найти участника по указанному Discord ID.');
                return;
            }

            await moveExamToReview(message, chosenMember);
            await sendTemporaryReply(modalInteraction, `Указан сдающий: ${chosenMember} (${chosenMember.displayName}).`);
            return;
        }

        if (isCandidateSelect) {
            await deferReplyWithRetry(interaction, { ephemeral: true });

            const { guild, hasAccess } = await getExaminerData(client, interaction);
            if (!hasAccess) {
                await editReply(4, interaction);
                return;
            }

            const message = interaction.message;
            const title = String(message.embeds?.[0]?.title || '');
            if (!title.includes('НУЖЕН ВЫБОР')) {
                await sendTemporaryReply(interaction, 'Выбор сдающего больше не требуется.');
                return;
            }

            const selectedId = interaction.values?.[0] || null;
            if (!selectedId) {
                await sendTemporaryReply(interaction, 'Не выбран кандидат.');
                return;
            }

            const chosenMember = await guild.members.fetch(selectedId).catch(() => null);
            if (!chosenMember) {
                await sendTemporaryReply(interaction, 'Не удалось получить выбранного участника. Возможно, он уже покинул сервер.');
                return;
            }

            await moveExamToReview(message, chosenMember);
            await sendTemporaryReply(interaction, `Выбран кандидат: ${chosenMember} (${chosenMember.displayName}).`);
            return;
        }

        const message = interaction.message;
        const title = String(message.embeds?.[0]?.title || '');
        if (title.includes('НУЖЕН ВЫБОР') && interaction.customId !== 'exam-spam') {
            await sendTemporaryReply(interaction, 'Сначала выберите сдающего экзамен.');
            return;
        }

        const testName = getFieldValue(message.embeds?.[0], 'Название экзамена:');
        const needsResultModal =
            (interaction.customId === 'exam-confirm' || interaction.customId === 'exam-decline') &&
            testName === 'ПРО (письменный)';

        if (!needsResultModal || interaction.customId === 'exam-spam') {
            await deferReplyWithRetry(interaction, { ephemeral: true });
        } else if (!hasExaminerAccessFromInteraction(interaction)) {
            await replyNoExaminerAccess(interaction);
            return;
        }

        const examEmbed = new EmbedBuilder(message.embeds[0]);
        const examineeInfo = getFieldValue(message.embeds?.[0], 'Результат поиска пользователя:');
        let result = getFieldValue(message.embeds?.[0], 'Результат экзамена:');

        const channelId = message.channelId;
        const messageId = message.id;
        const messageLink = `https://discord.com/channels/${interaction.guildId}/${channelId}/${messageId}`;

        if (needsResultModal) {
            const modalId = `exam-result-${interaction.user.id}`;
            const modal = new ModalBuilder()
                .setTitle('Проверка ПРО (письменный)')
                .setCustomId(modalId);

            const textInput = new TextInputBuilder()
                .setCustomId('exam-result')
                .setLabel('Введите результат экзамена (0-10)')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setPlaceholder('10')
                .setMinLength(1)
                .setMaxLength(2);

            modal.addComponents(new ActionRowBuilder().addComponents(textInput));
            await showModalWithRetry(interaction, modal);
            usedModal = true;

            try {
                modalInteraction = await interaction.awaitModalSubmit({
                    filter: (i) => i.customId === modalId && i.user.id === interaction.user.id,
                    time: 1000 * 60 * 3,
                });
            } catch (error) {
                if (error?.name === 'InteractionCollectorError') {
                    await followUpWithRetry(interaction, {
                        content: 'Время на ввод результата истекло (3 минуты). Нажми кнопку ещё раз.',
                        ephemeral: true,
                    });
                    return;
                }
                throw error;
            }

            await deferReplyWithRetry(modalInteraction, { ephemeral: true });

            const raw = modalInteraction.fields.getTextInputValue('exam-result');
            const parsed = Number(String(raw).replace(',', '.'));
            const clamped = Number.isFinite(parsed) ? Math.max(0, Math.min(10, Math.floor(parsed))) : 0;

            if (clamped > 7) result = `${clamped} / 10 - СДАНО ✅`;
            else result = `${clamped} / 10 - НЕ СДАНО ❌`;
        }

        const responseInteraction = modalInteraction || interaction;
        const { examiner, hasAccess } = await getExaminerData(client, responseInteraction);
        if (!hasAccess) {
            await editReply(4, responseInteraction);
            return;
        }

        const examResultChannelId = config.servers[interaction.guildId].examResultChannelId;
        const examResultChannel = await client.channels.fetch(examResultChannelId);

        if (interaction.customId === 'exam-confirm' || interaction.customId === 'exam-decline') {
            const examResults =
                `Экзаменатор: ${examiner} (${examiner.displayName})\n` +
                `Экзаменуемый: ${examineeInfo}\n` +
                `Ссылка на сдачу экзамена: ${messageLink}\n` +
                `Тип экзамена: ${testName}\n` +
                `Результат: ${result}`;

            await sendMessageWithRetry(examResultChannel, { content: examResults }, {
                nonceSeed: `examResult:${interaction.guildId}:${message.id}:${interaction.customId}`,
            });
        }

        const checkedBy = `${examiner} (${examiner.displayName})`;
        upsertField(examEmbed, 'Проверил:', checkedBy, false);

        if (interaction.customId === 'exam-confirm') {
            examEmbed.setTitle(EXAM_TITLES.passed);
            examEmbed.setColor(EXAM_COLORS.passed);
            upsertField(examEmbed, 'Результат экзамена:', result, false);

            if (testName === 'ПРО (письменный)' && modalInteraction) await editReply(1, modalInteraction);
            else await editReply(1, interaction);
        }

        if (interaction.customId === 'exam-decline') {
            examEmbed.setTitle(EXAM_TITLES.failed);
            examEmbed.setColor(EXAM_COLORS.failed);
            upsertField(examEmbed, 'Результат экзамена:', result, false);

            if (testName === 'ПРО (письменный)' && modalInteraction) await editReply(2, modalInteraction);
            else await editReply(2, interaction);
        }

        if (interaction.customId === 'exam-spam') {
            examEmbed.setTitle(EXAM_TITLES.spam);
            examEmbed.setColor(EXAM_COLORS.spam);
            await editReply(3, interaction);
        }

        await editMessageWithRetry(message, {
            content: '',
            embeds: [examEmbed],
            components: [],
        });
    } catch (error) {
        logger.error('Произошла ошибка при нажатии на кнопку, связанную с экзаменами:', error);
        if (error.rawError) logger.error('Дополнительная информация по предыдущей ошибке:', error.rawError);

        const errText = `Произошла ошибка при нажатии на кнопку: ${error}`;

        try {
            if (modalInteraction && (modalInteraction.deferred || modalInteraction.replied)) {
                await editReplyWithRetry(modalInteraction, { content: errText });
            } else if (usedModal) {
                await followUpWithRetry(interaction, { content: errText, ephemeral: true });
            } else if (interaction.deferred || interaction.replied) {
                await editReplyWithRetry(interaction, { content: errText });
            } else {
                await replyWithRetry(interaction, { content: errText, ephemeral: true });
            }
        } catch (_) {
            // игнорируем вторую ошибку ответа
        }
    }
};
