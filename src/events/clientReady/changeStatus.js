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
const { ActivityType } = require('discord.js');

module.exports = async (client) => {
    let techMaintenance = false;
    let testing = false;

    let status = [
        {
            name: 'Majestic RP',
        },
        {
            name: 'Версия 1.2.7',
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
            name: 'Legally Unbanned ✅',
            type: ActivityType.Custom,
        },
        {
            name: 'Ping: 9999ms',
            type: ActivityType.Custom,
        },
        {
            name: 'Memory Leak: 128GB',
            type: ActivityType.Custom,
        },
        {
            name: 'npm install life',
            type: ActivityType.Custom,
        },
        {
            name: 'Что? 9 рангов???',
            type: ActivityType.Custom,
        }
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
        {
            name: 'Вспоминаю, как это работало... 🔧',
            type: ActivityType.Custom,
        },
        {
            name: 'Фикшу баги годичной давности 🔧',
            type: ActivityType.Custom,
        },
        {
            name: 'Compiling... 🔧',
            type: ActivityType.Custom,
        }
    ];

    let testingStatus = [
        {
            name: 'Я недоступен! Идёт тест...',
            type: ActivityType.Custom,
        }
    ];

    setInterval(() => {
        let random;
        if (techMaintenance) {
            if (testing) {
                random = Math.floor(Math.random() * testingStatus.length);
                client.user.setActivity(testingStatus[random]);
            } else {
                random = Math.floor(Math.random() * techStatus.length);
                client.user.setActivity(techStatus[random]);
            }
        } else {
            random = Math.floor(Math.random() * status.length);
            client.user.setActivity(status[random]);
        }
    }, 10000);
};