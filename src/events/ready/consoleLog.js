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
const { Client, IntentsBitField, ActivityType, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');

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
            name: 'Версия 1.11',
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

    // const channel = await client.channels.fetch("1295313182843211788");
    // let hey = "Проверка 1";
    // hey += "\nПроверка 2";
    // await channel.send(hey);

    // const rows = [];

    // rows.push(
    //     new ButtonBuilder()
    //         .setCustomId('shift-one')
    //         .setLabel("12:00 - 12:55")
    //         .setStyle(ButtonStyle.Primary)
    // );

    // rows.push(
    //     new ButtonBuilder()
    //         .setCustomId('shift-h')
    //         .setLabel("13:00 - 13:55")
    //         .setStyle(ButtonStyle.Primary)
    // );

    // rows.push(
    //     new ButtonBuilder()
    //         .setCustomId('shift-hfg')
    //         .setLabel("14:00 - 14:55")
    //         .setStyle(ButtonStyle.Primary)
    // );

    // rows.push(
    //     new ButtonBuilder()
    //         .setCustomId('shift-jghgfj')
    //         .setLabel("15:00 - 15:55")
    //         .setStyle(ButtonStyle.Primary)
    // );

    // rows.push(
    //     new ButtonBuilder()
    //         .setCustomId('shift-ghjffhgj')
    //         .setLabel("16:00 - 16:55")
    //         .setStyle(ButtonStyle.Primary)
    // );
    
    // rows.push(
    //     new ButtonBuilder()
    //         .setCustomId('shift-jghfhfgj')
    //         .setLabel("17:00 - 17:55")
    //         .setStyle(ButtonStyle.Primary)
    // );

    // rows.push(
    //     new ButtonBuilder()
    //         .setCustomId('shift-kjdjfsg')
    //         .setLabel("18:00 - 18:55")
    //         .setStyle(ButtonStyle.Primary)
    // );

    // rows.push(
    //     new ButtonBuilder()
    //         .setCustomId('shift-rasdrf')
    //         .setLabel("19:00 - 19:55")
    //         .setStyle(ButtonStyle.Primary)
    // );

    // rows.push(
    //     new ButtonBuilder()
    //         .setCustomId('shift-fgjfhgj')
    //         .setLabel("20:00 - 20:55")
    //         .setStyle(ButtonStyle.Primary)
    // );

    // rows.push(
    //     new ButtonBuilder()
    //         .setCustomId('shift-nfbdbdf')
    //         .setLabel("21:00 - 21:55")
    //         .setStyle(ButtonStyle.Primary)
    // );

    // rows.push(
    //     new ButtonBuilder()
    //         .setCustomId('shift-hfsdghdfgh')
    //         .setLabel("22:00 - 22:55")
    //         .setStyle(ButtonStyle.Primary)
    // );

    // rows.push(
    //     new ButtonBuilder()
    //         .setCustomId('shift-hfghdfhf')
    //         .setLabel("23:00 - 00:00")
    //         .setLabel("1️⃣1️⃣")
    //         .setStyle(ButtonStyle.Primary)
    // );

    // const buttons = [];

    // for (let i = 0; i < rows.length; i += 4) {
    //     const row = new ActionRowBuilder().addComponents(rows.slice(i, i + 4));
    //     buttons.push(row);
    // };

    // await channel.send({ components: buttons });
};