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
const crypto = require('crypto');
const shiftSchedules = require('./database').shiftSchedules;
const shiftRotations = require('./database').shiftRotations;
const guildConfigService = require('../../core/config/guildConfigService');
const {
    findShiftType,
    getScheduleDurationMinutes,
    getShiftTypes,
    MAX_SHIFT_SLOTS,
    PUBLICATION_MODES,
    normalizeShiftType,
    timeToMinutes,
} = require('./settings/schema');
const {
    closeThreadWithRetry,
    editMessageWithRetry,
    runDiscordRequest,
    sendMessageWithRetry,
    startThreadWithRetry,
} = require('../../core/discord/request');
const logger = require('../../core/logging/logger');
const { MOSCOW_TIME_ZONE } = require('../../core/runtime/constants');
const FREE_SHIFT_VALUE = null;
const schedulerLocks = new Map();
const delayedGuildSyncs = new Map();
const publicationSkipLogKeys = new Set();
const {
    buildAccessLines,
    buildScheduleComponents,
    buildScheduleEmbed,
    buildScheduleEmbeds,
    buildSchedulePayload,
} = require('./presentation').createShiftPresentation({
    getCurrentAccessState,
    normalizeShiftType,
    renderShiftHeader,
});

function uniq(values) {
    return Array.from(new Set((Array.isArray(values) ? values : []).filter(Boolean)));
}

function getShiftTypeSignature(shiftType) {
    return crypto
        .createHash('sha1')
        .update(JSON.stringify(normalizeShiftType(shiftType)))
        .digest('hex');
}

function getAccessSignature(shiftType) {
    const type = normalizeShiftType(shiftType);
    return crypto
        .createHash('sha1')
        .update(JSON.stringify({
            accessGroups: type.accessGroups,
            rotateAccessDaily: type.rotateAccessDaily,
        }))
        .digest('hex');
}

function getPublicationSchedule(guildId, shiftType, publicationDateKey) {
    const type = normalizeShiftType(shiftType);
    if (type.publication.mode !== PUBLICATION_MODES.RANDOM) {
        const time = type.publication.time;
        return {
            publicationDateKey,
            actualDateKey: publicationDateKey,
            time,
            scheduledAt: getMoscowTimestamp(publicationDateKey, time),
        };
    }

    const fromMinutes = timeToMinutes(type.publication.fromTime);
    const toMinutes = timeToMinutes(type.publication.toTime);
    const durationMinutes = toMinutes >= fromMinutes
        ? toMinutes - fromMinutes
        : (1_440 - fromMinutes) + toMinutes;
    const randomValue = Number.parseInt(
        crypto
            .createHash('sha256')
            .update(`${guildId}:${type.id}:${publicationDateKey}:${type.publication.fromTime}:${type.publication.toTime}`)
            .digest('hex')
            .slice(0, 8),
        16
    );
    const selectedMinutes = fromMinutes + (randomValue % (durationMinutes + 1));
    const dayOffset = Math.floor(selectedMinutes / 1_440);
    const time = formatMinutes(selectedMinutes);
    const actualDateKey = addDaysToDateKey(publicationDateKey, dayOffset);
    return {
        publicationDateKey,
        actualDateKey,
        time,
        scheduledAt: getMoscowTimestamp(actualDateKey, time),
    };
}

function getPublicationReferenceTime(shiftType) {
    const type = normalizeShiftType(shiftType);
    return type.publication.mode === PUBLICATION_MODES.RANDOM
        ? type.publication.fromTime
        : type.publication.time;
}

function getMoscowParts(date = new Date()) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: MOSCOW_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    });
    const parts = Object.fromEntries(
        formatter.formatToParts(date)
            .filter((part) => part.type !== 'literal')
            .map((part) => [part.type, part.value])
    );
    return {
        dateKey: `${parts.year}-${parts.month}-${parts.day}`,
        time: `${parts.hour}:${parts.minute}`,
        hour: Number(parts.hour),
        minute: Number(parts.minute),
    };
}

function addDaysToDateKey(dateKey, days) {
    const [year, month, day] = String(dateKey).split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day + Number(days || 0)));
    return [
        date.getUTCFullYear(),
        String(date.getUTCMonth() + 1).padStart(2, '0'),
        String(date.getUTCDate()).padStart(2, '0'),
    ].join('-');
}

function getAutomaticScheduleDateKey(shiftType, publicationDateKey, publicationTime = null) {
    const type = normalizeShiftType(shiftType);
    const publicationMinutes = timeToMinutes(publicationTime || getPublicationReferenceTime(type));
    const startMinutes = timeToMinutes(type.schedule.startTime);
    const dayOffset = publicationMinutes < startMinutes ? 0 : 1;
    return addDaysToDateKey(publicationDateKey, dayOffset);
}

function getNearestUpcomingScheduleDateKey(shiftType, date = new Date()) {
    const type = normalizeShiftType(shiftType);
    const moscow = getMoscowParts(date);
    const currentMinutes = moscow.hour * 60 + moscow.minute;
    const startMinutes = timeToMinutes(type.schedule.startTime);
    return addDaysToDateKey(moscow.dateKey, currentMinutes < startMinutes ? 0 : 1);
}

function getScheduleMessageLink(record) {
    if (!record?.messageId || !record?.channelId || !record?.guildId) return null;
    return `https://discord.com/channels/${record.guildId}/${record.channelId}/${record.messageId}`;
}

function logPublicationSkipOnce(shiftType, record, reason) {
    const key = `${record.guildId}:${record.typeId}:${record.publicationDateKey || record.dateKey}`;
    if (publicationSkipLogKeys.has(key)) return;
    publicationSkipLogKeys.add(key);
    logger.info('Публикация расписания смен пропущена: сообщение за этот цикл уже существует', {
        guildId: record.guildId,
        shiftTypeId: record.typeId,
        shiftTypeName: shiftType.name,
        publicationDateKey: record.publicationDateKey || null,
        dateKey: record.dateKey,
        reason,
        messageId: record.messageId || null,
    });
}

