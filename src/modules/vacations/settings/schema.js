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
const VACATION_ACCESS_GROUPS = [
    { key: 'staffAudit', label: 'Кадровый аудит' },
    { key: 'discipline', label: 'Взыскания' },
    { key: 'examination', label: 'Экзаменация' },
    { key: 'shifts', label: 'Смены' },
    { key: 'giveRoles', label: 'Выдача ролей' },
    { key: 'settings', label: 'Настройки' },
    { key: 'manualTools', label: 'Ручные инструменты' },
];
const VACATION_ACCESS_GROUP_KEYS = new Set(VACATION_ACCESS_GROUPS.map((entry) => entry.key));
const VACATION_EXCEED_MODES = new Set(['block', 'reroute']);
const VACATION_OVERDUE_ACTIONS = new Set(['notify', 'written', 'dismissal']);

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

function normalizeText(value, maxLength = 200) {
    return String(value || '').trim().slice(0, maxLength);
}

function normalizeNullablePositiveInteger(value) {
    if (!hasValue(value)) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function normalizePositiveInteger(value, fallback = 1, max = 366) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 && number <= max ? number : fallback;
}

function normalizeNonNegativeInteger(value, fallback = 0, max = 366) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 && number <= max ? number : fallback;
}

function normalizeTime(value, fallback = '23:59') {
    const text = String(value || '').trim();
    if (!/^\d{2}:\d{2}$/.test(text)) return fallback;
    const [hours, minutes] = text.split(':').map(Number);
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return fallback;
    return text;
}

function normalizeRoleRoute(route) {
    const source = route && typeof route === 'object' ? route : {};
    return {
        id: normalizeText(source.id, 60),
        name: normalizeText(source.name || 'Маршрут по роли', 100),
        applicantRoleIds: normalizeIdList(source.applicantRoleIds),
        approverRoleIds: normalizeIdList(source.approverRoleIds),
    };
}

function normalizeOverdueRule(rule) {
    const source = rule && typeof rule === 'object' ? rule : {};
    const action = VACATION_OVERDUE_ACTIONS.has(source.action) ? source.action : 'notify';
    return {
        id: normalizeText(source.id, 60),
        afterDays: normalizePositiveInteger(source.afterDays, 1, 365),
        time: normalizeTime(source.time, '23:59'),
        action,
        notifyRoleIds: action === 'notify' ? normalizeIdList(source.notifyRoleIds) : [],
        reason: normalizeText(source.reason, 500),
    };
}

function normalizeVacationType(type) {
    const source = type && typeof type === 'object' ? type : {};
    const exceedMode = VACATION_EXCEED_MODES.has(source.exceedMode)
        ? source.exceedMode
        : 'block';
    const blockedAccessGroups = Array.from(new Set(
        (Array.isArray(source.blockedAccessGroups) ? source.blockedAccessGroups : [])
            .map(String)
            .filter((key) => VACATION_ACCESS_GROUP_KEYS.has(key))
    )).sort();
    const overdueRules = (Array.isArray(source.overdueRules) ? source.overdueRules : [])
        .map(normalizeOverdueRule)
        .filter((rule) => rule.id)
        .sort((left, right) => (
            left.afterDays - right.afterDays || left.time.localeCompare(right.time)
        ));

    return {
        id: normalizeText(source.id, 60),
        name: normalizeText(source.name || 'Отпуск', 100),
        enabled: source.enabled !== false,
        availability: {
            minRankNumber: normalizeNullablePositiveInteger(source.availability?.minRankNumber),
            allowNoDepartment: source.availability?.allowNoDepartment === true,
            roleIds: normalizeIdList(source.availability?.roleIds),
        },
        minDurationDays: normalizePositiveInteger(source.minDurationDays, 1, 366),
        maxDurationDays: normalizeNonNegativeInteger(source.maxDurationDays, 0, 366),
        monthlyLimitDays: normalizeNonNegativeInteger(source.monthlyLimitDays, 0, 366),
        exceedMode,
        exceedApproverRoleIds: exceedMode === 'reroute'
            ? normalizeIdList(source.exceedApproverRoleIds)
            : [],
        vacationRoleId: normalizeId(source.vacationRoleId),
        removeRoleIdsOnStart: normalizeIdList(source.removeRoleIdsOnStart),
        conditionalRemoveMinDurationDays: normalizeNonNegativeInteger(source.conditionalRemoveMinDurationDays, 0, 366),
        conditionalRemoveRoleIdsOnStart: normalizeIdList(source.conditionalRemoveRoleIdsOnStart),
        releaseShiftsOnStart: source.releaseShiftsOnStart !== false,
        releaseExaminationAssignmentsOnStart: source.releaseExaminationAssignmentsOnStart !== false,
        closeSettingsSessionOnStart: source.closeSettingsSessionOnStart === true,
        pauseDisciplineDeadlines: source.pauseDisciplineDeadlines === true,
        blockedAccessGroups,
        accessBypassRoleIds: normalizeIdList(source.accessBypassRoleIds),
        overdueRules,
    };
}

