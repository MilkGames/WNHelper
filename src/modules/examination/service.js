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
const {
    ChannelType,
    PermissionFlagsBits,
} = require('discord.js');
const { getDepartments } = require('../../core/config/departmentSchema');
const { findExamById, getExams } = require('./settings/examsSchema');
const { getExaminationSettings } = require('./settings/schema');
const guildConfigService = require('../../core/config/guildConfigService');
const examAttemptService = require('./attempts');
const {
    editMessageWithRetry,
    runDiscordRequest,
    sendMessageWithRetry,
} = require('../../core/discord/request');
const { mutateDatabase: mutateDb, readDatabase: readDb } = require('./database');
const logger = require('../../core/logging/logger');
const ExaminationError = require('./error');
const {
    buildRequestComponents,
    buildRequestEmbed,
} = require('./requestPresentation');

const ACTIVE_LECTURE_STATUSES = new Set([
    'publishing',
    'failed_publication',
    'pending',
    'waiting_for_voice',
    'in_progress',
    'completing',
    'completion_failed',
]);
const ACTIVE_RETEST_STATUSES = new Set([
    'publishing',
    'failed_publication',
    'pending',
    'waiting_for_voice',
    'in_progress',
    'completing',
    'completion_failed',
]);
const OPEN_REQUEST_STATUSES = new Set([
    ...ACTIVE_LECTURE_STATUSES,
    ...ACTIVE_RETEST_STATUSES,
]);
const VOICE_WAITING_STATUS = 'waiting_for_voice';
const VOICE_IN_PROGRESS_STATUS = 'in_progress';

function normalizeId(value) {
    return String(value || '').trim();
}

function normalizeComment(value) {
    const normalized = String(value || '').trim();
    return normalized ? normalized.slice(0, 1000) : null;
}