function daysBetweenDateKeys(leftKey, rightKey) {
    const left = new Date(`${leftKey}T00:00:00Z`).getTime();
    const right = new Date(`${rightKey}T00:00:00Z`).getTime();
    return Math.floor((right - left) / 86_400_000);
}

function formatDateKey(dateKey) {
    const [year, month, day] = String(dateKey).split('-');
    return `${day}.${month}.${year}`;
}

function renderShiftHeader(shiftType, dateKey) {
    const type = normalizeShiftType(shiftType);
    return String(type.headerTemplate || '')
        .replaceAll('{name}', type.name)
        .replaceAll('{date}', formatDateKey(dateKey));
}

function getScheduleActiveUntil(shiftType, dateKey) {
    const type = normalizeShiftType(shiftType);
    const start = timeToMinutes(type.schedule.startTime);
    const end = timeToMinutes(type.schedule.endTime);
    const endDateKey = end <= start ? addDaysToDateKey(dateKey, 1) : dateKey;
    return getMoscowTimestamp(endDateKey, type.schedule.endTime);
}

function getRecordShiftType(record, currentShiftType = null) {
    return normalizeShiftType(currentShiftType || record?.typeSnapshot || {
        id: record?.typeId || 'shift',
        name: 'Смены',
        enabled: false,
    });
}

