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
const { Client, IntentsBitField, ActivityType } = require('discord.js');

module.exports = (client) => {
    console.log(`Бот ${client.user.username} онлайн!`);

    let status = [
        {
            name: 'нервы ген. директора',
        },
        {
            name: 'Majestic RP',
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

    // let status = [
    //     {
    //         name: 'Я обновляюсь 🔧',
    //         type: ActivityType.Custom,
    //     },
    //     {
    //         name: 'До сих пор обновляюсь 🔧',
    //         type: ActivityType.Custom,
    //     },
    //     {
    //         name: 'Тех. обслуживание 🔧',
    //         type: ActivityType.Custom,
    //     },
    // ];

    setInterval(() => {
        let random = Math.floor(Math.random() * status.length);
        client.user.setActivity(status[random]);
    }, 10000);
};