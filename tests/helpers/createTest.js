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
const path = require('path');
const nodeTest = require('node:test');
const applicationConfig = require('../../config.json');

applicationConfig.logging = {
    level: 'fatal',
    toFile: false,
};

function createTest(filename) {
    const relativePath = path.relative(path.join(__dirname, '..', '..'), filename).replaceAll('\\', '/');
    const prefixName = (name) => `[${relativePath}] ${name}`;
    const test = (name, ...argumentsList) => nodeTest(prefixName(name), ...argumentsList);

    for (const method of ['only', 'skip', 'todo']) {
        test[method] = (name, ...argumentsList) => nodeTest[method](prefixName(name), ...argumentsList);
    }
    return test;
}

module.exports = createTest;
