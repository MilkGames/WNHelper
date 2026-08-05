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
const { Events } = require('discord.js');
const { getStaffAuditSettings } = require('../settings/schema');
const guildConfigService = require('../../../core/config/guildConfigService');
const { sendMessageWithRetry } = require('../../../core/discord/request');
const logger = require('../../../core/logging/logger');

module.exports = {
    name: Events.MessageReactionAdd,
    async execute(reaction, user) {
        try {
            if (user?.bot) return;

            if (reaction?.partial) {
                await reaction.fetch().catch(() => null);
            }
            if (reaction?.message?.partial) {
                await reaction.message.fetch().catch(() => null);
            }

            const guild = reaction?.message?.guild;
            if (!guild || reaction.emoji?.name !== '❌') return;

            const guildId = guild.id;
            const config = guildConfigService.get(guildId);
            if (!config?.features?.staffAudit) return;

            const settings = getStaffAuditSettings(config);
            if (
                !settings.channelId ||
                !settings.deleteRequestChannelId ||
                !settings.deleteNotifyRoleIds.length
            ) {
                return;
            }

            if (reaction.message.channel.id !== settings.channelId) return;

            const deleteChannel = await reaction.message.client.channels
                .fetch(settings.deleteRequestChannelId)
                .catch(() => null);
            if (!deleteChannel?.send) {
                logger.warn('Удаление кадрового аудита: канал запросов недоступен', {
                    guildId,
                    channelId: settings.deleteRequestChannelId,
                });
                return;
            }

            const messageId = reaction.message.id;
            const messageLink = `https://discord.com/channels/${guildId}/${settings.channelId}/${messageId}`;
            const mentions = settings.deleteNotifyRoleIds
                .map((roleId) => `<@&${roleId}>`)
                .join(' ');

            await sendMessageWithRetry(deleteChannel, {
                content:
                    `${mentions}, новая заявка на удаление записи из кадрового аудита!\n` +
                    `Ссылка на сообщение: ${messageLink}`,
                allowedMentions: {
                    parse: [],
                    roles: settings.deleteNotifyRoleIds,
                },
            }, {
                nonceSeed: `kaDelete:${guildId}:${messageId}`,
            });
        } catch (error) {
            logger.error('Удаление кадрового аудита: обработчик завершился с ошибкой', {}, error);
        }
    },
};
