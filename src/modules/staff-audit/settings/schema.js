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
const STAFF_AUDIT_SETTING_DEFINITIONS = [
    { key: 'channelId', label: 'Основной канал КА', valueType: 'channel' },
    { key: 'deleteRequestChannelId', label: 'Канал запросов на удаление', valueType: 'channel' },
    { key: 'deleteNotifyRoleIds', label: 'Роли уведомления об удалении', valueType: 'roles' },
    { key: 'departmentTransitionRankNumber', label: 'Ранг выхода из стажировочного отдела', valueType: 'rank' },
    { key: 'dismissalKeepRoleIds', label: 'Роли, сохраняемые при увольнении', valueType: 'roles' },
    { key: 'massAuditMaxItems', label: 'Максимум операций в одном массовом КА', valueType: 'integer' },
    { key: 'dismissalApprovalChannelId', label: 'Канал подтверждения увольнений', valueType: 'channel' },
    { key: 'dismissalApprovalRoleIds', label: 'Роли подтверждения увольнений', valueType: 'roles' },
    { key: 'dismissalLimitExemptRoleIds', label: 'Роли без лимита увольнений', valueType: 'roles' },
    { key: 'dismissalLimitCount', label: 'Лимит увольнений на исполнителя', valueType: 'integer' },
    { key: 'dismissalLimitWindowMinutes', label: 'Окно лимита увольнений, минуты', valueType: 'integer' },
    { key: 'promotionLimitBypassRoleIds', label: 'Роли без дневного лимита повышений', valueType: 'roles' },
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

function normalizePositiveInteger(value, fallback) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function getStaffAuditSettings(config) {
    const configured = config?.staffAuditSettings;

    return {
        channelId: normalizeId(configured?.channelId),
        deleteRequestChannelId: normalizeId(configured?.deleteRequestChannelId),
        deleteNotifyRoleIds: normalizeIdList(configured?.deleteNotifyRoleIds),
        departmentTransitionRankNumber: normalizeRankNumber(configured?.departmentTransitionRankNumber),
        dismissalKeepRoleIds: normalizeIdList(configured?.dismissalKeepRoleIds),
        massAuditMaxItems: normalizePositiveInteger(configured?.massAuditMaxItems, 25),
        dismissalApprovalChannelId: normalizeId(configured?.dismissalApprovalChannelId),
        dismissalApprovalRoleIds: normalizeIdList(configured?.dismissalApprovalRoleIds),
        dismissalLimitExemptRoleIds: normalizeIdList(configured?.dismissalLimitExemptRoleIds),
        dismissalLimitCount: normalizePositiveInteger(configured?.dismissalLimitCount, 3),
        dismissalLimitWindowMinutes: normalizePositiveInteger(configured?.dismissalLimitWindowMinutes, 60),
        promotionLimitBypassRoleIds: normalizeIdList(configured?.promotionLimitBypassRoleIds),
    };
}

function prepareStaffAuditSettingsForStorage(settings) {
    return getStaffAuditSettings({ staffAuditSettings: settings });
}

function getStaffAuditSettingsChanges(beforeSettings, afterSettings) {
    const before = prepareStaffAuditSettingsForStorage(beforeSettings);
    const after = prepareStaffAuditSettingsForStorage(afterSettings);
    const changes = [];

    for (const definition of STAFF_AUDIT_SETTING_DEFINITIONS) {
        const { key, label, valueType } = definition;

        if (valueType === 'roles') {
            const previous = new Set(before[key]);
            const next = new Set(after[key]);

            for (const roleId of after[key]) {
                if (!previous.has(roleId)) {
                    changes.push({ section: 'staffAudit', action: 'roleAdded', key, label, roleId });
                }
            }

            for (const roleId of before[key]) {
                if (!next.has(roleId)) {
                    changes.push({ section: 'staffAudit', action: 'roleRemoved', key, label, roleId });
                }
            }
            continue;
        }

        if (before[key] === after[key]) continue;
        changes.push({
            section: 'staffAudit',
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
    STAFF_AUDIT_SETTING_DEFINITIONS,
    getStaffAuditSettings,
    getStaffAuditSettingsChanges,
    prepareStaffAuditSettingsForStorage,
};
