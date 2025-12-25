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
const { ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder } = require('discord.js');
const config = require('../../../config.json');
const express = require('express');

const logger = require('../../utils/logger');

function getClientIp(req) {
    const xf = req.headers['x-forwarded-for'];
    if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim();
    return req.ip || 'unknown';
}

// Rate limiter, никогда не знаешь что будет
// На деле, конечно, плохо что у нас лимит по экзаменам, но боже мой
// Кто представляет в визлах 20 экзаменов за минуту...
function makeRateLimiter({ limit = 20, windowMs = 60_000 } = {}) {
    const buckets = new Map();
    return (req, res, next) => {
        const ip = getClientIp(req);
        const now = Date.now();
        const b = buckets.get(ip);

        if (!b || now >= b.resetAt) {
            buckets.set(ip, { count: 1, resetAt: now + windowMs });
            return next();
        }

        if (b.count >= limit) {
            res.setHeader('Retry-After', Math.ceil((b.resetAt - now) / 1000));
            return res.status(429).send('Too Many Requests');
        }

        b.count += 1;
        return next();
    };
}

function normalizeTestConfig({ testId, testName }) {
    // Все наши тесты в удобной функции
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

    // Падаем в выбор имени
    switch (testName) {
        case 'Тест на знание устава Weazel News | Dallas':
            return byId['2h5yvxravpgmw'];
        case 'Упрощённый тест на знание ПРО Weazel News | Dallas':
            return byId['2zogqqsz34kpc'];
        case 'Тест на знание ПРО Weazel News | Dallas':
            return byId['7vchtj53hnzui'];
        case 'Письменный тест на знание ПРО Weazel News | Dallas':
            return byId['qi7qrikeg7fxk'];
        default:
            return {
                shortName: `Неизвестный тест`,
                quickLink: '—',
                maxScore: 10,
                passScore: 8,
                manual: true, // безопаснее отправлять на рассмотрение, на деле это просто снова "на всякий"
            };
    }
}

function extractRegValue(regparams) {
    if (!Array.isArray(regparams)) return null;
    const p = regparams.find(x => typeof x?.name === 'string' && x.name.toLowerCase().includes('имя'));
    const v = p?.value;
    return (typeof v === 'string' && v.trim().length) ? v.trim() : null;
}

function extractCorrectAnswers(results) {
    if (!Array.isArray(results)) return null;
    const r = results.find(x => typeof x?.name === 'string' && x.name.toLowerCase().includes('количество правильных'));
    const n = Number(r?.value);
    return Number.isFinite(n) ? n : null;
}

