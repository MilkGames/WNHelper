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

const VACATION_OVERDUE_ACTION_INPUTS = new Map([
    ['уведомление', 'notify'],
    ['выговор', 'written'],
    ['письменный выговор', 'written'],
    ['увольнение', 'dismissal'],
    ['notify', 'notify'],
    ['written', 'written'],
    ['dismissal', 'dismissal'],
]);
const {
    VACATION_ACCESS_GROUP_KEYS,
    VACATION_OVERDUE_ACTIONS,
} = require('./schema');

function createVacationSettingsHandlers({
    acknowledgePanelInteraction,
    configSessionService,
    createVacationOverdueModal,
    createVacationRouteModal,
    createVacationTypeModal,
    runDiscordRequest,
    updatePanel,
}) {
    function unique(values) {
        return [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))];
    }

    function newId(prefix) {
        return `${prefix}-${crypto.randomBytes(5).toString('hex')}`;
    }

    function getType(session, id = session.selectedVacationTypeId) {
        return (session.draft.vacationSettings?.types || []).find((entry) => entry.id === id) || null;
    }

    function getRoute(session, id = session.selectedVacationRouteId) {
        return (session.draft.vacationSettings?.roleRoutes || []).find((entry) => entry.id === id) || null;
    }

    function getRule(session, id = session.selectedVacationOverdueRuleId) {
        const type = getType(session);
        return (type?.overdueRules || []).find((entry) => entry.id === id) || null;
    }

    async function render(client, interaction, session, status = null) {
        if (status !== null) configSessionService.markChanged(session, status);
        await updatePanel(client, interaction, session);
    }

    async function handleModal(client, interaction, session, parsed) {
        if (parsed.action === 'vacation_route_modal') {
            await acknowledgePanelInteraction(interaction);
            const name = interaction.fields.getTextInputValue('name').trim();
            if (!name) {
                configSessionService.setErrors(session, ['Укажите название маршрута.']);
                configSessionService.setSection(session, 'vacationRoutes');
                await updatePanel(client, interaction, session);
                return true;
            }
            const existing = parsed.value === 'new' ? null : getRoute(session, parsed.value);
            if (existing) existing.name = name;
            else {
                const route = { id: newId('vacroute'), name, applicantRoleIds: [], approverRoleIds: [] };
                session.draft.vacationSettings.roleRoutes.push(route);
                session.selectedVacationRouteId = route.id;
            }
            configSessionService.setSection(session, 'vacationRouteDetails');
            await render(client, interaction, session, `Маршрут "${name}" сохранён в черновике.`);
            return true;
        }

        if (parsed.action === 'vacation_type_modal') {
            await acknowledgePanelInteraction(interaction);
            const name = interaction.fields.getTextInputValue('name').trim();
            const minDurationDays = Number(interaction.fields.getTextInputValue('minDurationDays'));
            const maxDurationDays = Number(interaction.fields.getTextInputValue('maxDurationDays'));
            const monthlyLimitDays = Number(interaction.fields.getTextInputValue('monthlyLimitDays'));
            const conditionalRemoveMinDurationDays = Number(interaction.fields.getTextInputValue('conditionalRemoveMinDurationDays'));
            const errors = [];
            if (!name) errors.push('Укажите название типа отпуска.');
            if (!Number.isSafeInteger(minDurationDays) || minDurationDays < 1 || minDurationDays > 366) errors.push('Минимум дней должен быть от 1 до 366.');
            if (!Number.isSafeInteger(maxDurationDays) || maxDurationDays < 0 || maxDurationDays > 366) errors.push('Максимум дней должен быть от 0 до 366.');
            if (maxDurationDays > 0 && maxDurationDays < minDurationDays) errors.push('Максимум не может быть меньше минимума.');
            if (!Number.isSafeInteger(monthlyLimitDays) || monthlyLimitDays < 0 || monthlyLimitDays > 366) errors.push('Месячный лимит должен быть от 0 до 366.');
            if (!Number.isSafeInteger(conditionalRemoveMinDurationDays) || conditionalRemoveMinDurationDays < 0 || conditionalRemoveMinDurationDays > 366) errors.push('Порог условного снятия ролей должен быть от 0 до 366.');
            if (errors.length) {
                configSessionService.setErrors(session, errors);
                configSessionService.setSection(session, 'vacationTypes');
                await updatePanel(client, interaction, session);
                return true;
            }
            let type = parsed.value === 'new' ? null : getType(session, parsed.value);
            if (!type) {
                type = {
                    id: newId('vactype'),
                    name,
                    enabled: true,
                    availability: { minRankNumber: null, allowNoDepartment: false, roleIds: [] },
                    minDurationDays,
                    maxDurationDays,
                    monthlyLimitDays,
                    exceedMode: 'block',
                    exceedApproverRoleIds: [],
                    vacationRoleId: null,
                    removeRoleIdsOnStart: [],
                    conditionalRemoveMinDurationDays,
                    conditionalRemoveRoleIdsOnStart: [],
                    releaseShiftsOnStart: true,
                    releaseExaminationAssignmentsOnStart: true,
                    closeSettingsSessionOnStart: false,
                    pauseDisciplineDeadlines: false,
                    blockedAccessGroups: ['staffAudit', 'discipline', 'examination', 'shifts', 'giveRoles'],
                    accessBypassRoleIds: [],
                    overdueRules: [],
                };
                session.draft.vacationSettings.types.push(type);
                session.selectedVacationTypeId = type.id;
            } else {
                Object.assign(type, { name, minDurationDays, maxDurationDays, monthlyLimitDays, conditionalRemoveMinDurationDays });
            }
            configSessionService.setSection(session, 'vacationTypeDetails');
            await render(client, interaction, session, `Тип отпуска "${name}" сохранён в черновике.`);
            return true;
        }

        if (parsed.action === 'vacation_overdue_modal') {
            await acknowledgePanelInteraction(interaction);
            const type = getType(session);
            if (!type) {
                configSessionService.setErrors(session, ['Тип отпуска больше не существует.']);
                configSessionService.setSection(session, 'vacationTypes');
                await updatePanel(client, interaction, session);
                return true;
            }
            const afterDays = Number(interaction.fields.getTextInputValue('afterDays'));
            const time = interaction.fields.getTextInputValue('time').trim();
            const actionInput = interaction.fields.getTextInputValue('action').trim().toLowerCase();
            const action = VACATION_OVERDUE_ACTION_INPUTS.get(actionInput) || null;
            const reason = interaction.fields.getTextInputValue('reason').trim();
            const errors = [];
            if (!Number.isSafeInteger(afterDays) || afterDays < 1 || afterDays > 365) errors.push('Количество дней должно быть от 1 до 365.');
            if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) errors.push('Время должно быть в формате HH:MM.');
            if (!VACATION_OVERDUE_ACTIONS.has(action)) errors.push('Укажите действие: "уведомление", "выговор" или "увольнение".');
            if (errors.length) {
                configSessionService.setErrors(session, errors);
                configSessionService.setSection(session, 'vacationTypeOverdue');
                await updatePanel(client, interaction, session);
                return true;
            }
            let rule = parsed.value === 'new' ? null : getRule(session, parsed.value);
            if (!rule) {
                rule = { id: newId('vacoverdue'), afterDays, time, action, reason, notifyRoleIds: [] };
                type.overdueRules.push(rule);
                session.selectedVacationOverdueRuleId = rule.id;
            } else {
                Object.assign(rule, { afterDays, time, action, reason });
                if (action !== 'notify') rule.notifyRoleIds = [];
            }
            type.overdueRules.sort((left, right) => left.afterDays - right.afterDays || left.time.localeCompare(right.time));
            configSessionService.setSection(session, 'vacationTypeOverdue');
            await render(client, interaction, session, 'Правило просрочки сохранено в черновике.');
            return true;
        }
        return false;
    }

    async function handle(client, interaction, session, parsed) {
        if (!String(parsed.action || '').startsWith('vacation_')) return false;
        if (interaction.isModalSubmit()) return handleModal(client, interaction, session, parsed);

        if (parsed.action === 'vacation_route_add') {
            await runDiscordRequest(() => interaction.showModal(createVacationRouteModal(session)), { attempts: 1 });
            return true;
        }
        if (parsed.action === 'vacation_route_edit') {
            const route = getRoute(session, parsed.value);
            if (!route) return false;
            await runDiscordRequest(() => interaction.showModal(createVacationRouteModal(session, route)), { attempts: 1 });
            return true;
        }
        if (parsed.action === 'vacation_type_add') {
            await runDiscordRequest(() => interaction.showModal(createVacationTypeModal(session)), { attempts: 1 });
            return true;
        }
        if (parsed.action === 'vacation_type_basic_edit') {
            const type = getType(session, parsed.value);
            if (!type) return false;
            await runDiscordRequest(() => interaction.showModal(createVacationTypeModal(session, type)), { attempts: 1 });
            return true;
        }
        if (parsed.action === 'vacation_overdue_add') {
            await runDiscordRequest(() => interaction.showModal(createVacationOverdueModal(session)), { attempts: 1 });
            return true;
        }
        if (parsed.action === 'vacation_overdue_edit') {
            const rule = getRule(session, parsed.value);
            if (!rule) return false;
            await runDiscordRequest(() => interaction.showModal(createVacationOverdueModal(session, rule)), { attempts: 1 });
            return true;
        }

        await acknowledgePanelInteraction(interaction);
        const settings = session.draft.vacationSettings;

        if (parsed.action === 'vacation_request_channel' && interaction.isChannelSelectMenu()) {
            settings.requestChannelId = interaction.values[0] || null;
            await render(client, interaction, session, 'Канал заявок изменён.');
            return true;
        }
        if (parsed.action === 'vacation_no_department_roles' && interaction.isRoleSelectMenu()) {
            settings.noDepartmentApproverRoleIds = unique(interaction.values);
            await render(client, interaction, session, 'Роли согласования без отдела изменены.');
            return true;
        }
        if (parsed.action === 'vacation_upper_roles' && interaction.isRoleSelectMenu()) {
            settings.upperLeadershipRoleIds = unique(interaction.values);
            await render(client, interaction, session, 'Роли верхнего руководства изменены.');
            return true;
        }
        if (parsed.action === 'vacation_route_select' && interaction.isStringSelectMenu()) {
            session.selectedVacationRouteId = interaction.values[0] || null;
            configSessionService.setStatus(session, null);
            await updatePanel(client, interaction, session);
            return true;
        }
        if (parsed.action === 'vacation_route_open') {
            configSessionService.setSection(session, 'vacationRouteDetails');
            await updatePanel(client, interaction, session);
            return true;
        }
        if (parsed.action === 'vacation_route_delete') {
            const route = getRoute(session);
            if (route) settings.roleRoutes = settings.roleRoutes.filter((entry) => entry.id !== route.id);
            session.selectedVacationRouteId = null;
            await render(client, interaction, session, route ? `Маршрут "${route.name}" удалён из черновика.` : null);
            return true;
        }
        if (parsed.action === 'vacation_route_up' || parsed.action === 'vacation_route_down') {
            const route = getRoute(session, parsed.value);
            const index = route ? settings.roleRoutes.findIndex((entry) => entry.id === route.id) : -1;
            const nextIndex = parsed.action === 'vacation_route_up' ? index - 1 : index + 1;
            if (index >= 0 && nextIndex >= 0 && nextIndex < settings.roleRoutes.length) {
                [settings.roleRoutes[index], settings.roleRoutes[nextIndex]] = [
                    settings.roleRoutes[nextIndex],
                    settings.roleRoutes[index],
                ];
                await render(client, interaction, session, `Приоритет маршрута "${route.name}" изменён.`);
            } else {
                await updatePanel(client, interaction, session);
            }
            return true;
        }
        if (parsed.action === 'vacation_route_applicant_roles' && interaction.isRoleSelectMenu()) {
            const route = getRoute(session, parsed.value);
            if (route) route.applicantRoleIds = unique(interaction.values);
            await render(client, interaction, session, 'Роли заявителя изменены.');
            return true;
        }
        if (parsed.action === 'vacation_route_approver_roles' && interaction.isRoleSelectMenu()) {
            const route = getRoute(session, parsed.value);
            if (route) route.approverRoleIds = unique(interaction.values);
            await render(client, interaction, session, 'Роли согласования изменены.');
            return true;
        }
        if (parsed.action === 'vacation_type_select' && interaction.isStringSelectMenu()) {
            session.selectedVacationTypeId = interaction.values[0] || null;
            session.selectedVacationOverdueRuleId = null;
            configSessionService.setStatus(session, null);
            await updatePanel(client, interaction, session);
            return true;
        }
        if (parsed.action === 'vacation_type_open') {
            configSessionService.setSection(session, 'vacationTypeDetails');
            await updatePanel(client, interaction, session);
            return true;
        }
        if (parsed.action === 'vacation_type_toggle') {
            const type = getType(session, parsed.value);
            if (type) type.enabled = !type.enabled;
            await render(client, interaction, session, type ? `Тип "${type.name}" ${type.enabled ? 'включён' : 'выключен'}.` : null);
            return true;
        }
        if (parsed.action === 'vacation_type_delete') {
            const type = getType(session, parsed.value);
            if (type) settings.types = settings.types.filter((entry) => entry.id !== type.id);
            session.selectedVacationTypeId = null;
            session.selectedVacationOverdueRuleId = null;
            configSessionService.setSection(session, 'vacationTypes');
            await render(client, interaction, session, type ? `Тип "${type.name}" удалён из черновика.` : null);
            return true;
        }
        if (parsed.action === 'vacation_type_min_rank' && interaction.isStringSelectMenu()) {
            const type = getType(session, parsed.value);
            if (type) type.availability.minRankNumber = interaction.values[0] === 'none' ? null : Number(interaction.values[0]);
            await render(client, interaction, session, 'Минимальный ранг изменён.');
            return true;
        }
        if (parsed.action === 'vacation_type_availability_roles' && interaction.isRoleSelectMenu()) {
            const type = getType(session, parsed.value);
            if (type) type.availability.roleIds = unique(interaction.values);
            await render(client, interaction, session, 'Роли доступности изменены.');
            return true;
        }
        if (parsed.action === 'vacation_type_no_department_toggle') {
            const type = getType(session, parsed.value);
            if (type) type.availability.allowNoDepartment = !type.availability.allowNoDepartment;
            await render(client, interaction, session, 'Доступность для сотрудников без отдела изменена.');
            return true;
        }
        if (parsed.action === 'vacation_type_exceed_toggle') {
            const type = getType(session, parsed.value);
            if (type) {
                type.exceedMode = type.exceedMode === 'reroute' ? 'block' : 'reroute';
                if (type.exceedMode === 'block') type.exceedApproverRoleIds = [];
            }
            await render(client, interaction, session, 'Режим превышения лимитов изменён.');
            return true;
        }
        if (parsed.action === 'vacation_type_exceed_roles' && interaction.isRoleSelectMenu()) {
            const type = getType(session, parsed.value);
            if (type) type.exceedApproverRoleIds = unique(interaction.values);
            await render(client, interaction, session, 'Роли согласования превышений изменены.');
            return true;
        }
        if (parsed.action === 'vacation_type_vacation_role' && interaction.isRoleSelectMenu()) {
            const type = getType(session, parsed.value);
            if (type) type.vacationRoleId = interaction.values[0] || null;
            await render(client, interaction, session, 'Роль активного отпуска изменена.');
            return true;
        }
        if (parsed.action === 'vacation_type_remove_roles' && interaction.isRoleSelectMenu()) {
            const type = getType(session, parsed.value);
            if (type) type.removeRoleIdsOnStart = unique(interaction.values);
            await render(client, interaction, session, 'Снимаемые роли изменены.');
            return true;
        }
        if (parsed.action === 'vacation_type_conditional_remove_roles' && interaction.isRoleSelectMenu()) {
            const type = getType(session, parsed.value);
            if (type) type.conditionalRemoveRoleIdsOnStart = unique(interaction.values);
            await render(client, interaction, session, 'Условно снимаемые роли изменены.');
            return true;
        }
        if (parsed.action === 'vacation_type_blocked_groups' && interaction.isStringSelectMenu()) {
            const type = getType(session, parsed.value);
            if (type) type.blockedAccessGroups = unique(interaction.values).filter((key) => VACATION_ACCESS_GROUP_KEYS.has(key));
            await render(client, interaction, session, 'Блокируемые возможности изменены.');
            return true;
        }
        if (parsed.action === 'vacation_type_bypass_roles' && interaction.isRoleSelectMenu()) {
            const type = getType(session, parsed.value);
            if (type) type.accessBypassRoleIds = unique(interaction.values);
            await render(client, interaction, session, 'Роли обхода блокировок изменены.');
            return true;
        }
        const behaviorFields = {
            vacation_type_release_shifts: 'releaseShiftsOnStart',
            vacation_type_release_exams: 'releaseExaminationAssignmentsOnStart',
            vacation_type_close_settings: 'closeSettingsSessionOnStart',
            vacation_type_pause_discipline: 'pauseDisciplineDeadlines',
        };
        if (behaviorFields[parsed.action]) {
            const type = getType(session, parsed.value);
            if (type) type[behaviorFields[parsed.action]] = !type[behaviorFields[parsed.action]];
            await render(client, interaction, session, 'Поведение при начале отпуска изменено.');
            return true;
        }
        if (parsed.action === 'vacation_overdue_select' && interaction.isStringSelectMenu()) {
            session.selectedVacationOverdueRuleId = interaction.values[0] || null;
            configSessionService.setStatus(session, null);
            await updatePanel(client, interaction, session);
            return true;
        }
        if (parsed.action === 'vacation_overdue_delete') {
            const type = getType(session);
            const rule = getRule(session, parsed.value);
            if (type && rule) type.overdueRules = type.overdueRules.filter((entry) => entry.id !== rule.id);
            session.selectedVacationOverdueRuleId = null;
            await render(client, interaction, session, rule ? 'Правило просрочки удалено.' : null);
            return true;
        }
        if (parsed.action === 'vacation_overdue_notify_roles' && interaction.isRoleSelectMenu()) {
            const [typeId, ruleId] = String(parsed.value || '').split(':');
            const type = getType(session, typeId);
            const rule = (type?.overdueRules || []).find((entry) => entry.id === ruleId);
            if (rule) rule.notifyRoleIds = unique(interaction.values);
            await render(client, interaction, session, 'Роли уведомления изменены.');
            return true;
        }
        return false;
    }

    return { handle };
}

module.exports = { createVacationSettingsHandlers };
