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
const crypto = require('crypto');
const {
    ActionRowBuilder,
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require('discord.js');
const { findExamById } = require('../settings/examsSchema');
const guildConfigService = require('../../../core/config/guildConfigService');
const examAttemptService = require('../attempts');
const { invokeAction } = require('../../../core/integrations/actionRegistry');
const examinationService = require('../service');
const ExaminationError = require('../error');

const {
    deferReplyWithRetry,
    editMessageWithRetry,
    editReplyWithRetry,
    followUpWithRetry,
    replyWithRetry,
    sendMessageWithRetry,
    showModalWithRetry,
} = require('../../../core/discord/request');
const {
    EXAM_COLORS,
    EXAM_TITLES,
    buildExamCustomId,
    buildReviewButtonsRow,
    buildSearchResultText,
    buildSelectionButtonsRow,
    formatExamResult,
    getFieldValue,
    removeField,
    upsertField,
} = require('../presentation');
const logger = require('../../../core/logging/logger');
const { buildPublicErrorMessage } = require('../../../core/ui/errorMessage');
const { extractDiscordId, resolveExamMember } = require('../memberResolver');

const messageLocks = new Map();

function formatResultMember(memberId, displayName) {
    const normalizedId = String(memberId || '').trim();
    if (!normalizedId) return String(displayName || '-').slice(0, 300);
    return `<@${normalizedId}> | ${String(displayName || normalizedId).slice(0, 200)} | ||${normalizedId}||`;
}

function extractExamDisplayName(value, memberId) {
    const text = String(value || '');
    const normalizedId = String(memberId || '').trim();
    if (normalizedId) {
        const match = text.match(new RegExp(`<@!?${normalizedId}>\\s*\\(([^)]+)\\)`));
        if (match?.[1]) return match[1].trim();
    }
    const fallback = text.match(/\(([^)]+)\)\s*$/m);
    return fallback?.[1]?.trim() || normalizedId || '-';
}

function parseExamAction(customId) {
    const match = String(customId || '').match(
        /^exam-(confirm|decline|check|spam|choose-candidate|set-member-id|candidate-select|change-member):(.+)$/
    );
    if (!match) return null;
    return { action: match[1], examId: match[2] };
}

function withMessageLock(messageId, callback) {
    const key = String(messageId || '');
    const previous = messageLocks.get(key) || Promise.resolve();
    const task = previous.then(callback, callback);
    let tracked;
    tracked = task.finally(() => {
        if (messageLocks.get(key) === tracked) messageLocks.delete(key);
    });
    messageLocks.set(key, tracked);
    return tracked;
}

function shortMessageToken(messageId) {
    return crypto.createHash('sha1').update(String(messageId || '')).digest('hex').slice(0, 8);
}

function getSelectedExamineeId(message) {
    return extractDiscordId(getFieldValue(message?.embeds?.[0], 'Результат поиска пользователя:', ''));
}

function assertExpectedExaminee(message, expectedExamineeId) {
    if (!expectedExamineeId) return;
    const currentExamineeId = getSelectedExamineeId(message);
    if (String(currentExamineeId || '') !== String(expectedExamineeId)) {
        throw new Error('Сотрудник в сообщении экзамена изменился во время заполнения формы. Повторите действие.');
    }
}

async function sendTemporaryReply(interaction, content) {
    const payload = {
        content,
        allowedMentions: { parse: [] },
    };

    if (interaction.deferred || interaction.replied) {
        await editReplyWithRetry(interaction, payload);
    } else {
        await replyWithRetry(interaction, {
            ...payload,
            flags: MessageFlags.Ephemeral,
        });
    }
}

async function sendResultReply(interaction, passed) {
    const resultText = passed ? 'Сдано' : 'Не сдано';
    await sendTemporaryReply(
        interaction,
        `Экзамен отписан в итогах экзамена.\nРезультат экзамена: ${resultText}.\n-# Сообщение удалится через 30 секунд.`
    );
}

async function getExaminerData(client, interaction) {
    const guildId = interaction.guildId;
    const guild = await client.guilds.fetch(guildId);
    const serverConfig = guildConfigService.get(guildId);
    if (!serverConfig) throw new Error(`Не настроен сервер guildId=${guildId}`);

    const examinerRoleId = serverConfig.commonRoles?.examinerRoleId;
    if (!examinerRoleId) throw new Error(`Для guildId=${guildId} не настроена роль экзаменатора`);

    const examiner = await guild.members.fetch(interaction.user.id);
    return {
        examiner,
        guild,
        hasAccess: examiner.roles.cache.has(examinerRoleId),
        serverConfig,
    };
}

