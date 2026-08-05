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
const DisciplineError = require('../error');
const massService = require('../massService');
const {
    editMessageWithRetry,
    followUpWithRetry,
    replyWithRetry,
    runDiscordRequest,
} = require('../../../core/discord/request');
const logger = require('../../../core/logging/logger');
const { buildPublicErrorMessage } = require('../../../core/ui/errorMessage');

module.exports = async (client, interaction) => {
    if (!interaction.isButton()) return;
    const match = String(interaction.customId || '').match(/^massDisciplineApproval:(approve|reject):(.+)$/);
    if (!match) return;
    const [, action, batchId] = match;
    try {
        const guild = interaction.guild || await client.guilds.fetch(interaction.guildId);
        const approver = await guild.members.fetch(interaction.user.id);
        await runDiscordRequest(() => interaction.deferUpdate(), { attempts: 1 });
        if (action === 'reject') {
            const batch = await massService.rejectBatch({ batchId, approver });
            await editMessageWithRetry(interaction.message, {
                content: '',
                embeds: [massService.buildApprovalEmbed(batch, `Отклонено <@${approver.id}>`)],
                components: [massService.buildApprovalRow(batchId, true)],
                allowedMentions: { parse: [] },
            });
            return;
        }

        const result = await massService.approveBatch(client, { batchId, approver });
        const resultPayload = massService.buildResultPayload(result);
        await editMessageWithRetry(interaction.message, {
            ...resultPayload,
            components: [],
        });
    } catch (error) {
        logger[error instanceof DisciplineError ? 'warn' : 'error']('Ошибка подтверждения массового взыскания', {
            guildId: interaction.guildId,
            userId: interaction.user?.id,
            batchId,
            action,
        }, error);

        if (action === 'approve' && interaction.deferred && interaction.message) {
            const batch = await massService.getBatch(batchId).catch(() => null);
            if (batch?.status === 'partially_completed') {
                const resultPayload = massService.buildResultPayload(batch);
                await editMessageWithRetry(interaction.message, {
                    ...resultPayload,
                    components: [],
                }).catch((editError) => {
                    logger.warn('Не удалось закрыть панель после ошибки массового взыскания', {
                        guildId: interaction.guildId,
                        batchId,
                    }, editError);
                });
            }
        }

        const content = buildPublicErrorMessage(error, 'Не удалось рассмотреть массовое взыскание.');
        const payload = {
            content,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        };
        if (interaction.deferred || interaction.replied) {
            await followUpWithRetry(interaction, payload).catch(() => undefined);
        } else {
            await replyWithRetry(interaction, payload).catch(() => undefined);
        }
    }
};