function createRequestId() {
    return `examreq-${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
}

function createMessageNonce(seed) {
    return crypto
        .createHash('sha1')
        .update(String(seed))
        .digest('hex')
        .slice(0, 25);
}

function clone(value) {
    return value == null ? value : structuredClone(value);
}

function getRequestById(requestId) {
    const normalized = normalizeId(requestId);
    if (!normalized) return null;
    const db = readDb();
    const record = (db.examinationRequests || [])
        .find((entry) => String(entry.requestId) === normalized);
    return record ? clone(record) : null;
}

function getConfig(guildId) {
    const config = guildConfigService.get(guildId);
    if (!config) {
        throw new ExaminationError('Для этого сервера нет настроек.', 'config_missing');
    }
    if (config.features?.exams !== true) {
        throw new ExaminationError('Функция экзаменации отключена в настройках сервера.', 'feature_disabled');
    }
    return config;
}

function assertMemberHasWnRole(member, config) {
    const roleId = normalizeId(config.commonRoles?.weazelNewsRoleId);
    if (!roleId) {
        throw new ExaminationError(
            'В настройках не указана основная роль Weazel News.',
            'wn_role_not_configured'
        );
    }
    if (!member?.roles?.cache?.has(roleId)) {
        throw new ExaminationError(
            'Запрашивать лекции и пересдачи могут только действующие сотрудники Weazel News.',
            'wn_role_missing'
        );
    }
}

function getLectureType(config, lectureTypeId) {
    const settings = getExaminationSettings(config);
    return settings.lectureTypes.find((entry) => entry.id === normalizeId(lectureTypeId)) || null;
}

function getDepartment(config, departmentId) {
    return getDepartments(config)
        .find((entry) => entry.id === normalizeId(departmentId)) || null;
}

function getDepartmentManagerRoleIds(department) {
    return Array.from(new Set([
        department?.roles?.headRoleId,
        department?.roles?.deputyHeadRoleId,
    ].map(normalizeId).filter(Boolean)));
}

function resolveLectureType(config, lectureTypeId, guild = null) {
    const lectureType = getLectureType(config, lectureTypeId);
    if (!lectureType) return null;

    const department = lectureType.departmentId
        ? getDepartment(config, lectureType.departmentId)
        : null;
    const configuredRoleIds = department
        ? getDepartmentManagerRoleIds(department)
        : Array.from(new Set((lectureType.pingRoleIds || []).map(normalizeId).filter(Boolean)));
    const managerRoleIds = guild?.roles?.cache
        ? configuredRoleIds.filter((roleId) => guild.roles.cache.has(roleId))
        : configuredRoleIds;

    return {
        ...lectureType,
        department,
        managerRoleIds,
        departmentName: department
            ? (department.fullName
                ? `${department.shortName} - ${department.fullName}`
                : department.shortName)
            : null,
        departmentShortName: department?.shortName || null,
    };
}

function getAvailableLectureTypes(config, guild = null) {
    return getExaminationSettings(config).lectureTypes
        .filter((entry) => entry.id && entry.name)
        .map((entry) => resolveLectureType(config, entry.id, guild))
        .filter((entry) => entry && entry.managerRoleIds.length > 0);
}

function hasOpenRequest(db, predicate) {
    return (db.examinationRequests || []).some((request) => (
        OPEN_REQUEST_STATUSES.has(request.status) && predicate(request)
    ));
}

function getEligibleRetestExams(guildId, memberId, config = getConfig(guildId)) {
    const db = readDb();
    return getExams(config).filter((exam) => {
        if (!exam.retestEnabled || exam.maxAttempts <= 0) return false;
        const attempt = examAttemptService.getAttemptState(guildId, memberId, exam.id);
        const attemptsUsed = Number.isSafeInteger(attempt.attemptsUsed) ? attempt.attemptsUsed : 0;
        if (attemptsUsed < exam.maxAttempts) return false;
        return !hasOpenRequest(db, (request) => (
            request.type === 'retest' &&
            String(request.guildId) === String(guildId) &&
            String(request.memberId) === String(memberId) &&
            String(request.examId) === String(exam.id)
        ));
    });
}

function assertRegularExamAttemptAvailable(guildId, memberId, exam) {
    if (!exam || exam.maxAttempts === 0) {
        return { unlimited: true, attemptsUsed: 0 };
    }
    const state = examAttemptService.getAttemptState(guildId, memberId, exam.id);
    const attemptsUsed = Number.isSafeInteger(state.attemptsUsed) ? state.attemptsUsed : 0;
    if (attemptsUsed >= exam.maxAttempts) {
        throw new ExaminationError(
            'Обычные попытки этого экзамена исчерпаны. Дальнейшая пересдача проводится отдельно через панель экзаменации.',
            'regular_attempts_exhausted'
        );
    }
    return { unlimited: false, attemptsUsed };
}

function formatResultMember(memberId, displayName) {
    return `<@${memberId}> | ${String(displayName || memberId).slice(0, 200)} | ||${memberId}||`;
}

async function resolveCurrentDisplayName(guild, memberId, fallback = null) {
    const normalized = normalizeId(memberId);
    if (!normalized) return String(fallback || '-').slice(0, 200);
    const cached = guild?.members?.cache?.get(normalized) || null;
    const member = cached || await guild?.members?.fetch?.(normalized).catch(() => null);
    return String(member?.displayName || fallback || normalized).slice(0, 200);
}

function requestPingRoleIds(request, config) {
    if (request.type === 'retest') {
        const examinerRoleId = normalizeId(config.commonRoles?.examinerRoleId);
        return examinerRoleId ? [examinerRoleId] : [];
    }
    return Array.isArray(request.managerRoleIds)
        ? Array.from(new Set(request.managerRoleIds.map(normalizeId).filter(Boolean)))
        : [];
}

async function getRequestChannel(client, request, config) {
    const settings = getExaminationSettings(config);
    const channelId = request.requestChannelId || (
        request.type === 'lecture'
            ? settings.lectureRequestChannelId
            : settings.retestRequestChannelId
    );
    if (!channelId) {
        throw new ExaminationError(
            request.type === 'lecture'
                ? 'Канал заявок на лекции не настроен.'
                : 'Канал заявок на пересдачи не настроен.',
            'request_channel_missing'
        );
    }
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.() || typeof channel.send !== 'function') {
        throw new ExaminationError('Настроенный канал заявок недоступен.', 'request_channel_invalid');
    }
    const missingPermissions = getMissingChannelPermissions(channel.guild, channel);
    if (missingPermissions.length) {
        throw new ExaminationError(
            `В настроенном канале заявок у бота нет прав: ${missingPermissions.join(', ')}.`,
            'request_channel_permissions_missing'
        );
    }
    return channel;
}

async function getLectureResultChannel(client, request, config) {
    const settings = getExaminationSettings(config);
    const channelId = request.lectureResultChannelId || settings.lectureResultChannelId;
    if (!channelId) {
        throw new ExaminationError('Канал итогов лекций не настроен.', 'lecture_result_channel_missing');
    }
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.() || typeof channel.send !== 'function') {
        throw new ExaminationError('Канал итогов лекций недоступен.', 'lecture_result_channel_invalid');
    }
    const missingPermissions = getMissingChannelPermissions(channel.guild, channel);
    if (missingPermissions.length) {
        throw new ExaminationError(
            `В канале итогов лекций у бота нет прав: ${missingPermissions.join(', ')}.`,
            'lecture_result_channel_permissions_missing'
        );
    }
    return channel;
}

async function getRetestResultChannel(client, request, config) {
    const settings = getExaminationSettings(config);
    const channelId = normalizeId(
        request.retestResultChannelId ||
        settings.retestResultChannelId ||
        config.channels?.examResultChannelId
    );
    if (!channelId) {
        throw new ExaminationError(
            'Не настроен ни отдельный канал итогов пересдач, ни общий канал результатов экзаменов.',
            'retest_result_channel_missing'
        );
    }

    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased?.() || typeof channel.send !== 'function') {
        throw new ExaminationError('Канал публикации итогов пересдачи недоступен.', 'retest_result_channel_invalid');
    }
    const missingPermissions = getMissingChannelPermissions(channel.guild, channel);
    if (missingPermissions.length) {
        throw new ExaminationError(
            `В канале публикации итогов пересдачи у бота нет прав: ${missingPermissions.join(', ')}.`,
            'retest_result_channel_permissions_missing'
        );
    }
    return channel;
}

async function updateStoredRequest(requestId, updater) {
    return mutateDb((db) => {
        db.examinationRequests ||= [];
        const index = db.examinationRequests.findIndex((entry) => String(entry.requestId) === String(requestId));
        if (index === -1) return null;
        const record = db.examinationRequests[index];
        const result = updater(record, db);
        record.updatedAt = Date.now();
        db.examinationRequests[index] = record;
        return clone(result === undefined ? record : result);
    });
}

async function updateRequestMessage(client, request) {
    if (!request?.requestChannelId || !request?.requestMessageId) return false;
    const channel = await client.channels.fetch(request.requestChannelId).catch(() => null);
    if (!channel?.messages?.fetch) return false;
    const message = await channel.messages.fetch(request.requestMessageId).catch(() => null);
    if (!message) return false;
    await editMessageWithRetry(message, {
        embeds: [buildRequestEmbed(request)],
        components: buildRequestComponents(request),
        allowedMentions: { parse: [] },
    });
    return true;
}

async function publishRequest(client, requestId) {
    const request = getRequestById(requestId);
    if (!request) throw new ExaminationError('Заявка не найдена.', 'request_not_found');
    const config = getConfig(request.guildId);
    const channel = await getRequestChannel(client, request, config);

    if (request.requestMessageId && request.requestChannelId) {
        const updated = await updateRequestMessage(client, request).catch(() => false);
        if (updated) return request;
    }

    const shouldOpenForReview = ['publishing', 'failed_publication'].includes(request.status);
    const effectiveRequest = shouldOpenForReview
        ? { ...request, status: 'pending' }
        : request;
    const roleIds = effectiveRequest.status === 'pending'
        ? requestPingRoleIds(effectiveRequest, config)
            .filter((roleId) => channel.guild?.roles?.cache?.has(roleId))
        : [];
    const content = roleIds.map((roleId) => `<@&${roleId}>`).join(' ');
    const republishIndex = Number(request.republishCount || 0) + 1;
    const sent = await sendMessageWithRetry(channel, {
        content,
        embeds: [buildRequestEmbed(effectiveRequest)],
        components: buildRequestComponents(effectiveRequest),
        allowedMentions: { parse: [], roles: roleIds },
    }, {
        nonceSeed: `examinationRequest:${request.guildId}:${request.requestId}:${republishIndex}`,
    });

    return updateStoredRequest(request.requestId, (record) => {
        if (['publishing', 'failed_publication'].includes(record.status)) {
            record.status = 'pending';
        }
        record.requestChannelId = sent.channelId;
        record.requestMessageId = sent.id;
        record.requestMessageLink = `https://discord.com/channels/${record.guildId}/${sent.channelId}/${sent.id}`;
        record.voiceNoticeChannelId = null;
        record.voiceNoticeMessageId = null;
        record.voiceNoticeMessageLink = null;
        record.publishedAt ||= Date.now();
        record.republishedAt = Date.now();
        record.republishCount = Number(record.republishCount || 0) + 1;
        record.lastError = null;
        record.history ||= [];
        record.history.push({
            action: record.republishCount > 1 ? 'republished' : 'published',
            at: Date.now(),
            messageId: sent.id,
            status: record.status,
        });
        return record;
    });
}

