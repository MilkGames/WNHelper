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
const assert = require('node:assert/strict');
const test = require('./helpers/createTest')(__filename);

const { installRuntimeStubs } = require('./helpers/runtimeStubs');

function flatten(value) {
    if (Array.isArray(value)) return value.flatMap(flatten);
    return value == null ? [] : [value];
}

function getBuilderArguments(builder, method) {
    return flatten(builder?.data?.[method]);
}

function assertStringLimit(value, limit, context) {
    if (value == null) return;
    assert.ok(String(value).length <= limit, `${context}: ${String(value).length} > ${limit}`);
}

function inspectComponent(component, context, violations) {
    const customId = getBuilderArguments(component, 'setCustomId')[0];
    const label = getBuilderArguments(component, 'setLabel')[0];
    const placeholder = getBuilderArguments(component, 'setPlaceholder')[0];
    const title = getBuilderArguments(component, 'setTitle')[0];
    const value = getBuilderArguments(component, 'setValue')[0];
    const maxLength = getBuilderArguments(component, 'setMaxLength')[0];
    const options = getBuilderArguments(component, 'addOptions');

    try {
        assertStringLimit(customId, 100, `${context}: customId`);
        assertStringLimit(label, 80, `${context}: label`);
        assertStringLimit(placeholder, 150, `${context}: placeholder`);
        assertStringLimit(title, 45, `${context}: title`);
        if (maxLength != null && value != null) assertStringLimit(value, Number(maxLength), `${context}: value`);
        assert.ok(options.length <= 25, `${context}: options ${options.length} > 25`);
        for (const [index, option] of options.entries()) {
            assertStringLimit(option?.label, 100, `${context}: option ${index} label`);
            assertStringLimit(option?.value, 100, `${context}: option ${index} value`);
            assertStringLimit(option?.description, 100, `${context}: option ${index} description`);
        }
    } catch (error) {
        violations.push(error.message);
    }
}

function inspectPayload(payload, context) {
    const violations = [];
    assertStringLimit(payload?.content, 2_000, `${context}: content`);
    const rows = Array.isArray(payload?.components) ? payload.components : [];
    assert.ok(rows.length <= 5, `${context}: строк компонентов ${rows.length} > 5`);
    for (const [rowIndex, row] of rows.entries()) {
        const components = getBuilderArguments(row, 'addComponents');
        assert.ok(components.length <= 5, `${context}: компонентов в строке ${rowIndex + 1}: ${components.length} > 5`);
        for (const [componentIndex, component] of components.entries()) {
            inspectComponent(component, `${context}, строка ${rowIndex + 1}, компонент ${componentIndex + 1}`, violations);
        }
    }
    assert.deepEqual(violations, []);
}

function inspectModal(modal, context) {
    const violations = [];
    inspectComponent(modal, context, violations);
    const rows = getBuilderArguments(modal, 'addComponents');
    assert.ok(rows.length <= 5, `${context}: строк полей ${rows.length} > 5`);
    for (const [rowIndex, row] of rows.entries()) {
        const components = getBuilderArguments(row, 'addComponents');
        assert.equal(components.length, 1, `${context}: в строке ${rowIndex + 1} должно быть одно поле`);
        for (const component of components) inspectComponent(component, `${context}, поле ${rowIndex + 1}`, violations);
    }
    assert.deepEqual(violations, []);
}

