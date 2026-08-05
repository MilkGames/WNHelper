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
const DEFAULT_SHIFT_COLOR = '#F1C40F';
const DEFAULT_PUBLICATION_TIME = '21:00';
const DEFAULT_RANDOM_PUBLICATION_FROM_TIME = '20:00';
const DEFAULT_RANDOM_PUBLICATION_TO_TIME = '22:00';
const PUBLICATION_MODES = Object.freeze({
    FIXED: 'fixed',
    RANDOM: 'random',
});
const DEFAULT_SLOT_START_TIME = '10:00';
const DEFAULT_SLOT_END_TIME = '23:00';
const DEFAULT_SHIFT_HEADER = '✅ {name} на {date}:';
const MAX_SHIFT_SLOTS = 100;

function clone(value) {
    return value == null ? value : structuredClone(value);
}

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
    ));
}

function normalizeText(value) {
    return String(value || '').trim();
}

function normalizeColor(value, fallback = DEFAULT_SHIFT_COLOR) {
    const text = normalizeText(value);
    if (!text) return fallback;
    const normalized = text.startsWith('#') ? text : `#${text}`;
    return /^#[0-9A-F]{6}$/i.test(normalized) ? normalized.toUpperCase() : fallback;
}

function normalizeTime(value, fallback) {
    const text = normalizeText(value);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) return fallback;
    return text;
}

function normalizeInteger(value, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= min && number <= max ? number : fallback;
}

function timeToMinutes(value) {
    const normalized = normalizeTime(value, null);
    if (!normalized) return null;
    const [hours, minutes] = normalized.split(':').map(Number);
    return hours * 60 + minutes;
}


function normalizePublicationMode(value) {
    return value === PUBLICATION_MODES.RANDOM
        ? PUBLICATION_MODES.RANDOM
        : PUBLICATION_MODES.FIXED;
}

function addMinutesToTime(value, minutesToAdd) {
    const minutes = timeToMinutes(value);
    if (minutes === null) return null;
    const normalized = ((minutes + Number(minutesToAdd || 0)) % 1_440 + 1_440) % 1_440;
    return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}

function getScheduleDurationMinutes(schedule = {}) {
    const start = timeToMinutes(schedule.startTime);
    const end = timeToMinutes(schedule.endTime);
    if (start === null || end === null) return null;
    return end > start ? end - start : (24 * 60 - start) + end;
}

function getShiftSlotCount(shiftType) {
    const duration = getScheduleDurationMinutes(shiftType?.schedule);
    const slotDuration = Number(shiftType?.schedule?.slotDurationMinutes);
    if (!duration || !Number.isSafeInteger(slotDuration) || slotDuration <= 0) return 0;
    return Math.ceil(duration / slotDuration);
}

function normalizeAccessGroup(group) {
    const source = group && typeof group === 'object' ? group : {};
    return {
        id: normalizeText(source.id),
        name: normalizeText(source.name),
        delayMinutes: normalizeInteger(source.delayMinutes, 0, { min: 0, max: 10_080 }),
        roleIds: normalizeIdList(source.roleIds),
    };
}

