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
const CHANNEL_COUNTER_SETTING_DEFINITIONS = [
    {
        key: 'employeesChannelId',
        label: 'Счётчик сотрудников WN',
        valueType: 'channel',
    },
    {
        key: 'membersChannelId',
        label: 'Счётчик участников сервера',
        valueType: 'channel',
    },
];

function hasValue(value) {
    return value !== null && value !== undefined && value !== '';
}

function normalizeId(value) {
    return hasValue(value) ? String(value) : null;
}

function getChannelCounterSettings(config) {
    const source = config?.channelCounterSettings && typeof config.channelCounterSettings === 'object'
        ? config.channelCounterSettings
        : {};

    return {
        employeesChannelId: normalizeId(source.employeesChannelId),
        membersChannelId: normalizeId(source.membersChannelId),
    };
}

function prepareChannelCounterSettingsForStorage(settings) {
    return getChannelCounterSettings({ channelCounterSettings: settings });
}

function getChannelCounterSettingsChanges(beforeSettings, afterSettings) {
    const before = prepareChannelCounterSettingsForStorage(beforeSettings);
    const after = prepareChannelCounterSettingsForStorage(afterSettings);
    const changes = [];

    for (const definition of CHANNEL_COUNTER_SETTING_DEFINITIONS) {
        if (before[definition.key] === after[definition.key]) continue;

        changes.push({
            section: 'channelCounters',
            action: 'updated',
            key: definition.key,
            label: definition.label,
            valueType: definition.valueType,
            before: before[definition.key],
            after: after[definition.key],
        });
    }

    return changes;
}

module.exports = {
    CHANNEL_COUNTER_SETTING_DEFINITIONS,
    getChannelCounterSettings,
    getChannelCounterSettingsChanges,
    prepareChannelCounterSettingsForStorage,
};
