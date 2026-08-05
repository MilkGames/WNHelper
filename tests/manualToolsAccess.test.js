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
const nodeTest = require('node:test');
const test = require('./helpers/createTest')(__filename);
const { installRuntimeStubs } = require('./helpers/runtimeStubs');

const restoreRuntimeStubs = installRuntimeStubs();
nodeTest.after(restoreRuntimeStubs);

const applicationConfig = require('../config.json');
const guildConfigService = require('../src/core/config/guildConfigService');
const {
    MANUAL_TOOLS_SUBCOMMAND_DEFINITIONS,
    OWNER_ONLY_SUBCOMMANDS,
    canUseManualTool,
    normalizeManualToolsAccess,
} = require('../src/modules/manual-tools/access');
const {
    createSettingsDraft,
    formatSettingsChange,
    getSettingsChanges,
    prepareSettingsForStorage,
} = require('../src/modules/settings/schema');

const OWNER_ID = applicationConfig.devs[0];
const GUILD_ID = '100000000000000001';
const ROLE_ID = '100000000000000002';

function member(id, roleIds = []) {
    return {
        id,
        roles: {
            cache: new Map(roleIds.map((roleId) => [roleId, { id: roleId }])),
        },
    };
}

test('каждая подкоманда /manualtools относится к делегируемым или owner-only', () => {
    const command = require('../src/modules/manual-tools/command');
    const configured = new Set([
        ...MANUAL_TOOLS_SUBCOMMAND_DEFINITIONS.map((entry) => entry.key),
        ...OWNER_ONLY_SUBCOMMANDS,
    ]);
    assert.deepEqual(
        [...new Set(command.options.map((option) => option.name))].sort(),
        [...configured].sort()
    );
});

test('правила /manualtools объединяются по роли и удаляют неизвестные подкоманды', () => {
    assert.deepEqual(normalizeManualToolsAccess([
        { roleId: ROLE_ID, subcommandKeys: ['refresh', 'unknown', 'retry_uval'] },
        { roleId: ROLE_ID, subcommandKeys: ['refresh', 'database_status'] },
        { roleId: '', subcommandKeys: ['refresh'] },
        { roleId: '100000000000000003', subcommandKeys: ['shutdown_instance'] },
    ]), [{
        roleId: ROLE_ID,
        subcommandKeys: ['database_status', 'refresh', 'retry_uval'],
    }]);
});

test('владелец имеет полный доступ, а роль получает только выбранные подкоманды', () => {
    const originalGetAny = guildConfigService.getAny;
    guildConfigService.getAny = () => ({
        manualToolsAccess: [{
            roleId: ROLE_ID,
            subcommandKeys: ['refresh', 'retry_staff_action'],
        }],
    });

    try {
        assert.equal(canUseManualTool(member(OWNER_ID), GUILD_ID, 'database_apply'), true);
        assert.equal(canUseManualTool(member('100000000000000010', [ROLE_ID]), GUILD_ID, 'refresh'), true);
        assert.equal(canUseManualTool(member('100000000000000010', [ROLE_ID]), GUILD_ID, 'retry_uval'), false);
        assert.equal(canUseManualTool(member('100000000000000010', [ROLE_ID]), GUILD_ID, 'database_apply'), false);
        assert.equal(canUseManualTool(member('100000000000000011'), GUILD_ID, 'refresh'), false);
    } finally {
        guildConfigService.getAny = originalGetAny;
    }
});

test('настройки /manualtools сохраняются отдельно от доступа к /settings', () => {
    const before = createSettingsDraft({
        guildId: GUILD_ID,
        settingsManagerRoleIds: [ROLE_ID],
        settingsSectionAccess: [{ roleId: ROLE_ID, sectionKeys: ['vacations'] }],
    });
    const after = createSettingsDraft({
        ...before,
        manualToolsAccess: [{
            roleId: ROLE_ID,
            subcommandKeys: ['refresh', 'retry_vacation'],
        }],
    });
    const stored = prepareSettingsForStorage(after);
    const changes = getSettingsChanges(before, after);
    const manualChange = changes.find((change) => change.section === 'manualToolsAccess');

    assert.deepEqual(stored.settingsManagerRoleIds, [ROLE_ID]);
    assert.deepEqual(stored.settingsSectionAccess, [{ roleId: ROLE_ID, sectionKeys: ['vacations'] }]);
    assert.deepEqual(stored.manualToolsAccess, [{
        roleId: ROLE_ID,
        subcommandKeys: ['refresh', 'retry_vacation'],
    }]);
    assert.ok(manualChange);
    assert.match(formatSettingsChange(manualChange), /Доступ к \/manualtools/u);
});
