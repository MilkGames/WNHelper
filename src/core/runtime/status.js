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

let statusTimer = null;

async function startStatusRotation(client) {
    let techMaintenance = false;

    let statuses = [
        {
            name: 'Majestic RP',
        },
        {
            name: 'Версия 2.0',
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
            name: 'Жду PayDay 💰',
            type: ActivityType.Custom,
        },
        {
            name: 'Слив склада: Забанен',
            type: ActivityType.Custom,
        },
        {
            name: 'ReferenceError: sleep is not defined',
            type: ActivityType.Custom,
        },
        {
            name: 'Ушел в бесконечный цикл...',
            type: ActivityType.Custom,
        },
        {
            name: 'AFK 24/7',
            type: ActivityType.Custom,
        },
        {
            name: 'Нажми Alt+F4 для админки',
            type: ActivityType.Custom,
        },
        {
            name: '404: Brain not found',
            type: ActivityType.Custom,
        },
        {
            name: 'Работаю за еду 🍕',
            type: ActivityType.Custom,
        }
    ];

    let techStatuses = [
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
            name: 'Compiling... 🔧',
            type: ActivityType.Custom,
        }
    ];

    if (statusTimer) clearInterval(statusTimer);
    statusTimer = setInterval(() => {
        let random;
        if (techMaintenance) {
            random = Math.floor(Math.random() * techStatuses.length);
            client.user.setActivity(techStatuses[random]);
        } else {
            random = Math.floor(Math.random() * statuses.length);
            client.user.setActivity(statuses[random]);
        }
    }, 10000);
}

function stopStatusRotation() {
    if (!statusTimer) return;
    clearInterval(statusTimer);
    statusTimer = null;
}

module.exports = {
    startStatusRotation,
    stopStatusRotation,
};
