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
const fs = require('fs');
const path = require('path');
const test = require('../helpers/createTest')(__filename);

const { PROJECT_ROOT } = require('../helpers/projectFiles');
const channelCounters = require('../../src/modules/channel-counters/settings/schema');
const giveRoles = require('../../src/modules/give-roles/settings/schema');
const staffLists = require('../../src/modules/staff-lists/settings/schema');
const staffAudit = require('../../src/modules/staff-audit/settings/schema');
const discipline = require('../../src/modules/discipline/settings/schema');
const examination = require('../../src/modules/examination/settings/schema');
const vacations = require('../../src/modules/vacations/settings/schema');

const fixture = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'tests', 'fixtures', 'guild-config.json'), 'utf8'));

test('настройки небольших модулей сохраняют текущую нормализацию', () => {
    assert.deepEqual(channelCounters.getChannelCounterSettings(fixture), fixture.channelCounterSettings);
    assert.deepEqual(staffLists.getStaffListSettings(fixture), fixture.staffListSettings);
    assert.deepEqual(giveRoles.getGiveRolesSettings(fixture), fixture.giveRolesSettings);
});

test('списки идентификаторов выдачи ролей очищаются от дублей', () => {
    const result = giveRoles.getGiveRolesSettings({
        giveRolesSettings: {
            reviewerRoleIds: ['2', '1', '2', ''],
            blockerRoleIds: ['3', '3'],
        },
    });
    assert.deepEqual(result.reviewerRoleIds, ['1', '2']);
    assert.deepEqual(result.blockerRoleIds, ['3']);
});


test('новые настройки функциональных блоков нормализуются без технических значений', () => {
    const disciplineSettings = discipline.getDisciplineSettings({
        disciplineSettings: {
            issuePolicy: {
                enabled: true,
                leadershipRoleIds: ['2', '1', '2'],
                examinerRoleIds: ['3'],
                fallbackPermissionMode: 'policy',
            },
            appeals: {
                enabled: true,
                channelId: '4',
                finalReviewerRoleIds: ['6', '5', '6'],
                workoffReviewerRoleIds: ['7'],
                pauseWorkoffDeadline: true,
            },
            conditionalRules: [{
                id: 'roles',
                stage: 'written',
                count: 1,
                action: {
                    type: 'update_roles',
                    removeRoleIds: ['9', '8', '9'],
                    addRoleIds: ['10'],
                },
            }],
        },
    });
    assert.deepEqual(disciplineSettings.issuePolicy.leadershipRoleIds, ['1', '2']);
    assert.equal(disciplineSettings.issuePolicy.fallbackPermissionMode, 'policy');
    assert.deepEqual(disciplineSettings.appeals.finalReviewerRoleIds, ['5', '6']);
    assert.equal(disciplineSettings.appeals.pauseWorkoffDeadline, true);
    assert.deepEqual(disciplineSettings.conditionalRules[0].action, {
        type: 'update_roles',
        removeRoleIds: ['8', '9'],
        addRoleIds: ['10'],
    });

    const vacationType = vacations.normalizeVacationType({
        id: 'unpaid',
        conditionalRemoveMinDurationDays: 4,
        conditionalRemoveRoleIdsOnStart: ['12', '11', '12'],
    });
    assert.equal(vacationType.conditionalRemoveMinDurationDays, 4);
    assert.deepEqual(vacationType.conditionalRemoveRoleIdsOnStart, ['11', '12']);

    const examinationSettings = examination.getExaminationSettings({
        examinationSettings: { pendingReminderMinutes: 90 },
    });
    assert.equal(examinationSettings.pendingReminderMinutes, 90);

    const auditSettings = staffAudit.getStaffAuditSettings({
        staffAuditSettings: { promotionLimitBypassRoleIds: ['14', '13', '14'] },
    });
    assert.deepEqual(auditSettings.promotionLimitBypassRoleIds, ['13', '14']);

    const listSettings = staffLists.getStaffListSettings({
        staffListSettings: { leaderAppointmentDate: '2026-08-01', leaderTermDays: 31 },
    });
    assert.equal(listSettings.leaderTermDays, 31);
});
