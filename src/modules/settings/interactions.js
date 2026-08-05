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
const { MessageFlags } = require('discord.js');
const { createShiftSettingsModalHandlers } = require('../shifts');
const { createDisciplineSettingsHandlers } = require('../discipline');
const { createVacationSettingsHandlers } = require('../vacations');
const { SETTINGS_SECTION_KEYS } = require('./accessSchema');
const {
    MANUAL_TOOLS_SUBCOMMAND_KEYS,
} = require('../manual-tools');
const {
    CHANNEL_DEFINITIONS,
    COMMON_ROLE_DEFINITIONS,
    FEATURE_DEFINITIONS,
} = require('./schema');
const {
    DEPARTMENT_ROLE_DEFINITIONS,
    normalizeDepartmentColor,
} = require('../../core/config/departmentSchema');
const {
    EXAM_CHECK_MODES,
} = require('../examination');
const {
    GIVE_ROLES_SETTING_DEFINITIONS,
} = require('../give-roles');
const {
    STAFF_AUDIT_SETTING_DEFINITIONS,
} = require('../staff-audit');
const {
    STAFF_LIST_SETTING_DEFINITIONS,
} = require('../staff-lists');
const {
    CHANNEL_COUNTER_SETTING_DEFINITIONS,
} = require('../channel-counters');
const configSessionService = require('./session');
const guildConfigService = require('../../core/config/guildConfigService');
const { validateGuildSettings } = require('./validation');
const { scheduleGuildStaffListUpdate } = require('../staff-lists');
const { scheduleGuildChannelCounterUpdate } = require('../channel-counters');
const {
    PUBLICATION_MODES,
    addMinutesToTime,
    publishNextShiftScheduleNow,
    scheduleGuildShiftSync,
} = require('../shifts');
const {
    createDepartmentModal,
    createDisciplineIntegerModal,
    createDisciplineMethodModal,
    createDisciplineRuleModal,
    createExamModal,
    createExamScoresModal,
    createExaminationTimeoutModal,
    createLectureTypeModal,
    createVacationOverdueModal,
    createVacationRouteModal,
    createVacationTypeModal,
    createRankModal,
    createRankStaffListLimitModal,
    createStaffAuditIntegerModal,
    createStaffListDateModal,
    createShiftAccessGroupModal,
    createShiftScheduleModal,
    createShiftTypeModal,
    renderClosedPanel,
    renderSettingsPanel,
} = require('./presentation');
const settingsPublicationService = require('./publication');
const { buildConfigExport } = require('./configExport');
const {
    editMessageWithRetry,
    followUpWithRetry,
    replyWithRetry,
    runDiscordRequest,
} = require('../../core/discord/request');
const logger = require('../../core/logging/logger');
const { buildPublicErrorMessage } = require('../../core/ui/errorMessage');

const VALID_SECTIONS = new Set([
    'main',
    'features',
    'channels',
    'commonRoles',
    'settingsAccess',
    'manualToolsAccess',
    'departments',
    'departmentRoles',
    'departmentChannel',
    'departmentDelete',
    'ranks',
    'rankRole',
    'rankPolicy',
    'rankDelete',
    'rankStaffList',
    'exams',
    'examinationGeneral',
    'examinationChannels',
    'examinationVoiceChannels',
    'lectureTypes',
    'lectureTypeDetails',
    'lectureTypeDelete',
    'publicationPreview',
    'examMode',
    'examDelete',
    'giveRoles',
    'staffAudit',
    'staffLists',
    'channelCounters',
    'shiftTypes',
    'shiftTypeChannel',
    'shiftSchedule',
    'shiftAccess',
    'shiftManagers',
    'shiftPublish',
    'shiftDelete',
    'discipline',
    'disciplineGeneral',
    'disciplinePolicy',
    'disciplineAppeals',
    'disciplineStage',
    'disciplineStageRoles',
    'disciplineMethods',
    'disciplineMethodStages',
    'disciplineMethodDepartments',
    'disciplineRules',
    'disciplineRuleRoles',
    'vacations',
    'vacationGeneral',
    'vacationRoutes',
    'vacationRouteDetails',
    'vacationTypes',
    'vacationTypeDetails',
    'vacationTypeAvailability',
    'vacationTypeLimits',
    'vacationTypeActions',
    'vacationTypeBehavior',
    'vacationTypeOverdue',
    'diagnostics',
    'publications',
    'changes',
]);
const FEATURE_KEYS = new Set(FEATURE_DEFINITIONS.map(({ key }) => key));
const CHANNEL_KEYS = new Set(CHANNEL_DEFINITIONS.map(({ key }) => key));
const ROLE_KEYS = new Set(COMMON_ROLE_DEFINITIONS.map(({ key }) => key));
const DEPARTMENT_ROLE_KEYS = new Set(DEPARTMENT_ROLE_DEFINITIONS.map(({ key }) => key));
const RANK_POLICY_MODES = new Set(['unrestricted', 'roles', 'disabled']);
const GIVE_ROLES_KEYS = new Set(GIVE_ROLES_SETTING_DEFINITIONS.map(({ key }) => key));
const GIVE_ROLES_ROLE_KEYS = new Set(
    GIVE_ROLES_SETTING_DEFINITIONS
        .filter(({ valueType }) => valueType === 'roles')
        .map(({ key }) => key)
);
const STAFF_AUDIT_KEYS = new Set(STAFF_AUDIT_SETTING_DEFINITIONS.map(({ key }) => key));
const STAFF_AUDIT_ROLE_KEYS = new Set(
    STAFF_AUDIT_SETTING_DEFINITIONS
        .filter(({ valueType }) => valueType === 'roles')
        .map(({ key }) => key)
);
const STAFF_AUDIT_CHANNEL_KEYS = new Set(
    STAFF_AUDIT_SETTING_DEFINITIONS
        .filter(({ valueType }) => valueType === 'channel')
        .map(({ key }) => key)
);
const STAFF_LIST_KEYS = new Set(STAFF_LIST_SETTING_DEFINITIONS.map(({ key }) => key));
const STAFF_LIST_CHANNEL_KEYS = new Set(
    STAFF_LIST_SETTING_DEFINITIONS
        .filter(({ valueType }) => valueType === 'channel')
        .map(({ key }) => key)
);
const CHANNEL_COUNTER_KEYS = new Set(
    CHANNEL_COUNTER_SETTING_DEFINITIONS.map(({ key }) => key)
);
const RANK_PAGE_SIZE = 10;
const EXAM_PAGE_SIZE = 5;
const LECTURE_TYPE_PAGE_SIZE = 10;
const GIVE_ROLES_SELECT_PAGE_SIZE = 25;
const SHIFT_TYPE_PAGE_SIZE = 5;
const SHIFT_ACCESS_GROUP_PAGE_SIZE = 5;

const {
    handleShiftAccessGroupModal,
    handleShiftScheduleModal,
    handleShiftTypeModal,
} = createShiftSettingsModalHandlers({
    configSessionService,
    SHIFT_ACCESS_GROUP_PAGE_SIZE,
    SHIFT_TYPE_PAGE_SIZE,
    acknowledgePanelInteraction,
    generateShiftAccessGroupId,
    generateShiftTypeId,
    getShiftType,
    parseNonNegativeInteger,
    parsePositiveInteger,
    parseShiftAccessReference,
    updatePanel,
});


function getRequiredSettingsSection(parsed) {
    const action = String(parsed?.action || '');
    if (!action || ['save', 'cancel', 'changes_page'].includes(action)) return null;
    if (action === 'nav') return parsed.value || null;
    if (action.startsWith('settings_access_')) return 'settingsAccess';
    if (action.startsWith('manual_tools_access_')) return 'manualToolsAccess';
    if (action === 'feature') return 'features';
    if (action.startsWith('channel_counters_')) return 'channelCounters';
    if (action.startsWith('diagnostics_')) return 'diagnostics';
    if (action.startsWith('channel_')) return 'channels';
    if (action.startsWith('role_')) return 'commonRoles';
    if (action.startsWith('department_')) return 'departments';
    if (action.startsWith('rank_')) return 'ranks';
    if (action.startsWith('exam_')) return 'exams';
    if (action.startsWith('examination_') || action.startsWith('lecture_type_')) return 'exams';
    if (action === 'publication_examination_mode') return 'exams';
    if (action.startsWith('publication_')) {
        const reference = String(parsed.value || '');
        if (['examination', 'examinationGeneral'].includes(reference)) return 'exams';
        if (['giveRoles', 'giveRolesPanel'].includes(reference)) return 'giveRoles';
        if (['kaInfo', 'staffAudit'].includes(reference)) return 'staffAudit';
        if (reference === 'vacation') return 'vacations';
        if (reference === 'discordRules') return 'publications';
        return null;
    }
    if (action.startsWith('give_roles_')) return 'giveRoles';
    if (action.startsWith('staff_audit_')) return 'staffAudit';
    if (action.startsWith('staff_lists_')) return 'staffLists';
    if (action.startsWith('shift_')) return 'shiftTypes';
    if (action.startsWith('discipline_')) return 'discipline';
    if (action.startsWith('vacation_')) return 'vacations';
    return null;
}

function parseCustomId(customId) {
    const parts = String(customId || '').split(':');
    if (parts[0] !== 'settings' || !parts[1] || !parts[2]) return null;

    return {
        sessionId: parts[1],
        action: parts[2],
        value: parts.slice(3).join(':') || null,
    };
}

function parseDepartmentField(value) {
    const [departmentId, fieldKey] = String(value || '').split(':');
    return { departmentId, fieldKey };
}

function getDepartment(session, departmentId = session.selectedDepartmentId) {
    return (session.draft.departments || [])
        .find((department) => department.id === departmentId) || null;
}

function getRank(session, rankNumber = session.selectedRankNumber) {
    const number = Number(rankNumber);
    return (session.draft.ranks || [])
        .find((rank) => rank.number === number) || null;
}


function getExam(session, examId = session.selectedExamId) {
    return (session.draft.exams || [])
        .find((exam) => exam.id === String(examId || '')) || null;
}

function getShiftType(session, shiftTypeId = session.selectedShiftTypeId) {
    return (session.draft.shiftTypes || [])
        .find((shiftType) => shiftType.id === String(shiftTypeId || '')) || null;
}

function getShiftAccessGroup(session, groupId = session.selectedShiftAccessGroupId) {
    const shiftType = getShiftType(session);
    return (shiftType?.accessGroups || [])
        .find((group) => group.id === String(groupId || '')) || null;
}

function parseShiftAccessReference(value) {
    const [shiftTypeId, groupId] = String(value || '').split(':');
    return { shiftTypeId, groupId };
}


function sortSessionRanks(session) {
    session.draft.ranks.sort((left, right) => left.number - right.number);
}

function generateDepartmentId(session) {
    const existing = new Set((session.draft.departments || []).map(({ id }) => id));
    let id;
    do {
        id = `department-${crypto.randomBytes(5).toString('hex')}`;
    } while (existing.has(id));
    return id;
}


