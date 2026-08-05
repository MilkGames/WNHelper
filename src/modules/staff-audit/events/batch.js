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
const { MessageFlags } = require('discord.js');
const StaffAuditError = require('../error');
const batchService = require('../batchService');
const { buildBatchButtons } = require('../batchPresentation');
const { mutateDatabase: mutateDb } = require('../database');
const {
    deferReplyWithRetry,
    editReplyWithRetry,
    replyWithRetry,
    runDiscordRequest,
} = require('../../../core/discord/request');
const logger = require('../../../core/logging/logger');
const { buildPublicErrorMessage } = require('../../../core/ui/errorMessage');
const guildConfigService = require('../../../core/config/guildConfigService');

async function cancelBatch(massauditId, actorId) {
    return mutateDb((db) => {
        const batch = (db.staffAuditBatches || []).find((entry) => entry.massauditId === massauditId);
        if (!batch || String(batch.actorId) !== String(actorId)) return null;
        if (!['awaiting_confirmation', 'partially_completed'].includes(batch.status)) return batch;
        batch.status = 'cancelled';
        batch.updatedAt = Date.now();
        return JSON.parse(JSON.stringify(batch));
    });
}

module.exports = async (client, interaction) => {
    const isCreateModal = interaction.isModalSubmit() && interaction.customId === 'staffAuditBatch:create';
    const buttonMatch = interaction.isButton()
        ? String(interaction.customId || '').match(/^staffAuditBatch:(confirm|cancel):(.+)$/)
        : null;
    if (!isCreateModal && !buttonMatch) return;

    let massauditId = null;
    try {
        const guild = interaction.guild || await client.guilds.fetch(interaction.guildId);
        const actor = await guild.members.fetch(interaction.user.id);
        const config = guildConfigService.get(interaction.guildId);

        if (isCreateModal) {
            await deferReplyWithRetry(interaction, { flags: MessageFlags.Ephemeral }, { attempts: 1 });
            const text = interaction.fields.getTextInputValue('commands');
            const batch = await batchService.createBatch(client, { guild, config, actor, text });
            massauditId = batch.massauditId;
            await editReplyWithRetry(interaction, {
                content: batchService.buildPreview(batch),
                components: [buildBatchButtons(batch.massauditId)],
                allowedMentions: { parse: [] },
                temporary: false,
            });
            return;
        }

        const [, action, id] = buttonMatch;
        massauditId = id;
        await runDiscordRequest(() => interaction.deferUpdate(), { attempts: 1 });
        if (action === 'cancel') {
            const batch = await cancelBatch(massauditId, actor.id);
            if (!batch) throw new StaffAuditError('Пакет не найден или принадлежит другому пользователю.', 'massaudit_not_found');
            await editReplyWithRetry(interaction, {
                content: `Массовый кадровый аудит ${massauditId} отменён.`,
                components: [],
                allowedMentions: { parse: [] },
            });
            return;
        }

        const result = await batchService.executeBatch(client, { massauditId, actor });
        await editReplyWithRetry(interaction, {
            content: batchService.buildResult(result),
            components: result.status === 'partially_completed' ? [buildBatchButtons(massauditId)] : [],
            allowedMentions: { parse: [] },
            temporary: result.status !== 'partially_completed',
        });
    } catch (error) {
        logger[error instanceof StaffAuditError ? 'warn' : 'error']('Ошибка массового кадрового аудита', {
            guildId: interaction.guildId,
            userId: interaction.user?.id,
            massauditId,
        }, error);
        const idText = massauditId ? `\nID массового КА: ${massauditId}` : '';
        const content = `${buildPublicErrorMessage(error, 'Не удалось обработать массовый кадровый аудит.')}${idText}`;
        if (interaction.deferred || interaction.replied) {
            await editReplyWithRetry(interaction, {
                content,
                components: [],
                allowedMentions: { parse: [] },
            }).catch(() => undefined);
        } else {
            await replyWithRetry(interaction, {
                content,
                flags: MessageFlags.Ephemeral,
                allowedMentions: { parse: [] },
            }).catch(() => undefined);
        }
    }
};
