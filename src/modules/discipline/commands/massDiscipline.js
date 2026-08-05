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
    ApplicationCommandOptionType,
    MessageFlags,
    PermissionFlagsBits,
} = require('discord.js');
const DisciplineError = require('../error');
const massInteractionService = require('../massInteractionService');
const massService = require('../massService');
const guildConfigService = require('../../../core/config/guildConfigService');
const {
    deferReplyWithRetry,
    editReplyWithRetry,
} = require('../../../core/discord/request');
const logger = require('../../../core/logging/logger');
const { buildPublicErrorMessage } = require('../../../core/ui/errorMessage');

async function readAttachment(attachment) {
    if (!attachment) return null;
    if (Number(attachment.size) > 100_000) {
        throw new DisciplineError('TXT-файл не должен превышать 100 КБ.', 'mass_file_too_large');
    }
    if (!String(attachment.name || '').toLowerCase().endsWith('.txt')) {
        throw new DisciplineError('Поддерживаются только TXT-файлы.', 'mass_file_type');
    }
    const response = await fetch(attachment.url);
    if (!response.ok) {
        throw new DisciplineError(`Не удалось скачать TXT-файл: HTTP ${response.status}.`, 'mass_file_download');
    }
    return response.text();
}

module.exports = {
    name: 'massdiscipline',
    description: 'Оформить дисциплинарные взыскания нескольким сотрудникам.',
    options: [
        {
            name: 'file',
            description: 'TXT: Discord ID/упоминания или Имя Фамилия | статик. Без файла откроется выбор.',
            type: ApplicationCommandOptionType.Attachment,
        },
    ],
    botPermissions: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.SendMessagesInThreads,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageRoles,
    ],

    callback: async (client, interaction) => {
        const attachment = interaction.options.getAttachment('file');
        try {
            if (!attachment) {
                await massInteractionService.start(client, interaction);
                return;
            }
            await deferReplyWithRetry(interaction, { flags: MessageFlags.Ephemeral });
            const guild = interaction.guild || await client.guilds.fetch(interaction.guildId);
            const actor = await guild.members.fetch(interaction.user.id);
            const config = guildConfigService.get(interaction.guildId);
            await massService.preflight({ client, guild, config, actor });
            const text = await readAttachment(attachment);
            const targets = massService.parseTargetText(text, interaction.guildId);
            await massInteractionService.start(client, interaction, targets);
        } catch (error) {
            logger[error instanceof DisciplineError ? 'warn' : 'error']('Ошибка запуска /massdiscipline', {
                guildId: interaction.guildId,
                userId: interaction.user.id,
            }, error);
            const payload = {
                content: buildPublicErrorMessage(error, 'Не удалось открыть массовое взыскание.'),
                components: [],
                embeds: [],
                allowedMentions: { parse: [] },
            };
            if (interaction.deferred || interaction.replied) {
                await editReplyWithRetry(interaction, payload).catch(() => undefined);
            } else {
                await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => undefined);
            }
        }
    },
};