function normalizeShiftType(shiftType) {
    const source = shiftType && typeof shiftType === 'object' ? shiftType : {};
    const publication = source.publication && typeof source.publication === 'object'
        ? source.publication
        : {};
    const schedule = source.schedule && typeof source.schedule === 'object'
        ? source.schedule
        : {};

    const publicationMode = normalizePublicationMode(publication.mode);
    const normalizedPublication = publicationMode === PUBLICATION_MODES.RANDOM
        ? {
            mode: PUBLICATION_MODES.RANDOM,
            fromTime: normalizeTime(
                publication.fromTime,
                normalizeTime(publication.time, DEFAULT_RANDOM_PUBLICATION_FROM_TIME)
            ),
            toTime: normalizeTime(publication.toTime, DEFAULT_RANDOM_PUBLICATION_TO_TIME),
        }
        : {
            mode: PUBLICATION_MODES.FIXED,
            time: normalizeTime(publication.time, DEFAULT_PUBLICATION_TIME),
        };

    return {
        id: normalizeText(source.id),
        name: normalizeText(source.name),
        headerTemplate: normalizeText(source.headerTemplate) || DEFAULT_SHIFT_HEADER,
        enabled: source.enabled === true,
        channelId: normalizeId(source.channelId),
        color: normalizeColor(source.color),
        publication: normalizedPublication,
        schedule: {
            startTime: normalizeTime(schedule.startTime, DEFAULT_SLOT_START_TIME),
            endTime: normalizeTime(schedule.endTime, DEFAULT_SLOT_END_TIME),
            slotDurationMinutes: normalizeInteger(
                schedule.slotDurationMinutes,
                60,
                { min: 5, max: 1_440 }
            ),
        },
        maxSlotsPerMember: normalizeInteger(source.maxSlotsPerMember, 1, { min: 0, max: MAX_SHIFT_SLOTS }),
        rotateAccessDaily: source.rotateAccessDaily === true,
        accessGroups: (Array.isArray(source.accessGroups) ? source.accessGroups : [])
            .map(normalizeAccessGroup),
        managerRoleIds: normalizeIdList(source.managerRoleIds),
    };
}

function getShiftTypes(config) {
    return (Array.isArray(config?.shiftTypes) ? config.shiftTypes : [])
        .map(normalizeShiftType);
}

function prepareShiftTypesForStorage(shiftTypes) {
    return (Array.isArray(shiftTypes) ? shiftTypes : []).map(normalizeShiftType);
}

