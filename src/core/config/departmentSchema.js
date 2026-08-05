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
const DEPARTMENT_ROLE_DEFINITIONS = [
    { key: 'memberRoleId', label: 'Основная роль отдела' },
    { key: 'partTimeRoleId', label: 'Роль подработки' },
    { key: 'curatorRoleId', label: 'Роль куратора' },
    { key: 'headRoleId', label: 'Роль главы отдела' },
    { key: 'deputyHeadRoleId', label: 'Роль заместителя главы' },
];

function hasValue(value) {
    return value !== null && value !== undefined && value !== '';
}

function normalizeId(value) {
    return hasValue(value) ? String(value) : null;
}

function normalizeText(value) {
    return String(value || '').trim();
}

function normalizeNonNegativeInteger(value, fallback = 1) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function normalizeDepartmentColor(value) {
    if (Number.isSafeInteger(value) && value >= 0 && value <= 0xFFFFFF) {
        return `#${value.toString(16).padStart(6, '0').toUpperCase()}`;
    }

    const text = String(value || '').trim();
    if (!text) return null;

    const normalized = text.startsWith('#') ? text : `#${text}`;
    return /^#[0-9A-F]{6}$/i.test(normalized) ? normalized.toUpperCase() : null;
}

function normalizeDepartment(department) {
    const source = department && typeof department === 'object' ? department : {};
    const roles = source.roles && typeof source.roles === 'object' ? source.roles : {};
    const limits = source.limits && typeof source.limits === 'object' ? source.limits : {};

    return {
        id: normalizeText(source.id),
        shortName: normalizeText(source.shortName),
        fullName: normalizeText(source.fullName),
        staffChannelId: normalizeId(source.staffChannelId),
        color: normalizeDepartmentColor(source.color),
        curatorsEnabled: source.curatorsEnabled === true,
        roles: {
            memberRoleId: normalizeId(roles.memberRoleId),
            partTimeRoleId: normalizeId(roles.partTimeRoleId),
            curatorRoleId: normalizeId(roles.curatorRoleId),
            headRoleId: normalizeId(roles.headRoleId),
            deputyHeadRoleId: normalizeId(roles.deputyHeadRoleId),
        },
        limits: {
            heads: normalizeNonNegativeInteger(limits.heads, 1),
            deputyHeads: normalizeNonNegativeInteger(limits.deputyHeads, 1),
        },
    };
}

function getDepartments(config) {
    return (Array.isArray(config?.departments) ? config.departments : []).map(normalizeDepartment);
}

function prepareDepartmentsForStorage(departments) {
    return (Array.isArray(departments) ? departments : []).map(normalizeDepartment);
}

function getDepartmentFieldChanges(beforeDepartment, afterDepartment) {
    const before = normalizeDepartment(beforeDepartment);
    const after = normalizeDepartment(afterDepartment);
    const changes = [];

    const fields = [
        { path: 'shortName', label: 'Сокращение', type: 'text' },
        { path: 'fullName', label: 'Полное название', type: 'text' },
        { path: 'staffChannelId', label: 'Канал состава', type: 'channel' },
        { path: 'color', label: 'Цвет состава', type: 'color' },
        { path: 'curatorsEnabled', label: 'Кураторы отдела', type: 'boolean' },
        ...DEPARTMENT_ROLE_DEFINITIONS.map(({ key, label }) => ({
            path: `roles.${key}`,
            label,
            type: 'role',
        })),
        { path: 'limits.heads', label: 'Лимит глав отдела', type: 'number' },
        { path: 'limits.deputyHeads', label: 'Лимит заместителей главы', type: 'number' },
    ];

    function read(object, path) {
        return path.split('.').reduce((value, key) => value?.[key], object);
    }

    for (const field of fields) {
        const previousValue = read(before, field.path);
        const nextValue = read(after, field.path);
        if (previousValue === nextValue) continue;

        changes.push({
            section: 'departments',
            action: 'updated',
            departmentId: after.id,
            departmentName: after.shortName || after.fullName || after.id,
            field: field.path,
            label: field.label,
            valueType: field.type,
            before: previousValue,
            after: nextValue,
        });
    }

    return changes;
}

function getDepartmentChanges(beforeDepartments, afterDepartments) {
    const before = prepareDepartmentsForStorage(beforeDepartments);
    const after = prepareDepartmentsForStorage(afterDepartments);
    const beforeById = new Map(before.map((department) => [department.id, department]));
    const afterById = new Map(after.map((department) => [department.id, department]));
    const changes = [];

    for (const department of after) {
        const previous = beforeById.get(department.id);
        if (!previous) {
            changes.push({
                section: 'departments',
                action: 'added',
                departmentId: department.id,
                departmentName: department.shortName || department.fullName || department.id,
                department: structuredClone(department),
            });
            continue;
        }

        changes.push(...getDepartmentFieldChanges(previous, department));
    }

    for (const department of before) {
        if (afterById.has(department.id)) continue;
        changes.push({
            section: 'departments',
            action: 'removed',
            departmentId: department.id,
            departmentName: department.shortName || department.fullName || department.id,
            department: structuredClone(department),
        });
    }

    return changes;
}

module.exports = {
    DEPARTMENT_ROLE_DEFINITIONS,
    getDepartmentChanges,
    getDepartments,
    normalizeDepartment,
    normalizeDepartmentColor,
    prepareDepartmentsForStorage,
};
