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
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const {
    CHANNEL_DEFINITIONS,
    COMMON_ROLE_DEFINITIONS,
    FEATURE_DEFINITIONS,
} = require('./schema');
const { normalizeSettingsSectionAccess } = require('./accessSchema');
const { normalizeManualToolsAccess } = require('../manual-tools');
const {
    DEPARTMENT_ROLE_DEFINITIONS,
    prepareDepartmentsForStorage,
} = require('../../core/config/departmentSchema');
const {
    GRANT_POLICY_MODES,
    prepareRanksForStorage,
} = require('../staff-audit');
const {
    EXAM_CHECK_MODES,
    getExams,
    prepareExamsForStorage,
} = require('../examination');
const {
    prepareExaminationSettingsForStorage,
} = require('../examination');
const {
    prepareGiveRolesSettingsForStorage,
} = require('../give-roles');
const {
    prepareStaffAuditSettingsForStorage,
} = require('../staff-audit');
const {
    DISCIPLINE_STAGES,
    prepareDisciplineSettingsForStorage,
} = require('../discipline');
const {
    prepareStaffListSettingsForStorage,
} = require('../staff-lists');
const {
    prepareChannelCounterSettingsForStorage,
} = require('../channel-counters');
const {
    VACATION_ACCESS_GROUP_KEYS,
    prepareVacationSettingsForStorage,
} = require('../vacations');
const {
    MAX_SHIFT_SLOTS,
    PUBLICATION_MODES,
    getScheduleDurationMinutes,
    getShiftSlotCount,
    normalizeTime,
    prepareShiftTypesForStorage,
} = require('../shifts');