function createRichConfig() {
    const ids = Array.from({ length: 40 }, (_value, index) => String(100000000000000001n + BigInt(index)));
    return {
        guildId: ids[0],
        _serverName: 'Тестовый сервер',
        settingsManagerRoleIds: [ids[1]],
        settingsSectionAccess: [{ roleId: ids[2], sectionKeys: ['vacations', 'discipline'] }],
        manualToolsAccess: [{
            roleId: ids[2],
            subcommandKeys: ['refresh', 'retry_staff_action', 'retry_uval'],
        }],
        features: {
            giveRoles: true,
            staffAudit: true,
            discipline: true,
            exams: true,
            shifts: true,
            staffLists: true,
            channelCounters: true,
            vacations: true,
        },
        channels: {
            getRoleChannelId: ids[3],
            confirmRoleChannelId: ids[4],
            examChannelId: ids[5],
            examResultChannelId: ids[6],
        },
        commonRoles: { weazelNewsRoleId: ids[7], examinerRoleId: ids[8] },
        departments: [{
            id: 'rdd',
            shortName: 'RDD',
            fullName: 'Recruitment & Disciplinary Department',
            staffChannelId: ids[9],
            color: '#123456',
            curatorsEnabled: true,
            roles: {
                memberRoleId: ids[10],
                partTimeRoleId: ids[11],
                curatorRoleId: ids[12],
                headRoleId: ids[13],
                deputyHeadRoleId: ids[14],
            },
            limits: { heads: 1, deputyHeads: 3 },
        }],
        ranks: [1, 2, 6, 7, 8, 9].map((number, index) => ({
            number,
            name: `Ранг ${number}`,
            roleId: ids[15 + index],
            grantPolicy: { mode: 'roles', roleIds: [ids[1]] },
            staffList: { showInLeadership: number >= 6, maxMembers: number >= 6 ? 3 : null, showAppointmentTerm: number >= 8 },
        })),
        exams: [{
            id: 'charter',
            name: 'Экзамен по уставу',
            testId: '12345',
            quickCheckUrl: 'https://example.com/check',
            checkMode: 'automatic',
            maxScore: 20,
            passScore: 16,
            maxAttempts: 2,
            retestEnabled: true,
        }],
        examinationSettings: {
            lectureRequestChannelId: ids[21],
            retestRequestChannelId: ids[22],
            lectureResultChannelId: ids[23],
            retestResultChannelId: ids[24],
            lectureVoiceChannelId: ids[25],
            retestVoiceChannelId: ids[26],
            voiceJoinTimeoutMinutes: 15,
            pendingReminderMinutes: 60,
            lectureTypes: [{ id: 'intro', name: 'Вступительная лекция', departmentId: 'rdd', pingRoleIds: [] }],
        },
        vacationSettings: {
            requestChannelId: ids[27],
            noDepartmentApproverRoleIds: [ids[1]],
            upperLeadershipRoleIds: [ids[1]],
            roleRoutes: [{ id: 'leader', name: 'Руководство', applicantRoleIds: [ids[20]], approverRoleIds: [ids[1]] }],
            types: [{
                id: 'unpaid',
                name: 'Неоплачиваемый отпуск',
                enabled: true,
                availability: { minRankNumber: 2, allowNoDepartment: false, roleIds: [] },
                minDurationDays: 1,
                maxDurationDays: 7,
                monthlyLimitDays: 7,
                exceedMode: 'reroute',
                exceedApproverRoleIds: [ids[1]],
                vacationRoleId: ids[28],
                removeRoleIdsOnStart: [ids[11]],
                conditionalRemoveMinDurationDays: 4,
                conditionalRemoveRoleIdsOnStart: [ids[11]],
                releaseShiftsOnStart: true,
                releaseExaminationAssignmentsOnStart: true,
                closeSettingsSessionOnStart: true,
                pauseDisciplineDeadlines: true,
                blockedAccessGroups: ['staffAudit', 'discipline', 'examination'],
                accessBypassRoleIds: [ids[1]],
                overdueRules: [{ id: 'notify-1', afterDays: 1, time: '23:59', action: 'notify', notifyRoleIds: [ids[1]], reason: 'Вернуться в организацию' }],
            }],
        },
        giveRolesSettings: { dbRankNumber: 2, dbAdditionalRoleIds: [ids[10]], inviteDepartmentId: 'rdd', reviewerRoleIds: [ids[1]], blockerRoleIds: [] },
        staffAuditSettings: {
            channelId: ids[29],
            deleteRequestChannelId: ids[30],
            deleteNotifyRoleIds: [ids[1]],
            departmentTransitionRankNumber: 2,
            dismissalKeepRoleIds: [ids[7]],
            massAuditMaxItems: 25,
            dismissalApprovalChannelId: ids[31],
            dismissalApprovalRoleIds: [ids[1]],
            dismissalLimitExemptRoleIds: [ids[1]],
            dismissalLimitCount: 3,
            dismissalLimitWindowMinutes: 60,
            promotionLimitBypassRoleIds: [ids[1]],
        },
        disciplineSettings: {
            channelId: ids[32],
            removalChannelId: ids[33],
            removalApproverRoleIds: [ids[1]],
            massApprovalRoleIds: [ids[1]],
            massApprovalBypassRoleIds: [ids[1]],
            massMaxTargets: 25,
            massApprovalTimeoutMinutes: 30,
            maxIssueDelayDays: 7,
            noncomplianceOverdueAction: 'dismiss_blacklist',
            recertificationRoleId: ids[34],
            recertificationDeadlineDays: 7,
            recertificationExpiryAction: 'add_written',
            issuePolicy: { enabled: true, leadershipRoleIds: [ids[1]], examinerRoleIds: [ids[8]], departmentLeadershipEnabled: true, fallbackPermissionMode: 'checked' },
            appeals: { enabled: true, channelId: ids[35], finalReviewerRoleIds: [ids[1]], workoffReviewerRoleIds: [ids[1]], pauseWorkoffDeadline: true },
            workoffMethods: [{ id: 'interviews', name: 'Провести собеседования', stages: ['oral', 'written'], departmentIds: ['rdd'] }],
            conditionalRules: [{ id: 'demote', minRankNumber: 6, stage: 'written', count: 2, clause: '8.6', action: { type: 'update_roles', removeRoleIds: [ids[11]], addRoleIds: [ids[10]] } }],
        },
        staffListSettings: { highStaffChannelId: ids[36], leaderAppointmentDate: '2026-08-01', leaderTermDays: 30, curatorManagementRankNumbers: [8, 9] },
        channelCounterSettings: { employeesChannelId: ids[37], membersChannelId: ids[38] },
        shiftTypes: [{
            id: 'amd',
            name: 'Смены AMD',
            headerTemplate: 'Расписание смен AMD',
            enabled: true,
            channelId: ids[39],
            color: '#123456',
            publication: { time: '12:00' },
            schedule: { startTime: '14:00', endTime: '22:00', slotDurationMinutes: 60 },
            maxSlotsPerMember: 1,
            rotateAccessDaily: true,
            accessGroups: [{ id: 'staff', name: 'Сотрудники AMD', roleIds: [ids[11]], startDelayDays: 0 }],
            managerRoleIds: [ids[1]],
        }],
    };
}

