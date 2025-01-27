/*
 * WN Helper Discord Bot
 * Copyright (C) 2025 MilkGames
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
const {} = require('discord.js');
const config = require('../../../config.json');

module.exports = async (client) => {
    try {
        for (const serverId of Object.keys(config.servers)){
            const WNroleNumberChannelId = config.servers[serverId].WNroleNumberChannelId;
            const membersChannelId = config.servers[serverId].membersChannelId;
            if (WNroleNumberChannelId && membersChannelId) {
                let guild = client.guilds.cache.get(serverId);
                let WNroleNumberChannel = await guild.channels.fetch(WNroleNumberChannelId);
                let membersChannel = await guild.channels.fetch(membersChannelId);
                let roleId = config.servers[serverId].weazelNewsRoleId;
                let members;
                let membersWithRole;
                let countWN;
                let newWNName;
                let previousWNName;
                let previousMember;
                let changeChannelName = async () => {
                    members = await guild.members.fetch();
                    membersWithRole = members.filter(member => member.roles.cache.has(roleId));
                    countWN = membersWithRole.size;
                    countMembers = members.size;
                    newWNName = `Сотрудников: ${countWN}`;
                    newMembersName = `Участников: ${countMembers}`
                    if (previousWNName !== newWNName) {
                        await WNroleNumberChannel.setName(newWNName);
                        previousWNName = newWNName;
                    }
                    if (previousMember !== newMembersName) {
                        await membersChannel.setName(newMembersName);
                        previousMember = newMembersName;
                    }
                };
                changeChannelName();
                setInterval(changeChannelName, 360000);
            }
        }
    } catch (error) {
        console.log(`Произошла ошибка при обновлении названия канала: ${error}`);
    }
}