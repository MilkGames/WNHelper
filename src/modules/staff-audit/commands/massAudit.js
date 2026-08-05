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
} = require('discord.js');
const StaffAuditError = require('../error');
const batchService = require('../batchService');
const {
    buildBatchButtons,
    createMassAuditModal,
} = require('../batchPresentation');
const guildConfigService = require('../../../core/config/guildConfigService');
const {
    deferReplyWithRetry,
    editReplyWithRetry,
    showModalWithRetry,
} = require('../../../core/discord/request');
const logger = require('../../../core/logging/logger');
const { buildPublicErrorMessage } = require('../../../core/ui/errorMessage');

async function readAttachment(attachment) {
    if (!attachment) return null;
    if (Number(attachment.size) > 100_000) {
        throw new StaffAuditError('TXT-файл не должен превышать 100 КБ.', 'mass_audit_file_too_large');
    }
    if (!String(attachment.name || '').toLowerCase().endsWith('.txt')) {
        throw new StaffAuditError('Для массового КА поддерживаются только .txt-файлы.', 'mass_audit_file_type');
    }
    const response = await fetch(attachment.url);
    if (!response.ok) {
        throw new StaffAuditError(`Не удалось скачать TXT-файл: HTTP ${response.status}.`, 'mass_audit_file_download');
    }
    return response.text();
}

module.exports = {
    name: 'massaudit',
    description: 'Создать массовый кадровый аудит.',
    options: [
        {
            name: 'file',
            description: 'TXT-файл со списком операций. Без файла откроется форма.',
            type: ApplicationCommandOptionType.Attachment,
        },
    ],

    callback: async (client, interaction) => {
        const attachment = interaction.options.getAttachment('file');

        if (!attachment) {
            await showModalWithRetry(interaction, createMassAuditModal(), { attempts: 1 });
            return;
        }

        await deferReplyWithRetry(interaction, { flags: MessageFlags.Ephemeral });
        const guildId = interaction.guildId;
        try {
            const config = guildConfigService.get(guildId);
            const guild = interaction.guild || await client.guilds.fetch(guildId);
            const actor = await guild.members.fetch(interaction.user.id);
            const text = await readAttachment(attachment);
            const batch = await batchService.createBatch(client, { guild, config, actor, text });
            await editReplyWithRetry(interaction, {
                content: batchService.buildPreview(batch),
                components: [buildBatchButtons(batch.massauditId)],
                allowedMentions: { parse: [] },
                temporary: false,
            });
        } catch (error) {
            logger[error instanceof StaffAuditError ? 'warn' : 'error']('Ошибка /massaudit', {
                guildId,
                userId: interaction.user.id,
            }, error);
            await editReplyWithRetry(interaction, {
                content: buildPublicErrorMessage(error, 'Не удалось создать массовый кадровый аудит.'),
                components: [],
                allowedMentions: { parse: [] },
            });
        }
    },
};
