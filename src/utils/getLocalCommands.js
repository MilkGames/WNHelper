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
const path = require('path');
const getAllFiles = require('./getAllFiles');

module.exports = (exceptions = []) => {
    let localCommands = [];

    const commandCategories = getAllFiles(
        path.join(__dirname, '..', 'commands'),
        true
    );

    commandCategories.push(...getAllFiles(
        path.join(__dirname, '..', 'commands', 'wn'),
        true
    ));

    for (const commandCategory of commandCategories){
        const commandFiles = getAllFiles(commandCategory);

        for (const commandFile of commandFiles){
            const commandObject = require(commandFile);

            if (exceptions.includes(commandObject.name)) continue;
            localCommands.push(commandObject);
        }
    }

    return localCommands;
}