async function insertRequest(record, duplicatePredicate) {
    return mutateDb((db) => {
        db.examinationRequests ||= [];
        const duplicate = db.examinationRequests.find((entry) => (
            OPEN_REQUEST_STATUSES.has(entry.status) && duplicatePredicate(entry)
        ));
        if (duplicate) {
            throw new ExaminationError(
                `У вас уже есть активная заявка этого типа. ID: ${duplicate.requestId}`,
                'duplicate_request',
                { requestId: duplicate.requestId }
            );
        }
        db.examinationRequests.push(record);
        return clone(record);
    });
}

async function createLectureRequest(client, {
    guild,
    member,
    lectureTypeId,
    comment = null,
}) {
    const config = getConfig(guild.id);
    assertMemberHasWnRole(member, config);
    const settings = getExaminationSettings(config);
    if (!settings.lectureRequestChannelId) {
        throw new ExaminationError('Канал заявок на лекции не настроен.', 'lecture_channel_missing');
    }
    const lectureType = resolveLectureType(config, lectureTypeId, guild);
    if (!lectureType) {
        throw new ExaminationError('Выбранный тип лекции больше не существует.', 'lecture_type_missing');
    }
    if (!lectureType.managerRoleIds.length) {
        throw new ExaminationError(
            lectureType.departmentId
                ? 'У отдела этой лекции не настроены действующие роли главы или заместителя главы.'
                : 'Для этой лекции не настроены действующие роли для пинга.',
            'lecture_manager_roles_missing'
        );
    }

    const now = Date.now();
    const record = {
        requestId: createRequestId(),
        guildId: String(guild.id),
        type: 'lecture',
        memberId: String(member.id),
        memberDisplayName: member.displayName,
        lectureTypeId: lectureType.id,
        lectureTypeName: lectureType.name,
        departmentId: lectureType.department?.id || null,
        departmentName: lectureType.departmentName,
        departmentShortName: lectureType.departmentShortName,
        managerRoleIds: lectureType.managerRoleIds,
        comment: normalizeComment(comment),
        status: 'publishing',
        requestChannelId: settings.lectureRequestChannelId,
        lectureResultChannelId: settings.lectureResultChannelId,
        createdAt: now,
        updatedAt: now,
        history: [{ action: 'created', actorId: member.id, at: now }],
    };

    await insertRequest(record, (entry) => (
        entry.type === 'lecture' &&
        String(entry.guildId) === String(guild.id) &&
        String(entry.memberId) === String(member.id) &&
        String(entry.lectureTypeId) === String(lectureType.id)
    ));

    try {
        return await publishRequest(client, record.requestId);
    } catch (error) {
        await updateStoredRequest(record.requestId, (entry) => {
            entry.status = 'failed_publication';
            entry.lastError = String(error?.stack || error?.message || error);
            entry.history ||= [];
            entry.history.push({ action: 'publication_failed', at: Date.now() });
        });
        throw error;
    }
}

async function createRetestRequest(client, {
    guild,
    member,
    examId,
    comment = null,
}) {
    const config = getConfig(guild.id);
    assertMemberHasWnRole(member, config);
    const settings = getExaminationSettings(config);
    if (!settings.retestRequestChannelId) {
        throw new ExaminationError('Канал заявок на пересдачи не настроен.', 'retest_channel_missing');
    }
    const exam = findExamById(config, examId);
    if (!exam) throw new ExaminationError('Выбранный экзамен больше не существует.', 'exam_missing');
    if (exam.maxAttempts === 0) {
        throw new ExaminationError(
            'Для этого экзамена установлено неограниченное количество попыток. Пересдача не требуется.',
            'unlimited_attempts'
        );
    }
    if (!exam.retestEnabled) {
        throw new ExaminationError('Пересдача для этого экзамена не предусмотрена.', 'retest_disabled');
    }
    const attempt = examAttemptService.getAttemptState(guild.id, member.id, exam.id);
    const attemptsUsed = Number.isSafeInteger(attempt.attemptsUsed) ? attempt.attemptsUsed : 0;
    if (attemptsUsed < exam.maxAttempts) {
        throw new ExaminationError(
            `Пересдача пока недоступна: использовано ${attemptsUsed} из ${exam.maxAttempts} попыток.`,
            'attempts_remaining'
        );
    }

    const examinerRoleId = normalizeId(config.commonRoles?.examinerRoleId);
    if (!examinerRoleId || !guild.roles?.cache?.has(examinerRoleId)) {
        throw new ExaminationError('Роль экзаменатора не настроена или удалена.', 'examiner_role_missing');
    }

    const retestResultChannelId = normalizeId(
        settings.retestResultChannelId || config.channels?.examResultChannelId
    );
    if (!retestResultChannelId) {
        throw new ExaminationError(
            'Не настроен ни отдельный канал итогов пересдач, ни общий канал результатов экзаменов.',
            'retest_result_channel_missing'
        );
    }

    const now = Date.now();
    const record = {
        requestId: createRequestId(),
        guildId: String(guild.id),
        type: 'retest',
        memberId: String(member.id),
        memberDisplayName: member.displayName,
        examId: exam.id,
        examName: exam.name,
        attemptsUsed,
        maxAttempts: exam.maxAttempts,
        comment: normalizeComment(comment),
        status: 'publishing',
        requestChannelId: settings.retestRequestChannelId,
        retestResultChannelId,
        createdAt: now,
        updatedAt: now,
        history: [{ action: 'created', actorId: member.id, at: now }],
    };

    await insertRequest(record, (entry) => (
        entry.type === 'retest' &&
        String(entry.guildId) === String(guild.id) &&
        String(entry.memberId) === String(member.id) &&
        String(entry.examId) === String(exam.id)
    ));

    try {
        return await publishRequest(client, record.requestId);
    } catch (error) {
        await updateStoredRequest(record.requestId, (entry) => {
            entry.status = 'failed_publication';
            entry.lastError = String(error?.stack || error?.message || error);
            entry.history ||= [];
            entry.history.push({ action: 'publication_failed', at: Date.now() });
        });
        throw error;
    }
}

function memberHasAnyRole(member, roleIds) {
    return roleIds.some((roleId) => member?.roles?.cache?.has(roleId));
}

