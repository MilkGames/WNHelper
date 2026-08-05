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

const { applyRecoveryPlan } = require('../../core/database/recovery');
const { replyWithRetry } = require('../../core/discord/request');
const logger = require('../../core/logging/logger');
const { buildPublicErrorMessage } = require('../../core/ui/errorMessage');
const { isOwnerUser } = require('../../core/runtime/instance');
const {
    cancelDatabaseRecoveryConfirmation,
    consumeDatabaseRecoveryConfirmation,
} = require('./databaseRecoveryConfirmation');

const PREFIX = 'wn-db-recovery:';

async function sendExpired(interaction) {
    await replyWithRetry(interaction, {
        content: 'Подтверждение восстановления истекло или уже было использовано.',
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
    }).catch(() => undefined);
}

module.exports = async (_client, interaction) => {
    if (!interaction.isButton?.() || !String(interaction.customId || '').startsWith(PREFIX)) return;
    interaction.__wnStopPropagation = true;

    const [, action, token] = String(interaction.customId).split(':');
    if (!isOwnerUser(interaction.user?.id)) {
        logger.warn('Отклонена попытка подтвердить восстановление базы данных без прав владельца', {
            guildId: interaction.guildId || null,
            actorId: interaction.user?.id || null,
        });
        await replyWithRetry(interaction, {
            content: 'Недостаточно прав для выполнения этого действия.',
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        }).catch(() => undefined);
        return;
    }

    if (action === 'cancel') {
        if (!cancelDatabaseRecoveryConfirmation(token, interaction.user.id)) {
            await sendExpired(interaction);
            return;
        }
        await interaction.update({
            content: 'Применение плана восстановления отменено.',
            components: [],
            allowedMentions: { parse: [] },
        }).catch(() => undefined);
        return;
    }

    if (action !== 'confirm') return;
    const request = consumeDatabaseRecoveryConfirmation(token, interaction.user.id);
    if (!request) {
        await sendExpired(interaction);
        return;
    }

    await interaction.update({
        content: 'План восстановления применяется. Новые изменения базы данных временно заблокированы.',
        components: [],
        allowedMentions: { parse: [] },
    }).catch(() => undefined);

    try {
        const result = await applyRecoveryPlan(request.planId);
        logger.warn('Владелец подтвердил применение плана восстановления базы данных', {
            guildId: request.guildId,
            actorId: request.actorId,
            planId: request.planId,
        });
        await interaction.editReply({
            content: `План "${result.planId}" применён в режиме безопасного объединения. Для полного перечитывания состояния перезапустите бот.`,
            components: [],
            allowedMentions: { parse: [] },
        }).catch(() => undefined);
    } catch (error) {
        logger.error('Не удалось применить подтверждённый план восстановления базы данных', {
            guildId: request.guildId,
            actorId: request.actorId,
            planId: request.planId,
        }, error);
        await interaction.editReply({
            content: buildPublicErrorMessage(error, 'Не удалось применить план восстановления базы данных.'),
            components: [],
            allowedMentions: { parse: [] },
        }).catch(() => undefined);
    }
};
