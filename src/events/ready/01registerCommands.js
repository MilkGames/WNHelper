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
require('dotenv').config();
const config = require('../../../config.json');
const { ContextMenuCommandBuilder, ApplicationCommandType, REST, Routes } = require('discord.js');
const areCommandsDifferent = require('../../utils/areCommandsDifferent');
const getApplicationCommands = require('../../utils/getApplicationCommands');
const getLocalCommands = require('../../utils/getLocalCommands');

module.exports = async (client) => {
    const commandsData = [
        new ContextMenuCommandBuilder()
            .setName('Повысить по отчёту')
            .setType(ApplicationCommandType.Message),
    ];

    const rest = new REST().setToken(process.env.token);

    try {
        console.log('Перезагружаю контекстные команды на всех серверах...');

        const client_id = config.clientId;

        await rest.put(
            Routes.applicationCommands(client_id),
            { body: commandsData },
        )

        console.log('Успешно зарегестрировал контекстные команды на всех серверах!');
    } catch (error) {
        console.error(`Произошла ошибка при регистрации контекстных команд: ${error}`);
    }

    try {
        const localCommands = getLocalCommands();

        for (const serverId of Object.keys(config.servers)){
            const serverName = client.guilds.cache.get(serverId);

            const applicationCommands = await getApplicationCommands(client, serverId);

            for (const localCommand of localCommands){
                const { name, description, options } = localCommand;

                const existingCommand = await applicationCommands.cache.find(
                    (cmd) => cmd.name === name
                );

                if (existingCommand){
                    if (localCommand.deleted){
                        await applicationCommands.delete(existingCommand.id);
                        console.log(`Удалена команда "${name}" на сервере ${serverName}.`);
                        continue;
                    }

                    if (localCommand.mainOnly && serverId !== Object.keys(config.servers)[0]){
                        await applicationCommands.delete(existingCommand.id);
                        console.log(`Удалена команда "${name}" на сервере ${serverName}, так как она является эксклюзивной для основного сервера.`);
                        continue;
                    }

                    if (areCommandsDifferent(existingCommand, localCommand)) {
                        await applicationCommands.edit(existingCommand.id, {
                            description,
                            options,
                        });

                        console.log(`Изменена команда "${name}" на сервере ${serverName}.`);
                    }
                } else {
                    if (localCommand.deleted){
                        console.log(`Пропущена регистрация команды "${name}" на сервере ${serverName}, так как она обозначена на удаление.`)
                        continue;
                    }

                    if (localCommand.mainOnly && serverId !== Object.keys(config.servers)[0]){
                        console.log(`Пропущена регистрация команды "${name}" на сервере ${serverName}, так как она является эксклюзивной для основного сервера.`);
                        continue;
                    }
                    
                    await applicationCommands.create({
                        name,
                        description,
                        options,
                    })

                    console.log(`Успешно зарегистрирована команда "${name}" на сервере ${serverName}.`);
                }
            }
        }
    } catch (error) {
        console.log(`Произошла ошибка при регистрации команд: ${error}`);
    }
}