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
const STAFF_LIST_SETTING_DEFINITIONS = [
    {
        key: 'highStaffChannelId',
        label: 'Канал руководящего состава',
        valueType: 'channel',
    },
    {
        key: 'leaderAppointmentDate',
        label: 'Дата назначения директора',
        valueType: 'date',
    },
    {
        key: 'leaderTermDays',
        label: 'Продолжительность срока директора',
        valueType: 'integer',
    },
    {
        key: 'curatorManagementRankNumbers',
        label: 'Ранги руководства для определения кураторов',
        valueType: 'rankList',
    },
];

function hasValue(value) {
    return value !== null && value !== undefined && value !== '';
}

function normalizeId(value) {
    return hasValue(value) ? String(value) : null;
}

function normalizeRankNumberList(values) {
    return Array.from(new Set(
        (Array.isArray(values) ? values : [])
            .map((value) => Number(value))
            .filter((value) => Number.isSafeInteger(value) && value > 0)
    )).sort((left, right) => left - right);
}

function normalizeTermDays(value) {
    return Number(value) === 31 ? 31 : 30;
}

function normalizeDate(value) {
    const normalized = String(value || '').trim();
    return normalized || null;
}

function getStaffListSettings(config) {
    const source = config?.staffListSettings && typeof config.staffListSettings === 'object'
        ? config.staffListSettings
        : {};

    return {
        highStaffChannelId: normalizeId(source.highStaffChannelId),
        leaderAppointmentDate: normalizeDate(source.leaderAppointmentDate),
        leaderTermDays: normalizeTermDays(source.leaderTermDays),
        curatorManagementRankNumbers: normalizeRankNumberList(source.curatorManagementRankNumbers),
    };
}

function prepareStaffListSettingsForStorage(settings) {
    return getStaffListSettings({ staffListSettings: settings });
}

function getStaffListSettingsChanges(beforeSettings, afterSettings) {
    const before = prepareStaffListSettingsForStorage(beforeSettings);
    const after = prepareStaffListSettingsForStorage(afterSettings);
    const changes = [];

    for (const definition of STAFF_LIST_SETTING_DEFINITIONS) {
        const previousValue = before[definition.key];
        const nextValue = after[definition.key];
        const unchanged = definition.valueType === 'rankList'
            ? JSON.stringify(previousValue) === JSON.stringify(nextValue)
            : previousValue === nextValue;
        if (unchanged) continue;

        changes.push({
            section: 'staffLists',
            action: 'updated',
            key: definition.key,
            label: definition.label,
            valueType: definition.valueType,
            before: previousValue,
            after: nextValue,
        });
    }

    return changes;
}

module.exports = {
    STAFF_LIST_SETTING_DEFINITIONS,
    getStaffListSettings,
    getStaffListSettingsChanges,
    prepareStaffListSettingsForStorage,
};
