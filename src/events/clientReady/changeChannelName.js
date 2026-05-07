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
const config = require('../../../config.json');

const logger = require('../../utils/logger');

module.exports = async (client) => {
    try {
        for (const serverId of Object.keys(config.servers)) {
            const WNroleNumberChannelId = config.servers[serverId].WNroleNumberChannelId;
            const membersChannelId = config.servers[serverId].membersChannelId;

            const guild = client.guilds.cache.get(serverId);
            if (!guild) continue;

            if (WNroleNumberChannelId && membersChannelId) {
                let WNroleNumberChannel = await guild.channels.fetch(WNroleNumberChannelId).catch(() => null);
                let membersChannel = await guild.channels.fetch(membersChannelId).catch(() => null);
                
                let roleId = config.servers[serverId].weazelNewsRoleId;
                
                let previousWNName = WNroleNumberChannel ? WNroleNumberChannel.name : null;
                let previousMember = membersChannel ? membersChannel.name : null;

                const changeChannelName = async () => {
                    try {
                        if (!WNroleNumberChannel) WNroleNumberChannel = await guild.channels.fetch(WNroleNumberChannelId).catch(() => null);
                        if (!membersChannel) membersChannel = await guild.channels.fetch(membersChannelId).catch(() => null);
                        
                        if (!WNroleNumberChannel || !membersChannel) return;
                        
                        await guild.members.fetch({ time: 120000, withPresences: false, force: true }).catch(err => {
                            logger.info(`Ошибка! Не удалось загрузить список участников для ${guild.name}: ${err.message}`);
                        });

                        const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
                        
                        const countWN = role ? role.members.size : 0;
                        const countMembers = guild.memberCount;

                        const newWNName = `Сотрудников: ${countWN}`;
                        const newMembersName = `Участников: ${countMembers}`;

                        if (previousWNName !== newWNName) {
                            await WNroleNumberChannel.setName(newWNName);
                            previousWNName = newWNName;
                        }

                        if (previousMember !== newMembersName) {
                            await membersChannel.setName(newMembersName);
                            previousMember = newMembersName;
                        }
                    } catch (error) {
                        logger.info(`Произошла ошибка при обновлении названия канала (Сервер: ${guild.name}): ${error}`);
                    }
                };

                changeChannelName();
                setInterval(changeChannelName, 3600000);
            }
        }
    } catch (error) {
        logger.info(`Критическая ошибка в модуле статистики каналов: ${error}`);
    }
}
