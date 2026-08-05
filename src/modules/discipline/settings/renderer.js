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
const {
    ActionRowBuilder,
    ButtonStyle,
    ChannelSelectMenuBuilder,
    ModalBuilder,
    RoleSelectMenuBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require('discord.js');
const {
    DISCIPLINE_STAGES,
    DISCIPLINE_STAGE_LABELS,
} = require('./schema');

const GENERAL_DEFINITIONS = [
    { key: 'channelId', label: 'Канал взысканий', valueType: 'channel' },
    { key: 'removalChannelId', label: 'Канал запросов на снятие', valueType: 'channel' },
    { key: 'removalApproverRoleIds', label: 'Роли подтверждения снятия', valueType: 'roles' },
    { key: 'massApprovalRoleIds', label: 'Роли подтверждения массовых взысканий', valueType: 'roles' },
    { key: 'massApprovalBypassRoleIds', label: 'Роли обхода подтверждения массовых взысканий', valueType: 'roles' },
    { key: 'massMaxTargets', label: 'Максимум сотрудников в массовом взыскании', valueType: 'integer' },
    { key: 'massApprovalTimeoutMinutes', label: 'Срок подтверждения массового взыскания, минуты', valueType: 'integer' },
    { key: 'maxIssueDelayDays', label: 'Максимальная давность нарушения, дней', valueType: 'integer' },
    { key: 'noncomplianceOverdueAction', label: 'Повторная просрочка взыскания за неисполнение', valueType: 'action' },
    { key: 'recertificationRoleId', label: 'Роль переаттестации', valueType: 'role' },
    { key: 'recertificationDeadlineDays', label: 'Срок переаттестации, дней', valueType: 'integer' },
    { key: 'recertificationExpiryAction', label: 'Действие при просрочке переаттестации', valueType: 'recertAction' },
];

const MAX_WORKOFF_METHODS = 24;
const MAX_CONDITIONAL_RULES = 25;

const OVERDUE_OPTIONS = [
    { label: 'Ничего не делать', value: 'none' },
    { label: 'Добавить устный выговор', value: 'add_oral' },
    { label: 'Добавить письменный выговор', value: 'add_written' },
    { label: 'Заменить на устный выговор', value: 'replace_oral' },
    { label: 'Заменить на письменный выговор', value: 'replace_written' },
    { label: 'Уволить', value: 'dismiss' },
    { label: 'Уволить с ЧС', value: 'dismiss_blacklist' },
];


const DISCIPLINE_RULE_ACTION_LABELS = {
    update_roles: 'роли',
    set_rank: 'ранг',
};

const RECERTIFICATION_EXPIRY_OPTIONS = [
    { label: 'Ничего не делать', value: 'none' },
    { label: 'Добавить письменный выговор', value: 'add_written' },
    { label: 'Уволить', value: 'dismiss' },
    { label: 'Уволить с ЧС', value: 'dismiss_blacklist' },
];

function createDisciplineSettingsRenderer({
    customId,
    createButton,
    createFooterRow,
    formatStatus,
    getDepartments,
}) {
    function formatRoleList(roleIds) {
        return roleIds?.length ? roleIds.map((roleId) => `<@&${roleId}>`).join(', ') : 'не выбраны';
    }

    function renderDiscipline(session, guild) {
        const settings = session.draft.disciplineSettings;
        const content = [
            `## Настройки WN Helper - ${guild.name}`,
            formatStatus(session),
            '',
            `Канал взысканий: ${settings.channelId ? `<#${settings.channelId}>` : 'не выбран'}`,
            `Канал снятия: ${settings.removalChannelId ? `<#${settings.removalChannelId}>` : 'не выбран'}`,
            `Методов отработки: ${settings.workoffMethods.length}`,
            `Условных правил: ${settings.conditionalRules.length}`,
            '',
            'Выберите группу настроек.',
        ].join('\n');
        return {
            content,
            components: [
                new ActionRowBuilder().addComponents(
                    createButton(session, 'nav', 'Общее', ButtonStyle.Primary, 'disciplineGeneral'),
                    createButton(session, 'nav', 'Этапы', ButtonStyle.Primary, 'disciplineStage'),
                    createButton(session, 'nav', 'Методы', ButtonStyle.Primary, 'disciplineMethods'),
                    createButton(session, 'nav', 'Правила', ButtonStyle.Primary, 'disciplineRules'),
                ),
                new ActionRowBuilder().addComponents(
                    createButton(session, 'nav', 'Полномочия', ButtonStyle.Primary, 'disciplinePolicy'),
                    createButton(session, 'nav', 'Обжалования', ButtonStyle.Primary, 'disciplineAppeals'),
                ),
                createFooterRow(session),
            ],
        };
    }

    function renderDisciplineGeneral(session, guild) {
        const settings = session.draft.disciplineSettings;
        const selected = GENERAL_DEFINITIONS.find((entry) => entry.key === session.selectedDisciplineGeneralKey) || null;
        const lines = [
            `## Настройки WN Helper - ${guild.name}`,
            formatStatus(session),
            '',
            `Канал взысканий: ${settings.channelId ? `<#${settings.channelId}>` : 'не выбран'}`,
            `Канал запросов на снятие: ${settings.removalChannelId ? `<#${settings.removalChannelId}>` : 'не выбран'}`,
            `Роли подтверждения снятия: ${formatRoleList(settings.removalApproverRoleIds)}`,
            `Роли подтверждения массовых взысканий: ${formatRoleList(settings.massApprovalRoleIds)}`,
            `Роли обхода подтверждения: ${formatRoleList(settings.massApprovalBypassRoleIds)}`,
            `Максимум сотрудников в пакете: ${settings.massMaxTargets}`,
            `Срок подтверждения пакета: ${settings.massApprovalTimeoutMinutes} мин.`,
            `Максимальная давность нарушения: ${settings.maxIssueDelayDays} дн.`,
            `Повторная просрочка взыскания за неисполнение: ${OVERDUE_OPTIONS.find((item) => item.value === settings.noncomplianceOverdueAction)?.label || 'Неизвестное действие'}`,
            `Роль переаттестации: ${settings.recertificationRoleId ? `<@&${settings.recertificationRoleId}>` : 'не выбрана'}`,
            `Срок переаттестации: ${settings.recertificationDeadlineDays} дн.`,
            `Просрочка переаттестации: ${RECERTIFICATION_EXPIRY_OPTIONS.find((item) => item.value === settings.recertificationExpiryAction)?.label || 'Неизвестное действие'}`,
        ];
        const components = [new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(customId(session, 'discipline_general_select'))
                .setPlaceholder('Выбрать настройку')
                .addOptions(GENERAL_DEFINITIONS.map((entry) => ({
                    label: entry.label,
                    value: entry.key,
                    default: selected?.key === entry.key,
                })))
        )];

        if (selected?.valueType === 'channel') {
            components.push(new ActionRowBuilder().addComponents(
                new ChannelSelectMenuBuilder()
                    .setCustomId(customId(session, 'discipline_general_channel', selected.key))
                    .setPlaceholder(selected.label)
                    .setMinValues(1)
                    .setMaxValues(1)
            ));
        } else if (selected?.valueType === 'roles') {
            components.push(new ActionRowBuilder().addComponents(
                new RoleSelectMenuBuilder()
                    .setCustomId(customId(session, 'discipline_general_roles', selected.key))
                    .setPlaceholder(selected.label)
                    .setMinValues(1)
                    .setMaxValues(25)
            ));
        } else if (selected?.valueType === 'role') {
            components.push(new ActionRowBuilder().addComponents(
                new RoleSelectMenuBuilder()
                    .setCustomId(customId(session, 'discipline_general_role', selected.key))
                    .setPlaceholder(selected.label)
                    .setMinValues(1)
                    .setMaxValues(1)
            ));
        } else if (selected?.valueType === 'action') {
            components.push(new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(customId(session, 'discipline_general_action', selected.key))
                    .setPlaceholder(selected.label)
                    .addOptions(OVERDUE_OPTIONS
                        .filter((item) => ['none', 'dismiss', 'dismiss_blacklist'].includes(item.value))
                        .map((item) => ({
                            ...item,
                            default: item.value === settings[selected.key],
                        })))
            ));
        } else if (selected?.valueType === 'recertAction') {
            components.push(new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(customId(session, 'discipline_general_recert_action', selected.key))
                    .setPlaceholder(selected.label)
                    .addOptions(RECERTIFICATION_EXPIRY_OPTIONS.map((item) => ({
                        ...item,
                        default: item.value === settings[selected.key],
                    })))
            ));
        } else if (selected?.valueType === 'integer') {
            components.push(new ActionRowBuilder().addComponents(
                createButton(session, 'discipline_general_integer', 'Изменить число', ButtonStyle.Primary, selected.key)
            ));
        }
        components.push(createFooterRow(session, selected ? {
            includeClear: ['channel', 'roles', 'role'].includes(selected.valueType) ? {
                action: 'discipline_general_clear',
                value: selected.key,
            } : null,
            backSection: 'discipline',
        } : { backSection: 'discipline' }));
        return { content: lines.join('\n'), components };
    }

    function renderDisciplinePolicy(session, guild) {
        const policy = session.draft.disciplineSettings.issuePolicy;
        const fallbackLabel = policy.fallbackPermissionMode === 'policy'
            ? 'Проверять полномочия относительно сотрудника'
            : 'Безусловный доступ резервных ролей';
        return {
            content: [
                `## Настройки WN Helper - ${guild.name}`,
                '/settings -> Взыскания -> Полномочия',
                formatStatus(session),
                '',
                `Проверка полномочий: ${policy.enabled ? 'включена' : 'выключена'}`,
                `Руководящий состав: ${formatRoleList(policy.leadershipRoleIds)}`,
                `Экзаменаторы: ${formatRoleList(policy.examinerRoleIds)}`,
                `Старший состав своего отдела: ${policy.departmentLeadershipEnabled ? 'разрешён' : 'запрещён'}`,
                `Резервные роли: ${fallbackLabel}`,
                '',
                'Руководство может выдавать взыскания любому сотруднику. Экзаменаторы - любому, кроме руководства. Глава и заместитель главы - сотрудникам основного состава и подработки своего отдела.',
            ].join('\n'),
            components: [
                new ActionRowBuilder().addComponents(
                    new RoleSelectMenuBuilder()
                        .setCustomId(customId(session, 'discipline_policy_roles', 'leadershipRoleIds'))
                        .setPlaceholder('Роли руководящего состава')
                        .setMinValues(0)
                        .setMaxValues(25)
                        .setDefaultRoles(policy.leadershipRoleIds.slice(0, 25))
                ),
                new ActionRowBuilder().addComponents(
                    new RoleSelectMenuBuilder()
                        .setCustomId(customId(session, 'discipline_policy_roles', 'examinerRoleIds'))
                        .setPlaceholder('Роли экзаменаторов')
                        .setMinValues(0)
                        .setMaxValues(25)
                        .setDefaultRoles(policy.examinerRoleIds.slice(0, 25))
                ),
                new ActionRowBuilder().addComponents(
                    createButton(
                        session,
                        'discipline_policy_toggle',
                        policy.enabled ? 'Выключить проверку' : 'Включить проверку',
                        policy.enabled ? ButtonStyle.Danger : ButtonStyle.Success,
                        'enabled'
                    ),
                    createButton(
                        session,
                        'discipline_policy_toggle',
                        policy.departmentLeadershipEnabled ? 'Запретить старшему составу' : 'Разрешить старшему составу',
                        ButtonStyle.Secondary,
                        'departmentLeadershipEnabled'
                    ),
                ),
                new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(customId(session, 'discipline_policy_fallback'))
                        .setPlaceholder('Проверка резервных ролей')
                        .addOptions([
                            {
                                label: 'Безусловный доступ',
                                value: 'unconditional',
                                default: policy.fallbackPermissionMode === 'unconditional',
                            },
                            {
                                label: 'Проверять полномочия',
                                value: 'policy',
                                default: policy.fallbackPermissionMode === 'policy',
                            },
                        ])
                ),
                createFooterRow(session, { backSection: 'discipline' }),
            ],
        };
    }

    function renderDisciplineAppeals(session, guild) {
        const appeals = session.draft.disciplineSettings.appeals;
        return {
            content: [
                `## Настройки WN Helper - ${guild.name}`,
                '/settings -> Взыскания -> Обжалования',
                formatStatus(session),
                '',
                `Обжалования: ${appeals.enabled ? 'включены' : 'выключены'}`,
                `Канал: ${appeals.channelId ? `<#${appeals.channelId}>` : 'не выбран'}`,
                `Кто принимает окончательное решение: ${formatRoleList(appeals.finalReviewerRoleIds)}`,
                `Кто рассматривает изменение отработки: ${formatRoleList(appeals.workoffReviewerRoleIds)}`,
                `Приостанавливать срок отработки: ${appeals.pauseWorkoffDeadline ? 'да' : 'нет'}`,
                '',
                'Доказательства по обращению отправляются в отдельную ветку. Отзыв обращения всегда доступен заявителю.',
            ].join('\n'),
            components: [
                new ActionRowBuilder().addComponents(
                    new ChannelSelectMenuBuilder()
                        .setCustomId(customId(session, 'discipline_appeals_channel'))
                        .setPlaceholder('Канал обжалований')
                        .setMinValues(0)
                        .setMaxValues(1)
                        .setDefaultChannels(appeals.channelId ? [appeals.channelId] : [])
                ),
                new ActionRowBuilder().addComponents(
                    new RoleSelectMenuBuilder()
                        .setCustomId(customId(session, 'discipline_appeals_roles', 'finalReviewerRoleIds'))
                        .setPlaceholder('Кто принимает окончательное решение')
                        .setMinValues(0)
                        .setMaxValues(25)
                        .setDefaultRoles(appeals.finalReviewerRoleIds.slice(0, 25))
                ),
                new ActionRowBuilder().addComponents(
                    new RoleSelectMenuBuilder()
                        .setCustomId(customId(session, 'discipline_appeals_roles', 'workoffReviewerRoleIds'))
                        .setPlaceholder('Кто рассматривает изменение отработки')
                        .setMinValues(0)
                        .setMaxValues(25)
                        .setDefaultRoles(appeals.workoffReviewerRoleIds.slice(0, 25))
                ),
                new ActionRowBuilder().addComponents(
                    createButton(
                        session,
                        'discipline_appeals_toggle',
                        appeals.enabled ? 'Выключить обжалования' : 'Включить обжалования',
                        appeals.enabled ? ButtonStyle.Danger : ButtonStyle.Success,
                        'enabled'
                    ),
                    createButton(
                        session,
                        'discipline_appeals_toggle',
                        appeals.pauseWorkoffDeadline ? 'Не приостанавливать срок' : 'Приостанавливать срок',
                        ButtonStyle.Secondary,
                        'pauseWorkoffDeadline'
                    ),
                ),
                createFooterRow(session, { backSection: 'discipline' }),
            ],
        };
    }

    function renderDisciplineStage(session, guild) {
        const stageKey = DISCIPLINE_STAGES.includes(session.selectedDisciplineStage)
            ? session.selectedDisciplineStage
            : 'conversation';
        const stage = session.draft.disciplineSettings.stages[stageKey];
        const lines = [
            `## Настройки WN Helper - ${guild.name}`,
            formatStatus(session),
            '',
            `Этап: **${DISCIPLINE_STAGE_LABELS[stageKey]}**`,
            `Включён: ${stage.enabled ? 'да' : 'нет'}`,
            `Порог преобразования: ${stage.threshold}`,
            `Блокирует повышение: ${stage.blocksPromotion ? 'да' : 'нет'}`,
            `Блокирует обычное увольнение: ${stage.blocksOrdinaryDismissal ? 'да' : 'нет'}`,
            `Отработка: ${stage.workoffEnabled ? `да, ${stage.deadlineDays} дн.` : 'нет'}`,
            `Действие при просрочке: ${OVERDUE_OPTIONS.find((item) => item.value === stage.overdueAction)?.label || 'Неизвестное действие'}`,
            stageKey === 'conversation'
                ? `Автоистечение: ${stage.autoExpireEnabled ? `${stage.autoExpireDays} дн.` : 'выключено'}`
                : null,
        ].filter(Boolean);
        const components = [new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(customId(session, 'discipline_stage_select'))
                .setPlaceholder('Этап взыскания')
                .addOptions(DISCIPLINE_STAGES.map((key) => ({
                    label: DISCIPLINE_STAGE_LABELS[key],
                    value: key,
                    default: key === stageKey,
                })))
        )];
        components.push(new ActionRowBuilder().addComponents(
            createButton(session, 'discipline_stage_toggle', stage.enabled ? 'Выключить этап' : 'Включить этап', stage.enabled ? ButtonStyle.Danger : ButtonStyle.Success, 'enabled')
                .setDisabled(stageKey !== 'conversation'),
            createButton(session, 'discipline_stage_toggle', 'Блок повышения', stage.blocksPromotion ? ButtonStyle.Success : ButtonStyle.Secondary, 'blocksPromotion'),
            createButton(session, 'discipline_stage_toggle', 'Блок увольнения', stage.blocksOrdinaryDismissal ? ButtonStyle.Success : ButtonStyle.Secondary, 'blocksOrdinaryDismissal'),
            createButton(session, 'discipline_stage_toggle', 'Отработка', stage.workoffEnabled ? ButtonStyle.Success : ButtonStyle.Secondary, 'workoffEnabled'),
            createButton(session, 'discipline_stage_toggle', 'Автоистечение', stage.autoExpireEnabled ? ButtonStyle.Success : ButtonStyle.Secondary, 'autoExpireEnabled')
                .setDisabled(stageKey !== 'conversation'),
        ));
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(customId(session, 'discipline_stage_overdue'))
                .setPlaceholder('Действие при просрочке')
                .addOptions(OVERDUE_OPTIONS.map((item) => ({
                    ...item,
                    default: item.value === stage.overdueAction,
                })))
        ));
        components.push(new ActionRowBuilder().addComponents(
            createButton(session, 'discipline_stage_number', 'Порог', ButtonStyle.Primary, 'threshold')
                .setDisabled(stageKey !== 'conversation'),
            createButton(session, 'discipline_stage_number', 'Автоистечение', ButtonStyle.Primary, 'autoExpireDays')
                .setDisabled(stageKey !== 'conversation'),
            createButton(session, 'discipline_stage_number', 'Срок отработки', ButtonStyle.Primary, 'deadlineDays'),
            createButton(session, 'nav', 'Роли по количеству', ButtonStyle.Primary, 'disciplineStageRoles'),
        ));
        components.push(createFooterRow(session, { backSection: 'discipline' }));
        return { content: lines.join('\n'), components };
    }

    function renderDisciplineStageRoles(session, guild) {
        const stageKey = session.selectedDisciplineStage;
        const stage = session.draft.disciplineSettings.stages[stageKey];
        const counts = Array.from({ length: Math.max(stage.threshold - 1, 0) }, (_, index) => index + 1);
        session.selectedDisciplineRoleCount = counts.includes(session.selectedDisciplineRoleCount)
            ? session.selectedDisciplineRoleCount
            : counts[0] || 1;
        const selectedCount = session.selectedDisciplineRoleCount;
        const lines = [
            `## Настройки WN Helper - ${guild.name}`,
            formatStatus(session),
            '',
            `Этап: ${DISCIPLINE_STAGE_LABELS[stageKey]}`,
            ...counts.map((count) => `• ${count}: ${stage.roleByCount[String(count)] ? `<@&${stage.roleByCount[String(count)]}>` : 'роль не выбрана'}`),
        ];
        const components = [];
        if (counts.length) {
            components.push(new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(customId(session, 'discipline_role_count'))
                    .setPlaceholder('Количество активных взысканий')
                    .addOptions(counts.map((count) => ({
                        label: `${count} активн.`,
                        value: String(count),
                        default: count === selectedCount,
                    })))
            ));
            components.push(new ActionRowBuilder().addComponents(
                new RoleSelectMenuBuilder()
                    .setCustomId(customId(session, 'discipline_role_set', selectedCount))
                    .setPlaceholder(`Роль для количества ${selectedCount}`)
                    .setMinValues(1)
                    .setMaxValues(1)
            ));
        }
        components.push(createFooterRow(session, counts.length ? {
            includeClear: {
                action: 'discipline_role_clear',
                value: selectedCount,
            },
            backSection: 'disciplineStage',
        } : { backSection: 'disciplineStage' }));
        return { content: lines.join('\n'), components };
    }

    function renderDisciplineMethods(session, guild) {
        const methods = session.draft.disciplineSettings.workoffMethods;
        const selected = methods.find((method) => method.id === session.selectedDisciplineMethodId) || null;
        const lines = [
            `## Настройки WN Helper - ${guild.name}`,
            formatStatus(session),
            '',
            'Системный способ "Любой" доступен всегда.',
            `Пользовательских способов: ${methods.length}/${MAX_WORKOFF_METHODS}.`,
            ...methods.slice(0, 15).map((method) => (
                `• ${method.name}: ${method.stages.map((stage) => DISCIPLINE_STAGE_LABELS[stage]).join(', ')}; ` +
                `${method.departmentIds.length ? `${method.departmentIds.length} отдел(ов)` : 'все отделы'}`
            )),
            methods.length > 15 ? `• …и ещё ${methods.length - 15}` : null,
        ];
        const components = [];
        if (methods.length) {
            components.push(new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(customId(session, 'discipline_method_select'))
                    .setPlaceholder('Способ отработки')
                    .addOptions(methods.slice(0, 25).map((method) => ({
                        label: method.name.slice(0, 100),
                        value: method.id,
                        default: method.id === selected?.id,
                    })))
            ));
        }
        components.push(new ActionRowBuilder().addComponents(
            createButton(session, 'discipline_method_add', 'Добавить', ButtonStyle.Success)
                .setDisabled(methods.length >= MAX_WORKOFF_METHODS),
            createButton(session, 'discipline_method_edit', 'Переименовать', ButtonStyle.Primary).setDisabled(!selected),
            createButton(session, 'discipline_method_delete', 'Удалить', ButtonStyle.Danger).setDisabled(!selected),
        ));
        components.push(new ActionRowBuilder().addComponents(
            createButton(session, 'nav', 'Этапы метода', ButtonStyle.Primary, 'disciplineMethodStages').setDisabled(!selected),
            createButton(session, 'nav', 'Отделы метода', ButtonStyle.Primary, 'disciplineMethodDepartments').setDisabled(!selected),
        ));
        components.push(createFooterRow(session, { backSection: 'discipline' }));
        return { content: lines.filter(Boolean).join('\n'), components };
    }

    function renderDisciplineMethodStages(session, guild) {
        const method = session.draft.disciplineSettings.workoffMethods
            .find((entry) => entry.id === session.selectedDisciplineMethodId) || null;
        if (!method) return renderDisciplineMethods(session, guild);
        const select = new StringSelectMenuBuilder()
            .setCustomId(customId(session, 'discipline_method_stages'))
            .setPlaceholder('Этапы, для которых доступен способ')
            .setMinValues(1)
            .setMaxValues(DISCIPLINE_STAGES.length)
            .addOptions(DISCIPLINE_STAGES.map((stage) => ({
                label: DISCIPLINE_STAGE_LABELS[stage],
                value: stage,
                default: method.stages.includes(stage),
            })));
        return {
            content: [
                `## Настройки WN Helper - ${guild.name}`,
                formatStatus(session),
                '',
                `Способ: **${method.name}**`,
                `Этапы: ${method.stages.map((stage) => DISCIPLINE_STAGE_LABELS[stage]).join(', ')}`,
            ].join('\n'),
            components: [
                new ActionRowBuilder().addComponents(select),
                createFooterRow(session, { backSection: 'disciplineMethods' }),
            ],
        };
    }

    function renderDisciplineMethodDepartments(session, guild) {
        const method = session.draft.disciplineSettings.workoffMethods
            .find((entry) => entry.id === session.selectedDisciplineMethodId) || null;
        if (!method) return renderDisciplineMethods(session, guild);
        const departments = getDepartments(session.draft);
        const components = [];
        if (departments.length) {
            components.push(new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(customId(session, 'discipline_method_departments'))
                    .setPlaceholder('Отделы; пустой список означает все отделы')
                    .setMinValues(1)
                    .setMaxValues(Math.min(departments.length, 25))
                    .addOptions(departments.slice(0, 25).map((department) => ({
                        label: `${department.shortName} - ${department.fullName}`.slice(0, 100),
                        value: department.id,
                        default: method.departmentIds.includes(department.id),
                    })))
            ));
        }
        components.push(createFooterRow(session, {
            includeClear: {
                action: 'discipline_method_departments_clear',
            },
            backSection: 'disciplineMethods',
        }));
        return {
            content: [
                `## Настройки WN Helper - ${guild.name}`,
                formatStatus(session),
                '',
                `Способ: **${method.name}**`,
                method.departmentIds.length
                    ? `Доступен отделам: ${method.departmentIds.map((departmentId) => {
                        const department = departments.find((entry) => entry.id === departmentId);
                        return department
                            ? `${department.shortName} - ${department.fullName}`
                            : `удалённый отдел (${departmentId})`;
                    }).join(', ')}`
                    : 'Доступен всем отделам.',
            ].join('\n'),
            components,
        };
    }

    function renderDisciplineRules(session, guild) {
        const rules = session.draft.disciplineSettings.conditionalRules;
        const selected = rules.find((rule) => rule.id === session.selectedDisciplineRuleId) || null;
        const lines = [
            `## Настройки WN Helper - ${guild.name}`,
            formatStatus(session),
            '',
            `Условные правила проверяются после пересчёта активных взысканий. Настроено: ${rules.length}/${MAX_CONDITIONAL_RULES}.`,
            ...rules.slice(0, 15).map((rule) => {
                const action = rule.action.type === 'update_roles'
                    ? `снять ролей: ${rule.action.removeRoleIds.length}; выдать ролей: ${rule.action.addRoleIds.length}`
                    : `установить ранг ${rule.action.rankNumber}`;
                return `- ранг >= ${rule.minRankNumber}, ${DISCIPLINE_STAGE_LABELS[rule.stage]} × ${rule.count} ` +
                    `-> ${action}${rule.clause ? `; пункт: ${rule.clause}` : ''}`;
            }),
            rules.length > 15 ? `- и ещё ${rules.length - 15}` : null,
        ];
        const components = [];
        if (rules.length) {
            components.push(new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(customId(session, 'discipline_rule_select'))
                    .setPlaceholder('Условное правило')
                    .addOptions(rules.slice(0, 25).map((rule, index) => ({
                        label: `Правило ${index + 1}: ${DISCIPLINE_STAGE_LABELS[rule.stage]} × ${rule.count}`.slice(0, 100),
                        value: rule.id,
                        default: rule.id === selected?.id,
                    })))
            ));
        }
        components.push(new ActionRowBuilder().addComponents(
            createButton(session, 'discipline_rule_add', 'Добавить', ButtonStyle.Success)
                .setDisabled(rules.length >= MAX_CONDITIONAL_RULES),
            createButton(session, 'discipline_rule_edit', 'Изменить', ButtonStyle.Primary).setDisabled(!selected),
            createButton(session, 'nav', 'Роли действия', ButtonStyle.Secondary, 'disciplineRuleRoles')
                .setDisabled(!selected || selected.action.type !== 'update_roles'),
            createButton(session, 'discipline_rule_delete', 'Удалить', ButtonStyle.Danger).setDisabled(!selected),
        ));
        components.push(createFooterRow(session, { backSection: 'discipline' }));
        return { content: lines.filter(Boolean).join('\n'), components };
    }

    function renderDisciplineRuleRoles(session, guild) {
        const rule = session.draft.disciplineSettings.conditionalRules
            .find((entry) => entry.id === session.selectedDisciplineRuleId) || null;
        if (!rule || rule.action.type !== 'update_roles') return renderDisciplineRules(session, guild);
        return {
            content: [
                `## Настройки WN Helper - ${guild.name}`,
                '/settings -> Взыскания -> Условные правила -> Роли действия',
                formatStatus(session),
                '',
                `Снимаемые роли: ${formatRoleList(rule.action.removeRoleIds)}`,
                `Выдаваемые роли: ${formatRoleList(rule.action.addRoleIds)}`,
                '',
                'Роли изменяются только после достижения настроенного количества действующих взысканий.',
            ].join('\n'),
            components: [
                new ActionRowBuilder().addComponents(
                    new RoleSelectMenuBuilder()
                        .setCustomId(customId(session, 'discipline_rule_roles', 'removeRoleIds'))
                        .setPlaceholder('Роли, которые нужно снять')
                        .setMinValues(0)
                        .setMaxValues(25)
                        .setDefaultRoles(rule.action.removeRoleIds.slice(0, 25))
                ),
                new ActionRowBuilder().addComponents(
                    new RoleSelectMenuBuilder()
                        .setCustomId(customId(session, 'discipline_rule_roles', 'addRoleIds'))
                        .setPlaceholder('Роли, которые нужно выдать')
                        .setMinValues(0)
                        .setMaxValues(25)
                        .setDefaultRoles(rule.action.addRoleIds.slice(0, 25))
                ),
                createFooterRow(session, { backSection: 'disciplineRules' }),
            ],
        };
    }

    function createDisciplineIntegerModal(session, field, value) {
        const labels = {
            maxIssueDelayDays: 'Максимальная давность, дней',
            recertificationDeadlineDays: 'Срок переаттестации, дней',
            massMaxTargets: 'Максимум сотрудников в пакете',
            massApprovalTimeoutMinutes: 'Срок подтверждения, минуты',
            threshold: 'Порог преобразования',
            autoExpireDays: 'Автоистечение, дней',
            deadlineDays: 'Срок отработки, дней',
        };
        return new ModalBuilder()
            .setCustomId(customId(session, 'discipline_integer_modal', field))
            .setTitle(labels[field] || 'Числовая настройка')
            .addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('value')
                    .setLabel(labels[field] || 'Числовое значение')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMaxLength(4)
                    .setValue(String(value ?? ''))
            ));
    }

    function createDisciplineMethodModal(session, method = null) {
        return new ModalBuilder()
            .setCustomId(customId(session, 'discipline_method_modal', method?.id || 'new'))
            .setTitle(method ? 'Переименовать способ' : 'Добавить способ')
            .addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('name')
                    .setLabel('Название способа отработки')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMaxLength(100)
                    .setValue(method?.name || '')
            ));
    }

    function createDisciplineRuleModal(session, rule = null) {
        const modal = new ModalBuilder()
            .setCustomId(customId(session, 'discipline_rule_modal', rule?.id || 'new'))
            .setTitle(rule ? 'Изменить условное правило' : 'Добавить условное правило');
        const fields = [
            ['minRankNumber', 'Минимальный ранг сотрудника', rule?.minRankNumber || 1, true, 4],
            ['stage', 'Этап: беседа / устный / письменный', DISCIPLINE_STAGE_LABELS[rule?.stage] || 'Письменный выговор', true, 24],
            ['count', 'Количество активных взысканий', rule?.count || 2, true, 4],
            [
                'action',
                'Действие: ранг:НОМЕР или роли',
                rule?.action?.type === 'update_roles'
                    ? DISCIPLINE_RULE_ACTION_LABELS.update_roles
                    : `${DISCIPLINE_RULE_ACTION_LABELS.set_rank}:${rule?.action?.rankNumber || 1}`,
                true,
                20,
            ],
            ['clause', 'Пункт или основание (необязательно)', rule?.clause || '', false, 200],
        ];
        for (const [id, label, value, required, maxLength] of fields) {
            modal.addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId(id)
                    .setLabel(label)
                    .setStyle(TextInputStyle.Short)
                    .setRequired(required)
                    .setMaxLength(maxLength)
                    .setValue(String(value))
            ));
        }
        return modal;
    }

    return {
        createDisciplineIntegerModal,
        createDisciplineMethodModal,
        createDisciplineRuleModal,
        renderDiscipline,
        renderDisciplineAppeals,
        renderDisciplinePolicy,
        renderDisciplineGeneral,
        renderDisciplineMethodDepartments,
        renderDisciplineMethodStages,
        renderDisciplineMethods,
        renderDisciplineRuleRoles,
        renderDisciplineRules,
        renderDisciplineStage,
        renderDisciplineStageRoles,
    };
}

module.exports = {
    GENERAL_DEFINITIONS,
    createDisciplineSettingsRenderer,
};
