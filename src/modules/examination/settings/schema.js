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
const DEFAULT_VOICE_JOIN_TIMEOUT_MINUTES = 10;
const MAX_VOICE_JOIN_TIMEOUT_MINUTES = 180;
const MAX_LECTURE_PING_ROLES = 10;
const MAX_PENDING_REMINDER_MINUTES = 1440;

function normalizeText(value) {
    return String(value || '').trim();
}

function normalizeId(value) {
    const normalized = normalizeText(value);
    return normalized || null;
}

function normalizeIdArray(values, limit = 25) {
    return Array.from(new Set(
        (Array.isArray(values) ? values : [])
            .map(normalizeId)
            .filter(Boolean)
    )).slice(0, limit);
}

function normalizePendingReminderMinutes(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 && number <= MAX_PENDING_REMINDER_MINUTES
        ? number
        : 0;
}

function normalizeVoiceJoinTimeoutMinutes(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 1 && number <= MAX_VOICE_JOIN_TIMEOUT_MINUTES
        ? number
        : DEFAULT_VOICE_JOIN_TIMEOUT_MINUTES;
}

function normalizeLectureType(value) {
    const source = value && typeof value === 'object' ? value : {};
    const departmentId = normalizeId(source.departmentId);
    return {
        id: normalizeText(source.id),
        name: normalizeText(source.name),
        departmentId,
        pingRoleIds: departmentId
            ? []
            : normalizeIdArray(source.pingRoleIds, MAX_LECTURE_PING_ROLES),
    };
}

function normalizeLectureTypes(values) {
    return (Array.isArray(values) ? values : [])
        .map(normalizeLectureType);
}

function normalizeExaminationSettings(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        lectureRequestChannelId: normalizeId(source.lectureRequestChannelId),
        retestRequestChannelId: normalizeId(source.retestRequestChannelId),
        lectureResultChannelId: normalizeId(source.lectureResultChannelId),
        retestResultChannelId: normalizeId(source.retestResultChannelId),
        lectureVoiceChannelId: normalizeId(source.lectureVoiceChannelId),
        retestVoiceChannelId: normalizeId(source.retestVoiceChannelId),
        voiceJoinTimeoutMinutes: normalizeVoiceJoinTimeoutMinutes(source.voiceJoinTimeoutMinutes),
        pendingReminderMinutes: normalizePendingReminderMinutes(source.pendingReminderMinutes),
        lectureTypes: normalizeLectureTypes(source.lectureTypes),
    };
}

function getExaminationSettings(config) {
    return normalizeExaminationSettings(config?.examinationSettings);
}

function prepareExaminationSettingsForStorage(value) {
    return normalizeExaminationSettings(value);
}

function pushSimpleChange(changes, before, after, key, label, valueType) {
    if (before[key] === after[key]) return;
    changes.push({
        section: 'examination',
        action: 'updated',
        key,
        label,
        valueType,
        before: before[key],
        after: after[key],
    });
}

function getExaminationSettingsChanges(beforeValue, afterValue) {
    const before = normalizeExaminationSettings(beforeValue);
    const after = normalizeExaminationSettings(afterValue);
    const changes = [];

    for (const [key, label] of [
        ['lectureRequestChannelId', 'Канал заявок на лекции'],
        ['retestRequestChannelId', 'Канал заявок на пересдачи'],
        ['lectureResultChannelId', 'Канал итогов лекций'],
        ['retestResultChannelId', 'Отдельный канал итогов пересдач'],
        ['lectureVoiceChannelId', 'Голосовой канал лекций'],
        ['retestVoiceChannelId', 'Голосовой канал пересдач'],
    ]) {
        pushSimpleChange(changes, before, after, key, label, 'channel');
    }
    pushSimpleChange(
        changes,
        before,
        after,
        'voiceJoinTimeoutMinutes',
        'Время ожидания входа в голосовой канал',
        'number'
    );
    pushSimpleChange(
        changes,
        before,
        after,
        'pendingReminderMinutes',
        'Повторный пинг по необработанной заявке',
        'number'
    );

    const beforeById = new Map(before.lectureTypes.map((entry, index) => [entry.id, { entry, index }]));
    const afterById = new Map(after.lectureTypes.map((entry, index) => [entry.id, { entry, index }]));

    for (const { entry, index } of afterById.values()) {
        const previous = beforeById.get(entry.id);
        if (!previous) {
            changes.push({
                section: 'examination',
                action: 'lectureTypeAdded',
                lectureTypeId: entry.id,
                lectureTypeName: entry.name,
                index,
            });
            continue;
        }

        for (const [key, label, valueType] of [
            ['name', 'название', 'text'],
            ['departmentId', 'отдел', 'department'],
        ]) {
            if (previous.entry[key] === entry[key]) continue;
            changes.push({
                section: 'examination',
                action: 'lectureTypeUpdated',
                lectureTypeId: entry.id,
                lectureTypeName: entry.name,
                key,
                label,
                before: previous.entry[key],
                after: entry[key],
                valueType,
            });
        }

        if (JSON.stringify(previous.entry.pingRoleIds) !== JSON.stringify(entry.pingRoleIds)) {
            changes.push({
                section: 'examination',
                action: 'lectureTypeUpdated',
                lectureTypeId: entry.id,
                lectureTypeName: entry.name,
                key: 'pingRoleIds',
                label: 'роли для пинга',
                before: previous.entry.pingRoleIds,
                after: entry.pingRoleIds,
                valueType: 'roles',
            });
        }

        if (previous.index !== index) {
            changes.push({
                section: 'examination',
                action: 'lectureTypeMoved',
                lectureTypeId: entry.id,
                lectureTypeName: entry.name,
                before: previous.index,
                after: index,
            });
        }
    }

    for (const { entry, index } of beforeById.values()) {
        if (afterById.has(entry.id)) continue;
        changes.push({
            section: 'examination',
            action: 'lectureTypeRemoved',
            lectureTypeId: entry.id,
            lectureTypeName: entry.name,
            index,
        });
    }

    return changes;
}

module.exports = {
    DEFAULT_VOICE_JOIN_TIMEOUT_MINUTES,
    MAX_LECTURE_PING_ROLES,
    MAX_PENDING_REMINDER_MINUTES,
    MAX_VOICE_JOIN_TIMEOUT_MINUTES,
    getExaminationSettings,
    getExaminationSettingsChanges,
    normalizeExaminationSettings,
    normalizeLectureType,
    prepareExaminationSettingsForStorage,
};
