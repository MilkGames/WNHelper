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
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function writeTestConfig(targetRoot, overrides = {}) {
    const source = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'config.json'), 'utf8'));
    const config = {
        ...source,
        ...overrides,
        logging: {
            ...(source.logging || {}),
            level: 'fatal',
            toFile: false,
            ...(overrides.logging || {}),
        },
        webhookServer: {
            ...(source.webhookServer || {}),
            ...(overrides.webhookServer || {}),
        },
    };
    fs.writeFileSync(path.join(targetRoot, 'config.json'), `${JSON.stringify(config, null, 4)}\n`, 'utf8');
    return config;
}

module.exports = { writeTestConfig };