function hasExaminerAccessFromInteraction(interaction) {
    const examinerRoleId = guildConfigService.get(interaction.guildId)?.commonRoles?.examinerRoleId;
    if (!examinerRoleId) return false;

    const roles = interaction.member?.roles;
    if (roles?.cache?.has) return roles.cache.has(examinerRoleId);
    if (Array.isArray(roles)) return roles.includes(examinerRoleId);
    return false;
}

function resolveExam(serverConfig, examId) {
    const exam = findExamById(serverConfig, examId);
    if (exam) return exam;
    throw new Error(`Не удалось определить экзамен: examId=${examId || '-'}`);
}

function parseCandidateItems(searchResultValue) {
    const text = String(searchResultValue || '');
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    const headerIndex = lines.findIndex((line) => line.toLocaleLowerCase('ru').startsWith('кандидаты'));
    const candidateLines = headerIndex === -1 ? lines : lines.slice(headerIndex + 1);
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

    if (!items.length) {
        const mentionPattern = /<@!?(\d{17,20})>/g;
        let match;
        while ((match = mentionPattern.exec(text))) {
            const id = match[1];
            if (seen.has(id)) continue;
            seen.add(id);
            items.push({ id, displayName: id });
            if (items.length >= 10) break;
        }
    }

    return items;
}

async function moveExamToReview(message, chosenMember, exam) {
    examinationService.assertRegularExamAttemptAvailable(
        message.guildId,
        chosenMember.id,
        exam
    );

    const examEmbed = new EmbedBuilder(message.embeds[0]);
    examEmbed.setTitle(EXAM_TITLES.review);
    examEmbed.setColor(EXAM_COLORS.review);
    removeField(examEmbed, 'Проверил:');
    removeField(examEmbed, 'Причина результата:');
    removeField(examEmbed, 'Тип попытки:');
    removeField(examEmbed, 'Заявка на пересдачу:');
    upsertField(
        examEmbed,
        'Результат поиска пользователя:',
        `${chosenMember} (${chosenMember.displayName})`,
        false
    );

    const attempt = examAttemptService.getAttemptDisplay(message.guildId, chosenMember.id, exam);
    if (attempt.unlimited) {
        removeField(examEmbed, 'Попытка:');
    } else {
        upsertField(examEmbed, 'Попытка:', attempt.text, false);
    }

    await editMessageWithRetry(message, {
        embeds: [examEmbed],
        components: [buildReviewButtonsRow(exam)],
        allowedMentions: { parse: [] },
    });
}

async function resetExamMember(message, guild, exam) {
    const examEmbed = new EmbedBuilder(message.embeds[0]);
    const input = getFieldValue(message.embeds?.[0], 'Пользователь ввёл:', '-');
    const resolved = await resolveExamMember(guild, input);
    examEmbed.setTitle(EXAM_TITLES.needChoice);
    examEmbed.setColor(EXAM_COLORS.needChoice);
    upsertField(
        examEmbed,
        'Результат поиска пользователя:',
        buildSearchResultText(resolved?.member || null, resolved?.candidates || []),
        false
    );
    removeField(examEmbed, 'Попытка:');
    removeField(examEmbed, 'Проверил:');
    removeField(examEmbed, 'Причина результата:');
    removeField(examEmbed, 'Тип попытки:');
    removeField(examEmbed, 'Заявка на пересдачу:');

    await editMessageWithRetry(message, {
        embeds: [examEmbed],
        components: [buildSelectionButtonsRow(exam)],
        allowedMentions: { parse: [] },
    });
}

function extractScoreFromResult(resultText) {
    const match = String(resultText || '').match(/^\s*(-?\d+(?:[.,]\d+)?)\s*\//);
    if (!match) return null;
    const number = Number(match[1].replace(',', '.'));
    return Number.isFinite(number) ? number : null;
}

async function awaitTextModal(interaction, modal, modalId) {
    await showModalWithRetry(interaction, modal);
    try {
        return await interaction.awaitModalSubmit({
            filter: (candidate) => candidate.customId === modalId && candidate.user.id === interaction.user.id,
            time: 1000 * 60 * 3,
        });
    } catch (error) {
        if (error?.name === 'InteractionCollectorError') {
            await followUpWithRetry(interaction, {
                content: 'Время на ввод истекло (3 минуты). Нажми кнопку ещё раз.',
                flags: MessageFlags.Ephemeral,
                allowedMentions: { parse: [] },
            });
            return null;
        }
        throw error;
    }
}

function buildFailureReasonModal(interaction, exam, messageId) {
    const modalId = `exam-failure-reason:${interaction.user.id}:${shortMessageToken(messageId)}:${exam.id}`.slice(0, 100);
    const modal = new ModalBuilder()
        .setTitle('Причина результата "НЕ СДАНО"')
        .setCustomId(modalId)
        .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('failure-reason')
                .setLabel('Почему экзамен не сдан при достаточных баллах')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMinLength(3)
                .setMaxLength(1000)
        ));
    return { modal, modalId };
}

