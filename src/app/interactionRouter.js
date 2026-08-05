/*
 * WN Helper Discord Bot
 * Copyright (C) 2024-2026 MilkGames
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

const {
    followUpWithRetry,
    replyWithRetry,
} = require('../core/discord/request');
const logger = require('../core/logging/logger');
const { buildPublicErrorMessage } = require('../core/ui/errorMessage');

async function sendFallbackInteractionError(interaction, error) {
    if (!interaction) return false;
    const payload = {
        content: buildPublicErrorMessage(
            error,
            'Произошла ошибка при обработке действия. Ошибка записана в лог.'
        ),
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
    };

    try {
        if (interaction.deferred || interaction.replied) {
            if (typeof interaction.followUp !== 'function') return false;
            await followUpWithRetry(interaction, payload);
            return true;
        }
        if (typeof interaction.reply !== 'function') return false;
        await replyWithRetry(interaction, payload);
        return true;
    } catch (replyError) {
        logger.error('Не удалось отправить резервный ответ об ошибке взаимодействия', {
            interactionId: interaction.id || null,
            guildId: interaction.guildId || null,
            userId: interaction.user?.id || null,
        }, replyError);
        return false;
    }
}

async function routeInteraction(client, interaction, handlers) {
    for (const handler of handlers) {
        try {
            await handler.execute(client, interaction);
            if (interaction?.__wnStopPropagation === true) break;
        } catch (error) {
            logger.error('Обработчик взаимодействия завершился с ошибкой', {
                handler: handler.id,
                module: handler.module || null,
                guildId: interaction?.guildId || null,
                userId: interaction?.user?.id || null,
                customId: interaction?.customId || null,
                commandName: interaction?.commandName || null,
            }, error);
            if (interaction) interaction.__wnStopPropagation = true;
            await sendFallbackInteractionError(interaction, error);
            break;
        }
    }
}

module.exports = {
    routeInteraction,
    sendFallbackInteractionError,
};
