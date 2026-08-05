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
const { AttachmentBuilder } = require('discord.js');

function sanitizeConfig(value) {
    if (Array.isArray(value)) return value.map(sanitizeConfig);
    if (!value || typeof value !== 'object') return value;

    const result = {};
    for (const [key, entry] of Object.entries(value)) {
        if (key === '_comment') continue;
        result[key] = sanitizeConfig(entry);
    }
    return result;
}

function buildConfigExport(config, { guildId, guildName }) {
    const payload = {
        exportedAt: new Date().toISOString(),
        guild: {
            id: String(guildId),
            name: String(guildName || guildId),
        },
        config: sanitizeConfig(config),
    };
    const content = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return new AttachmentBuilder(content, {
        name: `wn-helper-config-${guildId}.json`,
        description: 'Экспорт сохранённой конфигурации WN Helper',
    });
}

module.exports = {
    buildConfigExport,
    sanitizeConfig,
};