function getVacationSettings(config) {
    const source = config?.vacationSettings && typeof config.vacationSettings === 'object'
        ? config.vacationSettings
        : {};
    return {
        requestChannelId: normalizeId(source.requestChannelId),
        noDepartmentApproverRoleIds: normalizeIdList(source.noDepartmentApproverRoleIds),
        upperLeadershipRoleIds: normalizeIdList(source.upperLeadershipRoleIds),
        roleRoutes: (Array.isArray(source.roleRoutes) ? source.roleRoutes : [])
            .map(normalizeRoleRoute)
            .filter((route) => route.id),
        types: (Array.isArray(source.types) ? source.types : [])
            .map(normalizeVacationType)
            .filter((type) => type.id),
    };
}

function prepareVacationSettingsForStorage(settings) {
    return getVacationSettings({ vacationSettings: settings });
}

function getVacationSettingsChanges(beforeSettings, afterSettings) {
    const before = prepareVacationSettingsForStorage(beforeSettings);
    const after = prepareVacationSettingsForStorage(afterSettings);
    if (JSON.stringify(before) === JSON.stringify(after)) return [];

    const changes = [];
    if (before.requestChannelId !== after.requestChannelId) {
        changes.push({
            section: 'vacations',
            label: 'Канал заявок',
            valueType: 'channel',
            before: before.requestChannelId,
            after: after.requestChannelId,
        });
    }
    for (const [key, label] of [
        ['noDepartmentApproverRoleIds', 'Согласование без отдела'],
        ['upperLeadershipRoleIds', 'Верхнее руководство'],
    ]) {
        if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
            changes.push({ section: 'vacations', label, valueType: 'roles', before: before[key], after: after[key] });
        }
    }

    const beforeRoutes = new Map(before.roleRoutes.map((entry) => [entry.id, entry]));
    const afterRoutes = new Map(after.roleRoutes.map((entry) => [entry.id, entry]));
    for (const route of after.roleRoutes) {
        const previous = beforeRoutes.get(route.id);
        if (!previous) changes.push({ section: 'vacations', action: 'routeAdded', route });
        else if (JSON.stringify(previous) !== JSON.stringify(route)) {
            changes.push({ section: 'vacations', action: 'routeUpdated', before: previous, after: route });
        }
    }
    for (const route of before.roleRoutes) {
        if (!afterRoutes.has(route.id)) changes.push({ section: 'vacations', action: 'routeRemoved', route });
    }
    const beforeRoutePositions = new Map(before.roleRoutes.map((entry, index) => [entry.id, index]));
    after.roleRoutes.forEach((route, index) => {
        const previousIndex = beforeRoutePositions.get(route.id);
        if (previousIndex !== undefined && previousIndex !== index) {
            changes.push({
                section: 'vacations',
                action: 'routeMoved',
                route,
                before: previousIndex,
                after: index,
            });
        }
    });

    const beforeTypes = new Map(before.types.map((entry) => [entry.id, entry]));
    const afterTypes = new Map(after.types.map((entry) => [entry.id, entry]));
    for (const type of after.types) {
        const previous = beforeTypes.get(type.id);
        if (!previous) changes.push({ section: 'vacations', action: 'typeAdded', vacationType: type });
        else if (JSON.stringify(previous) !== JSON.stringify(type)) {
            changes.push({ section: 'vacations', action: 'typeUpdated', before: previous, after: type });
        }
    }
    for (const type of before.types) {
        if (!afterTypes.has(type.id)) changes.push({ section: 'vacations', action: 'typeRemoved', vacationType: type });
    }
    return changes;
}

module.exports = {
    VACATION_ACCESS_GROUPS,
    VACATION_ACCESS_GROUP_KEYS,
    VACATION_EXCEED_MODES,
    VACATION_OVERDUE_ACTIONS,
    getVacationSettings,
    getVacationSettingsChanges,
    normalizeOverdueRule,
    normalizeRoleRoute,
    normalizeVacationType,
    prepareVacationSettingsForStorage,
};