function isFinalTitle(title) {
    return [EXAM_TITLES.passed, EXAM_TITLES.failed, EXAM_TITLES.spam].includes(String(title || ''));
}

async function processFinalAction(client, interaction, parsedAction, exam, precomputed = {}) {
    return withMessageLock(interaction.message.id, async () => {
        const message = await interaction.message.fetch?.().catch(() => interaction.message) || interaction.message;
        const title = String(message.embeds?.[0]?.title || '');
        if (isFinalTitle(title)) {
            await sendTemporaryReply(precomputed.modalInteraction || interaction, 'Этот экзамен уже обработан.');
            return;
        }
        if (title.includes('НУЖЕН ВЫБОР') && parsedAction.action !== 'spam') {
            await sendTemporaryReply(precomputed.modalInteraction || interaction, 'Сначала выберите сдающего экзамен.');
            return;
        }
        try {
            assertExpectedExaminee(message, precomputed.expectedExamineeId);
        } catch (error) {
            await sendTemporaryReply(precomputed.modalInteraction || interaction, error.message);
            return;
        }

        const responseInteraction = precomputed.modalInteraction || interaction;
        if (!responseInteraction.deferred && !responseInteraction.replied) {
            await deferReplyWithRetry(responseInteraction, { flags: MessageFlags.Ephemeral });
        }

        const { examiner, hasAccess, serverConfig: latestConfig } = await getExaminerData(client, responseInteraction);
        if (!hasAccess) {
            await sendTemporaryReply(responseInteraction, 'Вы не являетесь экзаменатором.');
            return;
        }

        let passed = parsedAction.action === 'confirm';
        let result = getFieldValue(message.embeds?.[0], 'Результат экзамена:');
        if (parsedAction.action === 'check') {
            passed = precomputed.passed;
            result = precomputed.result;
        } else if (parsedAction.action === 'confirm' || parsedAction.action === 'decline') {
            passed = parsedAction.action === 'confirm';
            const score = extractScoreFromResult(result);
            result = Number.isFinite(score)
                ? formatExamResult({ exam, score, forcePassed: passed })
                : (passed ? 'СДАНО ✅' : 'НЕ СДАНО ❌');
        }

        const examEmbed = new EmbedBuilder(message.embeds[0]);
        upsertField(examEmbed, 'Проверил:', `${examiner} (${examiner.displayName})`, false);

        if (parsedAction.action === 'spam') {
            examEmbed.setTitle(EXAM_TITLES.spam);
            examEmbed.setColor(EXAM_COLORS.spam);
            removeField(examEmbed, 'Причина результата:');
            removeField(examEmbed, 'Попытка:');
            removeField(examEmbed, 'Тип попытки:');
            removeField(examEmbed, 'Заявка на пересдачу:');
            await sendTemporaryReply(responseInteraction, 'Экзамен помечен как брак. Попытка сотруднику не засчитана.');
        } else {
            const examResultChannelId = latestConfig.channels?.examResultChannelId;
            if (!examResultChannelId) {
                throw new Error(`Для guildId=${interaction.guildId} не настроен канал результатов экзаменов`);
            }

            const examResultChannel = await client.channels.fetch(examResultChannelId);
            const examineeInfo = getFieldValue(message.embeds?.[0], 'Результат поиска пользователя:');
            const examineeId = extractDiscordId(examineeInfo);
            const examinee = examineeId
                ? await examiner.guild.members.fetch(examineeId).catch(() => null)
                : null;
            const messageLink = `https://discord.com/channels/${interaction.guildId}/${message.channelId}/${message.id}`;
            const failureReason = String(precomputed.failureReason || '').trim();
            const examResults = [
                `Экзаменатор: ${formatResultMember(examiner.id, examiner.displayName)}`,
                `Экзаменуемый: ${examineeId
                    ? formatResultMember(
                        examineeId,
                        examinee?.displayName || extractExamDisplayName(examineeInfo, examineeId)
                    )
                    : examineeInfo}`,
                `Ссылка на сдачу экзамена: ${messageLink}`,
                `Тип экзамена: ${exam.name}`,
                `Результат: ${result}`,
                ...(!passed && failureReason ? [`Причина: ${failureReason}`] : []),
            ].join('\n');

            await sendMessageWithRetry(examResultChannel, {
                content: examResults,
                allowedMentions: { parse: [] },
            }, {
                nonceSeed: `examResult:${interaction.guildId}:${message.id}:${passed ? 'passed' : 'failed'}`,
            });

            if (examineeId) {
                if (passed) {
                    await examAttemptService.clearAfterPass({
                        guildId: interaction.guildId,
                        memberId: examineeId,
                        examId: exam.id,
                    });
                } else {
                    await examAttemptService.recordFailedAttempt({
                            guildId: interaction.guildId,
                            memberId: examineeId,
                            examId: exam.id,
                            messageId: message.id,
                            maxAttempts: exam.maxAttempts,
                    });
                }

                try {
                    await invokeAction('discipline.recordRecertificationExamResult', client, {
                        guild: examiner.guild,
                        memberId: examineeId,
                        examId: exam.id,
                        passed,
                        examinerId: examiner.id,
                        sourceMessageId: message.id,
                        messageLink,
                    });
                } catch (error) {
                    logger.warn('Не удалось обновить переаттестацию по результату экзамена', {
                        guildId: interaction.guildId,
                        memberId: examineeId,
                        examId: exam.id,
                        messageId: message.id,
                    }, error);
                }

            } else {
                logger.warn('Не удалось определить сотрудника для учёта попытки экзамена', {
                    guildId: interaction.guildId,
                    examId: exam.id,
                    messageId: message.id,
                    examineeInfo,
                });
            }

            examEmbed.setTitle(passed ? EXAM_TITLES.passed : EXAM_TITLES.failed);
            examEmbed.setColor(passed ? EXAM_COLORS.passed : EXAM_COLORS.failed);
            upsertField(examEmbed, 'Результат экзамена:', result, false);
            if (!passed && failureReason) {
                upsertField(examEmbed, 'Причина результата:', failureReason, false);
            } else {
                removeField(examEmbed, 'Причина результата:');
            }
            await sendResultReply(responseInteraction, passed);
        }

        await editMessageWithRetry(message, {
            content: '',
            embeds: [examEmbed],
            components: [],
            allowedMentions: { parse: [] },
        });
    });
}

