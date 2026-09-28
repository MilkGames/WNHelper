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

function getBuilderValue(builder, method) {
    return flatten(builder?.data?.[method])[0] ?? null;
}

function getButtonLabels(rows) {
    return rows.flatMap((row) => flatten(row?.data?.addComponents))
        .map((button) => getBuilderValue(button, 'setLabel'))
        .filter(Boolean);
}

function createConfig() {
    return {
        features: { staffAudit: true, giveRoles: true },
        commonRoles: { weazelNewsRoleId: '100000000000000001' },
        ranks: [
            {
                number: 1,
                name: 'Intern',
                roleId: '100000000000000002',
                grantPolicy: { mode: 'unrestricted', roleIds: [] },
            },
            {
                number: 2,
                name: 'Assistant',
                roleId: '100000000000000003',
                grantPolicy: { mode: 'unrestricted', roleIds: [] },
            },
            {
                number: 3,
                name: 'Junior',
                roleId: null,
                grantPolicy: { mode: 'unrestricted', roleIds: [] },
            },
        ],
        departments: [{
            id: 'rdd',
            shortName: 'RDD',
            fullName: 'Recruitment & Disciplinary Department',
            roles: { memberRoleId: '100000000000000004' },
        }],
        giveRolesSettings: {
            inviteDepartmentId: 'rdd',
            dbRankNumber: 2,
            dbAdditionalRoleIds: [],
            reviewerRoleIds: ['100000000000000005'],
            blockerRoleIds: [],
        },
        staffAuditSettings: {
            channelId: '100000000000000006',
            deleteRequestChannelId: '100000000000000007',
            deleteNotifyRoleIds: ['100000000000000008'],
            departmentTransitionRankNumber: 2,
            dismissalKeepRoleIds: ['100000000000000001'],
            massAuditMaxItems: 25,
            dismissalApprovalChannelId: '100000000000000009',
            dismissalApprovalRoleIds: ['100000000000000010'],
            dismissalLimitExemptRoleIds: ['100000000000000011'],
            dismissalLimitCount: 3,
            dismissalLimitWindowMinutes: 60,
            promotionLimitBypassRoleIds: ['100000000000000012'],
        },
        staffListSettings: {
            leaderAppointmentDate: '2026-08-01',
            leaderTermDays: 30,
        },
    };
}

test('кнопка одобрения ДБ видна только в день срока директора и на следующий день', () => {
    const restore = installRuntimeStubs();
    try {
        const { buildRequestComponents } = require('../src/modules/give-roles/request');
        const config = createConfig();
        const labelsAt = (timestamp) => getButtonLabels(
            buildRequestComponents(config, 'request-1', timestamp)
        );

        assert.equal(labelsAt(Date.parse('2026-07-31T12:00:00Z')).includes('Одобрить (ДБ)'), false);
        assert.equal(labelsAt(Date.parse('2026-08-01T12:00:00Z')).includes('Одобрить (ДБ)'), true);
        assert.equal(labelsAt(Date.parse('2026-08-02T12:00:00Z')).includes('Одобрить (ДБ)'), true);
        assert.equal(labelsAt(Date.parse('2026-08-03T12:00:00Z')).includes('Одобрить (ДБ)'), false);
    } finally {
        restore();
    }
});

