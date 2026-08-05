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

const { editReplyWithRetry, replyWithRetry } = require('../../core/discord/request');
const logger = require('../../core/logging/logger');
const { isOwnerUser } = require('../../core/runtime/instance');
const { requestShutdown } = require('../../core/runtime/shutdown');
const {
    cancelShutdownConfirmation,
    consumeShutdownConfirmation,
} = require('../../core/runtime/shutdownConfirmation');

const PREFIX = 'wn-shutdown:';

async function sendExpired(interaction) {
    await replyWithRetry(interaction, {
        content: 'Подтверждение остановки истекло или уже было использовано.',
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
    }).catch(() => undefined);
}

module.exports = async (_client, interaction) => {
    if (!interaction.isButton?.() || !String(interaction.customId || '').startsWith(PREFIX)) return;
    interaction.__wnStopPropagation = true;

    const [, action, token] = String(interaction.customId).split(':');
    if (!isOwnerUser(interaction.user?.id)) {
        logger.warn('Отклонена попытка подтвердить остановку инстанса без прав владельца', {
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
        if (!cancelShutdownConfirmation(token, interaction.user.id)) {
            await sendExpired(interaction);
            return;
        }
        await interaction.update({
            content: 'Остановка инстанса отменена.',
            components: [],
            allowedMentions: { parse: [] },
        }).catch(() => undefined);
        return;
    }

    if (action !== 'confirm') return;
    const request = consumeShutdownConfirmation(token, interaction.user.id);
    if (!request) {
        await sendExpired(interaction);
        return;
    }

    logger.warn('Владелец подтвердил остановку текущего инстанса', {
        guildId: request.guildId,
        actorId: request.actorId,
        mode: request.mode,
    });
    await interaction.update({
        content: 'Остановка подтверждена. Текущий инстанс завершает работу.',
        components: [],
        allowedMentions: { parse: [] },
    }).catch(async () => {
        await editReplyWithRetry(interaction, {
            content: 'Остановка подтверждена. Текущий инстанс завершает работу.',
            components: [],
            allowedMentions: { parse: [] },
        }).catch(() => undefined);
    });

    setTimeout(() => {
        requestShutdown(`Остановка запрошена владельцем ${request.actorId}`, {
            exitCode: 0,
            timeoutMs: request.mode === 'force' ? 3_000 : 20_000,
        }).catch(() => process.exit(1));
    }, 250).unref?.();
};