function generateExamId(session) {
    const existing = new Set((session.draft.exams || []).map(({ id }) => id));
    let id;
    do {
        id = `exam-${crypto.randomBytes(5).toString('hex')}`;
    } while (existing.has(id));
    return id;
}

function generateLectureTypeId(session) {
    const existing = new Set(
        (session.draft.examinationSettings?.lectureTypes || []).map(({ id }) => id)
    );
    let id;
    do {
        id = `lecture-${crypto.randomBytes(5).toString('hex')}`;
    } while (existing.has(id));
    return id;
}

function generateShiftTypeId(session) {
    const existing = new Set((session.draft.shiftTypes || []).map(({ id }) => id));
    let id;
    do {
        id = `shift-${crypto.randomBytes(5).toString('hex')}`;
    } while (existing.has(id));
    return id;
}

function generateShiftAccessGroupId(shiftType) {
    const existing = new Set((shiftType.accessGroups || []).map(({ id }) => id));
    let id;
    do {
        id = `access-${crypto.randomBytes(5).toString('hex')}`;
    } while (existing.has(id));
    return id;
}

function parsePositiveInteger(value) {
    const number = Number(String(value || '').trim());
    return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function parseNonNegativeInteger(value) {
    const number = Number(String(value || '').trim());
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

async function acknowledgePanelInteraction(interaction) {
    if (interaction.deferred || interaction.replied) return;
    await runDiscordRequest(() => interaction.deferUpdate(), { attempts: 1 });
}

async function getPanelMessage(client, interaction, session) {
    if (interaction.message?.id === session.messageId) return interaction.message;
    if (!session.channelId || !session.messageId) return null;

    const channel = await client.channels.fetch(session.channelId).catch(() => null);
    if (!channel?.messages?.fetch) return null;
    return channel.messages.fetch(session.messageId).catch(() => null);
}

async function updatePanel(client, interaction, session) {
    await acknowledgePanelInteraction(interaction);
    const message = await getPanelMessage(client, interaction, session);
    if (!message) {
        throw new Error('Активное сообщение панели /settings не найдено');
    }

    await editMessageWithRetry(message, renderSettingsPanel(session, interaction.guild));
}

const { handle: handleDisciplineSettings } = createDisciplineSettingsHandlers({
    acknowledgePanelInteraction,
    configSessionService,
    createDisciplineIntegerModal,
    createDisciplineMethodModal,
    createDisciplineRuleModal,
    runDiscordRequest,
    updatePanel,
});

const { handle: handleVacationSettings } = createVacationSettingsHandlers({
    acknowledgePanelInteraction,
    configSessionService,
    createVacationOverdueModal,
    createVacationRouteModal,
    createVacationTypeModal,
    runDiscordRequest,
    updatePanel,
});

async function replyPublic(interaction, content) {
    await replyWithRetry(interaction, {
        content,
        allowedMentions: { parse: [] },
    });
}

async function closeExpiredPanel(client, interaction) {
    if (interaction.isMessageComponent()) {
        await acknowledgePanelInteraction(interaction);
        await editMessageWithRetry(interaction.message, {
            content: 'Эта сессия настроек завершилась или истекла. Открой новую через `/settings`.',
            components: [],
        });
        return;
    }

    await replyPublic(interaction, 'Эта сессия настроек завершилась или истекла.');
}

async function handleDepartmentModal(client, interaction, session, parsed) {
    await acknowledgePanelInteraction(interaction);

    const shortName = interaction.fields.getTextInputValue('shortName').trim();
    const fullName = interaction.fields.getTextInputValue('fullName').trim();
    const heads = parseNonNegativeInteger(interaction.fields.getTextInputValue('heads'));
    const deputyHeads = parseNonNegativeInteger(interaction.fields.getTextInputValue('deputyHeads'));
    const colorInput = interaction.fields.getTextInputValue('color').trim();
    const color = normalizeDepartmentColor(colorInput);
    const errors = [];

    if (!shortName) errors.push('Не указано сокращение отдела.');
    if (!fullName) errors.push('Не указано полное название отдела.');
    if (heads === null) errors.push('Количество глав должно быть целым числом от 0.');
    if (deputyHeads === null) errors.push('Количество заместителей главы должно быть целым числом от 0.');
    if (colorInput && !color) errors.push('Цвет отдела должен быть указан в формате #RRGGBB.');

    const editId = parsed.value === 'new' ? null : parsed.value;
    const duplicate = (session.draft.departments || []).find((department) => (
        department.id !== editId &&
        department.shortName.toLocaleLowerCase('ru') === shortName.toLocaleLowerCase('ru')
    ));
    if (duplicate) {
        errors.push(`Сокращение "${shortName}" уже используется отделом "${duplicate.fullName}".`);
    }

    if (errors.length) {
        configSessionService.setErrors(session, errors);
        configSessionService.setSection(session, 'departments');
        configSessionService.setErrors(session, errors);
        await updatePanel(client, interaction, session);
        return;
    }

    if (editId) {
        const department = getDepartment(session, editId);
        if (!department) {
            configSessionService.setSection(session, 'departments');
            configSessionService.setErrors(session, ['Выбранный отдел больше не существует в текущей сессии.']);
            await updatePanel(client, interaction, session);
            return;
        }

        department.shortName = shortName;
        department.fullName = fullName;
        department.color = color;
        department.limits.heads = heads;
        department.limits.deputyHeads = deputyHeads;
        session.selectedDepartmentId = department.id;
        configSessionService.setSection(session, 'departments');
        configSessionService.markChanged(session, `Отдел "${shortName}" изменён.`);
    } else {
        const department = {
            id: generateDepartmentId(session),
            shortName,
            fullName,
            staffChannelId: null,
            color,
            curatorsEnabled: true,
            roles: {
                memberRoleId: null,
                partTimeRoleId: null,
                curatorRoleId: null,
                headRoleId: null,
                deputyHeadRoleId: null,
            },
            limits: {
                heads,
                deputyHeads,
            },
        };

        session.draft.departments.push(department);
        session.selectedDepartmentId = department.id;
        session.departmentPage = Math.floor((session.draft.departments.length - 1) / 25);
        configSessionService.setSection(session, 'departments');
        configSessionService.markChanged(session, `Отдел "${shortName}" добавлен.`);
    }

    await updatePanel(client, interaction, session);
}


async function handleRankModal(client, interaction, session, parsed) {
    await acknowledgePanelInteraction(interaction);

    const number = parsePositiveInteger(interaction.fields.getTextInputValue('number'));
    const name = interaction.fields.getTextInputValue('name').trim();
    const errors = [];
    if (number === null) errors.push('Номер ранга должен быть положительным целым числом.');
    if (!name) errors.push('Не указано название ранга.');

    const previousNumber = parsed.value === 'new' ? null : Number(parsed.value);
    const duplicate = (session.draft.ranks || []).find((rank) => (
        rank.number !== previousNumber && rank.number === number
    ));
    if (duplicate) errors.push(`Номер ${number} уже используется рангом "${duplicate.name}".`);

    if (errors.length) {
        configSessionService.setSection(session, 'ranks');
        configSessionService.setErrors(session, errors);
        await updatePanel(client, interaction, session);
        return;
    }

    if (previousNumber !== null) {
        const rank = getRank(session, previousNumber);
        if (!rank) {
            configSessionService.setSection(session, 'ranks');
            configSessionService.setErrors(session, ['Выбранный ранг больше не существует в текущей сессии.']);
            await updatePanel(client, interaction, session);
            return;
        }

        rank.number = number;
        rank.name = name;
        if (session.draft.giveRolesSettings?.dbRankNumber === previousNumber) {
            session.draft.giveRolesSettings.dbRankNumber = number;
        }
        if (Array.isArray(session.draft.staffListSettings?.curatorManagementRankNumbers)) {
            session.draft.staffListSettings.curatorManagementRankNumbers = Array.from(new Set(
                session.draft.staffListSettings.curatorManagementRankNumbers
                    .map((rankNumber) => rankNumber === previousNumber ? number : rankNumber)
            )).sort((left, right) => left - right);
        }
        session.selectedRankNumber = number;
        sortSessionRanks(session);
        session.rankPage = Math.floor(session.draft.ranks.findIndex((entry) => entry.number === number) / RANK_PAGE_SIZE);
        configSessionService.setSection(session, 'ranks');
        configSessionService.markChanged(session, `Ранг ${number} "${name}" изменён.`);
    } else {
        session.draft.ranks.push({
            number,
            name,
            roleId: null,
            grantPolicy: {
                mode: 'unrestricted',
                roleIds: [],
            },
            staffList: {
                showInLeadership: false,
                maxMembers: null,
                showAppointmentTerm: false,
            },
        });
        sortSessionRanks(session);
        session.selectedRankNumber = number;
        session.rankPage = Math.floor(session.draft.ranks.findIndex((entry) => entry.number === number) / RANK_PAGE_SIZE);
        configSessionService.setSection(session, 'ranks');
        configSessionService.markChanged(session, `Ранг ${number} "${name}" добавлен.`);
    }

    await updatePanel(client, interaction, session);
}


async function handleRankStaffListLimitModal(client, interaction, session, parsed) {
    await acknowledgePanelInteraction(interaction);
    const rank = getRank(session, parsed.value);
    configSessionService.setSection(session, 'rankStaffList');
    if (!rank) {
        configSessionService.setErrors(session, ['Выбранный ранг больше не существует в текущей сессии.']);
        await updatePanel(client, interaction, session);
        return;
    }

    const maxMembers = parsePositiveInteger(interaction.fields.getTextInputValue('maxMembers'));
    if (maxMembers === null) {
        configSessionService.setErrors(session, ['Лимит должен быть положительным целым числом.']);
        await updatePanel(client, interaction, session);
        return;
    }

    rank.staffList ||= {
        showInLeadership: false,
        maxMembers: null,
        showAppointmentTerm: false,
    };
    rank.staffList.maxMembers = maxMembers;
    session.selectedRankNumber = rank.number;
    configSessionService.markChanged(session, `Лимит руководящего состава для ранга ${rank.number} изменён.`);
    await updatePanel(client, interaction, session);
}

async function handleExamModal(client, interaction, session, parsed) {
    await acknowledgePanelInteraction(interaction);

    const name = interaction.fields.getTextInputValue('name').trim();
    const testId = interaction.fields.getTextInputValue('testId').trim();
    const quickCheckUrl = interaction.fields.getTextInputValue('quickCheckUrl').trim() || null;
    const editId = parsed.value === 'new' ? null : parsed.value;
    const errors = [];

    if (!name) errors.push('Не указано название экзамена.');
    if (!testId) errors.push('Не указан testId экзамена.');

    if (quickCheckUrl) {
        try {
            const url = new URL(quickCheckUrl);
            if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol');
        } catch {
            errors.push('Ссылка быстрой проверки должна быть корректной HTTP- или HTTPS-ссылкой.');
        }
    }

    const duplicate = (session.draft.exams || []).find((exam) => (
        exam.id !== editId && exam.testId === testId
    ));
    if (duplicate) errors.push(`testId "${testId}" уже используется экзаменом "${duplicate.name}".`);

    if (errors.length) {
        configSessionService.setSection(session, 'exams');
        configSessionService.setErrors(session, errors);
        await updatePanel(client, interaction, session);
        return;
    }

    if (editId) {
        const exam = getExam(session, editId);
        if (!exam) {
            configSessionService.setSection(session, 'exams');
            configSessionService.setErrors(session, ['Выбранный экзамен больше не существует в текущей сессии.']);
            await updatePanel(client, interaction, session);
            return;
        }

        exam.name = name;
        exam.testId = testId;
        exam.quickCheckUrl = quickCheckUrl;
        session.selectedExamId = exam.id;
        configSessionService.setSection(session, 'exams');
        configSessionService.markChanged(session, `Экзамен "${name}" изменён.`);
    } else {
        const exam = {
            id: generateExamId(session),
            name,
            testId,
            quickCheckUrl,
            checkMode: 'automatic',
            maxScore: null,
            passScore: null,
            maxAttempts: 2,
            retestEnabled: false,
        };

        session.draft.exams.push(exam);
        session.selectedExamId = exam.id;
        session.examPage = Math.floor((session.draft.exams.length - 1) / EXAM_PAGE_SIZE);
        configSessionService.setSection(session, 'exams');
        configSessionService.markChanged(session, `Экзамен "${name}" добавлен. Настрой баллы перед сохранением.`);
    }

    await updatePanel(client, interaction, session);
}

async function handleExamScoresModal(client, interaction, session, parsed) {
    await acknowledgePanelInteraction(interaction);

    const exam = getExam(session, parsed.value);
    if (!exam) {
        configSessionService.setSection(session, 'exams');
        configSessionService.setErrors(session, ['Выбранный экзамен больше не существует в текущей сессии.']);
        await updatePanel(client, interaction, session);
        return;
    }

    const maxScore = parsePositiveInteger(interaction.fields.getTextInputValue('maxScore'));
    const passScore = parsePositiveInteger(interaction.fields.getTextInputValue('passScore'));
    const maxAttempts = parseNonNegativeInteger(interaction.fields.getTextInputValue('maxAttempts'));
    const errors = [];

    if (maxScore === null) errors.push('Максимальный балл должен быть положительным целым числом.');
    if (passScore === null) errors.push('Проходной балл должен быть положительным целым числом.');
    if (maxAttempts === null || maxAttempts > 100) errors.push('Максимальное количество сдач должно быть целым числом от 0 до 100. Значение 0 отключает подсчёт попыток.');
    if (maxScore !== null && passScore !== null && passScore > maxScore) {
        errors.push('Проходной балл не может быть больше максимального.');
    }

    if (errors.length) {
        configSessionService.setSection(session, 'exams');
        configSessionService.setErrors(session, errors);
        await updatePanel(client, interaction, session);
        return;
    }

    exam.maxScore = maxScore;
    exam.passScore = passScore;
    exam.maxAttempts = maxAttempts;
    if (maxAttempts === 0) exam.retestEnabled = false;
    session.selectedExamId = exam.id;
    configSessionService.setSection(session, 'exams');
    configSessionService.markChanged(
        session,
        maxAttempts === 0
            ? `Для экзамена "${exam.name}" настроены баллы ${passScore}/${maxScore}; подсчёт попыток отключён.`
            : `Для экзамена "${exam.name}" настроены баллы ${passScore}/${maxScore} и максимум ${maxAttempts} сдач.`
    );
    await updatePanel(client, interaction, session);
}

async function handleLectureTypeModal(client, interaction, session, parsed) {
    await acknowledgePanelInteraction(interaction);

    const name = interaction.fields.getTextInputValue('name').trim();
    const editId = parsed.value === 'new' ? null : parsed.value;
    const lectureTypes = session.draft.examinationSettings?.lectureTypes || [];
    const errors = [];

    if (!name) errors.push('Не указано название типа лекции.');
    const duplicate = lectureTypes.find((entry) => (
        entry.id !== editId && entry.name.toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru')
    ));
    if (duplicate) errors.push(`Тип лекции "${name}" уже существует.`);

    configSessionService.setSection(session, 'lectureTypes');
    if (errors.length) {
        configSessionService.setErrors(session, errors);
        await updatePanel(client, interaction, session);
        return;
    }

    if (editId) {
        const lectureType = lectureTypes.find((entry) => entry.id === editId);
        if (!lectureType) {
            configSessionService.setErrors(session, ['Выбранный тип лекции больше не существует в текущей сессии.']);
            await updatePanel(client, interaction, session);
            return;
        }
        lectureType.name = name;
        session.selectedLectureTypeId = lectureType.id;
        configSessionService.markChanged(session, `Тип лекции "${name}" изменён.`);
    } else {
        if (lectureTypes.length >= 25) {
            configSessionService.setErrors(session, ['Можно настроить не более 25 типов лекций.']);
            await updatePanel(client, interaction, session);
            return;
        }
        const lectureType = {
            id: generateLectureTypeId(session),
            name,
            departmentId: null,
            pingRoleIds: [],
        };
        lectureTypes.push(lectureType);
        session.draft.examinationSettings.lectureTypes = lectureTypes;
        session.selectedLectureTypeId = lectureType.id;
        session.lectureTypePage = Math.floor((lectureTypes.length - 1) / 10);
        configSessionService.markChanged(session, `Тип лекции "${name}" добавлен.`);
    }

    await updatePanel(client, interaction, session);
}

async function handleStaffAuditIntegerModal(client, interaction, session, parsed) {
    await acknowledgePanelInteraction(interaction);
    const definition = STAFF_AUDIT_SETTING_DEFINITIONS
        .find((entry) => entry.key === parsed.value && entry.valueType === 'integer');
    const value = parsePositiveInteger(interaction.fields.getTextInputValue('value'));

    if (!definition || value === null) {
        configSessionService.setSection(session, 'staffAudit');
        configSessionService.setErrors(session, ['Значение должно быть положительным целым числом.']);
        await updatePanel(client, interaction, session);
        return;
    }

    session.draft.staffAuditSettings[definition.key] = value;
    session.selectedStaffAuditKey = definition.key;
    configSessionService.setSection(session, 'staffAudit');
    configSessionService.markChanged(session, `Настройка "${definition.label}" изменена на ${value}.`);
    await updatePanel(client, interaction, session);
}

async function handleStaffListDateModal(client, interaction, session) {
    await acknowledgePanelInteraction(interaction);
    const value = interaction.fields.getTextInputValue('leaderAppointmentDate').trim();
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    const date = match
        ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
        : null;
    const valid = Boolean(
        match &&
        date.getUTCFullYear() === Number(match[1]) &&
        date.getUTCMonth() === Number(match[2]) - 1 &&
        date.getUTCDate() === Number(match[3])
    );

    configSessionService.setSection(session, 'staffLists');
    session.selectedStaffListKey = 'leaderAppointmentDate';
    if (!valid) {
        configSessionService.setErrors(session, [
            'Дата назначения директора должна быть корректной датой в формате YYYY-MM-DD.',
        ]);
        await updatePanel(client, interaction, session);
        return;
    }

    session.draft.staffListSettings.leaderAppointmentDate = value;
    configSessionService.markChanged(session, `Дата назначения директора изменена на ${value}.`);
    await updatePanel(client, interaction, session);
}

function getPublicationReturnSection(kind) {
    if (kind === 'examination') return 'examinationGeneral';
    if (kind === 'giveRoles') return 'giveRoles';
    if (kind === 'kaInfo') return 'staffAudit';
    if (kind === 'vacation') return 'vacations';
    if (kind === 'discordRules') return 'publications';
    return 'main';
}

async function publishSettingsMessage(client, interaction, session, kind) {
    await acknowledgePanelInteraction(interaction);
    const changes = configSessionService.getChanges(session);
    if (changes.length) {
        configSessionService.setErrors(session, [
            'Перед публикацией необходимо сохранить изменения настроек.',
        ]);
        await updatePanel(client, interaction, session);
        return;
    }

    const config = guildConfigService.getAny(interaction.guildId);
    if (!config) {
        configSessionService.setErrors(session, ['Сохранённая конфигурация сервера не найдена.']);
        await updatePanel(client, interaction, session);
        return;
    }

    try {
        let result;
        if (kind === 'examination') {
            result = await settingsPublicationService.publishExaminationPanel(client, {
                guild: interaction.guild,
                config,
                channelId: session.publicationChannelId,
                mode: session.publicationExaminationMode,
                nonceKey: interaction.id,
                publicationMode: session.publicationMode,
            });
        } else if (kind === 'giveRoles') {
            result = await settingsPublicationService.publishGiveRolesPanel(client, {
                guild: interaction.guild,
                config,
                nonceKey: interaction.id,
                mode: session.publicationMode,
            });
        } else if (kind === 'kaInfo') {
            result = await settingsPublicationService.publishKaInfo(client, {
                guild: interaction.guild,
                config,
                channelId: session.publicationChannelId,
                nonceKey: interaction.id,
                mode: session.publicationMode,
            });
        } else if (kind === 'vacation') {
            result = await settingsPublicationService.publishVacationPanel(client, {
                guild: interaction.guild,
                config,
                channelId: session.publicationChannelId,
                nonceKey: interaction.id,
                mode: session.publicationMode,
            });
        } else if (kind === 'discordRules') {
            result = await settingsPublicationService.publishDiscordRules(client, {
                guild: interaction.guild,
                channelId: session.publicationChannelId,
                nonceKey: interaction.id,
                mode: session.publicationMode,
            });
        } else {
            configSessionService.setErrors(session, ['Неизвестный тип публикуемого сообщения.']);
            await updatePanel(client, interaction, session);
            return;
        }

        const returnSection = getPublicationReturnSection(kind);
        configSessionService.setSection(session, returnSection);
        configSessionService.setStatus(
            session,
            `Сообщение опубликовано: ${result.messageLink}`
        );
        session.publicationKind = null;
        session.publicationChannelId = null;
        session.publicationExaminationMode = 'both';
        session.publicationMode = 'new';
        session.publicationExisting = null;
        await updatePanel(client, interaction, session);
    } catch (error) {
        const message = buildPublicErrorMessage(error, 'Не удалось опубликовать сообщение.');
        logger.warn('Ожидаемая ошибка публикации сообщения через /settings', {
            guildId: interaction.guildId,
            userId: interaction.user.id,
            publicationKind: kind,
            reason: message,
        });
        configSessionService.setErrors(session, String(message).split('\n'));
        await updatePanel(client, interaction, session);
    }
}

module.exports = async (client, interaction) => {
    if (!interaction.isMessageComponent() && !interaction.isModalSubmit()) return;
    if (!String(interaction.customId || '').startsWith('settings:')) return;

    let parsed = parseCustomId(interaction.customId);
    if (!parsed) return;

    const session = configSessionService.getById(parsed.sessionId);
    if (!session) {
        await closeExpiredPanel(client, interaction);
        return;
    }

    if (parsed.action === 'ref') {
        const payload = session.customIdPayloads?.[parsed.value];
        if (!payload?.action) {
            await replyPublic(interaction, 'Этот элемент панели настроек больше не активен.');
            return;
        }
        parsed = {
            ...parsed,
            action: payload.action,
            value: payload.value,
        };
    }

    if (interaction.guildId !== session.guildId) {
        await replyPublic(interaction, 'Эта панель настроек больше не является активной.');
        return;
    }

    if (
        interaction.isMessageComponent() &&
        session.messageId &&
        interaction.message?.id !== session.messageId
    ) {
        await replyPublic(interaction, 'Эта панель настроек больше не является активной.');
        return;
    }

    if (interaction.user.id !== session.userId) {
        await replyPublic(interaction, `Эту панель редактирует <@${session.userId}>.`);
        return;
    }

    try {
        configSessionService.touch(session);
        const requiredSection = getRequiredSettingsSection(parsed);
        if (requiredSection && !configSessionService.canAccessSection(session, requiredSection)) {
            await replyPublic(interaction, 'У вас нет доступа к этому окну настроек.');
            return;
        }

        if (await handleDisciplineSettings(client, interaction, session, parsed)) return;
        if (await handleVacationSettings(client, interaction, session, parsed)) return;

        if (interaction.isModalSubmit()) {
            if (parsed.action === 'department_modal') {
                await handleDepartmentModal(client, interaction, session, parsed);
            } else if (parsed.action === 'rank_modal') {
                await handleRankModal(client, interaction, session, parsed);
            } else if (parsed.action === 'rank_staff_list_limit_modal') {
                await handleRankStaffListLimitModal(client, interaction, session, parsed);

            } else if (parsed.action === 'exam_modal') {
                await handleExamModal(client, interaction, session, parsed);
            } else if (parsed.action === 'exam_scores_modal') {
                await handleExamScoresModal(client, interaction, session, parsed);
            } else if (parsed.action === 'examination_timeout_modal') {
                await acknowledgePanelInteraction(interaction);
                const minutes = Number(interaction.fields.getTextInputValue('minutes'));
                const pendingReminderMinutes = Number(interaction.fields.getTextInputValue('pendingReminderMinutes'));
                configSessionService.setSection(session, 'examinationGeneral');
                const errors = [];
                if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 180) {
                    errors.push('Время ожидания должно быть целым числом от 1 до 180 минут.');
                }
                if (!Number.isSafeInteger(pendingReminderMinutes) || pendingReminderMinutes < 0 || pendingReminderMinutes > 1440) {
                    errors.push('Повторный пинг должен быть целым числом от 0 до 1440 минут.');
                }
                if (errors.length) {
                    configSessionService.setErrors(session, errors);
                } else {
                    session.draft.examinationSettings.voiceJoinTimeoutMinutes = minutes;
                    session.draft.examinationSettings.pendingReminderMinutes = pendingReminderMinutes;
                    configSessionService.markChanged(
                        session,
                        `Сроки экзаменации изменены: voice ${minutes} мин., повторный пинг ${pendingReminderMinutes || 'выключен'}.`
                    );
                }
                await updatePanel(client, interaction, session);
            } else if (parsed.action === 'lecture_type_modal') {
                await handleLectureTypeModal(client, interaction, session, parsed);
            } else if (parsed.action === 'staff_audit_integer_modal') {
                await handleStaffAuditIntegerModal(client, interaction, session, parsed);
            } else if (parsed.action === 'staff_lists_date_modal') {
                await handleStaffListDateModal(client, interaction, session);
            } else if (parsed.action === 'shift_type_modal') {
                await handleShiftTypeModal(client, interaction, session, parsed);
            } else if (parsed.action === 'shift_schedule_modal') {
                await handleShiftScheduleModal(client, interaction, session, parsed);
            } else if (parsed.action === 'shift_access_group_modal') {
                await handleShiftAccessGroupModal(client, interaction, session, parsed);
            }
            return;
        }

        if (parsed.action === 'department_add') {
            await runDiscordRequest(() => interaction.showModal(createDepartmentModal(session)), { attempts: 1 });
            return;
        }

        if (parsed.action === 'department_edit') {
            const department = getDepartment(session);
            if (!department) {
                await acknowledgePanelInteraction(interaction);
                configSessionService.setErrors(session, ['Сначала выбери отдел.']);
                await updatePanel(client, interaction, session);
                return;
            }

            await runDiscordRequest(() => interaction.showModal(createDepartmentModal(session, department)), { attempts: 1 });
            return;
        }

        if (parsed.action === 'rank_add') {
            await runDiscordRequest(() => interaction.showModal(createRankModal(session)), { attempts: 1 });
            return;
        }

        if (parsed.action === 'rank_edit') {
            const rank = getRank(session);
            if (!rank) {
                await acknowledgePanelInteraction(interaction);
                configSessionService.setErrors(session, ['Сначала выбери ранг.']);
                await updatePanel(client, interaction, session);
                return;
            }

            await runDiscordRequest(() => interaction.showModal(createRankModal(session, rank)), { attempts: 1 });
            return;
        }


        if (parsed.action === 'rank_staff_list_limit_edit') {
            const rank = getRank(session);
            if (!rank) {
                await acknowledgePanelInteraction(interaction);
                configSessionService.setErrors(session, ['Сначала выбери ранг.']);
                await updatePanel(client, interaction, session);
                return;
            }
            await runDiscordRequest(
                () => interaction.showModal(createRankStaffListLimitModal(session, rank)),
                { attempts: 1 }
            );
            return;
        }

        if (parsed.action === 'staff_audit_integer_edit') {
            const modal = createStaffAuditIntegerModal(session, parsed.value);
            if (!modal) {
                await acknowledgePanelInteraction(interaction);
                configSessionService.setErrors(session, ['Неизвестная числовая настройка кадрового аудита.']);
                await updatePanel(client, interaction, session);
                return;
            }
            await runDiscordRequest(() => interaction.showModal(modal), { attempts: 1 });
            return;
        }

        if (parsed.action === 'exam_add') {
            await runDiscordRequest(() => interaction.showModal(createExamModal(session)), { attempts: 1 });
            return;
        }

        if (parsed.action === 'exam_edit') {
            const exam = getExam(session);
            if (!exam) {
                await acknowledgePanelInteraction(interaction);
                configSessionService.setErrors(session, ['Сначала выбери экзамен.']);
                await updatePanel(client, interaction, session);
                return;
            }

            await runDiscordRequest(() => interaction.showModal(createExamModal(session, exam)), { attempts: 1 });
            return;
        }

        if (parsed.action === 'exam_scores_edit') {
            const exam = getExam(session);
            if (!exam) {
                await acknowledgePanelInteraction(interaction);
                configSessionService.setErrors(session, ['Сначала выбери экзамен.']);
                await updatePanel(client, interaction, session);
                return;
            }

            await runDiscordRequest(() => interaction.showModal(createExamScoresModal(session, exam)), { attempts: 1 });
            return;
        }

        if (parsed.action === 'examination_timeout_edit') {
            await runDiscordRequest(
                () => interaction.showModal(createExaminationTimeoutModal(session)),
                { attempts: 1 }
            );
            return;
        }

        if (parsed.action === 'lecture_type_add') {
            await runDiscordRequest(
                () => interaction.showModal(createLectureTypeModal(session)),
                { attempts: 1 }
            );
            return;
        }

        if (parsed.action === 'lecture_type_edit') {
            const lectureType = (session.draft.examinationSettings?.lectureTypes || [])
                .find((entry) => entry.id === session.selectedLectureTypeId);
            if (!lectureType) {
                await acknowledgePanelInteraction(interaction);
                configSessionService.setErrors(session, ['Сначала выбери тип лекции.']);
                await updatePanel(client, interaction, session);
                return;
            }
            await runDiscordRequest(
                () => interaction.showModal(createLectureTypeModal(session, lectureType)),
                { attempts: 1 }
            );
            return;
        }

        if (parsed.action === 'shift_type_add') {
            await runDiscordRequest(() => interaction.showModal(createShiftTypeModal(session)), { attempts: 1 });
            return;
        }

        if (parsed.action === 'shift_type_edit') {
            const shiftType = getShiftType(session);
            if (!shiftType) {
                await acknowledgePanelInteraction(interaction);
                configSessionService.setErrors(session, ['Сначала выбери расписание смен.']);
                await updatePanel(client, interaction, session);
                return;
            }
            await runDiscordRequest(
                () => interaction.showModal(createShiftTypeModal(session, shiftType)),
                { attempts: 1 }
            );
            return;
        }

        if (parsed.action === 'shift_schedule_edit') {
            const shiftType = getShiftType(session, parsed.value);
            if (!shiftType) {
                await acknowledgePanelInteraction(interaction);
                configSessionService.setErrors(session, ['Сначала выбери расписание смен.']);
                await updatePanel(client, interaction, session);
                return;
            }
            await runDiscordRequest(
                () => interaction.showModal(createShiftScheduleModal(session, shiftType)),
                { attempts: 1 }
            );
            return;
        }

        if (parsed.action === 'shift_access_group_add') {
            const shiftType = getShiftType(session, parsed.value);
            if (!shiftType) {
                await acknowledgePanelInteraction(interaction);
                configSessionService.setErrors(session, ['Сначала выбери расписание смен.']);
                await updatePanel(client, interaction, session);
                return;
            }
            await runDiscordRequest(
                () => interaction.showModal(createShiftAccessGroupModal(session, shiftType)),
                { attempts: 1 }
            );
            return;
        }

        if (parsed.action === 'shift_access_group_edit') {
            const shiftType = getShiftType(session);
            const group = getShiftAccessGroup(session);
            if (!shiftType || !group) {
                await acknowledgePanelInteraction(interaction);
                configSessionService.setErrors(session, ['Сначала выбери группу доступа.']);
                await updatePanel(client, interaction, session);
                return;
            }
            await runDiscordRequest(
                () => interaction.showModal(createShiftAccessGroupModal(session, shiftType, group)),
                { attempts: 1 }
            );
            return;
        }

        if (parsed.action === 'staff_lists_date_edit') {
            await runDiscordRequest(
                () => interaction.showModal(createStaffListDateModal(session)),
                { attempts: 1 }
            );
            return;
        }

        await acknowledgePanelInteraction(interaction);

        if (parsed.action === 'nav') {
            if (VALID_SECTIONS.has(parsed.value)) {
                const changed = configSessionService.setSection(session, parsed.value);
                if (!changed) {
                    configSessionService.setErrors(session, ['У вас нет доступа к этому окну настроек.']);
                }
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'shift_type_page') {
            const count = session.draft.shiftTypes?.length || 0;
            const maxPage = Math.max(Math.ceil(count / SHIFT_TYPE_PAGE_SIZE) - 1, 0);
            session.shiftTypePage = Math.min(Math.max(Number(parsed.value) || 0, 0), maxPage);
            configSessionService.setStatus(session, null);
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'shift_access_group_page') {
            const shiftType = getShiftType(session);
            const count = shiftType?.accessGroups?.length || 0;
            const maxPage = Math.max(Math.ceil(count / SHIFT_ACCESS_GROUP_PAGE_SIZE) - 1, 0);
            session.shiftAccessGroupPage = Math.min(Math.max(Number(parsed.value) || 0, 0), maxPage);
            configSessionService.setStatus(session, null);
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'shift_type_select' && interaction.isStringSelectMenu()) {
            const shiftType = getShiftType(session, interaction.values[0]);
            if (shiftType) {
                session.selectedShiftTypeId = shiftType.id;
                session.selectedShiftAccessGroupId = null;
                session.shiftAccessGroupPage = 0;
                configSessionService.setStatus(session, null);
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'shift_type_toggle') {
            const shiftType = getShiftType(session, parsed.value);
            if (shiftType) {
                shiftType.enabled = !shiftType.enabled;
                session.selectedShiftTypeId = shiftType.id;
                configSessionService.markChanged(
                    session,
                    `Смены "${shiftType.name}" ${shiftType.enabled ? 'включены' : 'выключены'}.`
                );
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'shift_publication_mode_toggle') {
            const shiftType = getShiftType(session, parsed.value);
            if (shiftType) {
                if (shiftType.publication?.mode === PUBLICATION_MODES.RANDOM) {
                    shiftType.publication = {
                        mode: PUBLICATION_MODES.FIXED,
                        time: shiftType.publication.fromTime || '21:00',
                    };
                } else {
                    const fromTime = shiftType.publication?.time || '21:00';
                    shiftType.publication = {
                        mode: PUBLICATION_MODES.RANDOM,
                        fromTime,
                        toTime: addMinutesToTime(fromTime, 60) || '22:00',
                    };
                }
                session.selectedShiftTypeId = shiftType.id;
                configSessionService.markChanged(
                    session,
                    `Режим публикации смен "${shiftType.name}" изменён на ${shiftType.publication.mode === PUBLICATION_MODES.RANDOM ? 'случайный' : 'фиксированный'}.`
                );
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'shift_type_channel_set' && interaction.isChannelSelectMenu()) {
            const shiftType = getShiftType(session, parsed.value);
            if (shiftType) {
                shiftType.channelId = interaction.values[0] || null;
                session.selectedShiftTypeId = shiftType.id;
                configSessionService.markChanged(session, `Канал смен "${shiftType.name}" изменён.`);
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'shift_type_channel_clear') {
            const shiftType = getShiftType(session, parsed.value);
            if (shiftType) {
                shiftType.channelId = null;
                session.selectedShiftTypeId = shiftType.id;
                configSessionService.markChanged(session, `Канал смен "${shiftType.name}" очищен.`);
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'shift_access_group_select' && interaction.isStringSelectMenu()) {
            const group = getShiftAccessGroup(session, interaction.values[0]);
            if (group) {
                session.selectedShiftAccessGroupId = group.id;
                configSessionService.setStatus(session, null);
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'shift_access_group_roles_set' && interaction.isRoleSelectMenu()) {
            const { shiftTypeId, groupId } = parseShiftAccessReference(parsed.value);
            const shiftType = getShiftType(session, shiftTypeId);
            const group = (shiftType?.accessGroups || []).find((entry) => entry.id === groupId);
            if (shiftType && group) {
                group.roleIds = Array.from(new Set(interaction.values));
                session.selectedShiftTypeId = shiftType.id;
                session.selectedShiftAccessGroupId = group.id;
                configSessionService.markChanged(session, `Роли группы доступа "${group.name}" изменены.`);
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'shift_access_rotation_toggle') {
            const shiftType = getShiftType(session, parsed.value);
            if (shiftType) {
                shiftType.rotateAccessDaily = !shiftType.rotateAccessDaily;
                session.selectedShiftTypeId = shiftType.id;
                configSessionService.markChanged(
                    session,
                    `Ежедневная ротация смен "${shiftType.name}" ${shiftType.rotateAccessDaily ? 'включена' : 'выключена'}.`
                );
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'shift_access_group_delete') {
            const shiftType = getShiftType(session);
            const group = getShiftAccessGroup(session);
            if (shiftType && group) {
                shiftType.accessGroups = shiftType.accessGroups.filter((entry) => entry.id !== group.id);
                session.selectedShiftAccessGroupId = null;
                const maxPage = Math.max(
                    Math.ceil(shiftType.accessGroups.length / SHIFT_ACCESS_GROUP_PAGE_SIZE) - 1,
                    0
                );
                session.shiftAccessGroupPage = Math.min(session.shiftAccessGroupPage || 0, maxPage);
                configSessionService.markChanged(session, `Группа доступа "${group.name}" удалена.`);
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'shift_manager_roles_set' && interaction.isRoleSelectMenu()) {
            const shiftType = getShiftType(session, parsed.value);
            if (shiftType) {
                shiftType.managerRoleIds = Array.from(new Set(interaction.values));
                session.selectedShiftTypeId = shiftType.id;
                configSessionService.markChanged(session, `Роли управления смен "${shiftType.name}" изменены.`);
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'shift_manager_roles_clear') {
            const shiftType = getShiftType(session, parsed.value);
            if (shiftType) {
                shiftType.managerRoleIds = [];
                session.selectedShiftTypeId = shiftType.id;
                configSessionService.markChanged(session, `Роли управления смен "${shiftType.name}" очищены.`);
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'shift_type_delete_confirm') {
            const shiftType = getShiftType(session, parsed.value);
            if (shiftType) {
                session.draft.shiftTypes = session.draft.shiftTypes.filter((entry) => entry.id !== shiftType.id);
                session.selectedShiftTypeId = null;
                session.selectedShiftAccessGroupId = null;
                const maxPage = Math.max(
                    Math.ceil(session.draft.shiftTypes.length / SHIFT_TYPE_PAGE_SIZE) - 1,
                    0
                );
                session.shiftTypePage = Math.min(session.shiftTypePage || 0, maxPage);
                configSessionService.setSection(session, 'shiftTypes');
                configSessionService.markChanged(session, `Смены "${shiftType.name}" удалены.`);
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'changes_page') {
            configSessionService.setChangePage(session, parsed.value);
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'department_page') {
            const departmentCount = session.draft.departments?.length || 0;
            const maxPage = Math.max(Math.ceil(departmentCount / 25) - 1, 0);
            session.departmentPage = Math.min(Math.max(Number(parsed.value) || 0, 0), maxPage);
            configSessionService.setStatus(session, null);
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'rank_page') {
            const rankCount = session.draft.ranks?.length || 0;
            const maxPage = Math.max(Math.ceil(rankCount / RANK_PAGE_SIZE) - 1, 0);
            session.rankPage = Math.min(Math.max(Number(parsed.value) || 0, 0), maxPage);
            configSessionService.setStatus(session, null);
            await updatePanel(client, interaction, session);
            return;
        }


        if (parsed.action === 'exam_page') {
            const examCount = session.draft.exams?.length || 0;
            const maxPage = Math.max(Math.ceil(examCount / EXAM_PAGE_SIZE) - 1, 0);
            session.examPage = Math.min(Math.max(Number(parsed.value) || 0, 0), maxPage);
            configSessionService.setStatus(session, null);
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'lecture_type_page') {
            const count = session.draft.examinationSettings?.lectureTypes?.length || 0;
            const maxPage = Math.max(Math.ceil(count / LECTURE_TYPE_PAGE_SIZE) - 1, 0);
            session.lectureTypePage = Math.min(Math.max(Number(parsed.value) || 0, 0), maxPage);
            configSessionService.setStatus(session, null);
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'diagnostics_export_config') {
            const savedConfig = guildConfigService.getAny(interaction.guildId);
            if (!savedConfig) {
                await followUpWithRetry(interaction, {
                    content: 'Сохранённая конфигурация сервера не найдена.',
                    flags: MessageFlags.Ephemeral,
                    allowedMentions: { parse: [] },
                });
                return;
            }
            const attachment = buildConfigExport(savedConfig, {
                guildId: interaction.guildId,
                guildName: interaction.guild?.name,
            });
            await followUpWithRetry(interaction, {
                content: 'Экспорт сохранённой конфигурации:',
                files: [attachment],
                flags: MessageFlags.Ephemeral,
                allowedMentions: { parse: [] },
            });
            logger.info('Конфигурация сервера экспортирована через настройки', {
                guildId: interaction.guildId,
                userId: interaction.user.id,
            });
            return;
        }

        if (parsed.action === 'publication_start') {
            if (!['examination', 'giveRoles', 'kaInfo', 'vacation', 'discordRules'].includes(parsed.value)) {
                configSessionService.setErrors(session, ['Неизвестный тип публикуемого сообщения.']);
                await updatePanel(client, interaction, session);
                return;
            }
            if (parsed.value === 'discordRules' && !settingsPublicationService.canPublishDiscordRules(interaction.guildId)) {
                configSessionService.setErrors(session, ['Публикация правил недоступна на этом сервере.']);
                await updatePanel(client, interaction, session);
                return;
            }
            session.publicationKind = parsed.value;
            session.publicationChannelId = null;
            session.publicationMode = 'new';
            session.publicationExisting = settingsPublicationService.getPublicationRecord(
                interaction.guildId,
                parsed.value
            );
            session.publicationExaminationMode = parsed.value === 'examination'
                && ['lecture', 'retest', 'both'].includes(session.publicationExisting?.metadata?.mode)
                ? session.publicationExisting.metadata.mode
                : 'both';
            session.section = 'publicationPreview';
            configSessionService.setStatus(session, null);
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'publication_mode') {
            const mode = parsed.value === 'update' ? 'update' : 'new';
            if (mode === 'update' && !session.publicationExisting) {
                configSessionService.setErrors(session, ['Ранее опубликованное сообщение не зарегистрировано.']);
                await updatePanel(client, interaction, session);
                return;
            }
            session.publicationMode = mode;
            configSessionService.setStatus(session, null);
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'publication_channel_set' && interaction.isChannelSelectMenu()) {
            if (session.publicationKind === parsed.value) {
                session.publicationChannelId = interaction.values[0] || null;
                configSessionService.setStatus(session, null);
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'publication_examination_mode' && interaction.isStringSelectMenu()) {
            if (session.publicationKind !== 'examination') {
                configSessionService.setErrors(session, ['Параметры публикации устарели. Откройте окно публикации заново.']);
                await updatePanel(client, interaction, session);
                return;
            }

            const mode = interaction.values[0];
            if (!['lecture', 'retest', 'both'].includes(mode)) {
                configSessionService.setErrors(session, ['Выбран неизвестный состав панели экзаменации.']);
                await updatePanel(client, interaction, session);
                return;
            }

            session.publicationExaminationMode = mode;
            configSessionService.setStatus(session, null);
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'publication_back') {
            const returnSection = getPublicationReturnSection(session.publicationKind);
            session.publicationKind = null;
            session.publicationChannelId = null;
            session.publicationExaminationMode = 'both';
            session.publicationMode = 'new';
            session.publicationExisting = null;
            configSessionService.setSection(
                session,
                VALID_SECTIONS.has(parsed.value) ? parsed.value : returnSection
            );
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'publication_confirm') {
            if (session.publicationKind !== parsed.value) {
                configSessionService.setErrors(session, ['Параметры публикации устарели. Откройте окно публикации заново.']);
                await updatePanel(client, interaction, session);
                return;
            }
            await publishSettingsMessage(client, interaction, session, parsed.value);
            return;
        }

        if (parsed.action === 'examination_channel_set' && interaction.isChannelSelectMenu()) {
            const labels = {
                lectureRequestChannelId: 'Канал заявок на лекции',
                retestRequestChannelId: 'Канал заявок на пересдачи',
                lectureResultChannelId: 'Канал итогов лекций',
                retestResultChannelId: 'Отдельный канал итогов пересдач',
                lectureVoiceChannelId: 'Голосовой канал лекций',
                retestVoiceChannelId: 'Голосовой канал пересдач',
            };
            if (labels[parsed.value]) {
                session.draft.examinationSettings[parsed.value] = interaction.values[0] || null;
                configSessionService.markChanged(
                    session,
                    `${labels[parsed.value]} ${interaction.values[0] ? 'изменён' : 'очищен'}.`
                );
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'shift_publish_confirm') {
            await acknowledgePanelInteraction(interaction);
            const changes = configSessionService.getChanges(session);
            if (changes.length) {
                configSessionService.setErrors(session, ['Сначала сохраните изменения настроек.']);
                await updatePanel(client, interaction, session);
                return;
            }
            const config = guildConfigService.get(interaction.guildId);
            const selected = config?.shiftTypes?.find((entry) => entry.id === parsed.value);
            if (!selected || !selected.enabled || !selected.channelId) {
                configSessionService.setErrors(session, ['Расписание недоступно, выключено или не имеет канала.']);
                configSessionService.setSection(session, 'shiftTypes');
                await updatePanel(client, interaction, session);
                return;
            }
            try {
                const result = await publishNextShiftScheduleNow({
                    client,
                    guildId: interaction.guildId,
                    shiftTypeId: selected.id,
                    reason: `settings:${interaction.user.id}`,
                });
                configSessionService.setSection(session, 'shiftPublish');
                configSessionService.setStatus(
                    session,
                    result.recovered
                        ? `Сообщение расписания восстановлено: ${result.messageLink}`
                        : `Следующее расписание опубликовано: ${result.messageLink}`
                );
                logger.info('Расписание смен опубликовано вручную через настройки', {
                    guildId: interaction.guildId,
                    userId: interaction.user.id,
                    shiftTypeId: selected.id,
                    dateKey: result.dateKey || null,
                    recovered: Boolean(result.recovered),
                });
            } catch (error) {
                configSessionService.setErrors(session, [buildPublicErrorMessage(error, 'Не удалось опубликовать расписание.')]);
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'feature') {
            if (FEATURE_KEYS.has(parsed.value)) {
                session.draft.features[parsed.value] = !session.draft.features[parsed.value];
                configSessionService.markChanged(session);
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'channel_select' && interaction.isStringSelectMenu()) {
            const key = interaction.values[0];
            if (CHANNEL_KEYS.has(key)) {
                session.selectedChannelKey = key;
                configSessionService.setStatus(session, null);
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'channel_set' && interaction.isChannelSelectMenu()) {
            if (CHANNEL_KEYS.has(parsed.value)) {
                session.draft.channels[parsed.value] = interaction.values[0] || null;
                session.selectedChannelKey = parsed.value;
                configSessionService.markChanged(session, 'Канал изменён.');
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'channel_clear') {
            if (CHANNEL_KEYS.has(parsed.value)) {
                session.draft.channels[parsed.value] = null;
                session.selectedChannelKey = parsed.value;
                configSessionService.markChanged(session, 'Канал очищен.');
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'role_select' && interaction.isStringSelectMenu()) {
            const key = interaction.values[0];
            if (ROLE_KEYS.has(key)) {
                session.selectedRoleKey = key;
                configSessionService.setStatus(session, null);
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'role_set' && interaction.isRoleSelectMenu()) {
            if (ROLE_KEYS.has(parsed.value)) {
                session.draft.commonRoles[parsed.value] = interaction.values[0] || null;
                session.selectedRoleKey = parsed.value;
                configSessionService.markChanged(session, 'Роль изменена.');
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'role_clear') {
            if (ROLE_KEYS.has(parsed.value)) {
                session.draft.commonRoles[parsed.value] = null;
                session.selectedRoleKey = parsed.value;
                configSessionService.markChanged(session, 'Роль очищена.');
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'give_roles_field_select' && interaction.isStringSelectMenu()) {
            const key = interaction.values[0];
            if (GIVE_ROLES_KEYS.has(key)) {
                session.selectedGiveRolesKey = key;

                if (key === 'inviteDepartmentId') {
                    const index = (session.draft.departments || [])
                        .findIndex((department) => department.id === session.draft.giveRolesSettings?.inviteDepartmentId);
                    session.giveRolesDepartmentPage = index >= 0
                        ? Math.floor(index / GIVE_ROLES_SELECT_PAGE_SIZE)
                        : 0;
                }

                if (key === 'dbRankNumber') {
                    const index = (session.draft.ranks || [])
                        .findIndex((rank) => rank.number === session.draft.giveRolesSettings?.dbRankNumber);
                    session.giveRolesRankPage = index >= 0
                        ? Math.floor(index / GIVE_ROLES_SELECT_PAGE_SIZE)
                        : 0;
                }

                configSessionService.setStatus(session, null);
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'give_roles_page') {
            const [type, rawPage] = String(parsed.value || '').split(':');
            const page = Math.max(Number(rawPage) || 0, 0);
            if (type === 'department') session.giveRolesDepartmentPage = page;
            if (type === 'rank') session.giveRolesRankPage = page;
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'give_roles_department_set' && interaction.isStringSelectMenu()) {
            const department = getDepartment(session, interaction.values[0]);
            if (department) {
                session.draft.giveRolesSettings.inviteDepartmentId = department.id;
                session.selectedGiveRolesKey = 'inviteDepartmentId';
                configSessionService.markChanged(session, `Для принятия выбран отдел "${department.shortName}".`);
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'give_roles_rank_set' && interaction.isStringSelectMenu()) {
            const rank = getRank(session, interaction.values[0]);
            if (rank) {
                session.draft.giveRolesSettings.dbRankNumber = rank.number;
                session.selectedGiveRolesKey = 'dbRankNumber';
                configSessionService.markChanged(session, `Для ДБ выбран ранг ${rank.number} "${rank.name}".`);
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'give_roles_roles_set' && interaction.isRoleSelectMenu()) {
            if (GIVE_ROLES_ROLE_KEYS.has(parsed.value)) {
                session.draft.giveRolesSettings[parsed.value] = Array.from(new Set(interaction.values)).sort();
                session.selectedGiveRolesKey = parsed.value;
                configSessionService.markChanged(session, 'Список ролей выдачи ролей заменён.');
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'give_roles_clear') {
            if (GIVE_ROLES_KEYS.has(parsed.value)) {
                session.draft.giveRolesSettings[parsed.value] = GIVE_ROLES_ROLE_KEYS.has(parsed.value) ? [] : null;
                session.selectedGiveRolesKey = parsed.value;
                configSessionService.markChanged(session, 'Настройка выдачи ролей очищена.');
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'staff_audit_field_select' && interaction.isStringSelectMenu()) {
            const key = interaction.values[0];
            if (STAFF_AUDIT_KEYS.has(key)) {
                session.selectedStaffAuditKey = key;
                if (key === 'departmentTransitionRankNumber') {
                    const index = (session.draft.ranks || [])
                        .findIndex((rank) => rank.number === session.draft.staffAuditSettings?.departmentTransitionRankNumber);
                    session.staffAuditRankPage = index >= 0
                        ? Math.floor(index / 25)
                        : 0;
                }
                configSessionService.setStatus(session, null);
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'staff_audit_channel_set' && interaction.isChannelSelectMenu()) {
            if (STAFF_AUDIT_CHANNEL_KEYS.has(parsed.value)) {
                session.draft.staffAuditSettings[parsed.value] = interaction.values[0] || null;
                session.selectedStaffAuditKey = parsed.value;
                configSessionService.markChanged(session, 'Канал кадрового аудита изменён.');
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'staff_audit_roles_set' && interaction.isRoleSelectMenu()) {
            if (STAFF_AUDIT_ROLE_KEYS.has(parsed.value)) {
                session.draft.staffAuditSettings[parsed.value] = Array.from(new Set(interaction.values)).sort();
                session.selectedStaffAuditKey = parsed.value;
                configSessionService.markChanged(session, 'Список ролей кадрового аудита заменён.');
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'staff_audit_rank_set' && interaction.isStringSelectMenu()) {
            const rank = getRank(session, interaction.values[0]);
            if (rank) {
                session.draft.staffAuditSettings.departmentTransitionRankNumber = rank.number;
                session.selectedStaffAuditKey = 'departmentTransitionRankNumber';
                configSessionService.markChanged(
                    session,
                    `Ранг выхода из стажировочного отдела: ${rank.number} "${rank.name}".`
                );
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'staff_audit_rank_page') {
            session.staffAuditRankPage = Math.max(Number(parsed.value) || 0, 0);
            configSessionService.setStatus(session, null);
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'staff_audit_clear') {
            if (STAFF_AUDIT_KEYS.has(parsed.value)) {
                session.draft.staffAuditSettings[parsed.value] = STAFF_AUDIT_ROLE_KEYS.has(parsed.value)
                    ? []
                    : null;
                session.selectedStaffAuditKey = parsed.value;
                configSessionService.markChanged(session, 'Настройка кадрового аудита очищена.');
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'staff_lists_field_select' && interaction.isStringSelectMenu()) {
            const key = interaction.values[0];
            if (STAFF_LIST_KEYS.has(key)) {
                session.selectedStaffListKey = key;
                configSessionService.setStatus(session, null);
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'staff_lists_channel_set' && interaction.isChannelSelectMenu()) {
            if (STAFF_LIST_CHANNEL_KEYS.has(parsed.value)) {
                session.draft.staffListSettings[parsed.value] = interaction.values[0] || null;
                session.selectedStaffListKey = parsed.value;
                configSessionService.markChanged(session, 'Канал руководящего состава изменён.');
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'staff_lists_term_toggle') {
            session.draft.staffListSettings.leaderTermDays = session.draft.staffListSettings.leaderTermDays === 31 ? 30 : 31;
            session.selectedStaffListKey = 'leaderTermDays';
            configSessionService.markChanged(
                session,
                `Продолжительность срока директора: ${session.draft.staffListSettings.leaderTermDays} дн.`
            );
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'staff_lists_ranks_set' && interaction.isStringSelectMenu()) {
            if (parsed.value === 'curatorManagementRankNumbers') {
                session.draft.staffListSettings.curatorManagementRankNumbers = Array.from(new Set(
                    interaction.values.map((value) => Number(value))
                        .filter((value) => Number.isSafeInteger(value) && value > 0)
                )).sort((left, right) => left - right);
                session.selectedStaffListKey = parsed.value;
                configSessionService.markChanged(session, 'Ранги руководства для определения кураторов изменены.');
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'staff_lists_clear') {
            if (STAFF_LIST_KEYS.has(parsed.value)) {
                session.draft.staffListSettings[parsed.value] = parsed.value === 'curatorManagementRankNumbers' ? [] : null;
                session.selectedStaffListKey = parsed.value;
                configSessionService.markChanged(session, 'Настройка составов очищена.');
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'channel_counters_field_select' && interaction.isStringSelectMenu()) {
            const key = interaction.values[0];
            if (CHANNEL_COUNTER_KEYS.has(key)) {
                session.selectedChannelCounterKey = key;
                configSessionService.setStatus(session, null);
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'channel_counters_channel_set' && interaction.isChannelSelectMenu()) {
            if (CHANNEL_COUNTER_KEYS.has(parsed.value)) {
                session.draft.channelCounterSettings[parsed.value] = interaction.values[0] || null;
                session.selectedChannelCounterKey = parsed.value;
                configSessionService.markChanged(session, 'Канал-счётчик изменён.');
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'channel_counters_clear') {
            if (CHANNEL_COUNTER_KEYS.has(parsed.value)) {
                session.draft.channelCounterSettings[parsed.value] = null;
                session.selectedChannelCounterKey = parsed.value;
                configSessionService.markChanged(session, 'Настройка счётчика очищена.');
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'settings_access_set' && interaction.isRoleSelectMenu()) {
            session.draft.settingsManagerRoleIds = Array.from(new Set(interaction.values));
            configSessionService.markChanged(session, 'Список ролей с доступом заменён.');
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'settings_access_clear') {
            session.draft.settingsManagerRoleIds = [];
            configSessionService.markChanged(session, 'Список ролей с доступом очищен.');
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'settings_access_limited_role' && interaction.isRoleSelectMenu()) {
            session.selectedSettingsAccessRoleId = interaction.values[0] || null;
            configSessionService.setStatus(session, null);
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'settings_access_limited_sections' && interaction.isStringSelectMenu()) {
            const roleId = parsed.value;
            const sectionKeys = Array.from(new Set(interaction.values.filter((key) => SETTINGS_SECTION_KEYS.has(key)))).sort();
            session.draft.settingsSectionAccess ||= [];
            const existing = session.draft.settingsSectionAccess.find((entry) => entry.roleId === roleId);
            if (existing) existing.sectionKeys = sectionKeys;
            else session.draft.settingsSectionAccess.push({ roleId, sectionKeys });
            session.draft.settingsSectionAccess.sort((left, right) => left.roleId.localeCompare(right.roleId));
            session.selectedSettingsAccessRoleId = roleId;
            configSessionService.markChanged(session, 'Ограниченный доступ роли изменён.');
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'settings_access_limited_remove') {
            const roleId = parsed.value;
            session.draft.settingsSectionAccess = (session.draft.settingsSectionAccess || [])
                .filter((entry) => entry.roleId !== roleId);
            if (session.selectedSettingsAccessRoleId === roleId) session.selectedSettingsAccessRoleId = null;
            configSessionService.markChanged(session, 'Правило ограниченного доступа удалено.');
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'manual_tools_access_role' && interaction.isRoleSelectMenu()) {
            session.selectedManualToolsAccessRoleId = interaction.values[0] || null;
            configSessionService.setStatus(session, null);
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'manual_tools_access_subcommands' && interaction.isStringSelectMenu()) {
            const roleId = parsed.value;
            const subcommandKeys = Array.from(new Set(
                interaction.values.filter((key) => MANUAL_TOOLS_SUBCOMMAND_KEYS.has(key))
            )).sort();
            session.draft.manualToolsAccess ||= [];
            const existing = session.draft.manualToolsAccess.find((entry) => entry.roleId === roleId);
            if (existing) existing.subcommandKeys = subcommandKeys;
            else session.draft.manualToolsAccess.push({ roleId, subcommandKeys });
            session.draft.manualToolsAccess = session.draft.manualToolsAccess
                .filter((entry) => entry.subcommandKeys.length > 0)
                .sort((left, right) => left.roleId.localeCompare(right.roleId));
            session.selectedManualToolsAccessRoleId = roleId;
            configSessionService.markChanged(session, 'Доступ роли к /manualtools изменён.');
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'manual_tools_access_remove') {
            const roleId = parsed.value;
            session.draft.manualToolsAccess = (session.draft.manualToolsAccess || [])
                .filter((entry) => entry.roleId !== roleId);
            if (session.selectedManualToolsAccessRoleId === roleId) {
                session.selectedManualToolsAccessRoleId = null;
            }
            configSessionService.markChanged(session, 'Правило доступа к /manualtools удалено.');
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'rank_select' && interaction.isStringSelectMenu()) {
            const rank = getRank(session, interaction.values[0]);
            if (rank) {
                session.selectedRankNumber = rank.number;
                configSessionService.setStatus(session, null);
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'rank_role_set' && interaction.isRoleSelectMenu()) {
            const rank = getRank(session, parsed.value);
            if (rank) {
                rank.roleId = interaction.values[0] || null;
                session.selectedRankNumber = rank.number;
                configSessionService.markChanged(session, 'Discord-роль ранга изменена.');
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'rank_role_clear') {
            const rank = getRank(session, parsed.value);
            if (rank) {
                rank.roleId = null;
                session.selectedRankNumber = rank.number;
                configSessionService.markChanged(session, 'Discord-роль ранга очищена.');
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'rank_policy_mode') {
            const rank = getRank(session);
            if (rank && RANK_POLICY_MODES.has(parsed.value)) {
                rank.grantPolicy = {
                    mode: parsed.value,
                    roleIds: [],
                };
                configSessionService.markChanged(session, 'Правило выдачи ранга изменено.');
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'rank_policy_roles_set' && interaction.isRoleSelectMenu()) {
            const rank = getRank(session, parsed.value);
            if (rank && rank.grantPolicy?.mode === 'roles') {
                rank.grantPolicy.roleIds = Array.from(new Set(interaction.values)).sort();
                session.selectedRankNumber = rank.number;
                configSessionService.markChanged(session, 'Список ролей персонального правила заменён.');
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'rank_policy_roles_clear') {
            const rank = getRank(session, parsed.value);
            if (rank && rank.grantPolicy?.mode === 'roles') {
                rank.grantPolicy.roleIds = [];
                session.selectedRankNumber = rank.number;
                configSessionService.markChanged(session, 'Список ролей персонального правила очищен.');
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'rank_staff_list_toggle') {
            const rank = getRank(session);
            if (rank) {
                rank.staffList ||= {
                    showInLeadership: false,
                    maxMembers: null,
                    showAppointmentTerm: false,
                };
                if (parsed.value === 'show') {
                    rank.staffList.showInLeadership = !rank.staffList.showInLeadership;
                    if (!rank.staffList.showInLeadership) {
                        rank.staffList.showAppointmentTerm = false;
                    }
                } else if (parsed.value === 'term' && rank.staffList.showInLeadership) {
                    rank.staffList.showAppointmentTerm = !rank.staffList.showAppointmentTerm;
                }
                configSessionService.markChanged(session, `Отображение ранга ${rank.number} в составе изменено.`);
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'rank_staff_list_limit_clear') {
            const rank = getRank(session);
            if (rank) {
                rank.staffList ||= {
                    showInLeadership: false,
                    maxMembers: null,
                    showAppointmentTerm: false,
                };
                rank.staffList.maxMembers = null;
                configSessionService.markChanged(session, `Лимит руководящего состава для ранга ${rank.number} очищен.`);
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'rank_delete_confirm') {
            const rank = getRank(session, parsed.value);
            if (rank) {
                const linkedToGiveRoles = session.draft.giveRolesSettings?.dbRankNumber === rank.number;
                const linkedToStaffAudit = session.draft.staffAuditSettings?.departmentTransitionRankNumber === rank.number;
                const linkedToCurators = session.draft.staffListSettings?.curatorManagementRankNumbers
                    ?.includes(rank.number) === true;
                if (linkedToGiveRoles || linkedToStaffAudit || linkedToCurators) {
                    const errors = [];
                    if (linkedToGiveRoles) {
                        errors.push('Ранг выбран для принятия по ДБ. Сначала очисти его в разделе "Выдача ролей".');
                    }
                    if (linkedToStaffAudit) {
                        errors.push('Ранг выбран как граница выхода из стажировочного отдела. Сначала очисти его в разделе "Кадровый аудит".');
                    }
                    if (linkedToCurators) {
                        errors.push('Ранг используется для определения кураторов. Сначала убери его в разделе "Составы".');
                    }
                    configSessionService.setSection(session, 'ranks');
                    configSessionService.setErrors(session, errors);
                    await updatePanel(client, interaction, session);
                    return;
                }

                session.draft.ranks = session.draft.ranks.filter((entry) => entry.number !== rank.number);
                session.selectedRankNumber = null;
                const maxPage = Math.max(Math.ceil(session.draft.ranks.length / RANK_PAGE_SIZE) - 1, 0);
                session.rankPage = Math.min(session.rankPage || 0, maxPage);
                configSessionService.setSection(session, 'ranks');
                configSessionService.markChanged(session, `Ранг ${rank.number} "${rank.name}" удалён.`);
            }
            await updatePanel(client, interaction, session);
            return;
        }


        if (parsed.action === 'exam_select' && interaction.isStringSelectMenu()) {
            const exam = getExam(session, interaction.values[0]);
            if (exam) {
                session.selectedExamId = exam.id;
                configSessionService.setStatus(session, null);
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'exam_mode_set') {
            const exam = getExam(session);
            if (exam && EXAM_CHECK_MODES.has(parsed.value)) {
                exam.checkMode = parsed.value;
                configSessionService.markChanged(
                    session,
                    `Для экзамена "${exam.name}" выбран режим: ${parsed.value === 'manualScore' ? 'ручной ввод балла' : 'автоматический результат'}.`
                );
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'exam_retest_toggle') {
            const exam = getExam(session, parsed.value || session.selectedExamId);
            if (exam) {
                if (exam.maxAttempts === 0) {
                    exam.retestEnabled = false;
                    configSessionService.setErrors(session, [
                        'Для экзамена с неограниченными попытками пересдача не требуется.',
                    ]);
                } else {
                    exam.retestEnabled = exam.retestEnabled !== true;
                    session.selectedExamId = exam.id;
                    configSessionService.markChanged(
                        session,
                        `Пересдача для экзамена "${exam.name}" ${exam.retestEnabled ? 'разрешена' : 'отключена'}.`
                    );
                }
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'exam_move') {
            const exam = getExam(session);
            if (exam && (parsed.value === 'up' || parsed.value === 'down')) {
                const index = session.draft.exams.findIndex((entry) => entry.id === exam.id);
                const targetIndex = index + (parsed.value === 'up' ? -1 : 1);
                if (index >= 0 && targetIndex >= 0 && targetIndex < session.draft.exams.length) {
                    [session.draft.exams[index], session.draft.exams[targetIndex]] = [
                        session.draft.exams[targetIndex],
                        session.draft.exams[index],
                    ];
                    session.examPage = Math.floor(targetIndex / EXAM_PAGE_SIZE);
                    configSessionService.markChanged(session, `Экзамен "${exam.name}" перемещён ${parsed.value === 'up' ? 'выше' : 'ниже'}.`);
                }
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'exam_delete_confirm') {
            const exam = getExam(session, parsed.value);
            if (exam) {
                session.draft.exams = session.draft.exams.filter((entry) => entry.id !== exam.id);
                session.selectedExamId = null;
                const maxPage = Math.max(Math.ceil(session.draft.exams.length / EXAM_PAGE_SIZE) - 1, 0);
                session.examPage = Math.min(session.examPage || 0, maxPage);
                configSessionService.setSection(session, 'exams');
                configSessionService.markChanged(session, `Экзамен "${exam.name}" удалён.`);
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'lecture_type_select' && interaction.isStringSelectMenu()) {
            const lectureType = (session.draft.examinationSettings?.lectureTypes || [])
                .find((entry) => entry.id === interaction.values[0]);
            if (lectureType) {
                session.selectedLectureTypeId = lectureType.id;
                configSessionService.setStatus(session, null);
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'lecture_type_department_set' && interaction.isStringSelectMenu()) {
            const lectureType = (session.draft.examinationSettings?.lectureTypes || [])
                .find((entry) => entry.id === session.selectedLectureTypeId);
            if (lectureType) {
                lectureType.departmentId = interaction.values[0] || null;
                if (lectureType.departmentId) lectureType.pingRoleIds = [];
                configSessionService.markChanged(
                    session,
                    lectureType.departmentId
                        ? `Для лекции "${lectureType.name}" изменён отдел.`
                        : `Для лекции "${lectureType.name}" отдел очищен.`
                );
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'lecture_type_roles_set' && interaction.isRoleSelectMenu()) {
            const lectureType = (session.draft.examinationSettings?.lectureTypes || [])
                .find((entry) => entry.id === session.selectedLectureTypeId);
            if (lectureType) {
                lectureType.pingRoleIds = Array.from(new Set(interaction.values || [])).slice(0, 10);
                if (lectureType.pingRoleIds.length) lectureType.departmentId = null;
                configSessionService.markChanged(session, `Для лекции "${lectureType.name}" изменены роли для пинга.`);
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'lecture_type_department_clear') {
            const lectureType = (session.draft.examinationSettings?.lectureTypes || [])
                .find((entry) => entry.id === session.selectedLectureTypeId);
            if (lectureType) {
                lectureType.departmentId = null;
                configSessionService.markChanged(session, `Для лекции "${lectureType.name}" отдел очищен.`);
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'lecture_type_roles_clear') {
            const lectureType = (session.draft.examinationSettings?.lectureTypes || [])
                .find((entry) => entry.id === session.selectedLectureTypeId);
            if (lectureType) {
                lectureType.pingRoleIds = [];
                configSessionService.markChanged(session, `Для лекции "${lectureType.name}" роли для пинга очищены.`);
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'lecture_type_move') {
            const lectureTypes = session.draft.examinationSettings?.lectureTypes || [];
            const index = lectureTypes.findIndex((entry) => entry.id === session.selectedLectureTypeId);
            const targetIndex = index + (parsed.value === 'up' ? -1 : 1);
            if (
                index >= 0 &&
                ['up', 'down'].includes(parsed.value) &&
                targetIndex >= 0 &&
                targetIndex < lectureTypes.length
            ) {
                [lectureTypes[index], lectureTypes[targetIndex]] = [
                    lectureTypes[targetIndex],
                    lectureTypes[index],
                ];
                session.lectureTypePage = Math.floor(targetIndex / LECTURE_TYPE_PAGE_SIZE);
                configSessionService.markChanged(
                    session,
                    `Тип лекции "${lectureTypes[targetIndex].name}" перемещён ${parsed.value === 'up' ? 'выше' : 'ниже'}.`
                );
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'lecture_type_delete_confirm') {
            const lectureTypes = session.draft.examinationSettings?.lectureTypes || [];
            const lectureType = lectureTypes.find((entry) => entry.id === parsed.value);
            if (lectureType) {
                session.draft.examinationSettings.lectureTypes = lectureTypes
                    .filter((entry) => entry.id !== lectureType.id);
                session.selectedLectureTypeId = null;
                const maxPage = Math.max(
                    Math.ceil(session.draft.examinationSettings.lectureTypes.length / LECTURE_TYPE_PAGE_SIZE) - 1,
                    0
                );
                session.lectureTypePage = Math.min(session.lectureTypePage || 0, maxPage);
                configSessionService.setSection(session, 'lectureTypes');
                configSessionService.markChanged(session, `Тип лекции "${lectureType.name}" удалён.`);
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'department_select' && interaction.isStringSelectMenu()) {
            const department = getDepartment(session, interaction.values[0]);
            if (department) {
                session.selectedDepartmentId = department.id;
                session.selectedDepartmentRoleKey = null;
                configSessionService.setStatus(session, null);
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'department_role_select' && interaction.isStringSelectMenu()) {
            const roleKey = interaction.values[0];
            if (DEPARTMENT_ROLE_KEYS.has(roleKey)) {
                session.selectedDepartmentRoleKey = roleKey;
                configSessionService.setStatus(session, null);
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'department_role_set' && interaction.isRoleSelectMenu()) {
            const { departmentId, fieldKey } = parseDepartmentField(parsed.value);
            const department = getDepartment(session, departmentId);
            if (department && DEPARTMENT_ROLE_KEYS.has(fieldKey)) {
                department.roles[fieldKey] = interaction.values[0] || null;
                session.selectedDepartmentId = department.id;
                session.selectedDepartmentRoleKey = fieldKey;
                configSessionService.markChanged(session, 'Роль отдела изменена.');
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'department_role_clear') {
            const { departmentId, fieldKey } = parseDepartmentField(parsed.value);
            const department = getDepartment(session, departmentId);
            if (department && DEPARTMENT_ROLE_KEYS.has(fieldKey)) {
                department.roles[fieldKey] = null;
                session.selectedDepartmentId = department.id;
                session.selectedDepartmentRoleKey = fieldKey;
                configSessionService.markChanged(session, 'Роль отдела очищена.');
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'department_curators_toggle') {
            const department = getDepartment(session, parsed.value);
            if (department) {
                department.curatorsEnabled = department.curatorsEnabled === false;
                session.selectedDepartmentId = department.id;
                configSessionService.markChanged(
                    session,
                    `Кураторы отдела ${department.curatorsEnabled ? 'включены' : 'выключены'}.`
                );
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'department_channel_set' && interaction.isChannelSelectMenu()) {
            const department = getDepartment(session, parsed.value);
            if (department) {
                department.staffChannelId = interaction.values[0] || null;
                session.selectedDepartmentId = department.id;
                configSessionService.markChanged(session, 'Канал состава отдела изменён.');
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'department_channel_clear') {
            const department = getDepartment(session, parsed.value);
            if (department) {
                department.staffChannelId = null;
                session.selectedDepartmentId = department.id;
                configSessionService.markChanged(session, 'Канал состава отдела очищен.');
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'department_delete_confirm') {
            const department = getDepartment(session, parsed.value);
            if (department) {
                if (session.draft.giveRolesSettings?.inviteDepartmentId === department.id) {
                    configSessionService.setSection(session, 'departments');
                    configSessionService.setErrors(session, [
                        'Отдел выбран для принятия новых сотрудников. Сначала очисти его в разделе "Выдача ролей".',
                    ]);
                    await updatePanel(client, interaction, session);
                    return;
                }

                session.draft.departments = session.draft.departments
                    .filter(({ id }) => id !== department.id);
                session.selectedDepartmentId = null;
                session.selectedDepartmentRoleKey = null;
                const maxPage = Math.max(Math.ceil(session.draft.departments.length / 25) - 1, 0);
                session.departmentPage = Math.min(session.departmentPage || 0, maxPage);
                configSessionService.setSection(session, 'departments');
                configSessionService.markChanged(session, `Отдел "${department.shortName}" удалён.`);
            }
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.action === 'cancel') {
            const changes = configSessionService.getChanges(session);
            configSessionService.cancel(session);
            await editMessageWithRetry(interaction.message, renderClosedPanel({
                guildName: interaction.guild.name,
                userId: session.userId,
                saved: false,
                changes,
            }));

            logger.info('Редактирование настроек сервера отменено', {
                guildId: interaction.guildId,
                userId: interaction.user.id,
                changes,
            });
            return;
        }

        if (parsed.action === 'save') {
            const errors = await validateGuildSettings(interaction.guild, session.draft, {
                allGuildConfigs: guildConfigService.getAllIncludingEmpty(),
            });
            if (errors.length) {
                configSessionService.setErrors(session, errors);
                await updatePanel(client, interaction, session);
                return;
            }

            const changes = configSessionService.getChanges(session);
            await configSessionService.save(session);
            scheduleGuildStaffListUpdate(client, interaction.guildId, {
                delayMs: 0,
                reason: 'settings-save',
            });
            scheduleGuildChannelCounterUpdate(client, interaction.guildId, {
                delayMs: 0,
                reason: 'settings-save',
            });
            scheduleGuildShiftSync(client, interaction.guildId, {
                delayMs: 0,
                reason: 'settings-save',
            });
            await editMessageWithRetry(interaction.message, renderClosedPanel({
                guildName: interaction.guild.name,
                userId: session.userId,
                saved: true,
                changes,
            }));

            logger.info('Настройки сервера сохранены через /settings', {
                guildId: interaction.guildId,
                userId: interaction.user.id,
                changes,
            });
            return;
        }

        configSessionService.setErrors(session, ['Неизвестное действие панели настроек.']);
        await updatePanel(client, interaction, session);
    } catch (error) {
        logger.error('Ошибка обработки панели /settings', {
            guildId: interaction.guildId,
            userId: interaction.user.id,
            action: parsed.action,
        }, error);

        const activeSession = configSessionService.getById(parsed.sessionId);
        if (activeSession) {
            configSessionService.setErrors(activeSession, [
                buildPublicErrorMessage(error, 'Произошла внутренняя ошибка. Подробности записаны в лог.')
            ]);

            const message = await getPanelMessage(client, interaction, activeSession).catch(() => null);
            if (message) {
                await editMessageWithRetry(
                    message,
                    renderSettingsPanel(activeSession, interaction.guild)
                ).catch(() => undefined);
            }
        } else if (!interaction.deferred && !interaction.replied) {
            await replyPublic(
                interaction,
                buildPublicErrorMessage(error, 'Произошла внутренняя ошибка панели настроек.')
            ).catch(() => undefined);
        }
    }
};
