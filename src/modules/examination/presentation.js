/*
 * WN Helper Discord Bot
 * Copyright (C) 2026 MilkGames
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
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
} = require('discord.js');
const guildConfigService = require('../../core/config/guildConfigService');
const { sendMessageWithRetry } = require('../../core/discord/request');
const { getDefaultFooter } = require('../../core/ui/defaultFooter');
const { resolveExamMember } = require('./memberResolver');

const EXAM_MEMBER_FIELD_NAME = 'Имя Фамилия | Статик';
const EXAM_CORRECT_ANSWERS_FIELD_NAME = 'Количество правильных ответов';

const EXAM_TITLES = {
    needChoice: 'Новая сдача экзамена! - НУЖЕН ВЫБОР',
    review: 'Новая сдача экзамена! - НА РАССМОТРЕНИИ',
    passed: 'Новая сдача экзамена! - СДАНО',
    failed: 'Новая сдача экзамена! - НЕ СДАНО',
    spam: 'Новая сдача экзамена! - БРАК',
};

const EXAM_COLORS = {
    needChoice: 0xF1C40F,
    review: 0x3498DB,
    passed: 0x00FF00,
    failed: 0xFF0000,
    spam: 0xFF0000,
};

function extractRegValue(regparams) {
    if (!Array.isArray(regparams)) return null;
    const field = regparams.find((item) => item?.name === EXAM_MEMBER_FIELD_NAME);
    const value = field?.value;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function extractCorrectAnswers(results) {
    if (!Array.isArray(results)) return null;
    const field = results.find((item) => item?.name === EXAM_CORRECT_ANSWERS_FIELD_NAME);
    const value = Number(field?.value);
    return Number.isFinite(value) ? value : null;
}

function buildExamCustomId(action, examId) {
    return `exam-${action}:${String(examId || '')}`;
}

function buildCandidatesText(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return '';
    return candidates
        .slice(0, 5)
        .map((member) => `${member} (${member.displayName})`)
        .join('\n');
}

function buildSearchResultText(foundMember, candidates) {
    if (foundMember) return `Возможный кандидат:\n${foundMember} (${foundMember.displayName})`;

    const candidatesText = buildCandidatesText(candidates);
    if (candidatesText) return `Кандидаты:\n${candidatesText}`;

    return 'Пользователь не найден автоматически. Используйте кнопки ниже.';
}

function formatExamResult({ exam, score, forcePassed = null }) {
    if (!Number.isFinite(score)) return 'Экзамен необходимо проверить.';

    const passed = typeof forcePassed === 'boolean'
        ? forcePassed
        : score >= exam.passScore;
    return `${score} / ${exam.maxScore} - ${passed ? 'СДАНО ✅' : 'НЕ СДАНО ❌'}`;
}

function buildExamResultValue({ exam, correctAnswers }) {
    if (exam.checkMode === 'manualScore') return 'Экзамен необходимо проверить.';
    if (
        !Number.isSafeInteger(correctAnswers) ||
        correctAnswers < 0 ||
        correctAnswers > exam.maxScore
    ) {
        return 'Экзамен необходимо проверить.';
    }
    return formatExamResult({ exam, score: correctAnswers });
}

function buildSelectionButtonsRow(exam, { chooseDisabled = false } = {}) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(buildExamCustomId('choose-candidate', exam.id))
            .setLabel('Выбрать кандидата')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(chooseDisabled === true),
        new ButtonBuilder()
            .setCustomId(buildExamCustomId('set-member-id', exam.id))
            .setLabel('Вставить Discord ID')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(buildExamCustomId('spam', exam.id))
            .setLabel('Брак')
            .setStyle(ButtonStyle.Danger),
    );
}

function buildReviewButtonsRow(exam) {
    const changeMember = new ButtonBuilder()
        .setCustomId(buildExamCustomId('change-member', exam.id))
        .setLabel('Изменить сотрудника')
        .setStyle(ButtonStyle.Secondary);

    if (exam.checkMode === 'manualScore') {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(buildExamCustomId('check', exam.id))
                .setLabel('Проверить')
                .setStyle(ButtonStyle.Primary),
            changeMember,
            new ButtonBuilder()
                .setCustomId(buildExamCustomId('spam', exam.id))
                .setLabel('Брак')
                .setStyle(ButtonStyle.Danger),
        );
    }

    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(buildExamCustomId('confirm', exam.id))
            .setLabel('Сдано')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(buildExamCustomId('decline', exam.id))
            .setLabel('Не сдано')
            .setStyle(ButtonStyle.Danger),
        changeMember,
        new ButtonBuilder()
            .setCustomId(buildExamCustomId('spam', exam.id))
            .setLabel('Брак')
            .setStyle(ButtonStyle.Danger),
    );
}

function upsertField(embed, name, value, inline = false) {
    const rawFields = Array.isArray(embed.data?.fields) ? embed.data.fields : [];
    const fields = rawFields
        .filter(Boolean)
        .map((field) => ({
            name: String(field.name ?? '').slice(0, 256) || '-',
            value: String(field.value ?? '').slice(0, 1024) || '-',
            inline: field.inline === true,
        }));

    const index = fields.findIndex((field) => field.name === name);
    const next = {
        name: String(name).slice(0, 256) || '-',
        value: String(value ?? '').slice(0, 1024) || '-',
        inline: inline === true,
    };

    if (index === -1) fields.push(next);
    else fields[index] = next;

    while (fields.length > 25) fields.pop();
    embed.setFields(fields);
}

function removeField(embed, fieldName) {
    const fields = (Array.isArray(embed.data?.fields) ? embed.data.fields : [])
        .filter((field) => field?.name !== fieldName)
        .map((field) => ({
            name: String(field.name ?? '').slice(0, 256) || '-',
            value: String(field.value ?? '').slice(0, 1024) || '-',
            inline: field.inline === true,
        }));
    embed.setFields(fields);
    return embed;
}

function getFieldValue(embedLike, fieldName, fallback = '-') {
    const fields = Array.isArray(embedLike?.fields) ? embedLike.fields : [];
    const field = fields.find((item) => item?.name === fieldName);
    return field?.value ?? fallback;
}

async function buildExamMessagePayload(client, {
    guildId,
    exam,
    testUrl = '-',
    testMemberInput = '-',
    correctAnswers = null,
} = {}) {
    if (!exam?.id || !exam?.name) {
        throw new Error(`Для guildId=${guildId} не передана корректная конфигурация экзамена`);
    }

    const guild = await client.guilds.fetch(guildId);
    const resolved = await resolveExamMember(guild, testMemberInput);
    const foundMember = resolved?.member || null;
    const candidates = Array.isArray(resolved?.candidates) ? resolved.candidates : [];

    const examEmbed = new EmbedBuilder()
        .setColor(EXAM_COLORS.needChoice)
        .setTitle(EXAM_TITLES.needChoice)
        .addFields(
            { name: 'Название экзамена:', value: exam.name },
            { name: 'Ссылка на результат:', value: String(testUrl || '-') },
            { name: 'Пользователь ввёл:', value: String(testMemberInput || '-') },
            { name: 'Результат поиска пользователя:', value: buildSearchResultText(foundMember, candidates) },
            { name: 'Результат экзамена:', value: buildExamResultValue({ exam, correctAnswers }) },
            { name: 'Ссылка на быструю проверку экзамена:', value: exam.quickCheckUrl || 'Не указана.' },
        )
        .setTimestamp()
        .setFooter(getDefaultFooter());

    const serverConfig = guildConfigService.get(guildId);
    if (!serverConfig) throw new Error(`Не настроен сервер guildId=${guildId}`);

    const examinerRoleId = serverConfig.commonRoles?.examinerRoleId;
    if (!examinerRoleId) throw new Error(`Для guildId=${guildId} не настроена роль экзаменатора`);

    return {
        content: `<@&${examinerRoleId}>`,
        embeds: [examEmbed],
        components: [buildSelectionButtonsRow(exam)],
        allowedMentions: { parse: [], roles: [examinerRoleId] },
        meta: {
            examId: exam.id,
            foundMemberId: foundMember ? foundMember.id : null,
        },
    };
}

async function sendExamToChannel(client, payload, { nonceSeed = null } = {}) {
    const { guildId, exam } = payload;
    const serverConfig = guildConfigService.get(guildId);
    if (!serverConfig) throw new Error(`Не настроен сервер guildId=${guildId}`);

    const examChannelId = serverConfig.channels?.examChannelId;
    if (!examChannelId) throw new Error(`Для guildId=${guildId} не настроен основной канал экзаменов`);

    const examChannel = await client.channels.fetch(examChannelId);
    const messagePayload = await buildExamMessagePayload(client, payload);
    const sent = await sendMessageWithRetry(examChannel, {
        content: messagePayload.content,
        embeds: messagePayload.embeds,
        components: messagePayload.components,
        allowedMentions: messagePayload.allowedMentions,
    }, {
        nonceSeed: nonceSeed || `examPresentation:${guildId}:${exam.id}:${Date.now()}:${Math.random()}`,
    });

    return {
        sentChannelId: sent.channelId,
        sentMessageId: sent.id,
        messageLink: `https://discord.com/channels/${guildId}/${sent.channelId}/${sent.id}`,
        foundMemberId: messagePayload.meta?.foundMemberId || null,
        examId: exam.id,
    };
}

module.exports = {
    EXAM_COLORS,
    EXAM_CORRECT_ANSWERS_FIELD_NAME,
    EXAM_MEMBER_FIELD_NAME,
    EXAM_TITLES,
    buildExamCustomId,
    buildExamMessagePayload,
    buildReviewButtonsRow,
    buildSearchResultText,
    buildSelectionButtonsRow,
    extractCorrectAnswers,
    extractRegValue,
    formatExamResult,
    getFieldValue,
    removeField,
    sendExamToChannel,
    upsertField,
};