async function validateGuildSettings(guild, draft, { allGuildConfigs = [] } = {}) {
    const errors = [];

    for (const { key, label } of FEATURE_DEFINITIONS) {
        if (typeof draft.features?.[key] !== 'boolean') {
            errors.push(`Функция "${label}" имеет некорректное значение.`);
        }
    }

    for (const roleId of draft.settingsManagerRoleIds || []) {
        if (!guild.roles.cache.has(roleId)) {
            errors.push(`Роль доступа к настройкам ${roleId} больше не существует.`);
        }
    }

    for (const entry of normalizeSettingsSectionAccess(draft.settingsSectionAccess)) {
        if (!guild.roles.cache.has(entry.roleId)) {
            errors.push(`Роль ограниченного доступа к настройкам ${entry.roleId} больше не существует.`);
        }
    }

    for (const entry of normalizeManualToolsAccess(draft.manualToolsAccess)) {
        if (!guild.roles.cache.has(entry.roleId)) {
            errors.push(`Роль доступа к /manualtools ${entry.roleId} больше не существует.`);
        }
    }

    for (const definition of COMMON_ROLE_DEFINITIONS) {
        const roleId = draft.commonRoles?.[definition.key];
        if (roleId && !guild.roles.cache.has(roleId)) {
            errors.push(`Роль "${definition.label}" больше не существует.`);
        }
    }

    for (const definition of CHANNEL_DEFINITIONS) {
        const channelId = draft.channels?.[definition.key];
        if (!channelId) continue;

        const channel = guild.channels.cache.get(channelId);
        if (!channel) {
            errors.push(`Канал "${definition.label}" больше не существует.`);
            continue;
        }

        if (!definition.channelTypes.includes(channel.type)) {
            errors.push(`Для "${definition.label}" выбран канал неподходящего типа.`);
        }
    }


    const staffListSettings = prepareStaffListSettingsForStorage(draft.staffListSettings);
    if (staffListSettings.highStaffChannelId) {
        const channel = guild.channels.cache.get(staffListSettings.highStaffChannelId);
        if (!channel) {
            errors.push('Канал руководящего состава больше не существует.');
        } else if (!channel.isTextBased?.() || !channel.messages) {
            errors.push('Для руководящего состава выбран неподходящий канал.');
        }
    }

    if (staffListSettings.leaderAppointmentDate) {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(staffListSettings.leaderAppointmentDate);
        const date = match
            ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
            : null;
        if (
            !match ||
            date.getUTCFullYear() !== Number(match[1]) ||
            date.getUTCMonth() !== Number(match[2]) - 1 ||
            date.getUTCDate() !== Number(match[3])
        ) {
            errors.push('Дата назначения директора должна быть корректной датой в формате YYYY-MM-DD.');
        }
    }

    const channelCounterSettings = prepareChannelCounterSettingsForStorage(draft.channelCounterSettings);
    for (const [channelId, label] of [
        [channelCounterSettings.employeesChannelId, 'Счётчик сотрудников WN'],
        [channelCounterSettings.membersChannelId, 'Счётчик участников сервера'],
    ]) {
        if (!channelId) continue;
        const channel = guild.channels.cache.get(channelId);
        if (!channel) {
            errors.push(`Канал "${label}" больше не существует.`);
        } else if (![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type)) {
            errors.push(`Для "${label}" выбран канал неподходящего типа.`);
        }
    }

    if (
        channelCounterSettings.employeesChannelId &&
        !draft.commonRoles?.weazelNewsRoleId
    ) {
        errors.push('Для счётчика сотрудников WN не выбрана основная роль Weazel News.');
    }

    if (
        draft.features?.channelCounters &&
        !channelCounterSettings.employeesChannelId &&
        !channelCounterSettings.membersChannelId
    ) {
        errors.push('Для включённой функции "Счётчики" нужно выбрать хотя бы один канал-счётчик.');
    }


    const shiftTypes = prepareShiftTypesForStorage(draft.shiftTypes);
    const shiftTypeIds = new Set();
    const shiftTypeNames = new Set();
    let enabledShiftTypes = 0;

    for (const shiftType of shiftTypes) {
        const displayName = shiftType.name || shiftType.id || 'без названия';
        const normalizedName = displayName.toLocaleLowerCase('ru');

        if (!shiftType.id) {
            errors.push(`У расписания смен "${displayName}" отсутствует внутренний ID.`);
        } else if (!/^[A-Za-z0-9_-]{1,50}$/.test(shiftType.id)) {
            errors.push(`У расписания смен "${displayName}" внутренний ID содержит недопустимые символы.`);
        } else if (shiftTypeIds.has(shiftType.id)) {
            errors.push(`У расписаний смен повторяется внутренний ID "${shiftType.id}".`);
        } else {
            shiftTypeIds.add(shiftType.id);
        }

        if (!shiftType.name) {
            errors.push(`У расписания смен "${displayName}" не указано название.`);
        } else if (shiftTypeNames.has(normalizedName)) {
            errors.push(`Название смен "${shiftType.name}" используется несколько раз.`);
        } else {
            shiftTypeNames.add(normalizedName);
        }
        if (!shiftType.headerTemplate || shiftType.headerTemplate.length > 200) {
            errors.push(`У расписания смен "${displayName}" указана некорректная шапка сообщения.`);
        }

        if (shiftType.enabled) enabledShiftTypes += 1;

        if (shiftType.channelId) {
            const channel = guild.channels.cache.get(shiftType.channelId);
            if (!channel) {
                errors.push(`Канал смен "${displayName}" больше не существует.`);
            } else if (!channel.isTextBased?.() || !channel.messages) {
                errors.push(`Для смен "${displayName}" выбран неподходящий канал.`);
            }
        } else if (shiftType.enabled) {
            errors.push(`Для включённых смен "${displayName}" не выбран канал.`);
        }

        if (shiftType.publication.mode === PUBLICATION_MODES.RANDOM) {
            if (
                normalizeTime(shiftType.publication.fromTime, null) === null ||
                normalizeTime(shiftType.publication.toTime, null) === null
            ) {
                errors.push(`У расписания смен "${displayName}" указано некорректное окно случайной публикации.`);
            }
        } else if (normalizeTime(shiftType.publication.time, null) === null) {
            errors.push(`У расписания смен "${displayName}" указано некорректное время публикации.`);
        }
        if (
            normalizeTime(shiftType.schedule.startTime, null) === null ||
            normalizeTime(shiftType.schedule.endTime, null) === null
        ) {
            errors.push(`У расписания смен "${displayName}" указано некорректное время начала или конца смен.`);
        }
        if (
            !Number.isSafeInteger(shiftType.schedule.slotDurationMinutes) ||
            shiftType.schedule.slotDurationMinutes < 5 ||
            shiftType.schedule.slotDurationMinutes > 1_440
        ) {
            errors.push(`У расписания смен "${displayName}" указана некорректная длительность слота.`);
        }

        const scheduleDuration = getScheduleDurationMinutes(shiftType.schedule);
        const slotCount = getShiftSlotCount(shiftType);
        if (!scheduleDuration) {
            errors.push(`У расписания смен "${displayName}" расписание имеет нулевую длительность.`);
        } else if (!slotCount || slotCount > MAX_SHIFT_SLOTS) {
            errors.push(`Расписание смен "${displayName}" создаёт ${slotCount} слотов. Допустимо от 1 до ${MAX_SHIFT_SLOTS}.`);
        }

        if (
            !Number.isSafeInteger(shiftType.maxSlotsPerMember) ||
            shiftType.maxSlotsPerMember < 0 ||
            shiftType.maxSlotsPerMember > MAX_SHIFT_SLOTS
        ) {
            errors.push(`У расписания смен "${displayName}" указан некорректный лимит смен на сотрудника.`);
        }

        for (const roleId of shiftType.managerRoleIds) {
            if (!guild.roles.cache.has(roleId)) {
                errors.push(`В ролях управления смен "${displayName}" роль ${roleId} больше не существует.`);
            }
        }

        const groupIds = new Set();
        let previousDelay = -1;
        for (const group of shiftType.accessGroups) {
            const groupName = group.name || group.id || 'без названия';
            if (!group.id) {
                errors.push(`У группы доступа "${groupName}" смен "${displayName}" отсутствует ID.`);
            } else if (!/^[A-Za-z0-9_-]{1,50}$/.test(group.id)) {
                errors.push(`У группы доступа "${groupName}" смен "${displayName}" ID содержит недопустимые символы.`);
            } else if (groupIds.has(group.id)) {
                errors.push(`В расписании смен "${displayName}" повторяется ID группы доступа "${group.id}".`);
            } else {
                groupIds.add(group.id);
            }

            if (!group.name) {
                errors.push(`У одной из групп доступа смен "${displayName}" не указано название.`);
            }
            if (!Number.isSafeInteger(group.delayMinutes) || group.delayMinutes < 0) {
                errors.push(`У группы доступа "${groupName}" указана некорректная задержка.`);
            } else if (group.delayMinutes <= previousDelay) {
                errors.push(`Задержки групп доступа смен "${displayName}" должны строго возрастать по списку.`);
            }
            previousDelay = group.delayMinutes;

            if (!group.roleIds.length) {
                errors.push(`Для группы доступа "${groupName}" смен "${displayName}" не выбраны роли.`);
            }
            for (const roleId of group.roleIds) {
                if (!guild.roles.cache.has(roleId)) {
                    errors.push(`В группе доступа "${groupName}" смен "${displayName}" роль ${roleId} больше не существует.`);
                }
            }
        }
    }

    if (draft.features?.shifts && !enabledShiftTypes) {
        errors.push('Для включённой функции "Смены" нужно добавить и включить хотя бы одно расписание.');
    }

    const ranks = prepareRanksForStorage(draft.ranks);
    const rankNumbers = new Set();
    const rankRoleIds = new Set();

    for (const rank of ranks) {
        const displayName = rank.name || `${rank.number} ранг`;

        if (!Number.isSafeInteger(rank.number) || rank.number <= 0) {
            errors.push(`У ранга "${displayName}" указан некорректный номер.`);
        } else if (rankNumbers.has(rank.number)) {
            errors.push(`Номер ранга ${rank.number} используется несколько раз.`);
        } else {
            rankNumbers.add(rank.number);
        }

        if (!rank.name) {
            errors.push(`У ранга ${rank.number || '?'} не указано название.`);
        }

        if (rank.roleId) {
            if (!guild.roles.cache.has(rank.roleId)) {
                errors.push(`У ранга ${rank.number} "${displayName}" Discord-роль больше не существует.`);
            } else if (rankRoleIds.has(rank.roleId)) {
                errors.push(`Одна Discord-роль назначена нескольким рангам, включая ранг ${rank.number} "${displayName}".`);
            } else {
                rankRoleIds.add(rank.roleId);
            }
        }

        if (rank.staffList?.showInLeadership && !rank.roleId) {
            errors.push(`Для показа ранга ${rank.number} "${displayName}" в руководящем составе нужна Discord-роль.`);
        }
        if (
            rank.staffList?.maxMembers !== null &&
            (!Number.isSafeInteger(rank.staffList?.maxMembers) || rank.staffList.maxMembers <= 0)
        ) {
            errors.push(`У ранга ${rank.number} "${displayName}" указан некорректный лимит руководящего состава.`);
        }
        if (rank.staffList?.showAppointmentTerm && !rank.staffList?.showInLeadership) {
            errors.push(`У ранга ${rank.number} "${displayName}" срок назначения включён без показа в руководящем составе.`);
        }

        if (!GRANT_POLICY_MODES.has(rank.grantPolicy?.mode)) {
            errors.push(`У ранга ${rank.number} "${displayName}" указано некорректное правило выдачи.`);
        }

        if (rank.grantPolicy?.mode === 'roles') {
            if (!rank.grantPolicy.roleIds.length) {
                errors.push(`Для ранга ${rank.number} "${displayName}" не выбраны роли персонального правила выдачи.`);
            }

            for (const roleId of rank.grantPolicy.roleIds) {
                if (!guild.roles.cache.has(roleId)) {
                    errors.push(`В правиле выдачи ранга ${rank.number} "${displayName}" роль ${roleId} больше не существует.`);
                }
            }
        }

    }

    for (const rankNumber of staffListSettings.curatorManagementRankNumbers) {
        if (!rankNumbers.has(rankNumber)) {
            errors.push(`Ранг руководства для определения кураторов ${rankNumber} больше не существует.`);
        }
    }

    const departments = prepareDepartmentsForStorage(draft.departments);
    const departmentIds = new Set();
    const departmentShortNames = new Set();

    for (const department of departments) {
        const displayName = department.shortName || department.fullName || department.id;
        const normalizedShortName = department.shortName.toLocaleLowerCase('ru');

        if (!department.id) {
            errors.push('У одного из отделов отсутствует внутренний ID.');
        } else if (departmentIds.has(department.id)) {
            errors.push(`У отделов повторяется внутренний ID "${department.id}".`);
        } else {
            departmentIds.add(department.id);
        }

        if (!department.shortName) {
            errors.push(`У отдела "${displayName}" не указано сокращение.`);
        } else if (departmentShortNames.has(normalizedShortName)) {
            errors.push(`Сокращение отдела "${department.shortName}" используется несколько раз.`);
        } else {
            departmentShortNames.add(normalizedShortName);
        }

        if (!department.fullName) {
            errors.push(`У отдела "${displayName}" не указано полное название.`);
        }

        if (!Number.isSafeInteger(department.limits.heads) || department.limits.heads < 0) {
            errors.push(`У отдела "${displayName}" указан некорректный лимит глав.`);
        }

        if (!Number.isSafeInteger(department.limits.deputyHeads) || department.limits.deputyHeads < 0) {
            errors.push(`У отдела "${displayName}" указан некорректный лимит заместителей главы.`);
        }

        for (const definition of DEPARTMENT_ROLE_DEFINITIONS) {
            const roleId = department.roles?.[definition.key];
            if (roleId && !guild.roles.cache.has(roleId)) {
                errors.push(`В отделе "${displayName}" роль "${definition.label}" больше не существует.`);
            }
        }

        if (department.staffChannelId) {
            const channel = guild.channels.cache.get(department.staffChannelId);
            if (!channel) {
                errors.push(`Канал состава отдела "${displayName}" больше не существует.`);
            } else if (!channel.isTextBased?.() || !channel.messages) {
                errors.push(`Для состава отдела "${displayName}" выбран неподходящий канал.`);
            }
        }
    }

    if (
        draft.features?.staffLists &&
        !staffListSettings.highStaffChannelId &&
        !departments.some((department) => department.staffChannelId)
    ) {
        errors.push('Для включённой функции "Составы" нужно выбрать канал руководящего состава или канал состава хотя бы одного отдела.');
    }

    const exams = prepareExamsForStorage(draft.exams);
    const examIds = new Set();
    const testIds = new Set();

    for (const exam of exams) {
        const displayName = exam.name || exam.id || exam.testId || 'без названия';

        if (!exam.id) {
            errors.push(`У экзамена "${displayName}" отсутствует внутренний ID.`);
        } else if (examIds.has(exam.id)) {
            errors.push(`У экзаменов повторяется внутренний ID "${exam.id}".`);
        } else {
            examIds.add(exam.id);
        }

        if (!exam.name) {
            errors.push(`У экзамена "${displayName}" не указано название.`);
        }

        if (!exam.testId) {
            errors.push(`У экзамена "${displayName}" не указан testId.`);
        } else if (testIds.has(exam.testId)) {
            errors.push(`testId "${exam.testId}" используется несколькими экзаменами этого сервера.`);
        } else {
            testIds.add(exam.testId);
        }

        if (!EXAM_CHECK_MODES.has(exam.checkMode)) {
            errors.push(`У экзамена "${displayName}" указан некорректный режим проверки.`);
        }

        if (!Number.isSafeInteger(exam.maxScore) || exam.maxScore <= 0) {
            errors.push(`У экзамена "${displayName}" указан некорректный максимальный балл.`);
        }

        if (!Number.isSafeInteger(exam.passScore) || exam.passScore <= 0) {
            errors.push(`У экзамена "${displayName}" указан некорректный проходной балл.`);
        } else if (Number.isSafeInteger(exam.maxScore) && exam.passScore > exam.maxScore) {
            errors.push(`У экзамена "${displayName}" проходной балл не может быть больше максимального.`);
        }

        if (!Number.isSafeInteger(exam.maxAttempts) || exam.maxAttempts < 0 || exam.maxAttempts > 100) {
            errors.push(`У экзамена "${displayName}" максимальное количество сдач должно быть от 0 до 100.`);
        }
        if (exam.maxAttempts === 0 && exam.retestEnabled) {
            errors.push(`У экзамена "${displayName}" нельзя включить пересдачи при неограниченном количестве попыток.`);
        }

        if (exam.quickCheckUrl) {
            try {
                const url = new URL(exam.quickCheckUrl);
                if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
            } catch {
                errors.push(`У экзамена "${displayName}" указана некорректная ссылка быстрой проверки.`);
            }
        }
    }

    const examinationSettings = prepareExaminationSettingsForStorage(draft.examinationSettings);
    const lectureTypeIds = new Set();
    const lectureTypeNames = new Set();
    if (examinationSettings.lectureTypes.length > 25) {
        errors.push('В экзаменации можно настроить не больше 25 типов лекций.');
    }
    for (const lectureType of examinationSettings.lectureTypes) {
        const displayName = lectureType.name || lectureType.id || 'без названия';
        if (!lectureType.id) {
            errors.push(`У типа лекции "${displayName}" отсутствует внутренний ID.`);
        } else if (lectureTypeIds.has(lectureType.id)) {
            errors.push(`У типов лекций повторяется внутренний ID "${lectureType.id}".`);
        } else {
            lectureTypeIds.add(lectureType.id);
        }
        if (!lectureType.name) {
            errors.push(`У типа лекции "${displayName}" отсутствует название.`);
        } else {
            const normalizedName = lectureType.name.toLocaleLowerCase('ru');
            if (lectureTypeNames.has(normalizedName)) {
                errors.push(`Название типа лекции "${lectureType.name}" используется несколько раз.`);
            } else {
                lectureTypeNames.add(normalizedName);
            }
        }

        if (lectureType.departmentId) {
            const department = departments.find((entry) => entry.id === lectureType.departmentId);
            if (!department) {
                errors.push(`У типа лекции "${displayName}" выбран удалённый отдел.`);
            } else {
                const managerRoleIds = [
                    department.roles?.headRoleId,
                    department.roles?.deputyHeadRoleId,
                ].filter(Boolean);
                if (!managerRoleIds.length) {
                    errors.push(`У отдела типа лекции "${displayName}" не настроены роли главы или заместителя главы.`);
                }
            }
        } else if (!lectureType.pingRoleIds.length) {
            errors.push(`У типа лекции "${displayName}" без отдела нужно выбрать хотя бы одну роль для пинга.`);
        }

        for (const roleId of lectureType.pingRoleIds) {
            if (!guild.roles.cache.has(roleId)) {
                errors.push(`У типа лекции "${displayName}" роль для пинга ${roleId} больше не существует.`);
            }
        }
    }

    for (const [channelId, label] of [
        [examinationSettings.lectureRequestChannelId, 'Канал заявок на лекции'],
        [examinationSettings.retestRequestChannelId, 'Канал заявок на пересдачи'],
        [examinationSettings.lectureResultChannelId, 'Канал итогов лекций'],
        [examinationSettings.retestResultChannelId, 'Отдельный канал итогов пересдач'],
    ]) {
        if (!channelId) continue;
        const channel = guild.channels.cache.get(channelId);
        if (!channel) {
            errors.push(`${label} больше не существует.`);
        } else if (!channel.isTextBased?.() || typeof channel.send !== 'function') {
            errors.push(`${label} не поддерживает отправку сообщений.`);
        }
    }

    for (const [channelId, label] of [
        [examinationSettings.lectureVoiceChannelId, 'Голосовой канал лекций'],
        [examinationSettings.retestVoiceChannelId, 'Голосовой канал пересдач'],
    ]) {
        if (!channelId) continue;
        const voiceChannel = guild.channels.cache.get(channelId);
        if (!voiceChannel) {
            errors.push(`${label} больше не существует.`);
        } else if (![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(voiceChannel.type)) {
            errors.push(`${label}: выбран канал, который не является голосовым.`);
        } else {
            const me = guild.members?.me;
            const permissions = me && typeof voiceChannel.permissionsFor === 'function'
                ? voiceChannel.permissionsFor(me)
                : null;
            if (permissions?.has && !permissions.has(PermissionFlagsBits.ViewChannel)) {
                errors.push(`У бота нет права просматривать канал "${label}".`);
            }
        }
    }

    if (
        !Number.isSafeInteger(examinationSettings.voiceJoinTimeoutMinutes) ||
        examinationSettings.voiceJoinTimeoutMinutes < 1 ||
        examinationSettings.voiceJoinTimeoutMinutes > 180
    ) {
        errors.push('Время ожидания входа в голосовой канал должно быть целым числом от 1 до 180 минут.');
    }

    const giveRolesSettings = prepareGiveRolesSettingsForStorage(draft.giveRolesSettings);
    const inviteDepartment = giveRolesSettings.inviteDepartmentId
        ? departments.find((department) => department.id === giveRolesSettings.inviteDepartmentId) || null
        : null;
    const dbRank = giveRolesSettings.dbRankNumber
        ? ranks.find((rank) => rank.number === giveRolesSettings.dbRankNumber) || null
        : null;
    const initialRank = ranks[0] || null;

    for (const [key, label] of [
        ['dbAdditionalRoleIds', 'дополнительных ролей при ДБ'],
        ['reviewerRoleIds', 'ролей обработки заявок'],
        ['blockerRoleIds', 'ролей блокировки заявителей'],
    ]) {
        for (const roleId of giveRolesSettings[key]) {
            if (!guild.roles.cache.has(roleId)) {
                errors.push(`В настройке ${label} роль ${roleId} больше не существует.`);
            }
        }
    }

    if (giveRolesSettings.inviteDepartmentId && !inviteDepartment) {
        errors.push('Выбранный для принятия отдел больше не существует.');
    } else if (inviteDepartment && !inviteDepartment.roles?.memberRoleId) {
        errors.push(`У выбранного для принятия отдела "${inviteDepartment.shortName}" не настроена роль основного состава.`);
    }

    if (giveRolesSettings.dbRankNumber && !dbRank) {
        errors.push(`Выбранный для ДБ ранг ${giveRolesSettings.dbRankNumber} больше не существует.`);
    }

    if (draft.features?.giveRoles) {
        if (!draft.channels?.getRoleChannelId) {
            errors.push('Для включённой функции "Выдача ролей" не выбран канал подачи заявок.');
        }
        if (!draft.channels?.confirmRoleChannelId) {
            errors.push('Для включённой функции "Выдача ролей" не выбран канал подтверждения заявок.');
        }
        if (!draft.commonRoles?.weazelNewsRoleId) {
            errors.push('Для включённой функции "Выдача ролей" не выбрана основная роль Weazel News.');
        }
        if (!giveRolesSettings.inviteDepartmentId) {
            errors.push('Для включённой функции "Выдача ролей" не выбран отдел при принятии.');
        }
        if (!initialRank) {
            errors.push('Для включённой функции "Выдача ролей" нужен хотя бы один настроенный ранг.');
        }
        if (!giveRolesSettings.reviewerRoleIds.length) {
            errors.push('Для включённой функции "Выдача ролей" не выбраны роли обработки заявок.');
        }
    }

    const staffAuditSettings = prepareStaffAuditSettingsForStorage(draft.staffAuditSettings);

    for (const [key, label] of [
        ['deleteNotifyRoleIds', 'ролей уведомления об удалении'],
        ['dismissalKeepRoleIds', 'ролей, сохраняемых при увольнении'],
        ['dismissalApprovalRoleIds', 'ролей подтверждения увольнений'],
        ['dismissalLimitExemptRoleIds', 'ролей без лимита увольнений'],
    ]) {
        for (const roleId of staffAuditSettings[key]) {
            if (!guild.roles.cache.has(roleId)) {
                errors.push(`В настройке ${label} роль ${roleId} больше не существует.`);
            }
        }
    }

    for (const [channelId, label] of [
        [staffAuditSettings.channelId, 'Основной канал кадрового аудита'],
        [staffAuditSettings.deleteRequestChannelId, 'Канал запросов на удаление кадровых записей'],
        [staffAuditSettings.dismissalApprovalChannelId, 'Канал подтверждения увольнений'],
    ]) {
        if (!channelId) continue;
        const channel = guild.channels.cache.get(channelId);
        if (!channel) {
            errors.push(`${label} больше не существует.`);
        } else if (!channel.isTextBased?.() || !channel.messages) {
            errors.push(`Для настройки "${label}" выбран неподходящий канал.`);
        }
    }

    for (const [value, label] of [
        [staffAuditSettings.massAuditMaxItems, 'Максимум операций в одном массовом КА'],
        [staffAuditSettings.dismissalLimitCount, 'Лимит увольнений на исполнителя'],
        [staffAuditSettings.dismissalLimitWindowMinutes, 'Окно лимита увольнений'],
    ]) {
        if (!Number.isSafeInteger(value) || value <= 0) {
            errors.push(`Настройка "${label}" должна быть положительным целым числом.`);
        }
    }

    const hasApprovalChannel = Boolean(staffAuditSettings.dismissalApprovalChannelId);
    const hasApprovalRoles = staffAuditSettings.dismissalApprovalRoleIds.length > 0;
    if (hasApprovalChannel !== hasApprovalRoles) {
        errors.push('Канал подтверждения увольнений и роли подтверждения должны быть заполнены вместе.');
    }

    const hasDeleteChannel = Boolean(staffAuditSettings.deleteRequestChannelId);
    const hasDeleteRoles = staffAuditSettings.deleteNotifyRoleIds.length > 0;
    if (hasDeleteChannel !== hasDeleteRoles) {
        errors.push('Канал запросов на удаление и роли уведомления об удалении должны быть заполнены вместе.');
    }

    if (
        staffAuditSettings.departmentTransitionRankNumber &&
        !rankNumbers.has(staffAuditSettings.departmentTransitionRankNumber)
    ) {
        errors.push(
            `Ранг выхода из стажировочного отдела ${staffAuditSettings.departmentTransitionRankNumber} больше не существует.`
        );
    }

    if (draft.features?.staffAudit && !staffAuditSettings.channelId) {
        errors.push('Для включённой функции "Кадровый аудит" не выбран основной канал.');
    }
    if (
        draft.features?.staffAudit &&
        (!staffAuditSettings.dismissalApprovalChannelId || !staffAuditSettings.dismissalApprovalRoleIds.length)
    ) {
        errors.push(
            'Для включённого кадрового аудита нужно настроить канал и роли подтверждения увольнений сверх лимита.'
        );
    }

    const currentGuildId = String(guild.id);
    for (const config of Array.isArray(allGuildConfigs) ? allGuildConfigs : []) {
        if (String(config?.guildId || '') === currentGuildId) continue;

        for (const otherExam of getExams(config)) {
            if (!otherExam.testId || !testIds.has(otherExam.testId)) continue;
            errors.push(
                `testId "${otherExam.testId}" уже используется экзаменом "${otherExam.name || otherExam.id}" ` +
                `на сервере "${config._serverName || config.guildId}".`
            );
        }
    }

    if (draft.features?.exams) {
        if (!exams.length) {
            errors.push('Для включённой функции "Экзаменация" нужно добавить хотя бы один экзамен.');
        }
        if (!draft.channels?.examChannelId) {
            errors.push('Для включённой функции "Экзаменация" не выбран основной канал экзаменов.');
        }
        if (!draft.channels?.examResultChannelId) {
            errors.push('Для включённой функции "Экзаменация" не выбран канал результатов экзаменов.');
        }
        if (!draft.commonRoles?.examinerRoleId) {
            errors.push('Для включённой функции "Экзаменация" не выбрана роль экзаменатора.');
        }
    }


    const disciplineSettings = prepareDisciplineSettingsForStorage(draft.disciplineSettings);
    if (draft.features?.discipline) {
        if (!disciplineSettings.channelId) errors.push('Для включённой функции "Взыскания" не выбран канал взысканий.');
        if (!disciplineSettings.removalChannelId) errors.push('Для включённой функции "Взыскания" не выбран канал запросов на снятие.');
        if (!draft.commonRoles?.weazelNewsRoleId) {
            errors.push('Для включённой функции "Взыскания" не выбрана основная роль Weazel News.');
        }
        if (!disciplineSettings.removalApproverRoleIds.length) {
            errors.push('Для включённой функции "Взыскания" не выбраны роли подтверждения снятия.');
        }
        if (disciplineSettings.issuePolicy.enabled) {
            if (!disciplineSettings.issuePolicy.leadershipRoleIds.length) {
                errors.push('Для включённой проверки полномочий взысканий выберите роли руководящего состава.');
            }
            if (!disciplineSettings.issuePolicy.examinerRoleIds.length && !disciplineSettings.issuePolicy.departmentLeadershipEnabled) {
                errors.push('Проверка полномочий не предоставляет право ни экзаменаторам, ни старшему составу отделов.');
            }
        }
        if (disciplineSettings.appeals.enabled) {
            if (!disciplineSettings.appeals.channelId) errors.push('Для включённых обжалований выберите канал.');
            if (!disciplineSettings.appeals.finalReviewerRoleIds.length) {
                errors.push('Для включённых обжалований выберите тех, кто принимает окончательное решение.');
            }
            if (!disciplineSettings.appeals.workoffReviewerRoleIds.length) {
                errors.push('Для включённых обжалований выберите тех, кто рассматривает изменение способа отработки.');
            }
        }
    }
    for (const [key, label] of [
        ['channelId', 'Канал взысканий'],
        ['removalChannelId', 'Канал запросов на снятие взысканий'],
        ['appeals.channelId', 'Канал обжалований взысканий'],
    ]) {
        const channelId = key.includes('.')
            ? key.split('.').reduce((value, part) => value?.[part], disciplineSettings)
            : disciplineSettings[key];
        if (!channelId) continue;
        const channel = guild.channels.cache.get(channelId);
        if (!channel) errors.push(`${label} больше не существует.`);
        else if (!channel.isTextBased?.() || !channel.send || channel.isThread?.()) {
            errors.push(`${label}: нужен обычный текстовый канал с поддержкой веток.`);
        }
    }
    for (const [key, label] of [
        ['removalApproverRoleIds', 'Роль подтверждения снятия взысканий'],
        ['massApprovalRoleIds', 'Роль подтверждения массовых взысканий'],
        ['massApprovalBypassRoleIds', 'Роль обхода подтверждения массовых взысканий'],
        ['issuePolicy.leadershipRoleIds', 'Роль руководящего состава для взысканий'],
        ['issuePolicy.examinerRoleIds', 'Роль экзаменатора для взысканий'],
        ['appeals.finalReviewerRoleIds', 'Роль окончательного решения по обжалованию'],
        ['appeals.workoffReviewerRoleIds', 'Роль рассмотрения изменения отработки'],
    ]) {
        const roleIds = key.includes('.')
            ? key.split('.').reduce((value, part) => value?.[part], disciplineSettings)
            : disciplineSettings[key];
        for (const roleId of roleIds || []) {
            if (!guild.roles.cache.has(roleId)) errors.push(`${label} ${roleId} больше не существует.`);
        }
    }
    if (
        disciplineSettings.recertificationRoleId &&
        !guild.roles.cache.has(disciplineSettings.recertificationRoleId)
    ) {
        errors.push(`Роль переаттестации ${disciplineSettings.recertificationRoleId} больше не существует.`);
    }
    if (!Number.isSafeInteger(disciplineSettings.massMaxTargets) || disciplineSettings.massMaxTargets < 2 || disciplineSettings.massMaxTargets > 25) {
        errors.push('Максимум сотрудников в массовом взыскании должен быть от 2 до 25.');
    }
    if (!Number.isSafeInteger(disciplineSettings.massApprovalTimeoutMinutes) || disciplineSettings.massApprovalTimeoutMinutes < 5 || disciplineSettings.massApprovalTimeoutMinutes > 1440) {
        errors.push('Срок подтверждения массового взыскания должен быть от 5 до 1440 минут.');
    }
    const configuredDepartmentIds = new Set((draft.departments || []).map((department) => department.id));
    const disciplineRoleIds = new Set();
    for (const stageKey of DISCIPLINE_STAGES) {
        const stage = disciplineSettings.stages[stageKey];
        for (const roleId of Object.values(stage.roleByCount || {})) {
            if (!guild.roles.cache.has(roleId)) errors.push(`Роль состояния взысканий ${roleId} больше не существует.`);
            if (disciplineRoleIds.has(roleId)) errors.push(`Роль состояния взысканий ${roleId} назначена нескольким состояниям.`);
            disciplineRoleIds.add(roleId);
        }
    }
    if (disciplineSettings.workoffMethods.length > 24) errors.push('Можно настроить не больше 24 способов отработки.');
    const methodIds = new Set();
    const methodNames = new Set();
    for (const method of disciplineSettings.workoffMethods) {
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(method.id)) errors.push(`У способа отработки "${method.name}" некорректный ID.`);
        if (methodIds.has(method.id)) errors.push(`ID способа отработки ${method.id} используется несколько раз.`);
        methodIds.add(method.id);
        const normalizedMethodName = method.name.toLocaleLowerCase('ru');
        if (methodNames.has(normalizedMethodName)) errors.push(`Название способа отработки "${method.name}" используется несколько раз.`);
        methodNames.add(normalizedMethodName);
        for (const departmentId of method.departmentIds) {
            if (!configuredDepartmentIds.has(departmentId)) {
                errors.push(`Способ отработки "${method.name}" ссылается на отсутствующий отдел ${departmentId}.`);
            }
        }
    }
    if (disciplineSettings.conditionalRules.length > 25) errors.push('Можно настроить не больше 25 условных правил взысканий.');
    const configuredRankNumbers = new Set((draft.ranks || []).map((rank) => rank.number));
    const conditionalRuleIds = new Set();
    for (const rule of disciplineSettings.conditionalRules) {
        if (conditionalRuleIds.has(rule.id)) errors.push(`ID условного правила взысканий ${rule.id} используется несколько раз.`);
        conditionalRuleIds.add(rule.id);
        if (!configuredRankNumbers.has(rule.minRankNumber)) {
            errors.push(`Условное правило взысканий ссылается на отсутствующий минимальный ранг ${rule.minRankNumber}.`);
        }
        if (rule.action.type === 'set_rank') {
            if (!configuredRankNumbers.has(rule.action.rankNumber)) {
                errors.push(`Условное правило взысканий ссылается на отсутствующий целевой ранг ${rule.action.rankNumber}.`);
            }
            if (rule.action.rankNumber >= rule.minRankNumber) {
                errors.push('Условное дисциплинарное правило должно устанавливать ранг ниже минимального ранга условия.');
            }
        } else {
            const removeRoleIds = rule.action.removeRoleIds || [];
            const addRoleIds = rule.action.addRoleIds || [];
            if (!removeRoleIds.length && !addRoleIds.length) {
                errors.push(`У условного правила взысканий ${rule.id} не выбраны роли для изменения.`);
            }
            for (const roleId of [...removeRoleIds, ...addRoleIds]) {
                if (!guild.roles.cache.has(roleId)) {
                    errors.push(`Условное правило взысканий ${rule.id} ссылается на отсутствующую роль ${roleId}.`);
                }
            }
            const overlap = removeRoleIds.filter((roleId) => addRoleIds.includes(roleId));
            if (overlap.length) {
                errors.push(`Условное правило взысканий ${rule.id} одновременно снимает и выдаёт роли: ${overlap.join(', ')}.`);
            }
        }
    }


    const vacationSettings = prepareVacationSettingsForStorage(draft.vacationSettings);
    if (draft.features?.vacations) {
        if (!vacationSettings.requestChannelId) errors.push('Для включённой функции "Отпуска" не выбран канал заявок.');
        if (!vacationSettings.types.some((type) => type.enabled)) errors.push('Для включённой функции "Отпуска" нужно добавить хотя бы один тип отпуска.');
        if (!draft.commonRoles?.weazelNewsRoleId) errors.push('Для включённой функции "Отпуска" не выбрана основная роль Weazel News.');
    }
    if (vacationSettings.requestChannelId) {
        const channel = guild.channels.cache.get(vacationSettings.requestChannelId);
        if (!channel) errors.push('Канал заявок на отпуск больше не существует.');
        else if (!channel.isTextBased?.() || typeof channel.send !== 'function') errors.push('Для заявок на отпуск выбран неподходящий канал.');
    }
    for (const [roleIds, label] of [
        [vacationSettings.noDepartmentApproverRoleIds, 'Согласование отпусков без отдела'],
        [vacationSettings.upperLeadershipRoleIds, 'Верхнее руководство отпусков'],
    ]) {
        for (const roleId of roleIds) {
            if (!guild.roles.cache.has(roleId)) errors.push(`${label}: роль ${roleId} больше не существует.`);
        }
    }
    if (vacationSettings.roleRoutes.length > 25) errors.push('Можно настроить не более 25 маршрутов согласования отпусков.');
    if (vacationSettings.types.length > 25) errors.push('Можно настроить не более 25 типов отпусков.');
    const vacationRouteIds = new Set();
    for (const route of vacationSettings.roleRoutes) {
        if (!route.id || vacationRouteIds.has(route.id)) errors.push(`Маршрут отпусков "${route.name}" имеет пустой или повторяющийся ID.`);
        vacationRouteIds.add(route.id);
        if (!route.applicantRoleIds.length) errors.push(`В маршруте отпусков "${route.name}" не выбраны роли заявителя.`);
        if (!route.approverRoleIds.length) errors.push(`В маршруте отпусков "${route.name}" не выбраны роли согласования.`);
        for (const roleId of [...route.applicantRoleIds, ...route.approverRoleIds]) {
            if (!guild.roles.cache.has(roleId)) errors.push(`Маршрут отпусков "${route.name}" ссылается на удалённую роль ${roleId}.`);
        }
    }
    const vacationTypeIds = new Set();
    for (const type of vacationSettings.types) {
        if (!type.id || vacationTypeIds.has(type.id)) errors.push(`Тип отпуска "${type.name}" имеет пустой или повторяющийся ID.`);
        vacationTypeIds.add(type.id);
        if (!type.name) errors.push(`У типа отпуска ${type.id || 'без ID'} не указано название.`);
        if (type.maxDurationDays > 0 && type.maxDurationDays < type.minDurationDays) {
            errors.push(`У типа отпуска "${type.name}" максимум меньше минимальной продолжительности.`);
        }
        if (type.exceedMode === 'reroute' && !type.exceedApproverRoleIds.length) {
            errors.push(`У типа отпуска "${type.name}" включено перенаправление превышений, но не выбраны роли.`);
        }
        for (const roleId of [
            ...(type.availability?.roleIds || []),
            ...type.exceedApproverRoleIds,
            ...(type.removeRoleIdsOnStart || []),
            ...(type.accessBypassRoleIds || []),
            ...(type.vacationRoleId ? [type.vacationRoleId] : []),
            ...(type.overdueRules || []).flatMap((rule) => rule.notifyRoleIds || []),
        ]) {
            if (!guild.roles.cache.has(roleId)) errors.push(`Тип отпуска "${type.name}" ссылается на удалённую роль ${roleId}.`);
        }
        for (const group of type.blockedAccessGroups || []) {
            if (!VACATION_ACCESS_GROUP_KEYS.has(group)) errors.push(`Тип отпуска "${type.name}" содержит неизвестную группу блокировки ${group}.`);
        }
        if ((type.overdueRules || []).length > 25) errors.push(`У типа отпуска "${type.name}" можно настроить не более 25 правил просрочки.`);
        let previousDue = '';
        const ruleIds = new Set();
        for (const rule of type.overdueRules || []) {
            if (!rule.id || ruleIds.has(rule.id)) errors.push(`У типа отпуска "${type.name}" повторяется ID правила просрочки.`);
            ruleIds.add(rule.id);
            const dueKey = `${String(rule.afterDays).padStart(3, '0')}-${rule.time}`;
            if (previousDue && dueKey < previousDue) errors.push(`Правила просрочки типа "${type.name}" должны идти по возрастанию срока.`);
            previousDue = dueKey;
        }
    }

    return errors;
}

module.exports = {
    validateGuildSettings,
};
