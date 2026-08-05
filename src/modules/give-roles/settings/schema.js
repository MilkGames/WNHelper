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
const GIVE_ROLES_SETTING_DEFINITIONS = [
    { key: 'inviteDepartmentId', label: 'Отдел при принятии', valueType: 'department' },
    { key: 'dbRankNumber', label: 'Ранг при ДБ', valueType: 'rank' },
    { key: 'dbAdditionalRoleIds', label: 'Дополнительные роли при ДБ', valueType: 'roles' },
    { key: 'reviewerRoleIds', label: 'Роли обработки заявок', valueType: 'roles' },
    { key: 'blockerRoleIds', label: 'Роли блокировки заявителей', valueType: 'roles' },
];

function hasValue(value) {
    return value !== null && value !== undefined && value !== '';
}

function normalizeId(value) {
    return hasValue(value) ? String(value).trim() || null : null;
}

function normalizeIdList(values) {
    return Array.from(new Set(
        (Array.isArray(values) ? values : [])
            .map((value) => String(value || '').trim())
            .filter(Boolean)
    )).sort();
}

function normalizeRankNumber(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function getGiveRolesSettings(config) {
    const configured = config?.giveRolesSettings;

    return {
        dbRankNumber: normalizeRankNumber(configured?.dbRankNumber),
        dbAdditionalRoleIds: normalizeIdList(configured?.dbAdditionalRoleIds),
        inviteDepartmentId: normalizeId(configured?.inviteDepartmentId),
        reviewerRoleIds: normalizeIdList(configured?.reviewerRoleIds),
        blockerRoleIds: normalizeIdList(configured?.blockerRoleIds),
    };
}

function prepareGiveRolesSettingsForStorage(settings) {
    return getGiveRolesSettings({ giveRolesSettings: settings });
}

function getGiveRolesSettingsChanges(beforeSettings, afterSettings) {
    const before = prepareGiveRolesSettingsForStorage(beforeSettings);
    const after = prepareGiveRolesSettingsForStorage(afterSettings);
    const changes = [];

    for (const definition of GIVE_ROLES_SETTING_DEFINITIONS) {
        const { key, label, valueType } = definition;

        if (valueType === 'roles') {
            const previous = new Set(before[key]);
            const next = new Set(after[key]);

            for (const roleId of after[key]) {
                if (!previous.has(roleId)) {
                    changes.push({
                        section: 'giveRoles',
                        action: 'roleAdded',
                        key,
                        label,
                        roleId,
                    });
                }
            }

            for (const roleId of before[key]) {
                if (!next.has(roleId)) {
                    changes.push({
                        section: 'giveRoles',
                        action: 'roleRemoved',
                        key,
                        label,
                        roleId,
                    });
                }
            }
            continue;
        }

        if (before[key] === after[key]) continue;
        changes.push({
            section: 'giveRoles',
            action: 'updated',
            key,
            label,
            before: before[key],
            after: after[key],
            valueType,
        });
    }

    return changes;
}

module.exports = {
    GIVE_ROLES_SETTING_DEFINITIONS,
    getGiveRolesSettings,
    getGiveRolesSettingsChanges,
    prepareGiveRolesSettingsForStorage,
};
