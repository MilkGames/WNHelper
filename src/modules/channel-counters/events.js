/*
 * WN Helper Discord Bot
 * Copyright (C) 2025-2026 MilkGames
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
const service = require('./service');

function rolesChanged(oldMember, newMember) {
    if (oldMember.roles.cache.size !== newMember.roles.cache.size) return true;
    return newMember.roles.cache.some((role) => !oldMember.roles.cache.has(role.id));
}

module.exports = [
    {
        event: 'clientReady',
        id: 'changeChannelName.js',
        order: 30,
        execute: async (client) => {
            await service.updateAllGuildChannelCounters(client, { reason: 'startup' });
            service.startChannelCounterScheduler(client);
        },
    },
    {
        event: 'guildMemberAdd',
        id: 'updateStaffOverview.js:02-channel-counters',
        order: 100,
        execute: async (client, member) => {
            service.scheduleGuildChannelCounterUpdate(client, member.guild.id, { reason: 'guildMemberAdd' });
        },
    },
    {
        event: 'guildMemberRemove',
        id: 'updateStaffOverview.js:02-channel-counters',
        order: 100,
        execute: async (client, member) => {
            service.scheduleGuildChannelCounterUpdate(client, member.guild.id, { reason: 'guildMemberRemove' });
        },
    },
    {
        event: 'guildMemberUpdate',
        id: 'updateStaffOverview.js:02-channel-counters',
        order: 100,
        execute: async (client, oldMember, newMember) => {
            if (!rolesChanged(oldMember, newMember)) return;
            service.scheduleGuildChannelCounterUpdate(client, newMember.guild.id, { reason: 'guildMemberUpdate' });
        },
    },
];
