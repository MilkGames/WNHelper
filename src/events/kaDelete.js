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

module.exports = {
    name: Events.MessageReactionAdd,
    async execute(reaction, user) {
        if (user.bot) return;
        const guildId = reaction.message.guild.id;
        const targetChannelId = config.servers[guildId].kaChannelId;
        if (reaction.message.channel.id !== targetChannelId) return;
        const kaDeleteChannel = await reaction.message.client.channels.fetch(config.servers[guildId].kaDeleteChannelId);

        const targetEmoji = '❌';
        if (reaction.emoji.name !== targetEmoji) return;
        const messageId = reaction.message.id;
        const messageLink = `https://discord.com/channels/${guildId}/${targetChannelId}/${messageId}`;
        kaDeleteChannel.send(`<@&${config.servers[guildId].leaderRoleId}>, новая заявка на удаление записи из кадрового аудита!
Ссылка на сообщение: ${messageLink}`);
        return;
    },
};