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

module.exports = async (client, interaction) => {
    if (!interaction.isButton()) return;
    if (!['exam-confirm', 'exam-decline', 'exam-spam'].includes(interaction.customId)) return;

    try {
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

        let modalInteraction;
        let usedModal = false;

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