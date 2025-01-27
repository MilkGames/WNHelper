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
const config = require('../../../../config.json');
const { ApplicationCommandOptionType, PermissionFlagsBits } = require('discord.js');

module.exports = {
    name: 'creategr',
    description: 'Добавляет сообщение с выдачей ролей для Trainee Department в выбранном канале.',
    //devOnly: Boolean
    //testOnly: Boolean
    options: [
        {
            name: 'channel',
            description: 'Выберите канал, в который будет отправлено сообщение.',
            required: true,
            type: ApplicationCommandOptionType.Channel,
        },
    ],
    permissionsRequired: [PermissionFlagsBits.Administrator],
    botPermissions: [PermissionFlagsBits.ManageRoles],

    callback: async (client, interaction) => {
        try {
            await interaction.deferReply({ ephemeral: true });

            const guildId = interaction.guildId;

            const leaderRoleId = config.servers[guildId].leaderRoleId;

            const channel = interaction.options.getChannel('channel');
            const citizenChannel = await client.channels.fetch(config.servers[guildId].citizenChannelId);
            if (!channel) return;

            await channel.send(
                `Для того, чтобы получить роли стажировки, пропишите команду \`/sendgr\` в канале ${citizenChannel}. 
В данной команде должны быть указаны:
\`nickname\` - Имя Фамилия вашего персонажа, к примеру: Michael Lindberg
\`static\` - ваш статик, к примеру: 7658
\`invite-nick\` - тег сотрудника, который вас принимал.
Сотрудники Weazel News не примут вашу заявку на выдачу ролей, если она была составлена не по форме.

Если вам нужны особенные роли (МК, лидера/зам. лидера и т.п.), обратитесь напрямую в личные сообщения лидеру WN с ролью <@&${leaderRoleId}>.
Если же вы новый куратор фракции, пинганите ГК или ЗГА в ${citizenChannel}.
-# WN Helper by Michael Lindberg. Discord: milkgames`
            );

            await interaction.editReply({
                content: `Сообщение создано успешно в канале ${channel}!`,
                ephemeral: true,
            });
            return;
        } catch (error) {
            console.log(`Произошла ошибка при создании сообщения с выдачей ролей: ${error}`);
            if (!interaction.replied) {
                await interaction.editReply({
                    content: `Произошла ошибка при создании сообщения с выдачей ролей: ${error}`,
                    ephemeral: true,
                });
            }
        }
    },
};