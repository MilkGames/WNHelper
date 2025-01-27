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
const { ButtonBuilder, ActionRowBuilder, ButtonStyle } = require('discord.js');
const config = require('../../../config.json');
const cron = require('node-cron');
const amdShifts = require('../../models/amdShifts');

module.exports = async (client) => {
    for (const serverId of Object.keys(config.servers)){
        //if (serverId !== "1275070473474146345") break;
        const serverName = client.guilds.cache.get(serverId);
        const channel = await client.channels.fetch(config.servers[serverId].amdShiftsChannelId);
        const AMDRoleId = config.servers[serverId].AMDRoleId;
        const partWorkAMDRoleId = config.servers[serverId].partWorkAMDRoleId;
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

            const ifGuildId = await amdShifts.findOne(query);

            if (ifGuildId) {
                const messageId = ifGuildId.messageId;
                const message = await channel.messages.fetch(messageId);
                await message.edit({ components: [] });
                await amdShifts.deleteOne(query);
            }

            let pingRoles;
            if (partWorkAMDRoleId) pingRoles = `<@&${partWorkAMDRoleId}>
<@&${AMDRoleId}>`;
            else pingRoles = `<@&${AMDRoleId}>`;

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
В очень редких случаях кнопки могут оставаться неактивными после того, как вы на них нажали.
Это визуальный баг, используйте Ctrl+R, чтобы перезапустить Discord и кнопки вновь будут активными.
${pingRoles}
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