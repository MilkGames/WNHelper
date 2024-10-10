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
const { devs, testServer } = require('../../../config.json');
const getLocalCommands = require('../../utils/getLocalCommands');

module.exports = async (client, interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const localCommands = getLocalCommands();

    try {
        const commandObject = localCommands.find(
            (cmd) => cmd.name === interaction.commandName
        );

        if (!commandObject) return;

        if (commandObject.devOnly){
            if (!devs.includes(interaction.member.id)){
                interaction.reply({
                    content: 'Данная команда доступна только для разработчиков!',
                    ephemeral: true,
                });
                return;
            }
        }

        if (commandObject.testOnly){
            if (!(interaction.guild.id === testServer)){
                interaction.reply({
                    content: `Данная команда доступна только на тестовом сервере!`,
                    ephemeral: true,
                });
                return;
            }
        }

        if (commandObject.permissionsRequired?.length){
            for (const permission of commandObject.permissionsRequired){
                if (!interaction.member.permissions.has(permission)){
                    interaction.reply({
                        content: "У вас недостаточно прав для запуска данной команды.",
                        ephemeral: true,
                    });
                    return;
                }
            }   
        }

        if (commandObject.botPermissions?.length){
            for (const permission of commandObject.botPermissions){
                const bot = interaction.guild.members.me;
                if (!bot.permissions.has(permission)){
                    interaction.reply({
                        content: "У меня недостаточно прав для запуска данной команды...",
                        ephemeral: true,
                    });
                    return;
                }
            }
        }
        await commandObject.callback(client, interaction);
    } catch (error) {
        console.log(`Произошла общая ошибка при запуске команды: ${error}`);
        await interaction.reply(`Произошла общая ошибка при запуске команды: ${error}.`);
    }
};