function canManageRequest(member, request, config) {
    if (member?.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;
    if (request.type === 'retest') {
        const examinerRoleId = normalizeId(config.commonRoles?.examinerRoleId);
        return Boolean(examinerRoleId && member?.roles?.cache?.has(examinerRoleId));
    }
    return memberHasAnyRole(member, request.managerRoleIds || []);
}

function getVoiceSettings(config, guild, requestType) {
    const settings = getExaminationSettings(config);
    const isLecture = requestType === 'lecture';
    const configuredChannelId = isLecture
        ? settings.lectureVoiceChannelId
        : settings.retestVoiceChannelId;
    const voiceChannel = configuredChannelId
        ? guild.channels.cache.get(configuredChannelId)
        : null;
    if (!voiceChannel || ![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(voiceChannel.type)) {
        throw new ExaminationError(
            isLecture
                ? 'Голосовой канал лекций не настроен или удалён.'
                : 'Голосовой канал пересдач не настроен или удалён.',
            'voice_channel_missing'
        );
    }
    if (!Number.isSafeInteger(settings.voiceJoinTimeoutMinutes) || settings.voiceJoinTimeoutMinutes < 1) {
        throw new ExaminationError('Время ожидания входа в голосовой канал настроено некорректно.', 'voice_timeout_invalid');
    }
    const me = guild.members?.me;
    const permissions = me && typeof voiceChannel.permissionsFor === 'function'
        ? voiceChannel.permissionsFor(me)
        : null;
    if (permissions?.has && !permissions.has(PermissionFlagsBits.ViewChannel)) {
        throw new ExaminationError(
            'У бота нет права просматривать настроенный голосовой канал.',
            'voice_channel_permissions_missing'
        );
    }
    return {
        voiceChannelId: voiceChannel.id,
        voiceJoinTimeoutMinutes: settings.voiceJoinTimeoutMinutes,
    };
}

function buildVoiceNoticeContent(request) {
    if (request.status === 'waiting_for_voice') {
        const deadlineUnix = Math.floor(Number(request.voiceJoinDeadlineAt) / 1000);
        return [
            `<@${request.memberId}>, вашу заявку принял ${request.type === 'lecture' ? 'лектор' : 'экзаменатор'} <@${request.handledBy}>.`,
            `Зайдите в <#${request.voiceChannelId}> в течение ${request.voiceJoinTimeoutMinutes} мин.`,
            `Ожидание завершится <t:${deadlineUnix}:R>.`,
            '',
            'Лекция или пересдача начнётся автоматически, когда сотрудник и экзаменатор будут находиться в указанном голосовом канале.',
        ].join('\n');
    }
    if (request.status === 'in_progress') {
        return [
            `<@${request.memberId}> и <@${request.handledBy}> подключились к <#${request.voiceChannelId}>.`,
            request.type === 'lecture' ? 'Лекция начата.' : 'Пересдача начата.',
        ].join('\n');
    }
    if (request.status === 'expired') {
        return `<@${request.memberId}>, время ожидания входа в <#${request.voiceChannelId}> истекло. Заявка автоматически отменена.`;
    }
    if (request.status === 'closed_by_dismissal') {
        return 'Заявка закрыта в связи с увольнением сотрудника.';
    }
    if (request.status === 'completed') {
        if (request.type === 'lecture') return 'Лекция завершена.';
        return request.retestPassed === true
            ? 'Пересдача сдана.'
            : 'Пересдача не сдана.';
    }
    if (request.status === 'cancelled_by_handler') {
        return request.type === 'lecture'
            ? 'Лекция отменена лектором.'
            : 'Пересдача отменена экзаменатором.';
    }
    return null;
}

async function ensureVoiceNotice(client, request) {
    const content = buildVoiceNoticeContent(request);
    if (!content || !request.requestChannelId || !request.requestMessageId) return false;
    const channel = await client.channels.fetch(request.requestChannelId).catch(() => null);
    if (!channel?.messages?.fetch) return false;

    if (request.voiceNoticeMessageId) {
        const notice = await channel.messages.fetch(request.voiceNoticeMessageId).catch(() => null);
        if (notice) {
            await editMessageWithRetry(notice, {
                content,
                allowedMentions: { parse: [] },
            });
            return true;
        }
    }

    const parentMessage = await channel.messages.fetch(request.requestMessageId).catch(() => null);
    if (!parentMessage) return false;
    const publishIndex = Number(request.voiceNoticePublishCount || 0) + 1;
    const notice = await runDiscordRequest(() => parentMessage.reply({
        content,
        allowedMentions: {
            parse: [],
            users: request.status === 'waiting_for_voice' ? [request.memberId] : [],
        },
        nonce: createMessageNonce(
            `examinationVoiceNotice:${request.guildId}:${request.requestId}:${publishIndex}`
        ),
        enforceNonce: true,
    }), { attempts: 4 });

    await updateStoredRequest(request.requestId, (entry) => {
        entry.voiceNoticeChannelId = notice.channelId;
        entry.voiceNoticeMessageId = notice.id;
        entry.voiceNoticeMessageLink = `https://discord.com/channels/${entry.guildId}/${notice.channelId}/${notice.id}`;
        entry.voiceNoticePublishCount = publishIndex;
        entry.voiceNoticeError = null;
        entry.history ||= [];
        entry.history.push({ action: 'voice_notice_published', at: Date.now(), messageId: notice.id });
    });
    return true;
}

function memberVoiceChannelId(guild, memberId) {
    return guild.voiceStates?.cache?.get(String(memberId))?.channelId ||
        guild.members?.cache?.get(String(memberId))?.voice?.channelId ||
        null;
}

async function expireVoiceRequest(client, requestId, now = Date.now()) {
    const expired = await updateStoredRequest(requestId, (entry) => {
        if (entry.status !== 'waiting_for_voice') return entry;
        if (Number(entry.voiceJoinDeadlineAt || 0) > now) return entry;
        entry.status = 'expired';
        entry.expiredAt = now;
        entry.history ||= [];
        entry.history.push({ action: 'voice_wait_expired', at: now });
        return entry;
    });
    if (!expired || expired.status !== 'expired') return expired;
    await updateRequestMessage(client, expired).catch(() => false);
    await ensureVoiceNotice(client, expired).catch(() => false);
    return expired;
}

async function reconcileVoiceRequest(client, requestId) {
    let request = getRequestById(requestId);
    if (!request || request.status !== 'waiting_for_voice') return request;
    if (Number(request.voiceJoinDeadlineAt || 0) <= Date.now()) {
        return expireVoiceRequest(client, request.requestId);
    }

    await ensureVoiceNotice(client, request).catch(async (error) => {
        logger.warn('Не удалось отправить уведомление об ожидании голосового канала', {
            guildId: request.guildId,
            requestId: request.requestId,
        }, error);
        await updateStoredRequest(request.requestId, (entry) => {
            entry.voiceNoticeError = String(error?.stack || error?.message || error);
        });
    });

    const guild = client.guilds.cache.get(request.guildId) ||
        await client.guilds.fetch(request.guildId).catch(() => null);
    if (!guild) return request;
    const memberChannelId = memberVoiceChannelId(guild, request.memberId);
    const handlerChannelId = memberVoiceChannelId(guild, request.handledBy);
    if (
        String(memberChannelId || '') !== String(request.voiceChannelId) ||
        String(handlerChannelId || '') !== String(request.voiceChannelId)
    ) {
        return request;
    }

    request = await updateStoredRequest(request.requestId, (entry) => {
        if (entry.status !== 'waiting_for_voice') return entry;
        const now = Date.now();
        if (Number(entry.voiceJoinDeadlineAt || 0) <= now) return entry;
        entry.status = 'in_progress';
        entry.startedAt = now;
        entry.history ||= [];
        entry.history.push({ action: 'voice_participants_joined', at: now });
        return entry;
    });
    if (request.status !== 'in_progress') {
        if (request.status === 'waiting_for_voice') return expireVoiceRequest(client, request.requestId);
        return request;
    }
    await updateRequestMessage(client, request).catch(() => false);
    await ensureVoiceNotice(client, request).catch(() => false);
    return request;
}

async function handleVoiceStateUpdate(client, oldState, newState) {
    const guildId = newState?.guild?.id || oldState?.guild?.id;
    const memberId = newState?.id || oldState?.id;
    if (!guildId || !memberId) return 0;
    const db = readDb();
    const requestIds = (db.examinationRequests || [])
        .filter((request) => (
            request.status === 'waiting_for_voice' &&
            String(request.guildId) === String(guildId) &&
            [request.memberId, request.handledBy].some((id) => String(id) === String(memberId))
        ))
        .map((request) => request.requestId);
    for (const requestId of requestIds) {
        await reconcileVoiceRequest(client, requestId);
    }
    return requestIds.length;
}

function isPendingReminderDue(request, reminderMinutes, now = Date.now()) {
    if (!request || request.status !== 'pending' || request.pendingReminderAt) return false;
    const minutes = Number(reminderMinutes || 0);
    if (!Number.isFinite(minutes) || minutes <= 0) return false;
    const baseTimestamp = Number(request.publishedAt || request.createdAt || 0);
    return baseTimestamp > 0 && Number(now) - baseTimestamp >= minutes * 60_000;
}

async function processPendingRequestReminders(client) {
    const now = Date.now();
    const db = readDb();
    const requestIds = (db.examinationRequests || [])
        .filter((request) => (
            request.status === 'pending' &&
            !request.pendingReminderAt &&
            guildConfigService.isEnabled(request.guildId)
        ))
        .map((request) => request.requestId);
    let reminded = 0;

    for (const requestId of requestIds) {
        try {
            const request = getRequestById(requestId);
            if (!request || request.status !== 'pending' || request.pendingReminderAt) continue;
            const config = getConfig(request.guildId);
            const settings = getExaminationSettings(config);
            const reminderMinutes = Number(settings.pendingReminderMinutes || 0);
            if (!isPendingReminderDue(request, reminderMinutes, now)) continue;
            const channel = await client.channels.fetch(request.requestChannelId).catch(() => null);
            if (!channel?.send) continue;
            const roleIds = requestPingRoleIds(request, config)
                .filter((roleId) => channel.guild?.roles?.cache?.has(roleId));
            await sendMessageWithRetry(channel, {
                content: [
                    roleIds.map((roleId) => `<@&${roleId}>`).join(' '),
                    `Заявка ожидает рассмотрения больше ${reminderMinutes} мин.`,
                    request.requestMessageLink || '',
                ].filter(Boolean).join('\n'),
                allowedMentions: { parse: [], roles: roleIds },
            }, {
                nonceSeed: `examinationPendingReminder:${request.requestId}`,
            });
            await updateStoredRequest(request.requestId, (entry) => {
                if (entry.status !== 'pending' || entry.pendingReminderAt) return entry;
                entry.pendingReminderAt = now;
                entry.history ||= [];
                entry.history.push({ action: 'pending_reminder_sent', at: now });
                return entry;
            });
            reminded += 1;
        } catch (error) {
            logger.warn('Не удалось отправить повторный пинг по заявке экзаменации', { requestId }, error);
        }
    }
    return reminded;
}

async function processWaitingVoiceRequests(client) {
    const db = readDb();
    const requestIds = (db.examinationRequests || [])
        .filter((request) => (
            request.status === 'waiting_for_voice' &&
            guildConfigService.isEnabled(request.guildId)
        ))
        .map((request) => request.requestId);
    for (const requestId of requestIds) {
        try {
            await reconcileVoiceRequest(client, requestId);
        } catch (error) {
            logger.warn('Не удалось обработать ожидание голосового канала', { requestId }, error);
        }
    }
    return requestIds.length;
}

async function buildLectureResultContent(guild, request) {
    const [lecturerDisplayName, examineeDisplayName] = await Promise.all([
        resolveCurrentDisplayName(
            guild,
            request.handledBy,
            request.handledByDisplayName
        ),
        resolveCurrentDisplayName(
            guild,
            request.memberId,
            request.memberDisplayName
        ),
    ]);
    const departmentLabel = String(
        request.departmentShortName || request.departmentName || ''
    ).trim();
    const lectureName = String(
        request.lectureTypeName || request.lectureTypeId || 'лекцию'
    ).trim().replace(/[.!?]+$/u, '');
    const resultLine = departmentLabel
        ? `Прослушал вступительную лекцию по работе в отделе [${departmentLabel}].`
        : `Прослушал вступительную лекцию ${lectureName}.`;

    return [
        `Лектор: ${formatResultMember(request.handledBy, lecturerDisplayName)}`,
        `Экзаменуемый: ${formatResultMember(request.memberId, examineeDisplayName)}`,
        resultLine,
    ].join('\n');
}

async function publishLectureResult(client, requestId) {
    let request = getRequestById(requestId);
    if (!request || request.type !== 'lecture') {
        throw new ExaminationError('Заявка на лекцию не найдена.', 'lecture_request_not_found');
    }
    if (request.lectureResultMessageId) return request;
    if (!['completing', 'completion_failed'].includes(request.status)) {
        throw new ExaminationError('Итог этой лекции сейчас нельзя опубликовать.', 'lecture_result_state_conflict');
    }

    const config = getConfig(request.guildId);
    const channel = await getLectureResultChannel(client, request, config);
    try {
        const resultMessage = await sendMessageWithRetry(channel, {
            content: await buildLectureResultContent(channel.guild, request),
            allowedMentions: { parse: [] },
        }, {
            nonceSeed: `lectureResult:${request.guildId}:${request.requestId}`,
        });
        request = await updateStoredRequest(request.requestId, (entry) => {
            const now = Date.now();
            entry.status = 'completed';
            entry.completedAt = now;
            entry.lectureResultChannelId = resultMessage.channelId;
            entry.lectureResultMessageId = resultMessage.id;
            entry.lectureResultMessageLink = `https://discord.com/channels/${entry.guildId}/${resultMessage.channelId}/${resultMessage.id}`;
            entry.lastError = null;
            entry.history ||= [];
            entry.history.push({ action: 'lecture_completed', actorId: entry.handledBy, at: now, messageId: resultMessage.id });
            return entry;
        });
    } catch (error) {
        request = await updateStoredRequest(request.requestId, (entry) => {
            entry.status = 'completion_failed';
            entry.lastError = String(error?.stack || error?.message || error);
            entry.history ||= [];
            entry.history.push({ action: 'lecture_result_failed', at: Date.now() });
            return entry;
        });
        await updateRequestMessage(client, request).catch(() => false);
        throw error;
    }
    await updateRequestMessage(client, request).catch(() => false);
    await ensureVoiceNotice(client, request).catch(() => false);
    return request;
}

async function buildRetestResultContent(guild, request) {
    const [examinerDisplayName, examineeDisplayName] = await Promise.all([
        resolveCurrentDisplayName(
            guild,
            request.handledBy,
            request.handledByDisplayName
        ),
        resolveCurrentDisplayName(
            guild,
            request.memberId,
            request.memberDisplayName
        ),
    ]);
    const passed = request.retestPassed === true;
    return [
        `Экзаменатор: ${formatResultMember(request.handledBy, examinerDisplayName)}`,
        `Экзаменуемый: ${formatResultMember(request.memberId, examineeDisplayName)}`,
        `Ссылка на сдачу экзамена: ${request.requestMessageLink || '-'}`,
        `Тип экзамена: ${request.examName || request.examId}`,
        `Результат: ${passed ? 'СДАНО ✅' : 'НЕ СДАНО ❌'}`,
    ].join('\n');
}

async function publishRetestResult(client, requestId) {
    let request = getRequestById(requestId);
    if (!request || request.type !== 'retest') {
        throw new ExaminationError('Заявка на пересдачу не найдена.', 'retest_request_not_found');
    }
    if (request.retestResultMessageId) return request;
    if (!['completing', 'completion_failed'].includes(request.status)) {
        throw new ExaminationError('Итог этой пересдачи сейчас нельзя опубликовать.', 'retest_result_state_conflict');
    }
    if (typeof request.retestPassed !== 'boolean') {
        throw new ExaminationError(
            'Перед публикацией итога необходимо выбрать "Сдал" или "Не сдал".',
            'retest_result_missing'
        );
    }

    const config = getConfig(request.guildId);
    const channel = await getRetestResultChannel(client, request, config);

    try {
        const resultMessage = await sendMessageWithRetry(channel, {
            content: await buildRetestResultContent(channel.guild, request),
            allowedMentions: { parse: [] },
        }, {
            nonceSeed: `retestResult:${request.guildId}:${request.requestId}`,
        });
        if (request.retestPassed === true) {
            await examAttemptService.clearAfterPass({
                guildId: request.guildId,
                memberId: request.memberId,
                examId: request.examId,
            });
        }
        request = await updateStoredRequest(request.requestId, (entry) => {
            const now = Date.now();
            entry.status = 'completed';
            entry.completedAt = now;
            entry.retestResultChannelId = resultMessage.channelId;
            entry.retestResultMessageId = resultMessage.id;
            entry.retestResultMessageLink = `https://discord.com/channels/${entry.guildId}/${resultMessage.channelId}/${resultMessage.id}`;
            entry.lastError = null;
            entry.history ||= [];
            entry.history.push({
                action: entry.retestPassed === true ? 'retest_passed' : 'retest_failed',
                actorId: entry.handledBy,
                at: now,
                messageId: resultMessage.id,
            });
            return entry;
        });
    } catch (error) {
        request = await updateStoredRequest(request.requestId, (entry) => {
            entry.status = 'completion_failed';
            entry.lastError = String(error?.stack || error?.message || error);
            entry.history ||= [];
            entry.history.push({ action: 'retest_result_failed', at: Date.now() });
            return entry;
        });
        await updateRequestMessage(client, request).catch(() => false);
        throw error;
    }
    await updateRequestMessage(client, request).catch(() => false);
    await ensureVoiceNotice(client, request).catch(() => false);
    return request;
}

async function transitionRequest(client, {
    requestId,
    actor,
    action,
    reason = null,
}) {
    const normalizedReason = normalizeComment(reason);
    if (action === 'reject' && !normalizedReason) {
        throw new ExaminationError('Для отклонения нужно указать причину.', 'rejection_reason_required');
    }

    let request = getRequestById(requestId);
    if (!request) throw new ExaminationError('Заявка не найдена.', 'request_not_found');
    const config = getConfig(request.guildId);
    const guild = actor.guild;

    if (action === 'cancel') {
        if (String(request.memberId) !== String(actor.id)) {
            throw new ExaminationError('Отозвать заявку может только её автор.', 'cancel_access_denied');
        }
        if (request.status !== 'pending') {
            throw new ExaminationError('Эту заявку уже нельзя отозвать.', 'cancel_not_allowed');
        }
    } else if (['complete', 'pass', 'fail', 'cancel_procedure'].includes(action)) {
        if (request.status !== 'in_progress') {
            throw new ExaminationError('Заявка ещё не находится в процессе проведения.', 'complete_not_allowed');
        }
        if (String(request.handledBy) !== String(actor.id)) {
            throw new ExaminationError(
                request.type === 'lecture'
                    ? 'Завершить или отменить лекцию может только принявший её лектор.'
                    : 'Завершить или отменить пересдачу может только принявший её экзаменатор.',
                'handler_mismatch'
            );
        }
        if (action === 'complete' && request.type !== 'lecture') {
            throw new ExaminationError('Для пересдачи необходимо выбрать результат "Сдал" или "Не сдал".', 'retest_result_required');
        }
        if (['pass', 'fail'].includes(action) && request.type !== 'retest') {
            throw new ExaminationError('У лекции нет результата "Сдал" или "Не сдал".', 'lecture_result_invalid');
        }
    } else if (!canManageRequest(actor, request, config)) {
        throw new ExaminationError('У вас нет прав для обработки этой заявки.', 'manage_access_denied');
    }

    if (action === 'accept') {
        const voiceSettings = getVoiceSettings(config, guild, request.type);
        request = await updateStoredRequest(request.requestId, (entry) => {
            if (entry.status !== 'pending') {
                throw new ExaminationError('Заявка уже обработана или находится в другом состоянии.', 'state_conflict');
            }
            const now = Date.now();
            entry.status = 'waiting_for_voice';
            entry.handledBy = String(actor.id);
            entry.handledByDisplayName = actor.displayName;
            entry.handledAt = now;
            entry.voiceChannelId = voiceSettings.voiceChannelId;
            entry.voiceJoinTimeoutMinutes = voiceSettings.voiceJoinTimeoutMinutes;
            entry.voiceJoinDeadlineAt = now + voiceSettings.voiceJoinTimeoutMinutes * 60_000;
            entry.history ||= [];
            entry.history.push({ action: 'accept', actorId: actor.id, at: now });
            return entry;
        });
        await updateRequestMessage(client, request).catch(() => false);
        await ensureVoiceNotice(client, request).catch((error) => {
            logger.warn('Не удалось отправить сотруднику приглашение в голосовой канал', {
                guildId: request.guildId,
                requestId: request.requestId,
            }, error);
        });
        return reconcileVoiceRequest(client, request.requestId);
    }

    if (action === 'complete') {
        request = await updateStoredRequest(request.requestId, (entry) => {
            if (
                entry.type !== 'lecture' ||
                entry.status !== 'in_progress' ||
                String(entry.handledBy) !== String(actor.id)
            ) {
                throw new ExaminationError('Лекция уже завершена или передана другому лектору.', 'state_conflict');
            }
            entry.status = 'completing';
            entry.completionRequestedAt = Date.now();
            entry.history ||= [];
            entry.history.push({ action: 'lecture_completion_requested', actorId: actor.id, at: Date.now() });
            return entry;
        });
        await updateRequestMessage(client, request).catch(() => false);
        return publishLectureResult(client, request.requestId);
    }

    if (['pass', 'fail'].includes(action)) {
        request = await updateStoredRequest(request.requestId, (entry) => {
            if (
                entry.type !== 'retest' ||
                entry.status !== 'in_progress' ||
                String(entry.handledBy) !== String(actor.id)
            ) {
                throw new ExaminationError('Пересдача уже завершена или передана другому экзаменатору.', 'state_conflict');
            }
            const now = Date.now();
            entry.status = 'completing';
            entry.retestPassed = action === 'pass';
            entry.completionRequestedAt = now;
            entry.history ||= [];
            entry.history.push({
                action: entry.retestPassed ? 'retest_pass_requested' : 'retest_fail_requested',
                actorId: actor.id,
                at: now,
            });
            return entry;
        });
        await updateRequestMessage(client, request).catch(() => false);
        return publishRetestResult(client, request.requestId);
    }

    if (action === 'cancel_procedure') {
        request = await updateStoredRequest(request.requestId, (entry) => {
            if (entry.status !== 'in_progress' || String(entry.handledBy) !== String(actor.id)) {
                throw new ExaminationError('Процедура уже завершена или передана другому сотруднику.', 'state_conflict');
            }
            const now = Date.now();
            entry.status = 'cancelled_by_handler';
            entry.cancelledAt = now;
            entry.history ||= [];
            entry.history.push({
                action: entry.type === 'lecture' ? 'lecture_cancelled' : 'retest_cancelled',
                actorId: actor.id,
                at: now,
            });
            return entry;
        });
        await updateRequestMessage(client, request).catch(() => false);
        await ensureVoiceNotice(client, request).catch(() => false);
        return request;
    }

    request = await updateStoredRequest(request.requestId, (entry) => {
        const now = Date.now();
        const expected = {
            reject: ['pending'],
            cancel: ['pending'],
        }[action] || [];
        if (!expected.includes(entry.status)) {
            throw new ExaminationError('Заявка уже обработана или находится в другом состоянии.', 'state_conflict');
        }
        if (action === 'reject') entry.status = 'rejected';
        if (action === 'cancel') entry.status = 'cancelled';
        entry.handledBy = action === 'cancel' ? null : String(actor.id);
        entry.handledByDisplayName = action === 'cancel' ? null : actor.displayName;
        entry.handledAt = action === 'cancel' ? null : now;
        if (action === 'reject') entry.rejectionReason = normalizedReason;
        if (action === 'cancel') entry.cancelledAt = now;
        entry.history ||= [];
        entry.history.push({ action, actorId: actor.id, at: now, reason: normalizedReason });
        return entry;
    });

    await updateRequestMessage(client, request).catch((error) => {
        logger.warn('Не удалось обновить сообщение заявки экзаменации', {
            guildId: request.guildId,
            requestId: request.requestId,
            status: request.status,
        }, error);
    });
    return request;
}

async function releaseHandledRequestsForVacation(client, guildId, memberId, vacationId) {
    const released = await mutateDb((db) => {
        db.examinationRequests ||= [];
        const result = [];
        const now = Date.now();
        for (const request of db.examinationRequests) {
            if (String(request.guildId) !== String(guildId)) continue;
            if (String(request.handledBy || '') !== String(memberId)) continue;
            if (!['waiting_for_voice', 'in_progress'].includes(request.status)) continue;
            request.status = 'pending';
            request.handledBy = null;
            request.handledByDisplayName = null;
            request.handledAt = null;
            request.voiceChannelId = null;
            request.voiceJoinDeadlineAt = null;
            request.voiceStartedAt = null;
            request.updatedAt = now;
            request.history ||= [];
            request.history.push({
                action: 'handler_released_by_vacation',
                actorId: String(memberId),
                vacationId: String(vacationId || ''),
                at: now,
            });
            result.push(clone(request));
        }
        return result;
    });

    for (const request of released) {
        await updateRequestMessage(client, request).catch((error) => {
            logger.warn('Не удалось обновить заявку экзаменации после начала отпуска', {
                guildId,
                memberId,
                requestId: request.requestId,
            }, error);
        });
        await ensureVoiceNotice(client, request).catch(() => false);
    }
    return released.length;
}

async function closeMemberRequests(client, guildId, memberId) {
    const closed = await mutateDb((db) => {
        db.examinationRequests ||= [];
        const result = [];
        const now = Date.now();
        for (const request of db.examinationRequests) {
            if (String(request.guildId) !== String(guildId)) continue;
            if (String(request.memberId) !== String(memberId)) continue;
            if (!OPEN_REQUEST_STATUSES.has(request.status)) continue;
            request.status = 'closed_by_dismissal';
            request.closedAt = now;
            request.updatedAt = now;
            request.history ||= [];
            request.history.push({ action: 'closed_by_dismissal', at: now });
            result.push(clone(request));
        }
        return result;
    });

    for (const request of closed) {
        await updateRequestMessage(client, request).catch((error) => {
            logger.warn('Не удалось обновить заявку экзаменации после увольнения', {
                guildId,
                memberId,
                requestId: request.requestId,
            }, error);
        });
        await ensureVoiceNotice(client, request).catch(() => false);
    }
    return closed.length;
}

async function retryRequest(client, { guildId, requestId }) {
    let request = getRequestById(requestId);
    if (!request || String(request.guildId) !== String(guildId)) {
        throw new ExaminationError('Заявка экзаменации не найдена на этом сервере.', 'request_not_found');
    }

    if (request.status === 'completion_failed' && request.type === 'lecture') {
        request = await publishLectureResult(client, request.requestId);
    } else if (request.status === 'completion_failed' && request.type === 'retest') {
        request = await publishRetestResult(client, request.requestId);
    }

    const updated = await updateRequestMessage(client, request).catch(() => false);
    if (!updated) {
        request = await publishRequest(client, request.requestId);
    }

    if (request.status === 'waiting_for_voice') {
        request = await reconcileVoiceRequest(client, request.requestId) || request;
    } else if (request.voiceNoticeMessageId) {
        await ensureVoiceNotice(client, request).catch(() => false);
    }

    return { status: updated ? 'updated' : 'republished', request };
}

function getMissingChannelPermissions(guild, channel) {
    const me = guild?.members?.me;
    const permissions = me && typeof channel?.permissionsFor === 'function'
        ? channel.permissionsFor(me)
        : null;
    if (!permissions?.has) return [];

    const required = [
        [PermissionFlagsBits.ViewChannel, 'просматривать канал'],
        [PermissionFlagsBits.SendMessages, 'отправлять сообщения'],
        [PermissionFlagsBits.EmbedLinks, 'встраивать ссылки'],
        [PermissionFlagsBits.ReadMessageHistory, 'читать историю сообщений'],
    ];
    return required
        .filter(([permission]) => !permissions.has(permission))
        .map(([, label]) => label);
}

function validatePanelPublication(guild, config, mode = 'both') {
    const errors = [];
    if (!config || config.features?.exams !== true) {
        errors.push('Функция экзаменации отключена.');
        return errors;
    }

    const normalizedMode = ['lecture', 'retest', 'both'].includes(mode) ? mode : null;
    if (!normalizedMode) {
        errors.push('Выбран неизвестный состав панели экзаменации.');
        return errors;
    }

    const includesLecture = normalizedMode !== 'retest';
    const includesRetest = normalizedMode !== 'lecture';
    const settings = getExaminationSettings(config);
    const wnRoleId = normalizeId(config.commonRoles?.weazelNewsRoleId);
    if (!wnRoleId || !guild.roles.cache.has(wnRoleId)) {
        errors.push('Основная роль Weazel News не настроена или удалена.');
    }

    if (includesRetest) {
        const examinerRoleId = normalizeId(config.commonRoles?.examinerRoleId);
        if (!examinerRoleId || !guild.roles.cache.has(examinerRoleId)) {
            errors.push('Роль экзаменатора не настроена или удалена.');
        }
    }

    const textChannels = [];
    const voiceChannels = [];

    if (includesLecture) {
        if (!settings.lectureRequestChannelId) errors.push('Не настроен канал заявок на лекции.');
        if (!settings.lectureResultChannelId) errors.push('Не настроен канал итогов лекций.');
        if (!settings.lectureVoiceChannelId) errors.push('Не настроен голосовой канал лекций.');
        if (!settings.lectureTypes.length) errors.push('Не добавлен ни один тип лекции.');
        if (!getAvailableLectureTypes(config, guild).length) {
            errors.push('Нет ни одного типа лекции с действующим отделом/ролями обработки.');
        }
        textChannels.push(
            [settings.lectureRequestChannelId, 'Канал заявок на лекции'],
            [settings.lectureResultChannelId, 'Канал итогов лекций'],
        );
        voiceChannels.push([settings.lectureVoiceChannelId, 'Голосовой канал лекций']);
    }

    if (includesRetest) {
        if (!settings.retestRequestChannelId) errors.push('Не настроен канал заявок на пересдачи.');
        if (!settings.retestVoiceChannelId) errors.push('Не настроен голосовой канал пересдач.');
        if (!getExams(config).some((exam) => exam.retestEnabled && exam.maxAttempts > 0)) {
            errors.push('Нет ни одного экзамена с включёнными пересдачами и ограниченным количеством попыток.');
        }
        textChannels.push([settings.retestRequestChannelId, 'Канал заявок на пересдачи']);
        const retestResultChannelId = normalizeId(
            settings.retestResultChannelId || config.channels?.examResultChannelId
        );
        if (!retestResultChannelId) {
            errors.push('Не настроен ни отдельный канал итогов пересдач, ни общий канал результатов экзаменов.');
        } else {
            textChannels.push([
                retestResultChannelId,
                settings.retestResultChannelId
                    ? 'Канал итогов пересдач'
                    : 'Общий канал результатов экзаменов для итогов пересдач',
            ]);
        }
        voiceChannels.push([settings.retestVoiceChannelId, 'Голосовой канал пересдач']);
    }

    if (!Number.isSafeInteger(settings.voiceJoinTimeoutMinutes) || settings.voiceJoinTimeoutMinutes < 1) {
        errors.push('Некорректно настроено время ожидания входа в голосовой канал.');
    }

    for (const [channelId, label] of textChannels) {
        const channel = channelId ? guild.channels.cache.get(channelId) : null;
        if (channelId && (!channel?.isTextBased?.() || typeof channel.send !== 'function')) {
            errors.push(`${label} недоступен или не поддерживает сообщения.`);
            continue;
        }
        if (channel) {
            const missing = getMissingChannelPermissions(guild, channel);
            if (missing.length) errors.push(`${label}: у бота нет прав ${missing.join(', ')}.`);
        }
    }

    for (const [channelId, label] of voiceChannels) {
        if (!channelId) continue;
        const voiceChannel = guild.channels.cache.get(channelId);
        if (!voiceChannel || ![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(voiceChannel.type)) {
            errors.push(`${label} недоступен или имеет неподходящий тип.`);
            continue;
        }
        const permissions = guild.members?.me && typeof voiceChannel.permissionsFor === 'function'
            ? voiceChannel.permissionsFor(guild.members.me)
            : null;
        if (permissions?.has && !permissions.has(PermissionFlagsBits.ViewChannel)) {
            errors.push(`У бота нет права просматривать ${label.toLocaleLowerCase('ru')}.`);
        }
    }

    return errors;
}

module.exports = {
    ACTIVE_LECTURE_STATUSES,
    ACTIVE_RETEST_STATUSES,
    ExaminationError,
    assertRegularExamAttemptAvailable,
    canManageRequest,
    closeMemberRequests,
    createLectureRequest,
    createRetestRequest,
    getAvailableLectureTypes,
    getEligibleRetestExams,
    getRequestById,
    handleVoiceStateUpdate,
    isPendingReminderDue,
    processPendingRequestReminders,
    processWaitingVoiceRequests,
    publishLectureResult,
    publishRetestResult,
    releaseHandledRequestsForVacation,
    publishRequest,
    reconcileVoiceRequest,
    retryRequest,
    transitionRequest,
    updateRequestMessage,
    validatePanelPublication,
};
