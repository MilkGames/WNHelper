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
const StaffAuditError = require('../../staff-audit').StaffAuditError;
const memberOffboardingService = require('../service');
const {
    followUpWithRetry,
    runDiscordRequest,
} = require('../../../core/discord/request');
const logger = require('../../../core/logging/logger');
const { buildPublicErrorMessage } = require('../../../core/ui/errorMessage');

module.exports = async (client, interaction) => {
    if (!interaction.isButton()) return;
    const match = String(interaction.customId || '').match(/^uvalApproval:(approve|reject):(.+)$/);
    if (!match) return;

    const [, action, approvalKey] = match;
    try {
        await runDiscordRequest(() => interaction.deferUpdate(), { attempts: 1 });
        const result = await memberOffboardingService.handleApprovalInteraction(
            client,
            interaction,
            action,
            approvalKey
        );
        const plural = Number(result.count || 1) > 1;
        await followUpWithRetry(interaction, {
            content: result.status === 'rejected'
                ? (plural ? 'Увольнения отклонены.' : 'Увольнение отклонено.')
                : result.status === 'completed_with_issues'
                    ? 'Увольнения подтверждены, но часть операций завершилась с ошибкой. Проверьте итог массового КА.'
                    : (plural ? 'Увольнения подтверждены и обработаны.' : 'Увольнение подтверждено и обработано.'),
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        }).catch(() => undefined);
    } catch (error) {
        logger[error instanceof StaffAuditError ? 'warn' : 'error']('Ошибка подтверждения увольнения', {
            guildId: interaction.guildId,
            userId: interaction.user?.id,
            approvalKey,
            action,
        }, error);
        await followUpWithRetry(interaction, {
            content: `${buildPublicErrorMessage(error, 'Не удалось обработать подтверждение увольнения.')}\nID подтверждения: ${approvalKey}`,
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        }).catch(() => undefined);
    }
};