module.exports = async (client, interaction) => {
    if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;

    const parsedAction = parseExamAction(interaction.customId);
    if (!parsedAction) return;

    let modalInteraction = null;
    let usedModal = false;

    try {
        const message = interaction.message;
        const serverConfig = guildConfigService.get(interaction.guildId);
        if (!serverConfig) throw new Error(`Не настроен сервер guildId=${interaction.guildId}`);
        const exam = resolveExam(serverConfig, parsedAction.examId);

        if (parsedAction.action === 'choose-candidate') {
            await deferReplyWithRetry(interaction, { flags: MessageFlags.Ephemeral });
            const { hasAccess } = await getExaminerData(client, interaction);
            if (!hasAccess) {
                await sendTemporaryReply(interaction, 'Вы не являетесь экзаменатором.');
                return;
            }
            if (!String(message.embeds?.[0]?.title || '').includes('НУЖЕН ВЫБОР')) {
                await sendTemporaryReply(interaction, 'Выбор кандидата больше не требуется.');
                return;
            }

            const alreadyOpen = message.components?.some((row) =>
                row.components?.some((component) => String(component.customId || '').startsWith('exam-candidate-select'))
            );
            if (alreadyOpen) {
                await sendTemporaryReply(interaction, 'Меню выбора кандидата уже открыто.');
                return;
            }

            const candidates = parseCandidateItems(
                getFieldValue(message.embeds?.[0], 'Результат поиска пользователя:', '')
            );
            if (!candidates.length) {
                await sendTemporaryReply(interaction, 'Не удалось извлечь кандидатов. Используйте кнопку для вставки Discord ID.');
                return;
            }

            const select = new StringSelectMenuBuilder()
                .setCustomId(buildExamCustomId('candidate-select', exam.id))
                .setPlaceholder('Выберите кандидата')
                .addOptions(candidates.slice(0, 25).map((candidate) => ({
                    label: String(candidate.displayName || candidate.id).slice(0, 100),
                    value: candidate.id,
                })));

            await editMessageWithRetry(message, {
                components: [
                    buildSelectionButtonsRow(exam, { chooseDisabled: true }),
                    new ActionRowBuilder().addComponents(select),
                ],
            });
            await sendTemporaryReply(interaction, 'Выберите кандидата из списка под сообщением.');
            return;
        }

        if (parsedAction.action === 'set-member-id') {
            if (!hasExaminerAccessFromInteraction(interaction)) {
                await sendTemporaryReply(interaction, 'Вы не являетесь экзаменатором.');
                return;
            }
            if (!String(message.embeds?.[0]?.title || '').includes('НУЖЕН ВЫБОР')) {
                await sendTemporaryReply(interaction, 'Выбор сдающего больше не требуется.');
                return;
            }

            const modalId = `exam-set-member:${interaction.user.id}:${shortMessageToken(message.id)}:${exam.id}`.slice(0, 100);
            const modal = new ModalBuilder()
                .setTitle('Укажите Discord ID сдающего')
                .setCustomId(modalId)
                .addComponents(new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('exam-member-id')
                        .setLabel('Discord ID или @пинг')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                        .setPlaceholder('123456789012345678')
                ));

            usedModal = true;
            modalInteraction = await awaitTextModal(interaction, modal, modalId);
            if (!modalInteraction) return;
            await deferReplyWithRetry(modalInteraction, { flags: MessageFlags.Ephemeral });

            const memberId = extractDiscordId(modalInteraction.fields.getTextInputValue('exam-member-id'));
            if (!memberId) {
                await sendTemporaryReply(modalInteraction, 'Не удалось извлечь Discord ID. Введите ID или @пинг.');
                return;
            }

            const { guild, hasAccess } = await getExaminerData(client, modalInteraction);
            if (!hasAccess) {
                await sendTemporaryReply(modalInteraction, 'Вы не являетесь экзаменатором.');
                return;
            }
            const chosenMember = await guild.members.fetch(memberId).catch(() => null);
            if (!chosenMember) {
                await sendTemporaryReply(modalInteraction, 'Не удалось найти участника по указанному Discord ID.');
                return;
            }

            await withMessageLock(message.id, async () => {
                const fresh = await message.fetch?.().catch(() => message) || message;
                if (!String(fresh.embeds?.[0]?.title || '').includes('НУЖЕН ВЫБОР')) {
                    await sendTemporaryReply(modalInteraction, 'Сдающий уже выбран другим экзаменатором. Обновите сообщение.');
                    return;
                }
                await moveExamToReview(fresh, chosenMember, exam);
                await sendTemporaryReply(modalInteraction, `Указан сдающий: ${chosenMember} (${chosenMember.displayName}).`);
            });
            return;
        }

        if (parsedAction.action === 'candidate-select') {
            await deferReplyWithRetry(interaction, { flags: MessageFlags.Ephemeral });
            const { guild, hasAccess } = await getExaminerData(client, interaction);
            if (!hasAccess) {
                await sendTemporaryReply(interaction, 'Вы не являетесь экзаменатором.');
                return;
            }
            if (!String(message.embeds?.[0]?.title || '').includes('НУЖЕН ВЫБОР')) {
                await sendTemporaryReply(interaction, 'Выбор сдающего больше не требуется.');
                return;
            }

            const selectedId = interaction.values?.[0] || null;
            const chosenMember = selectedId ? await guild.members.fetch(selectedId).catch(() => null) : null;
            if (!chosenMember) {
                await sendTemporaryReply(interaction, 'Не удалось получить выбранного участника. Возможно, он уже покинул сервер.');
                return;
            }

            await withMessageLock(message.id, async () => {
                const fresh = await message.fetch?.().catch(() => message) || message;
                if (!String(fresh.embeds?.[0]?.title || '').includes('НУЖЕН ВЫБОР')) {
                    await sendTemporaryReply(interaction, 'Сдающий уже выбран другим экзаменатором. Обновите сообщение.');
                    return;
                }
                await moveExamToReview(fresh, chosenMember, exam);
                await sendTemporaryReply(interaction, `Выбран кандидат: ${chosenMember} (${chosenMember.displayName}).`);
            });
            return;
        }

        if (parsedAction.action === 'change-member') {
            await deferReplyWithRetry(interaction, { flags: MessageFlags.Ephemeral });
            const { guild, hasAccess } = await getExaminerData(client, interaction);
            if (!hasAccess) {
                await sendTemporaryReply(interaction, 'Вы не являетесь экзаменатором.');
                return;
            }
            await withMessageLock(message.id, async () => {
                const fresh = await message.fetch?.().catch(() => message) || message;
                if (isFinalTitle(fresh.embeds?.[0]?.title)) {
                    await sendTemporaryReply(interaction, 'Завершённый экзамен изменить нельзя.');
                    return;
                }
                await resetExamMember(fresh, guild, exam);
                await sendTemporaryReply(interaction, 'Сообщение возвращено к выбору сотрудника.');
            });
            return;
        }

        if (parsedAction.action === 'check') {
            if (!hasExaminerAccessFromInteraction(interaction)) {
                await sendTemporaryReply(interaction, 'Вы не являетесь экзаменатором.');
                return;
            }
            const expectedExamineeId = getSelectedExamineeId(message);
            const modalId = `exam-result:${interaction.user.id}:${shortMessageToken(message.id)}:${exam.id}`.slice(0, 100);
            const modal = new ModalBuilder()
                .setTitle(`Проверка: ${exam.name}`.slice(0, 45))
                .setCustomId(modalId)
                .addComponents(new ActionRowBuilder().addComponents(
                    new TextInputBuilder()
                        .setCustomId('exam-result')
                        .setLabel(`Введите результат (0-${exam.maxScore})`.slice(0, 45))
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                        .setPlaceholder(String(exam.maxScore))
                        .setMaxLength(Math.max(String(exam.maxScore).length, 1))
                ));

            usedModal = true;
            modalInteraction = await awaitTextModal(interaction, modal, modalId);
            if (!modalInteraction) return;
            await deferReplyWithRetry(modalInteraction, { flags: MessageFlags.Ephemeral });
            const rawScore = modalInteraction.fields.getTextInputValue('exam-result').trim();
            const score = Number(rawScore);
            if (!Number.isSafeInteger(score) || score < 0 || score > exam.maxScore) {
                await sendTemporaryReply(modalInteraction, `Результат должен быть целым числом от 0 до ${exam.maxScore}.`);
                return;
            }
            const passed = score >= exam.passScore;
            await processFinalAction(client, interaction, parsedAction, exam, {
                modalInteraction,
                expectedExamineeId,
                passed,
                result: formatExamResult({ exam, score, forcePassed: passed }),
            });
            return;
        }

        if (parsedAction.action === 'decline') {
            const score = extractScoreFromResult(getFieldValue(message.embeds?.[0], 'Результат экзамена:'));
            if (Number.isFinite(score) && score >= exam.passScore) {
                if (!hasExaminerAccessFromInteraction(interaction)) {
                    await sendTemporaryReply(interaction, 'Вы не являетесь экзаменатором.');
                    return;
                }
                const expectedExamineeId = getSelectedExamineeId(message);
                const { modal, modalId } = buildFailureReasonModal(interaction, exam, message.id);
                usedModal = true;
                modalInteraction = await awaitTextModal(interaction, modal, modalId);
                if (!modalInteraction) return;
                await deferReplyWithRetry(modalInteraction, { flags: MessageFlags.Ephemeral });
                const failureReason = modalInteraction.fields.getTextInputValue('failure-reason').trim();
                await processFinalAction(client, interaction, parsedAction, exam, {
                    modalInteraction,
                    expectedExamineeId,
                    failureReason,
                });
                return;
            }
        }

        await processFinalAction(client, interaction, parsedAction, exam);
    } catch (error) {
        logger[error instanceof ExaminationError ? 'warn' : 'error']('Ошибка обработки действия экзамена', {
            guildId: interaction.guildId,
            userId: interaction.user?.id,
            customId: interaction.customId,
        }, error);

        const payload = {
            content: buildPublicErrorMessage(error, 'Произошла ошибка при обработке экзамена. Ошибка записана в лог.'),
            allowedMentions: { parse: [] },
        };

        try {
            if (modalInteraction && (modalInteraction.deferred || modalInteraction.replied)) {
                await editReplyWithRetry(modalInteraction, payload);
            } else if (usedModal) {
                await followUpWithRetry(interaction, { ...payload, flags: MessageFlags.Ephemeral });
            } else if (interaction.deferred || interaction.replied) {
                await editReplyWithRetry(interaction, payload);
            } else {
                await replyWithRetry(interaction, { ...payload, flags: MessageFlags.Ephemeral });
            }
        } catch {
            // ошибка уже записана выше; повторный ответ мог протухнуть
        }
    }
};
