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
const { ModalBuilder, EmbedBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const config = require('../../../config.json');

const logger = require('../../utils/logger');

function upsertField(embed, name, value, inline = false) {
    const rawFields = Array.isArray(embed.data?.fields) ? embed.data.fields : [];

    // Нормализуем поля в чистые { name, value, inline } чтобы setFields не падал на валидации
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

    // На всякий случай, если бот тронется головой: лимит Discord на поля — 25
    if (fields.length > 25) {
        // Сначала пытаемся выкинуть служебное поле письменного
        const serviceIdx = fields.findIndex((f) => f.name === 'Экзамен необходимо проверить.');
        if (serviceIdx !== -1) fields.splice(serviceIdx, 1);

        while (fields.length > 25) fields.pop();
    }

    embed.setFields(fields);
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

    await interaction.editReply({ content });

    setTimeout(async () => {
        try {
            await interaction.deleteReply();
        } catch (error) {
            logger.info(`Не удалось удалить ответ: ${error}`);
        }
    }, 30_000);
}

function buildExamButtonsRow({ includeChoose = false, chooseDisabled = false } = {}) {
    const buttons = [
        new ButtonBuilder().setCustomId('exam-confirm').setLabel('Сдано').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('exam-decline').setLabel('Не сдано').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('exam-spam').setLabel('Брак').setStyle(ButtonStyle.Danger),
    ];

    if (includeChoose) {
        buttons.push(
            new ButtonBuilder()
                .setCustomId('exam-choose-candidate')
                .setLabel('Выбрать кандидата')
                .setStyle(ButtonStyle.Primary)
                .setDisabled(chooseDisabled === true),
        );
    }

    return new ActionRowBuilder().addComponents(...buttons);
}

function parseCandidateItems(examineeInfo) {
    const txt = String(examineeInfo || '');
    const lines = txt.split('\n').map((l) => l.trim()).filter(Boolean);

    let candidateLines = lines;
    const idx = lines.findIndex((l) => l.toLowerCase().startsWith('кандидаты'));
    if (idx !== -1) candidateLines = lines.slice(idx + 1);

    const items = [];
    const seen = new Set();

    for (const line of candidateLines) {
        const m = line.match(/<@!?(\d{17,20})>/);
        if (!m) continue;

        const id = m[1];
        if (seen.has(id)) continue;
        seen.add(id);

        const dn = (line.match(/\(([^)]+)\)\s*$/) || [])[1] || id;
        items.push({ id, displayName: dn });
    }

    // Если формат неожиданно поменяли, попробуем вытащить упоминания из всего текста
    if (items.length === 0) {
        const reId = /<@!?(\d{17,20})>/g;
        let mm;
        while ((mm = reId.exec(txt))) {
            const id = mm[1];
            if (seen.has(id)) continue;
            seen.add(id);
            items.push({ id, displayName: id });
            if (items.length >= 10) break;
        }
    }

    return items;
}

