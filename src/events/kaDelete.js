/*
 * WN Helper Discord Bot
 * Copyright (C) 2024 MilkGames
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
const config = require('../../config.json');
const logger = require('../utils/logger');

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
            if (!guild) return;

            const guildId = guild.id;
            const serverCfg = config?.servers?.[guildId];

            if (!serverCfg) {
                logger.debug('kaDelete: сервер не настроен, пропускаю', { guildId });
                return;
            }

            const { kaChannelId, kaDeleteChannelId, leaderRoleId } = serverCfg;
            if (!kaChannelId || !kaDeleteChannelId || !leaderRoleId) {
                logger.warn('kaDelete: не хватает настроек КА для сервера, пропускаю', { guildId });
                return;
            }

            if (reaction.message.channel.id !== kaChannelId) return;

            const targetEmoji = '❌';
            if (reaction.emoji?.name !== targetEmoji) return;

            const kaDeleteChannel = await reaction.message.client.channels.fetch(kaDeleteChannelId).catch(() => null);
            if (!kaDeleteChannel) {
                logger.warn('kaDelete: не удалось получить канал для удаления', { guildId, kaDeleteChannelId });
                return;
            }

            const messageId = reaction.message.id;
            const messageLink = `https://discord.com/channels/${guildId}/${kaChannelId}/${messageId}`;

            await kaDeleteChannel.send(
                `<@&${leaderRoleId}>, новая заявка на удаление записи из кадрового аудита!
Ссылка на сообщение: ${messageLink}`,
            );
        } catch (error) {
            logger.error('kaDelete: обработчик крашнулся', {}, error);
        }
    },
};