function getShiftTypeChanges(beforeTypes, afterTypes) {
    const before = prepareShiftTypesForStorage(beforeTypes);
    const after = prepareShiftTypesForStorage(afterTypes);
    const changes = [];
    const beforeById = new Map(before.map((type, index) => [type.id, { type, index }]));
    const afterById = new Map(after.map((type, index) => [type.id, { type, index }]));

    const scalarFields = [
        ['name', 'название', 'text'],
        ['headerTemplate', 'шапка сообщения', 'text'],
        ['enabled', 'состояние', 'boolean'],
        ['channelId', 'канал', 'channel'],
        ['color', 'цвет', 'color'],
        ['publication.mode', 'режим публикации', 'text'],
        ['publication.time', 'время публикации', 'text'],
        ['publication.fromTime', 'начало окна публикации', 'text'],
        ['publication.toTime', 'конец окна публикации', 'text'],
        ['schedule.startTime', 'начало смен', 'text'],
        ['schedule.endTime', 'конец смен', 'text'],
        ['schedule.slotDurationMinutes', 'длительность слота', 'number'],
        ['maxSlotsPerMember', 'лимит смен на сотрудника', 'number'],
        ['rotateAccessDaily', 'ежедневная ротация доступа', 'boolean'],
    ];

    const read = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);

    for (const { type, index } of afterById.values()) {
        const previous = beforeById.get(type.id);
        if (!previous) {
            changes.push({
                section: 'shiftTypes',
                action: 'added',
                shiftTypeId: type.id,
                shiftTypeName: type.name,
                shiftType: clone(type),
                index,
            });
            continue;
        }

        if (previous.index !== index) {
            changes.push({
                section: 'shiftTypes',
                action: 'moved',
                shiftTypeId: type.id,
                shiftTypeName: type.name,
                before: previous.index,
                after: index,
            });
        }

        for (const [path, label, valueType] of scalarFields) {
            const previousValue = read(previous.type, path);
            const nextValue = read(type, path);
            if (previousValue === nextValue) continue;
            changes.push({
                section: 'shiftTypes',
                action: 'updated',
                shiftTypeId: type.id,
                shiftTypeName: type.name,
                key: path,
                label,
                valueType,
                before: previousValue,
                after: nextValue,
            });
        }

        for (const [key, label] of [
            ['managerRoleIds', 'роли управления'],
        ]) {
            const previousSet = new Set(previous.type[key]);
            const nextSet = new Set(type[key]);
            for (const roleId of type[key]) {
                if (!previousSet.has(roleId)) {
                    changes.push({
                        section: 'shiftTypes',
                        action: 'roleAdded',
                        shiftTypeId: type.id,
                        shiftTypeName: type.name,
                        key,
                        label,
                        roleId,
                    });
                }
            }
            for (const roleId of previous.type[key]) {
                if (!nextSet.has(roleId)) {
                    changes.push({
                        section: 'shiftTypes',
                        action: 'roleRemoved',
                        shiftTypeId: type.id,
                        shiftTypeName: type.name,
                        key,
                        label,
                        roleId,
                    });
                }
            }
        }

        const previousGroups = new Map(previous.type.accessGroups.map((group) => [group.id, group]));
        const nextGroups = new Map(type.accessGroups.map((group) => [group.id, group]));

        for (const group of type.accessGroups) {
            const previousGroup = previousGroups.get(group.id);
            if (!previousGroup) {
                changes.push({
                    section: 'shiftTypes',
                    action: 'accessGroupAdded',
                    shiftTypeId: type.id,
                    shiftTypeName: type.name,
                    group: clone(group),
                    groupId: group.id,
                    groupName: group.name,
                });
                continue;
            }

            for (const [key, label, valueType] of [
                ['name', 'название группы', 'text'],
                ['delayMinutes', 'задержка группы', 'number'],
            ]) {
                if (previousGroup[key] === group[key]) continue;
                changes.push({
                    section: 'shiftTypes',
                    action: 'accessGroupUpdated',
                    shiftTypeId: type.id,
                    shiftTypeName: type.name,
                    groupId: group.id,
                    groupName: group.name,
                    key,
                    label,
                    valueType,
                    before: previousGroup[key],
                    after: group[key],
                });
            }

            const previousRoles = new Set(previousGroup.roleIds);
            const nextRoles = new Set(group.roleIds);
            for (const roleId of group.roleIds) {
                if (!previousRoles.has(roleId)) {
                    changes.push({
                        section: 'shiftTypes',
                        action: 'accessGroupRoleAdded',
                        shiftTypeId: type.id,
                        shiftTypeName: type.name,
                        groupId: group.id,
                        groupName: group.name,
                        roleId,
                    });
                }
            }
            for (const roleId of previousGroup.roleIds) {
                if (!nextRoles.has(roleId)) {
                    changes.push({
                        section: 'shiftTypes',
                        action: 'accessGroupRoleRemoved',
                        shiftTypeId: type.id,
                        shiftTypeName: type.name,
                        groupId: group.id,
                        groupName: group.name,
                        roleId,
                    });
                }
            }
        }

        for (const group of previous.type.accessGroups) {
            if (nextGroups.has(group.id)) continue;
            changes.push({
                section: 'shiftTypes',
                action: 'accessGroupRemoved',
                shiftTypeId: type.id,
                shiftTypeName: type.name,
                group: clone(group),
                groupId: group.id,
                groupName: group.name,
            });
        }
    }

    for (const { type, index } of beforeById.values()) {
        if (afterById.has(type.id)) continue;
        changes.push({
            section: 'shiftTypes',
            action: 'removed',
            shiftTypeId: type.id,
            shiftTypeName: type.name,
            shiftType: clone(type),
            index,
        });
    }

    return changes;
}

function findShiftType(config, typeId) {
    const normalizedId = normalizeText(typeId);
    return getShiftTypes(config).find((type) => type.id === normalizedId) || null;
}

module.exports = {
    DEFAULT_SHIFT_COLOR,
    DEFAULT_PUBLICATION_TIME,
    DEFAULT_RANDOM_PUBLICATION_FROM_TIME,
    DEFAULT_RANDOM_PUBLICATION_TO_TIME,
    DEFAULT_SHIFT_HEADER,
    DEFAULT_SLOT_END_TIME,
    DEFAULT_SLOT_START_TIME,
    MAX_SHIFT_SLOTS,
    PUBLICATION_MODES,
    addMinutesToTime,
    findShiftType,
    getScheduleDurationMinutes,
    getShiftSlotCount,
    getShiftTypeChanges,
    getShiftTypes,
    normalizeAccessGroup,
    normalizeColor,
    normalizePublicationMode,
    normalizeShiftType,
    normalizeTime,
    prepareShiftTypesForStorage,
    timeToMinutes,
};
