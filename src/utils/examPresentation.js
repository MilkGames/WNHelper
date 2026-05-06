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
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const config = require('../../config.json');
const { sendMessageWithRetry } = require('./discordRequest');

const { resolveExamMember } = require('./resolveExamMember');

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

function normalizeTestConfig({ testId, testName }) {
    const byId = {
        '2h5yvxravpgmw': {
            shortName: 'Устав',
            quickLink: 'https://app.onlinetestpad.com/tests/2h5yvxravpgmw/statistics/table',
            maxScore: 15,
            passScore: 12,
            manual: false,
        },
        '2zogqqsz34kpc': {
            shortName: 'ПРО (упрощённый)',
            quickLink: 'https://app.onlinetestpad.com/tests/2zogqqsz34kpc/statistics/table',
            maxScore: 10,
            passScore: 8,
            manual: false,
        },
        '7vchtj53hnzui': {
            shortName: 'ПРО (тестовый)',
            quickLink: 'https://app.onlinetestpad.com/tests/7vchtj53hnzui/statistics/table',
            maxScore: 15,
            passScore: 12,
            manual: false,
        },
        'qi7qrikeg7fxk': {
            shortName: 'ПРО (письменный)',
            quickLink: 'https://app.onlinetestpad.com/tests/qi7qrikeg7fxk/handchecks',
            maxScore: 10,
            passScore: 8,
            manual: true,
        },
    };

    if (byId[testId]) return byId[testId];

    switch (String(testName || '').trim()) {
        case 'Тест на знание устава Weazel News | Dallas':
        case 'Устав':
            return byId['2h5yvxravpgmw'];
        case 'Упрощённый тест на знание ПРО Weazel News | Dallas':
        case 'ПРО (упрощённый)':
            return byId['2zogqqsz34kpc'];
        case 'Тест на знание ПРО Weazel News | Dallas':
        case 'ПРО (тестовый)':
            return byId['7vchtj53hnzui'];
        case 'Письменный тест на знание ПРО Weazel News | Dallas':
        case 'ПРО (письменный)':
            return byId['qi7qrikeg7fxk'];
        default:
            return {
                shortName: 'Неизвестный тест',
                quickLink: '—',
                maxScore: 10,
                passScore: 8,
                manual: true,
            };
    }
}

function extractRegValue(regparams) {
    if (!Array.isArray(regparams)) return null;
    const p = regparams.find((x) => typeof x?.name === 'string' && x.name.toLowerCase().includes('имя'));
    const v = p?.value;
    return (typeof v === 'string' && v.trim().length) ? v.trim() : null;
}

function extractCorrectAnswers(results) {
    if (!Array.isArray(results)) return null;
    const r = results.find((x) => typeof x?.name === 'string' && x.name.toLowerCase().includes('количество правильных'));
    const n = Number(r?.value);
    return Number.isFinite(n) ? n : null;
}

function buildCandidatesText(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return '';
    return candidates
        .slice(0, 5)
        .map((m) => `${m} (${m.displayName})`)
        .join('\n');
}

function buildSearchResultText(foundMember, candidates) {
    if (foundMember) return `Возможный кандидат:\n${foundMember} (${foundMember.displayName})`;

    const candidatesText = buildCandidatesText(candidates);
    if (candidatesText) {
        return `Кандидаты:\n${candidatesText}`;
    }

    return 'Пользователь не найден автоматически. Используйте кнопки ниже.';
}

function buildExamResultValue({ cfg, correctAnswers }) {
    if (cfg.manual || cfg.shortName === 'ПРО (письменный)') {
        return 'Экзамен необходимо проверить.';
    }

    if (!Number.isFinite(correctAnswers)) {
        return 'Экзамен необходимо проверить.';
    }

    const passed = correctAnswers >= cfg.passScore;
    const mark = passed ? 'СДАНО ✅' : 'НЕ СДАНО ❌';
    return `${correctAnswers} / ${cfg.maxScore} - ${mark}`;
}

function buildSelectionButtonsRow({ chooseDisabled = false } = {}) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('exam-choose-candidate')
            .setLabel('Выбрать кандидата')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(chooseDisabled === true),
        new ButtonBuilder()
            .setCustomId('exam-set-member-id')
            .setLabel('Вставить Discord ID')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('exam-spam')
            .setLabel('Брак')
            .setStyle(ButtonStyle.Danger),
    );
}

function buildReviewButtonsRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('exam-confirm').setLabel('Сдано').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('exam-decline').setLabel('Не сдано').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('exam-spam').setLabel('Брак').setStyle(ButtonStyle.Danger),
    );
}

function upsertField(embed, name, value, inline = false) {
    const rawFields = Array.isArray(embed.data?.fields) ? embed.data.fields : [];

    const fields = rawFields
        .filter(Boolean)
        .map((f) => ({
            name: String(f.name ?? '').slice(0, 256) || '—',
            value: String(f.value ?? '').slice(0, 1024) || '—',
            inline: f.inline === true,
        }));

    const idx = fields.findIndex((f) => f.name === name);
    const next = {
        name: String(name).slice(0, 256) || '—',
        value: String(value ?? '').slice(0, 1024) || '—',
        inline: inline === true,
    };

    if (idx === -1) fields.push(next);
    else fields[idx] = next;

    while (fields.length > 25) fields.pop();
    embed.setFields(fields);
}

function getFieldValue(embedLike, fieldName, fallback = '—') {
    const fields = Array.isArray(embedLike?.fields) ? embedLike.fields : [];
    const field = fields.find((item) => item?.name === fieldName);
    return field?.value ?? fallback;
}

async function buildExamMessagePayload(client, {
    guildId,
    testId = null,
    rawTestName = '—',
    testUrl = '—',
    testMemberInput = '—',
    correctAnswers = null,
} = {}) {
    const cfg = normalizeTestConfig({ testId, testName: rawTestName });
    const testName = cfg.shortName;
    const quickLink = cfg.quickLink;

    const guild = await client.guilds.fetch(guildId);
    const resolved = await resolveExamMember(guild, testMemberInput);
    const foundMember = resolved?.member || null;
    const candidates = Array.isArray(resolved?.candidates) ? resolved.candidates : [];

    const examEmbed = new EmbedBuilder()
        .setColor(EXAM_COLORS.needChoice)
        .setTitle(EXAM_TITLES.needChoice)
        .addFields(
            { name: 'Название экзамена:', value: `${testName}` },
            { name: 'Ссылка на результат:', value: `${testUrl}` },
            { name: 'Пользователь ввёл:', value: `${testMemberInput}` },
            { name: 'Результат поиска пользователя:', value: buildSearchResultText(foundMember, candidates) },
            { name: 'Результат экзамена:', value: buildExamResultValue({ cfg, correctAnswers }) },
            { name: 'Ссылка на быструю проверку экзамена:', value: `${quickLink}` },
        )
        .setTimestamp()
        .setFooter({ text: 'WN Helper by Michael Lindberg. Discord: milkgames', iconURL: 'https://i.imgur.com/zdxWb0s.jpeg' });

    const examinerRoleId = config.servers[guildId].examinerRoleId;

    return {
        content: `<@&${examinerRoleId}>`,
        embeds: [examEmbed],
        components: [buildSelectionButtonsRow()],
        meta: {
            foundMemberId: foundMember ? foundMember.id : null,
        },
    };
}

async function sendExamToChannel(client, payload) {
    const { guildId } = payload;
    const examChannelId = config.servers[guildId].examChannelId;
    const examChannel = await client.channels.fetch(examChannelId);

    const messagePayload = await buildExamMessagePayload(client, payload);
    const sent = await sendMessageWithRetry(examChannel, {
        content: messagePayload.content,
        embeds: messagePayload.embeds,
        components: messagePayload.components,
    }, {
        nonceSeed: `examPresentation:${guildId}:${payload.rawTestName}:${payload.testUrl}`,
    });

    const messageLink = `https://discord.com/channels/${guildId}/${sent.channelId}/${sent.id}`;
    return {
        sentChannelId: sent.channelId,
        sentMessageId: sent.id,
        messageLink,
        foundMemberId: messagePayload.meta?.foundMemberId || null,
    };
}

module.exports = {
    EXAM_TITLES,
    EXAM_COLORS,
    normalizeTestConfig,
    extractRegValue,
    extractCorrectAnswers,
    buildCandidatesText,
    buildSelectionButtonsRow,
    buildReviewButtonsRow,
    upsertField,
    getFieldValue,
    buildExamMessagePayload,
    sendExamToChannel,
};