function getMoscowTimestamp(dateKey, time) {
    const normalizedDate = String(dateKey || '');
    const normalizedTime = String(time || '00:00');
    const timestamp = new Date(`${normalizedDate}T${normalizedTime}:00+03:00`).getTime();
    return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function formatMinutes(minutes) {
    const normalized = ((minutes % 1_440) + 1_440) % 1_440;
    const hours = Math.floor(normalized / 60);
    const remainder = normalized % 60;
    return `${String(hours).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function buildSlots(shiftType) {
    const type = normalizeShiftType(shiftType);
    const startMinutes = timeToMinutes(type.schedule.startTime);
    const durationMinutes = getScheduleDurationMinutes(type.schedule);
    const slotDuration = type.schedule.slotDurationMinutes;
    const slots = [];

    if (startMinutes === null || !durationMinutes || !slotDuration) return slots;

    let consumed = 0;
    let index = 0;
    while (consumed < durationMinutes && index < MAX_SHIFT_SLOTS) {
        const currentDuration = Math.min(slotDuration, durationMinutes - consumed);
        const slotStart = startMinutes + consumed;
        const slotEnd = slotStart + currentDuration;
        slots.push({
            id: `s${index + 1}`,
            number: index + 1,
            startTime: formatMinutes(slotStart),
            endTime: formatMinutes(slotEnd - 1),
            memberId: FREE_SHIFT_VALUE,
        });
        consumed += currentDuration;
        index += 1;
    }

    return slots;
}

function reconcileSlots(shiftType, currentSlots) {
    const nextSlots = buildSlots(shiftType);
    const assignments = new Map(
        (Array.isArray(currentSlots) ? currentSlots : []).map((slot) => [
            `${slot.startTime}:${slot.endTime}`,
            slot.memberId || FREE_SHIFT_VALUE,
        ])
    );
    for (const slot of nextSlots) {
        const key = `${slot.startTime}:${slot.endTime}`;
        if (assignments.has(key)) slot.memberId = assignments.get(key);
    }

    const previousComparable = (Array.isArray(currentSlots) ? currentSlots : []).map((slot) => ({
        id: slot.id,
        number: slot.number,
        startTime: slot.startTime,
        endTime: slot.endTime,
        memberId: slot.memberId || FREE_SHIFT_VALUE,
    }));
    return {
        changed: JSON.stringify(previousComparable) !== JSON.stringify(nextSlots),
        slots: nextSlots,
    };
}

function getElapsedMinutesSincePublication(record, nowMs = Date.now()) {
    if (!Number.isFinite(record?.publishedAt)) return 0;
    return Math.max(0, Math.floor((nowMs - record.publishedAt) / 60_000));
}

function rotate(values, offset) {
    if (!values.length) return [];
    const normalized = ((Number(offset || 0) % values.length) + values.length) % values.length;
    return [...values.slice(normalized), ...values.slice(0, normalized)];
}

function buildAccessPlan(shiftType, rotationIndex = 0) {
    const type = normalizeShiftType(shiftType);
    const groups = type.accessGroups;
    if (!groups.length) {
        return {
            unrestricted: true,
            stages: [],
            orderedGroups: [],
            firstGroup: null,
        };
    }

    const delayPositions = groups
        .map((group) => group.delayMinutes)
        .sort((left, right) => left - right);
    const orderedGroups = type.rotateAccessDaily
        ? rotate(groups, rotationIndex)
        : [...groups];
    const positionedGroups = orderedGroups.map((group, index) => ({
        ...group,
        delayMinutes: delayPositions[index],
    }));
    const stages = positionedGroups.map((group, index) => ({
        delayMinutes: group.delayMinutes,
        addedGroup: group,
        groups: positionedGroups.slice(0, index + 1),
        roleIds: uniq(positionedGroups.slice(0, index + 1).flatMap((item) => item.roleIds)),
    }));

    return {
        unrestricted: false,
        stages,
        orderedGroups: positionedGroups,
        firstGroup: positionedGroups[0] || null,
    };
}

function getCurrentAccessState(shiftType, record, nowMs = Date.now()) {
    const plan = buildAccessPlan(shiftType, record?.rotationIndex || 0);
    if (plan.unrestricted) {
        return {
            ...plan,
            stageIndex: 0,
            currentGroups: [],
            currentRoleIds: [],
            nextStage: null,
            elapsedMinutes: getElapsedMinutesSincePublication(record, nowMs),
        };
    }

    const elapsedMinutes = getElapsedMinutesSincePublication(record, nowMs);
    let stageIndex = -1;
    for (let index = 0; index < plan.stages.length; index += 1) {
        if (plan.stages[index].delayMinutes <= elapsedMinutes) stageIndex = index;
    }

    const currentStage = stageIndex >= 0 ? plan.stages[stageIndex] : null;
    const nextStage = plan.stages[stageIndex + 1] || null;
    return {
        ...plan,
        stageIndex,
        currentGroups: currentStage?.groups || [],
        currentRoleIds: currentStage?.roleIds || [],
        nextStage,
        elapsedMinutes,
    };
}

function memberHasAnyRole(member, roleIds) {
    return uniq(roleIds).some((roleId) => member?.roles?.cache?.has(roleId));
}

function canMemberTakeShift(member, shiftType, record, nowMs = Date.now()) {
    const access = getCurrentAccessState(shiftType, record, nowMs);
    if (access.unrestricted) return { allowed: true, access };
    if (access.stageIndex < 0) return { allowed: false, access };
    return {
        allowed: memberHasAnyRole(member, access.currentRoleIds),
        access,
    };
}

function canMemberManageShift(member, shiftType) {
    return memberHasAnyRole(member, shiftType.managerRoleIds);
}

function isMissingDiscordResource(error) {
    return [10_003, 10_008].includes(Number(error?.code));
}

async function fetchScheduleChannel(client, channelId) {
    try {
        return await runDiscordRequest(() => client.channels.fetch(channelId));
    } catch (error) {
        if (isMissingDiscordResource(error)) return null;
        throw error;
    }
}

async function fetchScheduleMessage(client, record) {
    if (!record.channelId || !record.messageId) return null;
    const channel = await fetchScheduleChannel(client, record.channelId);
    if (!channel?.messages?.fetch) return null;

    try {
        return await runDiscordRequest(() => channel.messages.fetch(record.messageId));
    } catch (error) {
        if (isMissingDiscordResource(error)) return null;
        throw error;
    }
}

async function updateScheduleMessage(
    client,
    shiftType,
    record,
    nowMs = Date.now(),
    prefetchedMessage = undefined
) {
    if (!record.channelId) return false;
    let message = prefetchedMessage === undefined
        ? await fetchScheduleMessage(client, record)
        : prefetchedMessage;

    if (!message && record.status === 'active') {
        const channel = await fetchScheduleChannel(client, record.channelId);
        if (!channel?.send) return false;
        message = await sendMessageWithRetry(
            channel,
            buildSchedulePayload(shiftType, record, nowMs),
            { nonceSeed: `shift-recover:${record.guildId}:${record.typeId}:${record.dateKey}` }
        );
        record.messageId = message.id;
        logger.info('Восстановлено удалённое сообщение расписания смен', {
            guildId: record.guildId,
            shiftTypeId: record.typeId,
            shiftTypeName: shiftType.name,
            dateKey: record.dateKey,
            messageId: message.id,
        });
    } else if (message) {
        await editMessageWithRetry(message, buildSchedulePayload(shiftType, record, nowMs));
    } else {
        return false;
    }

    await shiftSchedules.updateOne(
        { guildId: record.guildId, typeId: record.typeId, dateKey: record.dateKey },
        {
            messageId: record.messageId,
            renderedStage: getCurrentAccessState(shiftType, record, nowMs).stageIndex,
            messageRevision: record.revision,
            renderedTypeSignature: getShiftTypeSignature(shiftType),
        }
    );
    return true;
}

async function getRotationIndex(guildId, shiftType, scheduleDateKey) {
    if (!shiftType.rotateAccessDaily || shiftType.accessGroups.length <= 1) return 0;

    const query = { guildId, typeId: shiftType.id };
    const state = await shiftRotations.findOne(query);
    if (!state) {
        await new shiftRotations({
            ...query,
            rotationIndex: 0,
            lastPublicationDateKey: scheduleDateKey,
        }).save();
        return 0;
    }

    if (state.lastPublicationDateKey === scheduleDateKey) {
        return Number(state.rotationIndex || 0);
    }

    const days = Math.max(1, daysBetweenDateKeys(state.lastPublicationDateKey, scheduleDateKey));
    const nextIndex = (Number(state.rotationIndex || 0) + days) % shiftType.accessGroups.length;
    await shiftRotations.updateOne(query, {
        rotationIndex: nextIndex,
        lastPublicationDateKey: scheduleDateKey,
    });
    return nextIndex;
}

async function publishShiftTypeNow({
    client,
    guildId,
    shiftTypeId,
    publicationDateKey = getMoscowParts().dateKey,
    targetDateKey = null,
    reason = 'manual',
    skipPublicationGuard = false,
    publishedAtMs = null,
    publicationTime = null,
    scheduledPublicationAt = null,
}) {
    const normalizedGuildId = String(guildId);
    const config = guildConfigService.get(normalizedGuildId);
    if (!config) throw new Error('Конфигурация сервера не найдена');
    if (!config.features?.shifts) throw new Error('Функция смен выключена');

    const shiftType = findShiftType(config, shiftTypeId);
    if (!shiftType) throw new Error('Расписание смен не найдено');
    if (!shiftType.enabled) throw new Error('Расписание смен выключено');
    if (!shiftType.channelId) throw new Error('Канал смен не настроен');

    if (!skipPublicationGuard) {
        const publishedThisCycle = await shiftSchedules.findOne({
            guildId: normalizedGuildId,
            typeId: shiftType.id,
            publicationDateKey,
        });
        if (publishedThisCycle) {
            logPublicationSkipOnce(shiftType, publishedThisCycle, reason);
            return {
                created: false,
                record: publishedThisCycle,
                messageLink: getScheduleMessageLink(publishedThisCycle),
            };
        }
    }

    const effectivePublicationTime = publicationTime || getPublicationReferenceTime(shiftType);
    const dateKey = targetDateKey || getAutomaticScheduleDateKey(
        shiftType,
        publicationDateKey,
        effectivePublicationTime
    );
    const existing = await shiftSchedules.findOne({
        guildId: normalizedGuildId,
        typeId: shiftType.id,
        dateKey,
    });
    if (existing) {
        if (!skipPublicationGuard) logPublicationSkipOnce(shiftType, existing, reason);
        return {
            created: false,
            record: existing,
            messageLink: getScheduleMessageLink(existing),
        };
    }

    const typeSnapshot = normalizeShiftType(shiftType);
    const activeUntil = getScheduleActiveUntil(typeSnapshot, dateKey);
    if (Date.now() >= activeUntil) {
        return {
            created: false,
            skipped: 'expired',
            record: null,
            messageLink: null,
        };
    }

    const channel = await client.channels.fetch(typeSnapshot.channelId);
    if (!channel?.isTextBased?.() || !channel.messages) {
        throw new Error('Для смен выбран неподходящий канал');
    }

    const rotationIndex = await getRotationIndex(normalizedGuildId, typeSnapshot, dateKey);
    const publishedAt = Number.isFinite(publishedAtMs) ? publishedAtMs : Date.now();
    const renderedAt = Date.now();
    const record = {
        guildId: normalizedGuildId,
        typeId: typeSnapshot.id,
        dateKey,
        channelId: channel.id,
        messageId: null,
        threadId: null,
        publishedAt,
        publicationDateKey,
        publicationTime: effectivePublicationTime,
        scheduledPublicationAt: Number.isFinite(scheduledPublicationAt)
            ? scheduledPublicationAt
            : publishedAt,
        activeUntil,
        rotationIndex,
        renderedStage: -1,
        notifiedStage: -1,
        typeSnapshot: structuredClone(typeSnapshot),
        revision: 0,
        messageRevision: 0,
        renderedTypeSignature: getShiftTypeSignature(typeSnapshot),
        accessSignature: getAccessSignature(typeSnapshot),
        status: 'active',
        closeReason: null,
        closedAt: null,
        slots: buildSlots(typeSnapshot),
    };

    const message = await sendMessageWithRetry(
        channel,
        buildSchedulePayload(typeSnapshot, record, renderedAt),
        { nonceSeed: `shift:${normalizedGuildId}:${typeSnapshot.id}:${dateKey}` }
    );
    record.messageId = message.id;
    record.renderedStage = getCurrentAccessState(typeSnapshot, record, renderedAt).stageIndex;
    const inserted = await shiftSchedules.insertOneIfAbsent(
        { guildId: normalizedGuildId, typeId: typeSnapshot.id, dateKey },
        record
    );
    if (!inserted.inserted) {
        await message.delete().catch(() => undefined);
        return {
            created: false,
            record: inserted.document,
            messageLink: getScheduleMessageLink(inserted.document),
        };
    }

    if (record.renderedStage >= 0) {
        await notifyAccessStages(client, typeSnapshot, record, record.renderedStage).catch((error) => {
            logger.error('Не удалось отправить первое уведомление доступа к сменам', {
                guildId: normalizedGuildId,
                shiftTypeId: typeSnapshot.id,
                dateKey,
            }, error);
        });
    }

    logger.info('Опубликовано расписание смен', {
        guildId: normalizedGuildId,
        shiftTypeId: typeSnapshot.id,
        shiftTypeName: typeSnapshot.name,
        publicationDateKey,
        publicationTime: effectivePublicationTime,
        scheduledPublicationAt: record.scheduledPublicationAt,
        dateKey,
        activeUntil,
        reason,
        messageId: message.id,
    });

    return {
        created: true,
        record,
        messageLink: getScheduleMessageLink(record),
    };
}

async function publishNextShiftScheduleNow({
    client,
    guildId,
    shiftTypeId,
    reason = 'manual-next',
}) {
    const normalizedGuildId = String(guildId);
    const config = guildConfigService.get(normalizedGuildId);
    if (!config) throw new Error('Конфигурация сервера не найдена');
    if (!config.features?.shifts) throw new Error('Функция смен выключена');

    const shiftType = findShiftType(config, shiftTypeId);
    if (!shiftType) throw new Error('Расписание смен не найдено');
    if (!shiftType.enabled) throw new Error('Расписание смен выключено');
    if (!shiftType.channelId) throw new Error('Канал смен не настроен');

    const publicationDateKey = getMoscowParts().dateKey;
    const baseDateKey = getNearestUpcomingScheduleDateKey(shiftType);
    const records = await shiftSchedules.find({
        guildId: normalizedGuildId,
        typeId: shiftType.id,
    });

    const recordsByDate = new Map(
        records.map((record) => [String(record.dateKey), record])
    );
    let targetDateKey = baseDateKey;

    while (recordsByDate.has(targetDateKey)) {
        const record = recordsByDate.get(targetDateKey);
        if (record.status === 'active') {
            const existingMessage = await fetchScheduleMessage(client, record);
            if (!existingMessage) {
                const snapshot = getRecordShiftType(record, shiftType);
                const recovered = await updateScheduleMessage(client, snapshot, record, Date.now(), null);
                if (recovered) {
                    return {
                        created: false,
                        recovered: true,
                        record,
                        messageLink: getScheduleMessageLink(record),
                    };
                }
            }
        }
        targetDateKey = addDaysToDateKey(targetDateKey, 1);
    }

    return publishShiftTypeNow({
        client,
        guildId: normalizedGuildId,
        shiftTypeId: shiftType.id,
        publicationDateKey,
        targetDateKey,
        reason,
        skipPublicationGuard: true,
    });
}

async function closeScheduleThread(client, record, reason) {
    let thread = null;
    if (record.threadId) {
        thread = await client.channels.fetch(record.threadId).catch(() => null);
    }
    if (!thread && record.messageId) {
        const message = await fetchScheduleMessage(client, record).catch(() => null);
        thread = message?.thread || null;
    }
    if (!thread) return false;

    await closeThreadWithRetry(thread, {
        reason: `WN Helper: расписание смен завершено (${reason})`,
    });
    return true;
}

async function closeSchedule(client, shiftType, record, reason) {
    if (record.status !== 'active') return;
    const closed = {
        ...record,
        status: 'closed',
        closeReason: reason,
        closedAt: Date.now(),
        revision: Number(record.revision || 0) + 1,
    };
    await shiftSchedules.replaceOne(
        {
            guildId: record.guildId,
            typeId: record.typeId,
            dateKey: record.dateKey,
        },
        closed
    );
    await updateScheduleMessage(client, shiftType || normalizeShiftType(
        record.typeSnapshot || {
            id: record.typeId,
            name: 'Смены',
            enabled: false,
        }
    ), closed).catch((error) => {
        logger.warn('Не удалось закрыть сообщение смен', {
            guildId: record.guildId,
            shiftTypeId: record.typeId,
            dateKey: record.dateKey,
            reason,
        }, error);
    });
    await closeScheduleThread(client, closed, reason).catch((error) => {
        logger.warn('Не удалось закрыть ветку журнала смен', {
            guildId: record.guildId,
            shiftTypeId: record.typeId,
            dateKey: record.dateKey,
            threadId: record.threadId || null,
            reason,
        }, error);
    });
    logger.info('Расписание смен завершено', {
        guildId: record.guildId,
        shiftTypeId: record.typeId,
        shiftTypeName: shiftType?.name || record.typeSnapshot?.name || null,
        dateKey: record.dateKey,
        reason,
        messageId: record.messageId || null,
    });
}

async function notifyAccessStages(client, shiftType, record, currentStage) {
    if (currentStage <= Number(record.notifiedStage ?? -1)) return;
    const plan = buildAccessPlan(shiftType, record.rotationIndex);
    const channel = await client.channels.fetch(record.channelId).catch(() => null);
    if (!channel?.send) return;

    for (let stageIndex = Number(record.notifiedStage ?? -1) + 1; stageIndex <= currentStage; stageIndex += 1) {
        const stage = plan.stages[stageIndex];
        if (!stage) continue;
        const roleIds = stage.addedGroup.roleIds;
        const roleText = roleIds.length
            ? roleIds.map((roleId) => `<@&${roleId}>`).join(' ')
            : `группа "${stage.addedGroup.name}"`;
        await sendMessageWithRetry(channel, {
            content: `Доступ к сменам **${shiftType.name}** открыт для: ${roleText}.`,
            allowedMentions: { parse: [], roles: roleIds },
        }, {
            nonceSeed: `shift-stage:${record.guildId}:${record.typeId}:${record.dateKey}:${stageIndex}`,
        });
    }

    await shiftSchedules.updateOne(
        { guildId: record.guildId, typeId: record.typeId, dateKey: record.dateKey },
        { notifiedStage: currentStage }
    );
}

async function moveScheduleMessage(client, shiftType, previousRecord, nextRecord, nowMs) {
    const previousMessage = await fetchScheduleMessage(client, previousRecord).catch((error) => {
        logger.warn('Не удалось получить старое сообщение смен перед переносом', {
            guildId: previousRecord.guildId,
            shiftTypeId: previousRecord.typeId,
            dateKey: previousRecord.dateKey,
            channelId: previousRecord.channelId,
        }, error);
        return null;
    });
    const channel = await fetchScheduleChannel(client, shiftType.channelId);
    if (!channel?.isTextBased?.() || !channel?.send) {
        throw new Error('Новый канал смен недоступен или не поддерживает сообщения');
    }

    const movedRecord = {
        ...nextRecord,
        channelId: channel.id,
        messageId: null,
        threadId: null,
    };
    const message = await sendMessageWithRetry(
        channel,
        buildSchedulePayload(shiftType, movedRecord, nowMs),
        { nonceSeed: `shift-move:${movedRecord.guildId}:${movedRecord.typeId}:${movedRecord.dateKey}:${channel.id}` }
    );
    movedRecord.messageId = message.id;
    movedRecord.renderedStage = getCurrentAccessState(shiftType, movedRecord, nowMs).stageIndex;
    movedRecord.messageRevision = movedRecord.revision;
    movedRecord.renderedTypeSignature = getShiftTypeSignature(shiftType);

    await shiftSchedules.replaceOne(
        {
            guildId: movedRecord.guildId,
            typeId: movedRecord.typeId,
            dateKey: movedRecord.dateKey,
        },
        movedRecord
    );

    if (previousMessage?.delete) {
        await previousMessage.delete().catch((error) => {
            logger.warn('Не удалось удалить старое сообщение смен после переноса', {
                guildId: previousRecord.guildId,
                shiftTypeId: previousRecord.typeId,
                dateKey: previousRecord.dateKey,
                messageId: previousRecord.messageId,
            }, error);
        });
    }

    logger.info('Сообщение расписания смен перенесено в новый канал', {
        guildId: movedRecord.guildId,
        shiftTypeId: movedRecord.typeId,
        shiftTypeName: shiftType.name,
        dateKey: movedRecord.dateKey,
        previousChannelId: previousRecord.channelId,
        channelId: movedRecord.channelId,
        messageId: movedRecord.messageId,
    });
    Object.assign(nextRecord, movedRecord);
    return message;
}

function hasScheduleRecordChanges(previousRecord, nextRecord) {
    const fields = [
        'typeSnapshot',
        'activeUntil',
        'accessSignature',
        'rotationIndex',
        'slots',
        'revision',
        'notifiedStage',
    ];
    return fields.some((field) => (
        JSON.stringify(previousRecord?.[field]) !== JSON.stringify(nextRecord?.[field])
    ));
}

async function syncActiveSchedule(client, config, currentShiftType, record, nowMs) {
    const previousShiftType = getRecordShiftType(record);
    const shiftType = currentShiftType ? normalizeShiftType(currentShiftType) : null;
    const closeWithCurrentSettings = async (reason) => {
        if (!shiftType) {
            await closeSchedule(client, previousShiftType, record, reason);
            return;
        }
        const closingRecord = {
            ...record,
            typeSnapshot: structuredClone(shiftType),
            activeUntil: getScheduleActiveUntil(shiftType, record.dateKey),
            accessSignature: getAccessSignature(shiftType),
        };
        Object.assign(record, closingRecord);
        await closeSchedule(client, shiftType, record, reason);
    };

    if (!config.features?.shifts) {
        await closeWithCurrentSettings('feature-disabled');
        return;
    }
    if (!shiftType) {
        await closeWithCurrentSettings('type-removed');
        return;
    }
    if (!shiftType.enabled) {
        await closeWithCurrentSettings('type-disabled');
        return;
    }
    if (!shiftType.channelId) {
        await closeWithCurrentSettings('channel-unconfigured');
        return;
    }

    const previousRecord = structuredClone(record);
    const nextRecord = {
        ...record,
        typeSnapshot: structuredClone(shiftType),
        activeUntil: getScheduleActiveUntil(shiftType, record.dateKey),
        accessSignature: getAccessSignature(shiftType),
        rotationIndex: shiftType.accessGroups.length
            ? Number(record.rotationIndex || 0) % shiftType.accessGroups.length
            : 0,
    };
    const reconciled = reconcileSlots(shiftType, record.slots);
    if (reconciled.changed) {
        nextRecord.slots = reconciled.slots;
        nextRecord.revision = Number(record.revision || 0) + 1;
    }
    if (record.accessSignature && record.accessSignature !== nextRecord.accessSignature) {
        nextRecord.notifiedStage = -1;
    }

    if (nowMs >= nextRecord.activeUntil) {
        Object.assign(record, nextRecord);
        await closeSchedule(client, shiftType, record, 'expired');
        return;
    }

    const channelChanged = String(record.channelId || '') !== String(shiftType.channelId || '');
    const recordChanged = hasScheduleRecordChanges(record, nextRecord);
    let existingMessage;
    if (channelChanged) {
        existingMessage = await moveScheduleMessage(client, shiftType, previousRecord, nextRecord, nowMs);
        Object.assign(record, nextRecord);
    } else {
        if (recordChanged) {
            await shiftSchedules.replaceOne(
                { guildId: record.guildId, typeId: record.typeId, dateKey: record.dateKey },
                nextRecord
            );
        }
        Object.assign(record, nextRecord);
        try {
            existingMessage = await fetchScheduleMessage(client, record);
        } catch (error) {
            logger.error('Не удалось проверить сообщение расписания смен', {
                guildId: record.guildId,
                shiftTypeId: record.typeId,
                dateKey: record.dateKey,
            }, error);
            return;
        }
    }

    const access = getCurrentAccessState(shiftType, record, nowMs);
    const shouldRender =
        !existingMessage ||
        Number(record.renderedStage ?? -1) !== access.stageIndex ||
        Number(record.messageRevision ?? -1) !== Number(record.revision || 0) ||
        record.renderedTypeSignature !== getShiftTypeSignature(shiftType);

    if (shouldRender) {
        await updateScheduleMessage(client, shiftType, record, nowMs, existingMessage).catch((error) => {
            logger.error('Не удалось обновить расписание смен', {
                guildId: record.guildId,
                shiftTypeId: record.typeId,
                dateKey: record.dateKey,
            }, error);
        });
    }

    if (access.stageIndex >= 0) {
        await notifyAccessStages(client, shiftType, record, access.stageIndex).catch((error) => {
            logger.error('Не удалось отправить уведомление этапа смен', {
                guildId: record.guildId,
                shiftTypeId: record.typeId,
                dateKey: record.dateKey,
                stageIndex: access.stageIndex,
            }, error);
        });
    }
}

async function syncGuildShiftSchedules(client, guildId, { reason = 'scheduled' } = {}) {
    const key = String(guildId);
    const previous = schedulerLocks.get(key) || Promise.resolve();
    const task = previous.then(async () => {
        const config = guildConfigService.getAny(guildId);
        if (!config) return;
        const shiftTypes = getShiftTypes(config);
        const typeById = new Map(shiftTypes.map((type) => [type.id, type]));
        const now = new Date();
        const nowMs = now.getTime();
        const moscow = getMoscowParts(now);
        const schedules = await shiftSchedules.find({ guildId: String(guildId), status: 'active' });

        for (const record of schedules) {
            if (record.status !== 'active') continue;
            const type = typeById.get(record.typeId) || null;
            await syncActiveSchedule(client, config, type, record, nowMs);
        }

        if (!config.features?.shifts) return;

        for (const type of shiftTypes) {
            if (!type.enabled || !type.channelId) continue;
            const publicationSchedules = [getPublicationSchedule(guildId, type, moscow.dateKey)];
            if (type.publication.mode === PUBLICATION_MODES.RANDOM) {
                const previousDateKey = addDaysToDateKey(moscow.dateKey, -1);
                const previousSchedule = getPublicationSchedule(guildId, type, previousDateKey);
                if (previousSchedule.actualDateKey === moscow.dateKey) {
                    publicationSchedules.unshift(previousSchedule);
                }
            }

            for (const publicationSchedule of publicationSchedules) {
                if (nowMs < publicationSchedule.scheduledAt) continue;
                await publishShiftTypeNow({
                    client,
                    guildId: String(guildId),
                    shiftTypeId: type.id,
                    publicationDateKey: publicationSchedule.publicationDateKey,
                    targetDateKey: getAutomaticScheduleDateKey(
                        type,
                        publicationSchedule.actualDateKey,
                        publicationSchedule.time
                    ),
                    reason,
                    publishedAtMs: publicationSchedule.scheduledAt,
                    publicationTime: publicationSchedule.time,
                    scheduledPublicationAt: publicationSchedule.scheduledAt,
                }).catch((error) => {
                    logger.error('Не удалось автоматически опубликовать расписание смен', {
                        guildId,
                        shiftTypeId: type.id,
                        shiftTypeName: type.name,
                        publicationDateKey: publicationSchedule.publicationDateKey,
                        publicationTime: publicationSchedule.time,
                        reason,
                    }, error);
                });
            }
        }
    });

    schedulerLocks.set(key, task.then(() => undefined, () => undefined));
    return task;
}

async function syncAllShiftSchedules(client, { reason = 'scheduled' } = {}) {
    for (const config of guildConfigService.getAllIncludingEmpty()) {
        if (!config?.guildId) continue;
        await syncGuildShiftSchedules(client, String(config.guildId), { reason });
    }
}

function scheduleGuildShiftSync(client, guildId, { delayMs = 1_000, reason = 'event' } = {}) {
    const key = String(guildId);
    const existing = delayedGuildSyncs.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
        delayedGuildSyncs.delete(key);
        syncGuildShiftSchedules(client, key, { reason }).catch((error) => {
            logger.error('Не удалось синхронизировать смены сервера', { guildId: key, reason }, error);
        });
    }, Math.max(0, delayMs));
    timer.unref?.();
    delayedGuildSyncs.set(key, timer);
}

async function getOrCreateScheduleThread(message, record, shiftType) {
    if (record.threadId) {
        const existing = await message.guild.channels.fetch(record.threadId).catch(() => null);
        if (existing?.isThread?.()) {
            if (existing.archived) await existing.setArchived(false).catch(() => undefined);
            return existing;
        }
    }

    if (message.thread) return message.thread;
    let thread = await startThreadWithRetry(message, {
        name: `${shiftType.name} ${formatDateKey(record.dateKey)}`.slice(0, 100),
        autoArchiveDuration: 60,
    }).catch(() => null);

    if (!thread) {
        const fresh = await message.channel.messages.fetch(message.id).catch(() => null);
        thread = fresh?.thread || null;
    }
    if (!thread) throw new Error('Не удалось получить тред журнала смен');

    await shiftSchedules.updateOne(
        {
            guildId: record.guildId,
            typeId: record.typeId,
            dateKey: record.dateKey,
        },
        { threadId: thread.id }
    );
    return thread;
}

async function writeShiftAudit(message, record, shiftType, {
    actorId,
    slot,
    previousMemberId,
    action,
}) {
    const thread = await getOrCreateScheduleThread(message, record, shiftType);
    let content;
    if (action === 'take') {
        content = `<@${actorId}> занял смену №${slot.number} (${slot.startTime}-${slot.endTime}).`;
    } else if (previousMemberId === actorId) {
        content = `<@${actorId}> освободил свою смену №${slot.number} (${slot.startTime}-${slot.endTime}).`;
    } else {
        content = `<@${actorId}> освободил смену №${slot.number} сотрудника <@${previousMemberId}>.`;
    }
    await sendMessageWithRetry(thread, {
        content,
        allowedMentions: { parse: [] },
    }, {
        nonceSeed: `shift-audit:${record.guildId}:${record.typeId}:${record.dateKey}:${record.revision}:${slot.id}`,
    });
}

async function updateScheduleAfterInteraction(client, shiftType, record, message) {
    const latest = await shiftSchedules.findOne({
        guildId: record.guildId,
        typeId: record.typeId,
        dateKey: record.dateKey,
    }) || record;
    const snapshot = getRecordShiftType(latest, shiftType);
    await editMessageWithRetry(message, buildSchedulePayload(snapshot, latest));
    await shiftSchedules.updateOne(
        { guildId: latest.guildId, typeId: latest.typeId, dateKey: latest.dateKey },
        {
            messageRevision: latest.revision,
            renderedStage: getCurrentAccessState(snapshot, latest).stageIndex,
            renderedTypeSignature: getShiftTypeSignature(snapshot),
        }
    );
    return latest;
}


function getAutomaticReleaseReasonText(reason) {
    const normalized = String(reason || '').toLowerCase();
    if (normalized.startsWith('vacation')) return 'Отпуск сотрудника.';
    if (normalized.startsWith('dismissal') || normalized.startsWith('uval') || normalized.startsWith('offboarding')) {
        return 'Увольнение сотрудника.';
    }
    return 'Служебное освобождение.';
}

async function writeAutomaticShiftAudit(client, record, memberId, removedSlots, reason) {
    if (!client || !Array.isArray(removedSlots) || removedSlots.length === 0) return false;
    const message = await fetchScheduleMessage(client, record);
    if (!message) return false;
    const shiftType = getRecordShiftType(record);
    const thread = await getOrCreateScheduleThread(message, record, shiftType);
    const slotsText = removedSlots
        .map((slot) => {
            const time = slot.startTime && slot.endTime ? ` (${slot.startTime}-${slot.endTime})` : '';
            return `№${slot.number}${time}`;
        })
        .join(', ');
    await sendMessageWithRetry(thread, {
        content: [
            `Система автоматически освободила <@${memberId}> от следующих смен: ${slotsText}.`,
            `Причина: ${getAutomaticReleaseReasonText(reason)}`,
        ].join('\n'),
        allowedMentions: { parse: [] },
    }, {
        nonceSeed: `shift-auto-release:${record.guildId}:${record.typeId}:${record.dateKey}:${record.revision}:${memberId}:${removedSlots.map((slot) => slot.id).join(',')}:${reason}`,
    });
    return true;
}

async function releaseMemberFromSchedulesInPeriod(client, guildId, memberId, startDate, endDate, { reason = 'vacation' } = {}) {
    const schedules = await shiftSchedules.find({ guildId: String(guildId), status: 'active' });
    let changedCount = 0;
    let removedSlotCount = 0;
    for (const schedule of schedules) {
        if (String(schedule.dateKey || '') < String(startDate || '')) continue;
        if (String(schedule.dateKey || '') > String(endDate || '')) continue;
        const removedSlots = [];
        const slots = (schedule.slots || []).map((slot) => {
            if (String(slot.memberId || '') !== String(memberId)) return slot;
            removedSlots.push(slot);
            return { ...slot, memberId: null };
        });
        if (!removedSlots.length) continue;
        const replacement = {
            ...schedule,
            slots,
            revision: Number(schedule.revision || 0) + 1,
            updatedAt: Date.now(),
        };
        await shiftSchedules.replaceOne(
            { guildId: schedule.guildId, typeId: schedule.typeId, dateKey: schedule.dateKey },
            replacement
        );
        changedCount += 1;
        removedSlotCount += removedSlots.length;
        if (client) {
            await writeAutomaticShiftAudit(client, replacement, memberId, removedSlots, reason).catch((error) => {
                logger.warn('Не удалось записать автоматическое освобождение смены в журнал', {
                    guildId: schedule.guildId,
                    shiftTypeId: schedule.typeId,
                    dateKey: schedule.dateKey,
                    memberId: String(memberId),
                    reason,
                }, error);
            });
        }
    }
    if (changedCount > 0) {
        logger.info('Сотрудник автоматически снят со смен', {
            guildId: String(guildId),
            memberId: String(memberId),
            scheduleCount: changedCount,
            slotCount: removedSlotCount,
            startDate,
            endDate,
            reason,
        });
        if (client) scheduleGuildShiftSync(client, guildId, { reason: String(reason || 'vacation') });
    }
    return changedCount;
}

async function releaseMemberFromSchedules(client, guildId, memberId, { reason = 'offboarding' } = {}) {
    const schedules = await shiftSchedules.find({ guildId: String(guildId), status: 'active' });
    let changedCount = 0;
    let removedSlotCount = 0;
    for (const schedule of schedules) {
        const removedSlots = [];
        const slots = (schedule.slots || []).map((slot) => {
            if (String(slot.memberId || '') !== String(memberId)) return slot;
            removedSlots.push(slot);
            return { ...slot, memberId: null };
        });
        if (!removedSlots.length) continue;
        const replacement = {
            ...schedule,
            slots,
            revision: Number(schedule.revision || 0) + 1,
            updatedAt: Date.now(),
        };
        await shiftSchedules.replaceOne(
            { guildId: schedule.guildId, typeId: schedule.typeId, dateKey: schedule.dateKey },
            replacement
        );
        changedCount += 1;
        removedSlotCount += removedSlots.length;
        if (client && schedule.status === 'active') {
            await writeAutomaticShiftAudit(client, replacement, memberId, removedSlots, reason).catch((error) => {
                logger.warn('Не удалось записать автоматическое освобождение смены в журнал', {
                    guildId: schedule.guildId,
                    shiftTypeId: schedule.typeId,
                    dateKey: schedule.dateKey,
                    memberId: String(memberId),
                    reason,
                }, error);
            });
        }
    }
    if (changedCount > 0) {
        logger.info('Сотрудник автоматически снят со всех смен', {
            guildId: String(guildId),
            memberId: String(memberId),
            scheduleCount: changedCount,
            slotCount: removedSlotCount,
            reason,
        });
        if (client) scheduleGuildShiftSync(client, guildId, { reason: String(reason || 'offboarding') });
    }
    return changedCount;
}

module.exports = {
    FREE_SHIFT_VALUE,
    addDaysToDateKey,
    buildAccessLines,
    buildAccessPlan,
    buildScheduleComponents,
    buildScheduleEmbed,
    buildScheduleEmbeds,
    buildSchedulePayload,
    buildSlots,
    canMemberManageShift,
    canMemberTakeShift,
    formatDateKey,
    getAutomaticScheduleDateKey,
    getCurrentAccessState,
    getMoscowParts,
    getMoscowTimestamp,
    getPublicationSchedule,
    getNearestUpcomingScheduleDateKey,
    getRecordShiftType,
    getShiftTypeSignature,
    getScheduleActiveUntil,
    memberHasAnyRole,
    publishNextShiftScheduleNow,
    reconcileSlots,
    publishShiftTypeNow,
    releaseMemberFromSchedules,
    releaseMemberFromSchedulesInPeriod,
    scheduleGuildShiftSync,
    syncActiveSchedule,
    syncAllShiftSchedules,
    syncGuildShiftSchedules,
    updateScheduleAfterInteraction,
    writeShiftAudit,
};