module.exports = async (client, interaction) => {
    const isExamButton =
        interaction.isButton() && ['exam-confirm', 'exam-decline', 'exam-spam'].includes(interaction.customId);
    const isChooseButton = interaction.isButton() && interaction.customId === 'exam-choose-candidate';
    const isCandidateSelect = interaction.isStringSelectMenu() && interaction.customId === 'exam-candidate-select';

    if (!isExamButton && !isChooseButton && !isCandidateSelect) return;

    let modalInteraction;
    let usedModal = false;

    try {
        if (isChooseButton) {
            await interaction.deferReply({ ephemeral: true });

            const guildId = interaction.guildId;
            const guild = await client.guilds.fetch(guildId);
            const examinerRoleId = config.servers[guildId].examinerRoleId;

            const examiner = await guild.members.fetch(interaction.user.id);

            if (!examiner.roles.cache.has(examinerRoleId)) {
                await editReply(4, interaction);
                return;
            }

            const message = interaction.message;
            const title = String(message.embeds?.[0]?.title || '');
            if (!title.includes('НУЖЕН ВЫБОР')) {
                await interaction.editReply({ content: 'Выбор кандидата не требуется.' });
                setTimeout(async () => { try { await interaction.deleteReply(); } catch (_) {} }, 30_000);
                return;
            }

            const alreadyOpen = Array.isArray(message.components) && message.components.some((row) =>
                Array.isArray(row.components) && row.components.some((c) => c.customId === 'exam-candidate-select')
            );
            if (alreadyOpen) {
                await interaction.editReply({ content: 'Меню выбора кандидата уже открыто.' });
                setTimeout(async () => { try { await interaction.deleteReply(); } catch (_) {} }, 30_000);
                return;
            }

            const examineeInfo = message.embeds?.[0]?.fields?.[3]?.value ?? '';
            const candidates = parseCandidateItems(examineeInfo);

            if (!candidates.length) {
                await interaction.editReply({ content: 'Не удалось извлечь кандидатов из сообщения.' });
                setTimeout(async () => { try { await interaction.deleteReply(); } catch (_) {} }, 30_000);
                return;
            }

            const options = candidates.slice(0, 25).map((c) => ({
                label: String(c.displayName || c.id).slice(0, 100) || c.id,
                value: c.id,
            }));

            const select = new StringSelectMenuBuilder()
                .setCustomId('exam-candidate-select')
                .setPlaceholder('Выберите кандидата')
                .addOptions(options);

            const selectRow = new ActionRowBuilder().addComponents(select);

            const buttonsRow = buildExamButtonsRow({ includeChoose: true, chooseDisabled: true });

            await message.edit({ components: [buttonsRow, selectRow] });

            await interaction.editReply({ content: 'Выбери кандидата из списка (меню появилось под сообщением).' });
            setTimeout(async () => { try { await interaction.deleteReply(); } catch (_) {} }, 30_000);
            return;
        }

        if (isCandidateSelect) {
            await interaction.deferReply({ ephemeral: true });

            const guildId = interaction.guildId;
            const guild = await client.guilds.fetch(guildId);
            const examinerRoleId = config.servers[guildId].examinerRoleId;

            const examiner = await guild.members.fetch(interaction.user.id);
            if (!examiner.roles.cache.has(examinerRoleId)) {
                await editReply(4, interaction);
                return;
            }

            const selectedId = interaction.values?.[0] || null;
            if (!selectedId) {
                await interaction.editReply({ content: 'Не выбран кандидат.' });
                setTimeout(async () => { try { await interaction.deleteReply(); } catch (_) {} }, 30_000);
                return;
            }

            const chosen = await guild.members.fetch(selectedId).catch(() => null);
            if (!chosen) {
                await interaction.editReply({ content: 'Не удалось получить выбранного участника (возможно вышел с сервера).' });
                setTimeout(async () => { try { await interaction.deleteReply(); } catch (_) {} }, 30_000);
                return;
            }

            const message = interaction.message;
            const examEmbed = new EmbedBuilder(message.embeds[0]);

            examEmbed.setTitle('Новая сдача экзамена! - НА РАССМОТРЕНИИ');
            examEmbed.setColor(0x3498DB);
            upsertField(examEmbed, 'Результат поиска пользователя:', `${chosen} (${chosen.displayName})`, false);

            const buttonsRow = buildExamButtonsRow({ includeChoose: false });

            await message.edit({
                embeds: [examEmbed],
                components: [buttonsRow],
            });

            await interaction.editReply({ content: `Выбран кандидат: ${chosen} (${chosen.displayName}).` });
            setTimeout(async () => { try { await interaction.deleteReply(); } catch (_) {} }, 30_000);
            return;
        }

        const guildId = interaction.guildId;
        const guild = await client.guilds.fetch(guildId);

        const examResultChannelId = config.servers[guildId].examResultChannelId;
        const examResultChannel = await client.channels.fetch(examResultChannelId);

        const examinerRoleId = config.servers[guildId].examinerRoleId;

        const message = interaction.message;
        const memberId = interaction.user.id;
        const examiner = await guild.members.fetch(memberId);

        const examEmbed = new EmbedBuilder(message.embeds[0]);

        // Для будущего меня: порядок полей такой, как мы формируем в webhook:
        // 0: Название экзамена
        // 1: Ссылка на результат
        // 2: Пользователь ввёл
        // 3: Результат поиска пользователя
        // 4: Результат экзамена ИЛИ "Экзамен необходимо проверить."
        const testName = message.embeds?.[0]?.fields?.[0]?.value ?? '—';
        const examineeInfo = message.embeds?.[0]?.fields?.[3]?.value ?? '—';
        let result = message.embeds?.[0]?.fields?.[4]?.value ?? '—';

        const channelId = message.channelId;
        const messageId = message.id;
        const messageLink = `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;

        // Для НЕ письменного — сразу defer, чтобы не ловить "interaction failed"
        if (testName !== 'ПРО (письменный)' || interaction.customId === 'exam-spam') {
            await interaction.deferReply({ ephemeral: true });
        }

        if (!examiner.roles.cache.has(examinerRoleId)) {
            await editReply(4, interaction);
            return;
        }

        // Если письменный — запрашиваем оценку через модалку
        if ((interaction.customId === 'exam-confirm' || interaction.customId === 'exam-decline') && testName === 'ПРО (письменный)') {
            const modal = new ModalBuilder()
                .setTitle('Проверка ПРО (письменный):')
                .setCustomId(`exam-${memberId}`);

            const textInput = new TextInputBuilder()
                .setCustomId('exam-result')
                .setLabel('Введите результат экзамена (0-10):')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setPlaceholder('10')
                .setMinLength(1)
                .setMaxLength(2);

            modal.addComponents(new ActionRowBuilder().addComponents(textInput));

            await interaction.showModal(modal);

            usedModal = true;

            const filter = (i) => i.customId === `exam-${memberId}`;

            // bugfix #1: перекрылся пинг когда прошло время на ввод
            try {
                modalInteraction = await interaction.awaitModalSubmit({ filter, time: 1000 * 60 * 3 });
            } catch (err) {
                if (err?.name === 'InteractionCollectorError') {
                    await interaction.followUp({
                        content: 'Время на ввод результата истекло (3 минуты). Нажми кнопку ещё раз.',
                        ephemeral: true
                    });
                    return;
                }
                throw err;
            }

            await modalInteraction.deferReply({ ephemeral: true });

            const raw = modalInteraction.fields.getTextInputValue('exam-result');
            const pre = Number(String(raw).replace(',', '.'));

            // Ограничиваем до 10
            const clamped = Number.isFinite(pre) ? Math.max(0, Math.min(10, Math.floor(pre))) : 0;

            if (clamped > 7) result = `${clamped} / 10 - СДАНО ✅`;
            else result = `${clamped} / 10 - НЕ СДАНО ❌`;
        }

        // Отписка в канал итогов
        if (interaction.customId === 'exam-confirm' || interaction.customId === 'exam-decline') {
            const examResults =
                `Экзаменатор: ${examiner} (${examiner.displayName})\n` +
                `Экзаменуемый: ${examineeInfo}\n` +
                `Ссылка на сдачу экзамена: ${messageLink}\n` +
                `Тип экзамена: ${testName}\n` +
                `Результат: ${result}`;

            await examResultChannel.send(examResults);
        }

        // Обновляем embed (статус + кто проверил)
        const checkedBy = `${examiner} (${examiner.displayName})`;
        upsertField(examEmbed, 'Проверил:', checkedBy, false);

        if (interaction.customId === 'exam-confirm') {
            examEmbed.setTitle('Новая сдача экзамена! - СДАНО');
            examEmbed.setColor(0x00FF00);
            upsertField(examEmbed, 'Результат экзамена:', result, false);

            if (testName === 'ПРО (письменный)' && modalInteraction) await editReply(1, modalInteraction);
            else await editReply(1, interaction);
        }

        if (interaction.customId === 'exam-decline') {
            examEmbed.setTitle('Новая сдача экзамена! - НЕ СДАНО');
            examEmbed.setColor(0xFF0000);
            upsertField(examEmbed, 'Результат экзамена:', result, false);

            if (testName === 'ПРО (письменный)' && modalInteraction) await editReply(2, modalInteraction);
            else await editReply(2, interaction);
        }

        if (interaction.customId === 'exam-spam') {
            examEmbed.setTitle('Новая сдача экзамена! - БРАК');
            examEmbed.setColor(0xFF0000);
            await editReply(3, interaction);
        }

        // Кнопки убираем, чтобы не было хаоса
        await message.edit({
            content: '',
            embeds: [examEmbed],
            components: [],
        });
    } catch (error) {
        logger.error('Произошла ошибка при нажатии на кнопку, связанную с итогами экзамена:', error);
        if (error.rawError) logger.error('Дополнительная информация по предыдущей ошибке:', error.rawError);

        const errText = `Произошла ошибка при нажатии на кнопку: ${error}`;

        try {
            if (modalInteraction && (modalInteraction.deferred || modalInteraction.replied)) {
                await modalInteraction.editReply({ content: errText });
            }
            else if (usedModal) {
                await interaction.followUp({ content: errText, ephemeral: true });
            }
            else if (interaction.deferred || interaction.replied) {
                await interaction.editReply({ content: errText });
            } else {
                await interaction.reply({ content: errText, ephemeral: true });
            }
        } catch (_) {
            // игнорируем вторую ошибку ответа
        }
    }
};