function createGuild(config, Collection) {
    const roleIds = new Set();
    const channelIds = new Set();
    const visit = (value, key = '') => {
        if (Array.isArray(value)) return value.forEach((item) => visit(item, key));
        if (!value || typeof value !== 'object') {
            if (typeof value === 'string' && /^\d{17,20}$/u.test(value)) {
                if (/channel/i.test(key)) channelIds.add(value);
                else roleIds.add(value);
            }
            return;
        }
        for (const [nestedKey, nestedValue] of Object.entries(value)) visit(nestedValue, nestedKey);
    };
    visit(config);
    const roles = new Collection([...roleIds].map((id) => [id, { id, name: `Роль ${id.slice(-2)}` }]));
    const channels = new Collection([...channelIds].map((id) => [id, {
        id,
        name: `канал-${id.slice(-2)}`,
        permissionsFor: () => ({ has: () => true }),
    }]));
    return {
        id: config.guildId,
        name: config._serverName,
        roles: { cache: roles },
        channels: { cache: channels },
        members: { me: { id: 'bot' } },
    };
}

test('все экраны настроек и модальные окна соблюдают ограничения Discord', () => {
    const restore = installRuntimeStubs();
    try {
        const { Collection } = require('discord.js');
        const { createSettingsDraft } = require('../src/modules/settings/schema');
        const presentation = require('../src/modules/settings/presentation');
        const config = createRichConfig();
        const session = {
            id: 'settings-test',
            userId: '100000000000000001',
            fullAccess: true,
            allowedSectionKeys: [],
            original: createSettingsDraft(config),
            draft: createSettingsDraft(config),
            changes: [],
            errorLines: [],
            statusLine: null,
            selectedChannelKey: 'getRoleChannelId',
            selectedRoleKey: 'weazelNewsRoleId',
            selectedSettingsAccessRoleId: '100000000000000003',
            selectedManualToolsAccessRoleId: '100000000000000003',
            selectedDepartmentId: 'rdd',
            selectedDepartmentRoleKey: 'memberRoleId',
            selectedRankNumber: 6,
            selectedExamId: 'charter',
            selectedLectureTypeId: 'intro',
            selectedGiveRolesKey: 'reviewerRoleIds',
            selectedStaffAuditKey: 'channelId',
            selectedStaffListKey: 'highStaffChannelId',
            selectedChannelCounterKey: 'employeesChannelId',
            selectedShiftTypeId: 'amd',
            selectedShiftAccessGroupId: 'staff',
            selectedDisciplineGeneralKey: 'channelId',
            selectedDisciplineStage: 'written',
            selectedDisciplineRoleCount: 1,
            selectedDisciplineMethodId: 'interviews',
            selectedDisciplineRuleId: 'demote',
            selectedVacationRouteId: 'leader',
            selectedVacationTypeId: 'unpaid',
            selectedVacationOverdueRuleId: 'notify-1',
            publicationKind: 'examination',
            publicationMode: 'new',
            publicationExaminationMode: 'both',
            publicationChannelId: '100000000000000004',
        };
        const guild = createGuild(config, Collection);
        const sections = [
            'main', 'features', 'channels', 'commonRoles', 'settingsAccess', 'manualToolsAccess', 'departments', 'departmentRoles',
            'departmentChannel', 'departmentDelete', 'ranks', 'rankRole', 'rankPolicy', 'rankDelete',
            'rankStaffList', 'exams', 'examinationGeneral', 'examinationChannels', 'examinationVoiceChannels',
            'lectureTypes', 'lectureTypeDetails', 'lectureTypeDelete', 'publicationPreview', 'examMode',
            'examDelete', 'giveRoles', 'staffAudit', 'discipline', 'disciplineGeneral', 'disciplinePolicy',
            'disciplineAppeals', 'disciplineStage', 'disciplineStageRoles', 'disciplineMethods',
            'disciplineMethodStages', 'disciplineMethodDepartments', 'disciplineRules', 'disciplineRuleRoles',
            'staffLists', 'channelCounters', 'shiftTypes', 'shiftTypeChannel', 'shiftSchedule', 'shiftAccess',
            'shiftManagers', 'shiftPublish', 'shiftDelete', 'vacations', 'vacationGeneral', 'vacationRoutes',
            'vacationRouteDetails', 'vacationTypes', 'vacationTypeDetails', 'vacationTypeAvailability',
            'vacationTypeLimits', 'vacationTypeActions', 'vacationTypeBehavior', 'vacationTypeOverdue',
            'diagnostics', 'publications', 'changes',
        ];
        for (const section of sections) {
            session.section = section;
            inspectPayload(presentation.renderSettingsPanel(session, guild), `Экран "${section}"`);
        }

        const modals = [
            presentation.createDepartmentModal(session, session.draft.departments[0]),
            presentation.createRankModal(session, session.draft.ranks.find((rank) => rank.number === 6)),
            presentation.createRankStaffListLimitModal(session, session.draft.ranks.find((rank) => rank.number === 6)),
            presentation.createExamModal(session, session.draft.exams[0]),
            presentation.createExamScoresModal(session, session.draft.exams[0]),
            presentation.createExaminationTimeoutModal(session, 'voiceJoinTimeoutMinutes', 15),
            presentation.createLectureTypeModal(session, session.draft.examinationSettings.lectureTypes[0]),
            presentation.createStaffAuditIntegerModal(session, 'massAuditMaxItems', 25),
            presentation.createStaffListDateModal(session, '2026-08-01'),
            presentation.createShiftTypeModal(session, session.draft.shiftTypes[0]),
            presentation.createShiftTypeModal(session, {
                ...session.draft.shiftTypes[0],
                publication: { mode: 'random', fromTime: '20:00', toTime: '22:00' },
            }),
            presentation.createShiftScheduleModal(session, session.draft.shiftTypes[0]),
            presentation.createShiftAccessGroupModal(session, session.draft.shiftTypes[0].accessGroups[0]),
            presentation.createDisciplineIntegerModal(session, 'maxIssueDelayDays', 7),
            presentation.createDisciplineMethodModal(session, session.draft.disciplineSettings.workoffMethods[0]),
            presentation.createDisciplineRuleModal(session, session.draft.disciplineSettings.conditionalRules[0]),
            presentation.createVacationRouteModal(session, session.draft.vacationSettings.roleRoutes[0]),
            presentation.createVacationTypeModal(session, session.draft.vacationSettings.types[0]),
            presentation.createVacationOverdueModal(session, session.draft.vacationSettings.types[0].overdueRules[0]),
        ];
        modals.forEach((modal, index) => inspectModal(modal, `Модальное окно ${index + 1}`));
    } finally {
        restore();
    }
});
