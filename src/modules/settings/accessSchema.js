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
const SETTINGS_SECTION_DEFINITIONS = [
    { key: 'features', label: 'Функции' },
    { key: 'channels', label: 'Каналы' },
    { key: 'commonRoles', label: 'Общие роли' },
    { key: 'departments', label: 'Отделы' },
    { key: 'ranks', label: 'Ранги' },
    { key: 'exams', label: 'Экзаменация' },
    { key: 'giveRoles', label: 'Выдача ролей' },
    { key: 'staffAudit', label: 'Кадровый аудит' },
    { key: 'staffLists', label: 'Составы' },
    { key: 'channelCounters', label: 'Счётчики' },
    { key: 'shiftTypes', label: 'Смены' },
    { key: 'discipline', label: 'Взыскания' },
    { key: 'vacations', label: 'Отпуска' },
    { key: 'diagnostics', label: 'Диагностика' },
    { key: 'publications', label: 'Публикации' },
];

const SETTINGS_SECTION_KEYS = new Set(SETTINGS_SECTION_DEFINITIONS.map((entry) => entry.key));

function normalizeRoleId(value) {
    const result = String(value || '').trim();
    return result || null;
}

function normalizeSectionKeys(values) {
    return Array.from(new Set(
        (Array.isArray(values) ? values : [])
            .map((value) => String(value || '').trim())
            .filter((value) => SETTINGS_SECTION_KEYS.has(value))
    )).sort();
}

function normalizeSettingsSectionAccess(entries) {
    const byRole = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
        const roleId = normalizeRoleId(entry?.roleId);
        if (!roleId) continue;
        const previous = byRole.get(roleId) || [];
        byRole.set(roleId, normalizeSectionKeys([...previous, ...(entry?.sectionKeys || [])]));
    }

    return [...byRole.entries()]
        .map(([roleId, sectionKeys]) => ({ roleId, sectionKeys }))
        .filter((entry) => entry.sectionKeys.length > 0)
        .sort((left, right) => left.roleId.localeCompare(right.roleId));
}

function getSettingsAccessChanges(beforeEntries, afterEntries) {
    const before = new Map(normalizeSettingsSectionAccess(beforeEntries)
        .map((entry) => [entry.roleId, entry.sectionKeys]));
    const after = new Map(normalizeSettingsSectionAccess(afterEntries)
        .map((entry) => [entry.roleId, entry.sectionKeys]));
    const roleIds = new Set([...before.keys(), ...after.keys()]);
    const changes = [];

    for (const roleId of roleIds) {
        const previous = before.get(roleId) || [];
        const next = after.get(roleId) || [];
        if (JSON.stringify(previous) === JSON.stringify(next)) continue;
        changes.push({
            section: 'access',
            key: 'settingsSectionAccess',
            label: 'Ограниченный доступ к /settings',
            roleId,
            before: previous,
            after: next,
            valueType: 'settingsSections',
        });
    }

    return changes;
}

module.exports = {
    SETTINGS_SECTION_DEFINITIONS,
    SETTINGS_SECTION_KEYS,
    getSettingsAccessChanges,
    normalizeSettingsSectionAccess,
};
