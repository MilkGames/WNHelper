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
    ChannelType,
    ModalBuilder,
    RoleSelectMenuBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require('discord.js');
const {
    VACATION_ACCESS_GROUPS,
} = require('./schema');

const VACATION_OVERDUE_ACTION_LABELS = {
    notify: 'Уведомление',
    written: 'Письменный выговор',
    dismissal: 'Увольнение',
};

function createVacationSettingsRenderer({
    customId,
    createButton,
    createFooterRow,
    formatStatus,
    getRanks,
}) {
    function selectedType(session) {
        return (session.draft.vacationSettings?.types || [])
            .find((entry) => entry.id === session.selectedVacationTypeId) || null;
    }

    function selectedRoute(session) {
        return (session.draft.vacationSettings?.roleRoutes || [])
            .find((entry) => entry.id === session.selectedVacationRouteId) || null;
    }

    function selectedRule(session) {
        const type = selectedType(session);
        return (type?.overdueRules || [])
            .find((entry) => entry.id === session.selectedVacationOverdueRuleId) || null;
    }

    function roleList(roleIds) {
        return Array.isArray(roleIds) && roleIds.length
            ? roleIds.map((roleId) => `<@&${roleId}>`).join(' ')
            : 'не выбраны';
    }

    function renderVacations(session, guild) {
        const settings = session.draft.vacationSettings || {};
        const enabled = (settings.types || []).filter((type) => type.enabled).length;
        const content = [
            `## Настройки WN Helper - ${guild.name}`,
            formatStatus(session),
            '',
            `Канал заявок: ${settings.requestChannelId ? `<#${settings.requestChannelId}>` : 'не выбран'}`,
            `Типов отпусков: ${settings.types?.length || 0} (${enabled} включено)`,
            `Маршрутов по ролям: ${settings.roleRoutes?.length || 0}`,
            '',
            'Стандартная маршрутизация: сотрудник → руководство отдела; заместитель → глава; глава → верхнее руководство.',
            'Маршруты по ролям имеют приоритет. При превышении лимитов используются роли, настроенные у типа отпуска.',
        ].join('\n');
        return {
            content,
            components: [
                new ActionRowBuilder().addComponents(
                    createButton(session, 'nav', 'Общие настройки', ButtonStyle.Primary, 'vacationGeneral'),
                    createButton(session, 'nav', 'Маршруты по ролям', ButtonStyle.Primary, 'vacationRoutes'),
                    createButton(session, 'nav', 'Типы отпусков', ButtonStyle.Primary, 'vacationTypes'),
                    createButton(session, 'publication_start', 'Опубликовать панель', ButtonStyle.Success, 'vacation'),
                ),
                createFooterRow(session),
            ],
        };
    }

    function renderVacationGeneral(session, guild) {
        const settings = session.draft.vacationSettings || {};
        return {
            content: [
                `## Настройки WN Helper - ${guild.name}`,
                formatStatus(session),
                '',
                `Канал заявок: ${settings.requestChannelId ? `<#${settings.requestChannelId}>` : 'не выбран'}`,
                `Согласование сотрудников без отдела: ${roleList(settings.noDepartmentApproverRoleIds)}`,
                `Верхнее руководство: ${roleList(settings.upperLeadershipRoleIds)}`,
            ].join('\n'),
            components: [
                new ActionRowBuilder().addComponents(
                    new ChannelSelectMenuBuilder()
                        .setCustomId(customId(session, 'vacation_request_channel'))
                        .setPlaceholder('Канал заявок на отпуск')
                        .setMinValues(0)
                        .setMaxValues(1)
                        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                ),
                new ActionRowBuilder().addComponents(
                    new RoleSelectMenuBuilder()
                        .setCustomId(customId(session, 'vacation_no_department_roles'))
                        .setPlaceholder('Роли согласования без отдела')
                        .setMinValues(0)
                        .setMaxValues(10)
                ),
                new ActionRowBuilder().addComponents(
                    new RoleSelectMenuBuilder()
                        .setCustomId(customId(session, 'vacation_upper_roles'))
                        .setPlaceholder('Роли верхнего руководства')
                        .setMinValues(0)
                        .setMaxValues(10)
                ),
                createFooterRow(session, { backSection: 'vacations' }),
            ],
        };
    }

    function renderVacationRoutes(session, guild) {
        const routes = session.draft.vacationSettings?.roleRoutes || [];
        const route = selectedRoute(session);
        const components = [];
        if (routes.length) {
            components.push(new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(customId(session, 'vacation_route_select'))
                    .setPlaceholder('Выберите маршрут')
                    .setMinValues(1)
                    .setMaxValues(1)
                    .addOptions(routes.slice(0, 25).map((entry) => ({
                        label: entry.name.slice(0, 100),
                        value: entry.id,
                        description: `${entry.applicantRoleIds.length} ролей заявителя → ${entry.approverRoleIds.length} ролей согласования`.slice(0, 100),
                        default: route?.id === entry.id,
                    })))
            ));
        }
        components.push(new ActionRowBuilder().addComponents(
            createButton(session, 'vacation_route_add', 'Добавить', ButtonStyle.Success),
            createButton(session, 'vacation_route_open', 'Настроить', ButtonStyle.Primary).setDisabled(!route),
            createButton(session, 'vacation_route_delete', 'Удалить', ButtonStyle.Danger).setDisabled(!route),
        ));
        components.push(createFooterRow(session, { backSection: 'vacations' }));
        return {
            content: [
                `## Настройки WN Helper - ${guild.name}`,
                formatStatus(session),
                '',
                'Первый подходящий маршрут заменяет стандартный маршрут отдела.',
                ...routes.map((entry, index) => `${index + 1}. ${entry.name}: ${roleList(entry.applicantRoleIds)} → ${roleList(entry.approverRoleIds)}`),
            ].join('\n'),
            components,
        };
    }

    function renderVacationRouteDetails(session, guild) {
        const route = selectedRoute(session);
        if (!route) return renderVacationRoutes(session, guild);
        return {
            content: [
                `## Настройки WN Helper - ${guild.name}`,
                formatStatus(session),
                '',
                `Маршрут: **${route.name}**`,
                `Роли заявителя: ${roleList(route.applicantRoleIds)}`,
                `Роли согласования: ${roleList(route.approverRoleIds)}`,
            ].join('\n'),
            components: [
                new ActionRowBuilder().addComponents(
                    new RoleSelectMenuBuilder()
                        .setCustomId(customId(session, 'vacation_route_applicant_roles', route.id))
                        .setPlaceholder('Роли заявителя')
                        .setMinValues(1)
                        .setMaxValues(10)
                ),
                new ActionRowBuilder().addComponents(
                    new RoleSelectMenuBuilder()
                        .setCustomId(customId(session, 'vacation_route_approver_roles', route.id))
                        .setPlaceholder('Роли согласования')
                        .setMinValues(1)
                        .setMaxValues(10)
                ),
                new ActionRowBuilder().addComponents(
                    createButton(session, 'vacation_route_edit', 'Изменить название', ButtonStyle.Primary, route.id),
                    createButton(session, 'vacation_route_up', 'Выше', ButtonStyle.Secondary, route.id)
                        .setDisabled((session.draft.vacationSettings?.roleRoutes || []).findIndex((entry) => entry.id === route.id) <= 0),
                    createButton(session, 'vacation_route_down', 'Ниже', ButtonStyle.Secondary, route.id)
                        .setDisabled((session.draft.vacationSettings?.roleRoutes || []).findIndex((entry) => entry.id === route.id) >= (session.draft.vacationSettings?.roleRoutes || []).length - 1),
                ),
                createFooterRow(session, { backSection: 'vacationRoutes' }),
            ],
        };
    }

    function renderVacationTypes(session, guild) {
        const types = session.draft.vacationSettings?.types || [];
        const type = selectedType(session);
        const components = [];
        if (types.length) {
            components.push(new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(customId(session, 'vacation_type_select'))
                    .setPlaceholder('Выберите тип отпуска')
                    .setMinValues(1)
                    .setMaxValues(1)
                    .addOptions(types.slice(0, 25).map((entry) => ({
                        label: `${entry.enabled ? '✅' : '❌'} ${entry.name}`.slice(0, 100),
                        value: entry.id,
                        description: `${entry.minDurationDays}-${entry.maxDurationDays || '∞'} дн.; месяц ${entry.monthlyLimitDays || '∞'}`.slice(0, 100),
                        default: type?.id === entry.id,
                    })))
            ));
        }
        components.push(new ActionRowBuilder().addComponents(
            createButton(session, 'vacation_type_add', 'Добавить', ButtonStyle.Success),
            createButton(session, 'vacation_type_open', 'Настроить', ButtonStyle.Primary).setDisabled(!type),
            createButton(session, 'vacation_type_toggle', type?.enabled ? 'Выключить' : 'Включить', ButtonStyle.Secondary, type?.id || '').setDisabled(!type),
            createButton(session, 'vacation_type_delete', 'Удалить', ButtonStyle.Danger, type?.id || '').setDisabled(!type),
        ));
        components.push(createFooterRow(session, { backSection: 'vacations' }));
        return {
            content: [
                `## Настройки WN Helper - ${guild.name}`,
                formatStatus(session),
                '',
                ...types.map((entry, index) => `${index + 1}. ${entry.enabled ? '✅' : '❌'} ${entry.name}`),
                ...(types.length ? [] : ['Типы отпусков ещё не добавлены.']),
            ].join('\n'),
            components,
        };
    }

    function renderVacationTypeDetails(session, guild) {
        const type = selectedType(session);
        if (!type) return renderVacationTypes(session, guild);
        const availability = type.availability || {};
        const content = [
            `## Настройки WN Helper - ${guild.name}`,
            formatStatus(session),
            '',
            `Тип: **${type.name}** (${type.enabled ? 'включён' : 'выключен'})`,
            `Продолжительность: ${type.minDurationDays}-${type.maxDurationDays || 'без максимума'} дн.`,
            `Месячный лимит: ${type.monthlyLimitDays || 'без лимита'} дн.`,
            `Доступность: ранг ${availability.minRankNumber ? `от ${availability.minRankNumber}` : 'не ограничен'}; без отдела ${availability.allowNoDepartment ? 'да' : 'нет'}; роли ${roleList(availability.roleIds)}`,
            `Превышение: ${type.exceedMode === 'reroute' ? `перенаправить ${roleList(type.exceedApproverRoleIds)}` : 'запретить'}`,
            `Правил просрочки: ${type.overdueRules?.length || 0}`,
        ].join('\n');
        return {
            content,
            components: [
                new ActionRowBuilder().addComponents(
                    createButton(session, 'vacation_type_basic_edit', 'Основное', ButtonStyle.Primary, type.id),
                    createButton(session, 'nav', 'Доступность', ButtonStyle.Primary, 'vacationTypeAvailability'),
                    createButton(session, 'nav', 'Лимиты', ButtonStyle.Primary, 'vacationTypeLimits'),
                ),
                new ActionRowBuilder().addComponents(
                    createButton(session, 'nav', 'Роли и доступ', ButtonStyle.Primary, 'vacationTypeActions'),
                    createButton(session, 'nav', 'Поведение', ButtonStyle.Primary, 'vacationTypeBehavior'),
                    createButton(session, 'nav', 'Просрочка', ButtonStyle.Primary, 'vacationTypeOverdue'),
                ),
                createFooterRow(session, { backSection: 'vacationTypes' }),
            ],
        };
    }

    function renderVacationTypeAvailability(session, guild) {
        const type = selectedType(session);
        if (!type) return renderVacationTypes(session, guild);
        const ranks = getRanks(session.draft);
        const options = [
            { label: 'Без ограничения по рангу', value: 'none', default: !type.availability.minRankNumber },
            ...ranks.slice(0, 24).map((rank) => ({
                label: `${rank.number} - ${rank.name}`.slice(0, 100),
                value: String(rank.number),
                default: type.availability.minRankNumber === rank.number,
            })),
        ];
        return {
            content: [
                `## Настройки WN Helper - ${guild.name}`,
                formatStatus(session),
                '',
                `Тип: **${type.name}**`,
                'Условия работают как ИЛИ: минимальный ранг, отсутствие отдела либо одна из выбранных ролей.',
                `Без отдела: ${type.availability.allowNoDepartment ? 'разрешено' : 'не разрешено'}`,
                `Роли-исключения: ${roleList(type.availability.roleIds)}`,
            ].join('\n'),
            components: [
                new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(customId(session, 'vacation_type_min_rank', type.id))
                        .setPlaceholder('Минимальный ранг')
                        .setMinValues(1)
                        .setMaxValues(1)
                        .addOptions(options)
                ),
                new ActionRowBuilder().addComponents(
                    new RoleSelectMenuBuilder()
                        .setCustomId(customId(session, 'vacation_type_availability_roles', type.id))
                        .setPlaceholder('Роли-исключения доступности')
                        .setMinValues(0)
                        .setMaxValues(10)
                ),
                new ActionRowBuilder().addComponents(
                    createButton(
                        session,
                        'vacation_type_no_department_toggle',
                        `${type.availability.allowNoDepartment ? '✅' : '❌'} Без отдела`,
                        type.availability.allowNoDepartment ? ButtonStyle.Success : ButtonStyle.Secondary,
                        type.id
                    )
                ),
                createFooterRow(session, { backSection: 'vacationTypeDetails' }),
            ],
        };
    }

    function renderVacationTypeLimits(session, guild) {
        const type = selectedType(session);
        if (!type) return renderVacationTypes(session, guild);
        return {
            content: [
                `## Настройки WN Helper - ${guild.name}`,
                formatStatus(session),
                '',
                `Тип: **${type.name}**`,
                `При превышении: ${type.exceedMode === 'reroute' ? 'перенаправлять на отдельные роли' : 'блокировать заявку'}`,
                `Роли при превышении: ${roleList(type.exceedApproverRoleIds)}`,
            ].join('\n'),
            components: [
                new ActionRowBuilder().addComponents(
                    createButton(
                        session,
                        'vacation_type_exceed_toggle',
                        type.exceedMode === 'reroute' ? 'Перенаправлять' : 'Блокировать',
                        type.exceedMode === 'reroute' ? ButtonStyle.Success : ButtonStyle.Secondary,
                        type.id
                    )
                ),
                new ActionRowBuilder().addComponents(
                    new RoleSelectMenuBuilder()
                        .setCustomId(customId(session, 'vacation_type_exceed_roles', type.id))
                        .setPlaceholder('Роли согласования превышений')
                        .setMinValues(type.exceedMode === 'reroute' ? 1 : 0)
                        .setMaxValues(10)
                        .setDisabled(type.exceedMode !== 'reroute')
                ),
                createFooterRow(session, { backSection: 'vacationTypeDetails' }),
            ],
        };
    }

    function renderVacationTypeActions(session, guild) {
        const type = selectedType(session);
        if (!type) return renderVacationTypes(session, guild);
        return {
            content: [
                `## Настройки WN Helper - ${guild.name}`,
                formatStatus(session),
                '',
                `Тип: **${type.name}**`,
                `Роль отпуска: ${type.vacationRoleId ? `<@&${type.vacationRoleId}>` : 'не выбрана'}`,
                `Роли, снимаемые при старте: ${roleList(type.removeRoleIdsOnStart)}`,
                `Заблокированные возможности: ${type.blockedAccessGroups.length ? type.blockedAccessGroups.join(', ') : 'не выбраны'}`,
                `Роли обхода блокировки: ${roleList(type.accessBypassRoleIds)}`,
            ].join('\n'),
            components: [
                new ActionRowBuilder().addComponents(
                    new RoleSelectMenuBuilder()
                        .setCustomId(customId(session, 'vacation_type_vacation_role', type.id))
                        .setPlaceholder('Роль активного отпуска')
                        .setMinValues(0)
                        .setMaxValues(1)
                ),
                new ActionRowBuilder().addComponents(
                    new RoleSelectMenuBuilder()
                        .setCustomId(customId(session, 'vacation_type_remove_roles', type.id))
                        .setPlaceholder('Роли, снимаемые при старте')
                        .setMinValues(0)
                        .setMaxValues(10)
                ),
                new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(customId(session, 'vacation_type_blocked_groups', type.id))
                        .setPlaceholder('Блокируемые возможности бота')
                        .setMinValues(0)
                        .setMaxValues(VACATION_ACCESS_GROUPS.length)
                        .addOptions(VACATION_ACCESS_GROUPS.map((entry) => ({
                            label: entry.label,
                            value: entry.key,
                            default: type.blockedAccessGroups.includes(entry.key),
                        })))
                ),
                new ActionRowBuilder().addComponents(
                    new RoleSelectMenuBuilder()
                        .setCustomId(customId(session, 'vacation_type_bypass_roles', type.id))
                        .setPlaceholder('Роли обхода блокировок')
                        .setMinValues(0)
                        .setMaxValues(10)
                ),
                createFooterRow(session, { backSection: 'vacationTypeDetails' }),
            ],
        };
    }

    function renderVacationTypeBehavior(session, guild) {
        const type = selectedType(session);
        if (!type) return renderVacationTypes(session, guild);
        const toggle = (action, label, enabled) => createButton(
            session,
            action,
            `${enabled ? '✅' : '❌'} ${label}`,
            enabled ? ButtonStyle.Success : ButtonStyle.Secondary,
            type.id
        );
        return {
            content: [
                `## Настройки WN Helper - ${guild.name}`,
                formatStatus(session),
                '',
                `Тип: **${type.name}**`,
                'Снятые роли и освобождённые смены после возвращения автоматически не восстанавливаются. Доступ к функциям возвращается автоматически.',
                'При включённом освобождении принятые сотрудником лекции и пересдачи возвращаются в очередь в момент начала отпуска.',
                `Условные роли: ${type.conditionalRemoveMinDurationDays > 0 ? `снимать от ${type.conditionalRemoveMinDurationDays} дн. - ${roleList(type.conditionalRemoveRoleIdsOnStart)}` : 'отключено'}`, 
            ].join('\n'),
            components: [
                new ActionRowBuilder().addComponents(
                    toggle('vacation_type_release_shifts', 'Освобождать смены', type.releaseShiftsOnStart),
                    toggle('vacation_type_release_exams', 'Освобождать лекции/пересдачи', type.releaseExaminationAssignmentsOnStart),
                ),
                new ActionRowBuilder().addComponents(
                    toggle('vacation_type_close_settings', 'Закрывать /settings', type.closeSettingsSessionOnStart),
                    toggle('vacation_type_pause_discipline', 'Пауза сроков взысканий', type.pauseDisciplineDeadlines),
                ),
                new ActionRowBuilder().addComponents(
                    new RoleSelectMenuBuilder()
                        .setCustomId(customId(session, 'vacation_type_conditional_remove_roles', type.id))
                        .setPlaceholder('Роли, снимаемые только при достижении порога')
                        .setMinValues(0)
                        .setMaxValues(10)
                ),
                createFooterRow(session, { backSection: 'vacationTypeDetails' }),
            ],
        };
    }

    function renderVacationTypeOverdue(session, guild) {
        const type = selectedType(session);
        if (!type) return renderVacationTypes(session, guild);
        const rules = type.overdueRules || [];
        const rule = selectedRule(session);
        const actionLabel = { notify: 'Уведомление', written: 'Письменный выговор', dismissal: 'Увольнение' };
        const components = [];
        if (rules.length) {
            components.push(new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(customId(session, 'vacation_overdue_select'))
                    .setPlaceholder('Выберите правило просрочки')
                    .setMinValues(1)
                    .setMaxValues(1)
                    .addOptions(rules.slice(0, 25).map((entry) => ({
                        label: `${entry.afterDays} дн. ${entry.time} - ${actionLabel[entry.action] || 'Неизвестное действие'}`.slice(0, 100),
                        value: entry.id,
                        default: rule?.id === entry.id,
                    })))
            ));
        }
        if (rule?.action === 'notify') {
            components.push(new ActionRowBuilder().addComponents(
                new RoleSelectMenuBuilder()
                    .setCustomId(customId(session, 'vacation_overdue_notify_roles', `${type.id}:${rule.id}`))
                    .setPlaceholder('Роли уведомления')
                    .setMinValues(0)
                    .setMaxValues(10)
            ));
        }
        components.push(new ActionRowBuilder().addComponents(
            createButton(session, 'vacation_overdue_add', 'Добавить', ButtonStyle.Success, type.id),
            createButton(session, 'vacation_overdue_edit', 'Изменить', ButtonStyle.Primary, rule?.id || '').setDisabled(!rule),
            createButton(session, 'vacation_overdue_delete', 'Удалить', ButtonStyle.Danger, rule?.id || '').setDisabled(!rule),
        ));
        components.push(createFooterRow(session, { backSection: 'vacationTypeDetails' }));
        return {
            content: [
                `## Настройки WN Helper - ${guild.name}`,
                formatStatus(session),
                '',
                `Тип: **${type.name}**`,
                ...rules.map((entry, index) => `${index + 1}. Через ${entry.afterDays} дн. в ${entry.time}: ${actionLabel[entry.action] || 'Неизвестное действие'}${entry.reason ? ` - ${entry.reason}` : ''}`),
                ...(rules.length ? [] : ['Правила просрочки не настроены.']),
            ].join('\n'),
            components,
        };
    }

    function createVacationRouteModal(session, route = null) {
        const input = new TextInputBuilder()
            .setCustomId('name')
            .setLabel('Название маршрута')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(100);
        if (route?.name) input.setValue(route.name);
        return new ModalBuilder()
            .setCustomId(customId(session, 'vacation_route_modal', route?.id || 'new'))
            .setTitle(route ? 'Изменение маршрута' : 'Новый маршрут')
            .addComponents(new ActionRowBuilder().addComponents(input));
    }

    function createVacationTypeModal(session, type = null) {
        const modal = new ModalBuilder()
            .setCustomId(customId(session, 'vacation_type_modal', type?.id || 'new'))
            .setTitle(type ? 'Изменение типа отпуска' : 'Новый тип отпуска');
        const fields = [
            ['name', 'Название', type?.name || '', 100],
            ['minDurationDays', 'Минимум дней', String(type?.minDurationDays ?? 1), 3],
            ['maxDurationDays', 'Максимум дней (0 - без лимита)', String(type?.maxDurationDays ?? 7), 3],
            ['monthlyLimitDays', 'Дней в месяц (0 - без лимита)', String(type?.monthlyLimitDays ?? 7), 3],
            ['conditionalRemoveMinDurationDays', 'Снимать условные роли от N дней (0 - выкл.)', String(type?.conditionalRemoveMinDurationDays ?? 0), 3],
        ];
        for (const [key, label, value, maxLength] of fields) {
            modal.addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId(key)
                    .setLabel(label)
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMaxLength(maxLength)
                    .setValue(value)
            ));
        }
        return modal;
    }

    function createVacationOverdueModal(session, rule = null) {
        const modal = new ModalBuilder()
            .setCustomId(customId(session, 'vacation_overdue_modal', rule?.id || 'new'))
            .setTitle(rule ? 'Изменение просрочки' : 'Новое правило просрочки');
        const fields = [
            ['afterDays', 'Через сколько дней', String(rule?.afterDays ?? 1), TextInputStyle.Short, 3],
            ['time', 'Время по Москве (HH:MM)', rule?.time || '23:59', TextInputStyle.Short, 5],
            ['action', 'Действие: уведомление / выговор / увольнение', VACATION_OVERDUE_ACTION_LABELS[rule?.action] || 'Уведомление', TextInputStyle.Short, 30],
            ['reason', 'Причина/текст (необязательно)', rule?.reason || '', TextInputStyle.Paragraph, 500],
        ];
        for (const [key, label, value, style, maxLength] of fields) {
            const input = new TextInputBuilder()
                .setCustomId(key)
                .setLabel(label)
                .setStyle(style)
                .setRequired(key !== 'reason')
                .setMaxLength(maxLength);
            if (value) input.setValue(value);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
        }
        return modal;
    }

    return {
        createVacationOverdueModal,
        createVacationRouteModal,
        createVacationTypeModal,
        renderVacationGeneral,
        renderVacationRouteDetails,
        renderVacationRoutes,
        renderVacationTypeActions,
        renderVacationTypeAvailability,
        renderVacationTypeBehavior,
        renderVacationTypeDetails,
        renderVacationTypeLimits,
        renderVacationTypeOverdue,
        renderVacationTypes,
        renderVacations,
    };
}

module.exports = { createVacationSettingsRenderer };
