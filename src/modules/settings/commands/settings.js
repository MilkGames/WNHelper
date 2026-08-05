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
const { ApplicationCommandOptionType } = require('discord.js');
const configSessionService = require('../session');
const guildConfigService = require('../../../core/config/guildConfigService');
const {
    renderClosedPanel,
    renderSettingsPanel,
} = require('../presentation');
const {
    editMessageWithRetry,
    replyWithRetry,
} = require('../../../core/discord/request');
const logger = require('../../../core/logging/logger');

async function closeOldPanel(client, session) {
    if (!session?.channelId || !session?.messageId) return;

    try {
        const channel = await client.channels.fetch(session.channelId).catch(() => null);
        if (!channel?.messages?.fetch) return;

        const message = await channel.messages.fetch(session.messageId).catch(() => null);
        if (!message) return;

        await editMessageWithRetry(message, renderClosedPanel({
            guildName: message.guild?.name || session.guildId,
            userId: session.userId,
            saved: false,
            reason: 'Сессия принудительно закрыта создателем бота.',
        }));
    } catch (error) {
        logger.warn('Не удалось заблокировать старую панель /settings', {
            guildId: session.guildId,
            messageId: session.messageId,
        }, error);
    }
}

module.exports = {
    name: 'settings',
    description: 'Открывает панель настройки WN Helper для текущего сервера.',
    publicResponses: true,
    options: [
        {
            name: 'force',
            description: 'Принудительно закрыть текущую сессию настройки.',
            type: ApplicationCommandOptionType.Boolean,
            required: false,
        },
    ],

    callback: async (client, interaction) => {
        if (!interaction.inGuild() || !interaction.guild || !interaction.member) {
            await replyWithRetry(interaction, {
                content: 'Эта команда доступна только на сервере.',
            });
            return;
        }

        await guildConfigService.ensureGuild(interaction.guild);

        if (!configSessionService.canManageSettings(interaction.member, interaction.guildId)) {
            await replyWithRetry(interaction, {
                content: 'У вас нет доступа к настройкам WN Helper на этом сервере.',
            });
            return;
        }

        const force = interaction.options.getBoolean('force') === true;
        const existing = configSessionService.getActiveByGuild(interaction.guildId);
        let forceClosedSession = null;

        if (existing) {
            if (!force) {
                const link = configSessionService.buildMessageLink(existing);
                await replyWithRetry(interaction, {
                    content: [
                        `Настройки сервера уже редактирует <@${existing.userId}>.`,
                        link ? `Текущая панель: ${link}` : null,
                    ].filter(Boolean).join('\n'),
                    allowedMentions: { parse: [] },
                });
                return;
            }

            if (!configSessionService.isBotOwner(interaction.user.id)) {
                await replyWithRetry(interaction, {
                    content: 'Принудительно закрыть чужую сессию может только создатель бота.',
                });
                return;
            }

            forceClosedSession = configSessionService.forceClose(interaction.guildId);
        }

        const result = configSessionService.start({
            guild: interaction.guild,
            user: interaction.user,
            member: interaction.member,
        });

        if (!result.created) {
            await replyWithRetry(interaction, {
                content: result.denied
                    ? 'У вас нет доступа ни к одному разделу настроек.'
                    : 'Не удалось открыть новую сессию настроек: сервер уже редактируется.',
            });
            return;
        }

        await replyWithRetry(interaction, renderSettingsPanel(result.session, interaction.guild));
        const message = await interaction.fetchReply();
        configSessionService.attachMessage(result.session, message);

        if (forceClosedSession) {
            await closeOldPanel(client, forceClosedSession);
        }

        logger.info('Открыта панель /settings', {
            guildId: interaction.guildId,
            userId: interaction.user.id,
            sessionId: result.session.id,
        });
    },
};