module.exports = async (client) => {
    const app = express();
    const PORT = Number(process.env.PORT) || 80;

    const WEBHOOK_KEY = process.env.WEBHOOK_KEY;
    const TEST_KEY = process.env.TEST_KEY;
    if (!WEBHOOK_KEY) {
        // Это защита от дурака (от меня)
        throw new Error('WEBHOOK_KEY is not set in environment');
    }
    if (!TEST_KEY) {
        // Это защита от дурака (от меня)
        throw new Error('TEST_KEY is not set in environment');
    }

    // На всякий, никогда не знаешь когда понадобится
    app.set('trust proxy', 1);

    app.use(express.json({ limit: '256kb' }));
    app.use('/webhook', makeRateLimiter({ limit: 10, windowMs: 60_000 }));

    // Отправляем ключ на onlinetestpad
    app.get('/webhook', (req, res) => {
        res.status(200).send(TEST_KEY); // Да, он показывается даже на /webhook, но это не огромная проблема
    });

    app.post('/webhook', async (req, res) => {
        try {
            // Защита по query key
            if (req.query.key !== WEBHOOK_KEY) return res.status(403).send('Forbidden');

            const data = req.body || {};
            const testId = typeof data.testId === 'string' ? data.testId : null;
            const rawTestName = typeof data.testName === 'string' ? data.testName : '—';
            const testUrl = typeof data.url === 'string' ? data.url : '—';

            const cfg = normalizeTestConfig({ testId, testName: rawTestName });
            const testName = cfg.shortName;
            const quickLink = cfg.quickLink;

            const testMemberInput = extractRegValue(data.regparams) || '—';
            const correctAnswers = extractCorrectAnswers(data.results);

            // Discord guild (как-нибудь надо исправить это) TODO!
            const guildId = Object.keys(config.servers)[1];
            const guild = await client.guilds.fetch(guildId);

            // Ищем участника
            const members = await guild.members.fetch();

            const staticMatch = (typeof testMemberInput === 'string')
                ? (testMemberInput.match(/\d+/)?.[0] || null)
                : null;

            let foundMember = null;
            if (staticMatch) {
                foundMember = members.find(m => (m.displayName || '').includes(staticMatch)) || null;
            }
            if (!foundMember && typeof testMemberInput === 'string' && testMemberInput !== '—') {
                foundMember = members.find(m => (m.displayName || '').includes(testMemberInput)) || null;
            }

            const foundMemberText = foundMember
                ? `${foundMember} (${foundMember.displayName})`
                : 'Пользователь не найден.';

            let title = 'Новая сдача экзамена! - НА РАССМОТРЕНИИ';
            let color = 0x3498DB;

            if (!foundMember) {
                title = 'Новая сдача экзамена! - БРАК';
                color = 0xFF0000;
            }

            const examEmbed = new EmbedBuilder()
                .setColor(color)
                .setTitle(title)
                .addFields(
                    { name: 'Название экзамена:', value: `${testName}` },
                    { name: 'Ссылка на результат:', value: `${testUrl}` },
                    { name: 'Пользователь ввёл:', value: `${testMemberInput}` },
                    { name: 'Результат поиска пользователя:', value: `${foundMemberText}` },
                )
                .setTimestamp()
                .setFooter({ text: 'WN Helper by Michael Lindberg. Discord: milkgames', iconURL: 'https://i.imgur.com/zdxWb0s.jpeg' });

            // Результат
            if (cfg.manual || testName === 'ПРО (письменный)') {
                examEmbed.addFields({ name: 'Экзамен необходимо проверить.', value: ' ' });
            } else {
                // Даже если не смогли вытащить число — всё равно отправляем на рассмотрение
                if (!Number.isFinite(correctAnswers)) {
                    examEmbed.addFields({ name: 'Экзамен необходимо проверить.', value: 'Не удалось определить результат (формат данных).' });
                } else {
                    const maxScore = cfg.maxScore;
                    const passScore = cfg.passScore;

                    const passed = correctAnswers >= passScore;
                    const mark = passed ? 'СДАНО ✅' : 'НЕ СДАНО ❌';

                    examEmbed.addFields({
                        name: 'Результат экзамена:',
                        value: `${correctAnswers} / ${maxScore} - ${mark}`,
                    });
                }
            }

            examEmbed.addFields({ name: 'Ссылка на быструю проверку экзамена:', value: `${quickLink}` });

            const examinerRoleId = config.servers[guildId].examinerRoleId;
            const examChannelId = config.servers[guildId].examChannelId;
            const examChannel = await client.channels.fetch(examChannelId);

            // Кнопки только если пользователь найден
            if (!foundMember) {
                await examChannel.send({ embeds: [examEmbed] });
            } else {
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('exam-confirm').setLabel('Сдано').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('exam-decline').setLabel('Не сдано').setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId('exam-spam').setLabel('Брак').setStyle(ButtonStyle.Danger),
                );

                await examChannel.send({
                    content: `<@&${examinerRoleId}>`,
                    embeds: [examEmbed],
                    components: [row],
                });
            }

            return res.status(200).send('Принято');
        } catch (error) {
            logger.error(`Произошла ошибка при принятии результатов экзамена: ${error}`);
            return res.status(400).send('Ошибка на стороне клиента');
        }
    });

    app.listen(PORT, () => {
        logger.info(`Сервер запущен на порту: ${PORT}`);
    });
};