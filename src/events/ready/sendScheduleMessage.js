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
const { Client, Interaction, ApplicationCommandOptionType, EmbedBuilder, PermissionFlagsBits, ButtonBuilder, ActionRowBuilder, ButtonStyle } = require('discord.js');
const config = require('../../../config.json');
const cron = require('node-cron');
const amdShifts = require('../../models/amdShifts');

module.exports = async (client) => {
    for (const serverId of Object.keys(config.servers)){
        const serverName = client.guilds.cache.get(serverId);
        const channel = await client.channels.fetch(config.servers[serverId].amdShiftsChannelId);
        const AMDRoleId = config.servers[serverId].AMDRoleId;
        const headAMDRoleId = config.servers[serverId].headAMDRoleId;
        console.log(`Смены для AMD успешно запланированы на сервере ${serverName}.`);
        cron.schedule('0 21 * * *', async () => {
            console.log(`Начинаю отправлять смены AMD для сервера ${serverName}...`);
            let currentDate = new Date();
            let tomorrow = new Date(currentDate);
            tomorrow.setDate(tomorrow.getDate() + 1);
            let formattedDate = `${String(tomorrow.getDate()).padStart(2, '0')}.${String(tomorrow.getMonth() + 1).padStart(2, '0')}.${tomorrow.getFullYear()}`;
            
            const query = {
                guildId: serverId,
            };
            console.log(serverId);

            const ifGuildId = await amdShifts.findOne(query);

            if (ifGuildId) {
                const previousDate = ifGuildId.date;
                const messageId = ifGuildId.messageId;
                const message = await channel.messages.fetch(messageId);
   
                let firstHour = ifGuildId.firstHour;
                if (!(firstHour === 'Свободно')) firstHour = await client.users.fetch(firstHour);
                let secondHour = ifGuildId.secondHour;
                if (!(secondHour === 'Свободно')) secondHour = await client.users.fetch(secondHour);
                let thirdHour = ifGuildId.thirdHour;
                if (!(thirdHour === 'Свободно')) thirdHour = await client.users.fetch(thirdHour);
                let fourthHour = ifGuildId.fourthHour;
                if (!(fourthHour === 'Свободно')) fourthHour = await client.users.fetch(fourthHour);
                let fifthHour = ifGuildId.fifthHour;
                if (!(fifthHour === 'Свободно')) fifthHour = await client.users.fetch(fifthHour);
                let sixthHour = ifGuildId.sixthHour;
                if (!(sixthHour === 'Свободно')) sixthHour = await client.users.fetch(sixthHour);
                let seventhHour = ifGuildId.seventhHour;
                if (!(seventhHour === 'Свободно')) seventhHour = await client.users.fetch(seventhHour);
                let eighthHour = ifGuildId.eighthHour;
                if (!(eighthHour === 'Свободно')) eighthHour = await client.users.fetch(eighthHour);

                const content = `:white_check_mark: Смены на ${previousDate}:

:one: 14:00 - 14:55: ${firstHour}
:two: 15:00 - 15:55: ${secondHour}
:three: 16:00 - 16:55: ${thirdHour}
:four: 17:00 - 17:55: ${fourthHour}
:five: 18:00 - 18:55: ${fifthHour}
:six: 19:00 - 19:55: ${sixthHour}
:seven: 20:00 - 20:55: ${seventhHour}
:eight: 21:00 - 22:00: ${eighthHour}

**Нажмите на кнопку, соответствующую времени смены, чтобы занять текущее время в холле и для отправления объявлений.**
Пользователи с ролью <@&${headAMDRoleId}> также могут нажать на кнопку, чтобы убрать сотрудника из списка.
<@&${AMDRoleId}>
-# WN Helper by Michael Lindberg. Discord: milkgames`;
            
                await message.edit({ content: content, components: [] });
  
                await amdShifts.deleteOne(query);
            }

            const content = `:white_check_mark: Смены на ${formattedDate}:

:one: 14:00 - 14:55: Свободно
:two: 15:00 - 15:55: Свободно
:three: 16:00 - 16:55: Свободно
:four: 17:00 - 17:55: Свободно
:five: 18:00 - 18:55: Свободно
:six: 19:00 - 19:55: Свободно
:seven: 20:00 - 20:55: Свободно
:eight: 21:00 - 22:00: Свободно

**Нажмите на кнопку, соответствующую времени смены, чтобы занять текущее время в холле и для отправления объявлений.**
Пользователи с ролью <@&${headAMDRoleId}> также могут нажать на кнопку, чтобы убрать сотрудника из списка.
<@&${AMDRoleId}>
-# WN Helper by Michael Lindberg. Discord: milkgames`;

            const rows = [];

            rows.push(
                new ButtonBuilder()
                    .setCustomId('shift-one')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('1️⃣')
            );

            rows.push(
                new ButtonBuilder()
                    .setCustomId('shift-two')
                    .setEmoji('2️⃣')
                    .setStyle(ButtonStyle.Primary)
            );

            rows.push(
                new ButtonBuilder()
                    .setCustomId('shift-three')
                    .setEmoji('3️⃣')
                    .setStyle(ButtonStyle.Primary)
            );

            rows.push(
                new ButtonBuilder()
                    .setCustomId('shift-four')
                    .setEmoji('4️⃣')
                    .setStyle(ButtonStyle.Primary)
            );

            rows.push(
                new ButtonBuilder()
                    .setCustomId('shift-five')
                    .setEmoji('5️⃣')
                    .setStyle(ButtonStyle.Primary)
            );

            rows.push(
                new ButtonBuilder()
                    .setCustomId('shift-six')
                    .setEmoji('6️⃣')
                    .setStyle(ButtonStyle.Primary)
            );

            rows.push(
                new ButtonBuilder()
                    .setCustomId('shift-seven')
                    .setEmoji('7️⃣')
                    .setStyle(ButtonStyle.Primary)
            );

            rows.push(
                new ButtonBuilder()
                    .setCustomId('shift-eight')
                    .setEmoji('8️⃣')
                    .setStyle(ButtonStyle.Primary)
            );

            const buttons = [];

            for (let i = 0; i < rows.length; i += 4) {
                const row = new ActionRowBuilder().addComponents(rows.slice(i, i + 4));
                buttons.push(row);
            };

            const sentMessage = await channel.send({
                content: `${content}`,
                components: buttons,
            });

            const messageId = sentMessage.id;
            const newAmdShifts = new amdShifts({
                guildId: serverId,
                messageId: messageId,
                date: formattedDate
            });
            newAmdShifts.save();

            console.log(`Смены для AMD успешно отправлены на сервере ${serverName}.`);
        }, {
            scheduled: true,
            timezone: "Europe/Moscow"
        });
    }
};