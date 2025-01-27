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
const { ActivityType } = require('discord.js');

module.exports = async (client) => {
    console.log(`Бот ${client.user.username} онлайн!`);
    
    let techMaintenance = false;

    let status = [
        {
            name: 'нервы ген. директора',
        },
        {
            name: 'Majestic RP',
        },
        {
            name: 'Версия 1.2',
            type: ActivityType.Custom,
        },
        {
            name: 'Выполняю БП...',
            type: ActivityType.Custom,
        },
        {
            name: 'Weazel News 😍',
            type: ActivityType.Custom,
        },
        {
            name: 'DiscordAPIError[10062]: Unknown interaction',
            type: ActivityType.Custom,
        },
        {
            name: 'Value "52" is not a valid enum value.',
            type: ActivityType.Custom,
        },
        {
            name: 'новый ролик у Logan Fletcher',
            type: ActivityType.Streaming,
            url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        },
        {
            name: 'функционал Weazel News',
            type: ActivityType.Streaming,
            url: 'https://www.youtube.com/watch?v=rnGQoE93KZ8',
        },
    ];

    let techStatus = [
        {
            name: 'Я обновляюсь 🔧',
            type: ActivityType.Custom,
        },
        {
            name: 'До сих пор обновляюсь 🔧',
            type: ActivityType.Custom,
        },
        {
            name: 'Тех. обслуживание 🔧',
            type: ActivityType.Custom,
        },
        {
            name: 'Придумываем фичи... 🔧',
            type: ActivityType.Custom,
        },
        {
            name: 'Ожидайте... 🔧',
            type: ActivityType.Custom,
        },
    ];

    setInterval(() => {
        let random;
        if (techMaintenance) {
            random = Math.floor(Math.random() * techStatus.length);
            client.user.setActivity(techStatus[random]);
        } else {
            random = Math.floor(Math.random() * status.length);
            client.user.setActivity(status[random]);
        }
    }, 10000);

    // const channel = await client.channels.fetch("1249711900292546681");
    // const message = await channel.messages.fetch("1332387885843873864");
    // console.log(message.embeds[0].data.fields[message.embeds[0].data.fields.length - 1].value);
};