test('принятие и одобрение ДБ поддерживают ранги без Discord-роли', async () => {
    const restore = installRuntimeStubs();
    try {
        const giveRolesService = require('../src/modules/give-roles');
        const { validateGuildSettings } = require('../src/modules/settings/validation');
        const config = createConfig();
        config.guildId = '100000000000000099';
        config.ranks = config.ranks.map((rank) => ({ ...rank, roleId: null }));
        config.giveRolesSettings.dbRankNumber = 3;

        const roleIds = [
            config.commonRoles.weazelNewsRoleId,
            config.departments[0].roles.memberRoleId,
            ...config.giveRolesSettings.reviewerRoleIds,
        ];
        const guild = {
            id: config.guildId,
            roles: {
                cache: new Map(roleIds.map((roleId) => [roleId, { id: roleId }])),
            },
            channels: { cache: new Map() },
            members: { me: null },
        };

        const initialRank = giveRolesService.getInitialRank(config);
        assert.equal(initialRank.number, 1);
        assert.equal(initialRank.roleId, null);

        const regular = giveRolesService.getAssignmentErrors(guild, config, 'role-confirm');
        assert.deepEqual(regular.errors, []);
        assert.equal(regular.assignment.rank.number, 1);
        assert.deepEqual(regular.assignment.roleIds, [
            config.commonRoles.weazelNewsRoleId,
            config.departments[0].roles.memberRoleId,
        ]);

        const db = giveRolesService.getAssignmentErrors(guild, config, 'role-db');
        assert.deepEqual(db.errors, []);
        assert.equal(db.assignment.rank.number, 3);
        assert.deepEqual(db.assignment.roleIds, [
            config.commonRoles.weazelNewsRoleId,
            config.departments[0].roles.memberRoleId,
        ]);
        assert.equal(
            giveRolesService.shouldShowDbButton(config, Date.parse('2026-08-01T12:00:00Z')),
            true
        );

        const settingsErrors = await validateGuildSettings(guild, config);
        assert.equal(
            settingsErrors.some((error) => error.includes('выбранного для ДБ ранга') && error.includes('Discord-роль')),
            false
        );
        assert.equal(
            settingsErrors.some((error) => error.includes('хотя бы один ранг с Discord-ролью')),
            false
        );
    } finally {
        restore();
    }
});

test('повышение на ранг без Discord-роли допускает исполнителя без роли ранга', async () => {
    const restore = installRuntimeStubs();
    try {
        const staffAuditService = require('../src/modules/staff-audit/service');
        const guild = {
            id: '100000000000000099',
            roles: { cache: new Map() },
        };
        const actor = {
            id: '100000000000000090',
            guild,
            roles: { cache: new Map() },
        };
        const member = {
            id: '100000000000000091',
            guild,
            roles: { cache: new Map() },
        };
        const target = {
            member,
            memberId: member.id,
            displayName: 'Employee | 7658',
            staticId: '7658',
            displayValue: '<@100000000000000091>',
        };
        const config = {
            features: { staffAudit: true },
            ranks: [
                {
                    number: 1,
                    name: 'First',
                    roleId: null,
                    grantPolicy: { mode: 'unrestricted', roleIds: [] },
                },
                {
                    number: 2,
                    name: 'Second',
                    roleId: null,
                    grantPolicy: { mode: 'unrestricted', roleIds: [] },
                },
            ],
        };

        const result = await staffAuditService.changeRank(null, {
            guild,
            config,
            actor,
            target,
            actionInput: '1-2',
            reason: 'Повышение',
            currentRankConfirmed: true,
            skipDiscord: true,
            skipAudit: true,
            skipPromotionRecord: true,
        });
        assert.equal(result.rankAction.formattedAction, 'Повышен 1-2');

        config.ranks[1].roleId = '100000000000000092';
        await assert.rejects(
            () => staffAuditService.changeRank(null, {
                guild,
                config,
                actor,
                target,
                actionInput: '1-2',
                reason: 'Повышение',
                currentRankConfirmed: true,
                skipDiscord: true,
                skipAudit: true,
                skipPromotionRecord: true,
            }),
            (error) => error?.code === 'исполнителя_rank_missing'
        );

        config.ranks[1].roleId = null;
        await assert.rejects(
            () => staffAuditService.changeRank(null, {
                guild,
                config,
                actor,
                target,
                actionInput: '2-1',
                reason: 'Понижение',
                currentRankConfirmed: true,
                skipDiscord: true,
                skipAudit: true,
                skipPromotionRecord: true,
            }),
            (error) => error?.code === 'исполнителя_rank_missing'
        );
    } finally {
        restore();
    }
});

test('справка кадрового аудита покрывает основные процессы и ограничения Discord', () => {
    const restore = installRuntimeStubs();
    try {
        const { buildKaInfoPayloads } = require('../src/modules/settings/publication');
        const payloads = buildKaInfoPayloads(createConfig());
        const descriptions = [];

        assert.equal(payloads.length, 6);
        for (const [payloadIndex, payload] of payloads.entries()) {
            assert.ok(payload.embeds.length <= 10);
            let totalLength = 0;
            for (const embed of payload.embeds) {
                const title = String(getBuilderValue(embed, 'setTitle') || '');
                const description = String(getBuilderValue(embed, 'setDescription') || '');
                assert.ok(title.length <= 256, `payload ${payloadIndex + 1}: слишком длинный title`);
                assert.ok(description.length <= 4096, `payload ${payloadIndex + 1}: слишком длинное описание`);
                totalLength += title.length + description.length;
                descriptions.push(description);
            }
            assert.ok(totalLength <= 6000, `payload ${payloadIndex + 1}: превышен общий лимит embed`);
        }

        const text = descriptions.join('\n');
        for (const expected of [
            '/invite',
            '/rank',
            '/uval',
            '/massaudit',
            'не умеют сами определять, утверждён ли отчёт или заявление',
            'текущим считается ранг слева в `action`',
            'при повышении на ранг без Discord-роли исполнитель без роли ранга может провести операцию',
            'наличие других ролей рангов само по себе slash-команду не останавливает',
            'ошибка никнейма записывается в лог',
            'одно повышение за московский календарный день',
            'Для текстовой записи без Discord ID дневной лимит не применяется',
            'Одобрить (ДБ)',
            'интеграционные управляемые роли',
            'закрывает очереди экзаменации, попытки и заявки',
            'Во всех трёх действиях для Discord-участника бот сначала ищет статик в конце никнейма',
            'action:2-3',
            'обычное текстовое имя',
            '@username',
            'повторная проверка может отметить строку как изменившуюся',
            'не проверяет кадровый ранг или специальную роль пользователя',
            '/manualtools retry_staff_action',
            '/manualtools retry_uval',
            '/manualtools retry_massaudit',
            'Массовый КА работает иначе',
            'автоматически не удаляется',
        ]) {
            assert.ok(text.includes(expected), `в справке отсутствует: ${expected}`);
        }

        for (const misleading of [
            'исполнитель и сотрудник должны иметь однозначно определяемые ранги',
            'бот заранее проверяет существование ролей, возможность управлять ими и возможность изменить никнейм',
            'После увольнения сохраняются только настроенные роли',
            'Повышение по утверждённому отчёту',
            'статик должен читаться из никнейма',
            '`static` поддерживается лишь в строке `invite`',
            'параметр `from` сверяется с найденной ролью',
            '`member` принимает только Discord ID или упоминание',
        ]) {
            assert.equal(text.includes(misleading), false, `в справке осталось неточное утверждение: ${misleading}`);
        }
    } finally {
        restore();
    }
});


test('явно выбранный отдел отражается в записи, а стандартная роль снимается только при реальной смене отдела', () => {
    const restore = installRuntimeStubs();
    try {
        const { getManualAssignment } = require('../src/modules/give-roles');
        const config = createConfig();
        config.departments.push({
            id: 'pd',
            shortName: 'PD',
            fullName: 'Publishing Department',
            roles: { memberRoleId: '100000000000000013' },
        });

        const sameDepartment = getManualAssignment(config, { departmentId: 'rdd' });
        assert.equal(sameDepartment.departmentOverridden, true);
        assert.deepEqual(sameDepartment.roleIdsToRemove, []);

        const changedDepartment = getManualAssignment(config, { departmentId: 'pd' });
        assert.equal(changedDepartment.departmentOverridden, true);
        assert.deepEqual(changedDepartment.roleIdsToRemove, ['100000000000000004']);
    } finally {
        restore();
    }
});
