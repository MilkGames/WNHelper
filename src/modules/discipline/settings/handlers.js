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
    DISCIPLINE_STAGES,
    createId,
} = require('./schema');

const DISCIPLINE_STAGE_INPUTS = new Map([
    ['беседа', 'conversation'],
    ['устный', 'oral'],
    ['устный выговор', 'oral'],
    ['письменный', 'written'],
    ['письменный выговор', 'written'],
    ['conversation', 'conversation'],
    ['oral', 'oral'],
    ['written', 'written'],
]);

function createDisciplineSettingsHandlers({
    acknowledgePanelInteraction,
    configSessionService,
    createDisciplineIntegerModal,
    createDisciplineMethodModal,
    createDisciplineRuleModal,
    runDiscordRequest,
    updatePanel,
}) {
    function getStage(session) {
        return session.draft.disciplineSettings.stages[session.selectedDisciplineStage];
    }

    function getMethod(session, id = session.selectedDisciplineMethodId) {
        return session.draft.disciplineSettings.workoffMethods.find((method) => method.id === id) || null;
    }

    function getRule(session, id = session.selectedDisciplineRuleId) {
        return session.draft.disciplineSettings.conditionalRules.find((rule) => rule.id === id) || null;
    }

    async function handleModal(client, interaction, session, parsed) {
        if (parsed.action === 'discipline_integer_modal') {
            await acknowledgePanelInteraction(interaction);
            const number = Number(interaction.fields.getTextInputValue('value').trim());
            if (!Number.isSafeInteger(number) || number <= 0) {
                configSessionService.setErrors(session, ['Значение должно быть положительным целым числом.']);
                await updatePanel(client, interaction, session);
                return true;
            }
            if (['maxIssueDelayDays', 'recertificationDeadlineDays', 'massMaxTargets', 'massApprovalTimeoutMinutes'].includes(parsed.value)) {
                const max = parsed.value === 'massMaxTargets' ? 25 : parsed.value === 'massApprovalTimeoutMinutes' ? 1440 : 365;
                const min = parsed.value === 'massMaxTargets' ? 2 : parsed.value === 'massApprovalTimeoutMinutes' ? 5 : 1;
                if (number < min || number > max) {
                    configSessionService.setErrors(session, [`Значение должно быть от ${min} до ${max}.`]);
                } else {
                    session.draft.disciplineSettings[parsed.value] = number;
                    configSessionService.setSection(session, 'disciplineGeneral');
                    configSessionService.markChanged(session, 'Числовая настройка взысканий изменена.');
                }
            } else {
                const stage = getStage(session);
                if (parsed.value === 'threshold') {
                    if (session.selectedDisciplineStage !== 'conversation' || number < 2 || number > 10) {
                        configSessionService.setErrors(session, ['Порог бесед должен быть от 2 до 10.']);
                    } else {
                        stage.threshold = number;
                        stage.roleByCount = Object.fromEntries(
                            Object.entries(stage.roleByCount || {})
                                .filter(([count]) => Number(count) < number)
                        );
                        configSessionService.setSection(session, 'disciplineStage');
                        configSessionService.markChanged(session, 'Порог преобразования бесед изменён.');
                    }
                } else if (parsed.value === 'autoExpireDays') {
                    if (session.selectedDisciplineStage !== 'conversation' || number > 3650) {
                        configSessionService.setErrors(session, ['Срок автоистечения бесед должен быть от 1 до 3650 дней.']);
                    } else {
                        stage.autoExpireDays = number;
                        configSessionService.setSection(session, 'disciplineStage');
                        configSessionService.markChanged(session, 'Срок автоистечения бесед изменён.');
                    }
                } else if (parsed.value === 'deadlineDays') {
                    if (number > 365) {
                        configSessionService.setErrors(session, ['Срок отработки не может превышать 365 дней.']);
                    } else {
                        stage.deadlineDays = number;
                        configSessionService.setSection(session, 'disciplineStage');
                        configSessionService.markChanged(session, 'Срок отработки изменён.');
                    }
                }
            }
            await updatePanel(client, interaction, session);
            return true;
        }

        if (parsed.action === 'discipline_method_modal') {
            await acknowledgePanelInteraction(interaction);
            const name = interaction.fields.getTextInputValue('name').trim();
            const duplicate = session.draft.disciplineSettings.workoffMethods.find((method) => (
                method.id !== parsed.value && method.name.toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru')
            ));
            if (!name) {
                configSessionService.setErrors(session, ['Название способа не может быть пустым.']);
            } else if (duplicate) {
                configSessionService.setErrors(session, ['Способ с таким названием уже существует.']);
            } else if (parsed.value === 'new' && session.draft.disciplineSettings.workoffMethods.length >= 24) {
                configSessionService.setErrors(session, ['Можно настроить не больше 24 способов отработки.']);
            } else if (parsed.value === 'new') {
                const method = {
                    id: createId('workoff'),
                    name,
                    stages: ['oral'],
                    departmentIds: [],
                };
                session.draft.disciplineSettings.workoffMethods.push(method);
                session.draft.disciplineSettings.workoffMethods.sort((left, right) => left.name.localeCompare(right.name, 'ru'));
                session.selectedDisciplineMethodId = method.id;
                configSessionService.setSection(session, 'disciplineMethods');
                configSessionService.markChanged(session, `Способ "${name}" добавлен.`);
            } else {
                const method = getMethod(session, parsed.value);
                if (!method) {
                    configSessionService.setErrors(session, ['Выбранный способ больше не существует.']);
                } else {
                    method.name = name;
                    configSessionService.setSection(session, 'disciplineMethods');
                    configSessionService.markChanged(session, `Способ переименован в "${name}".`);
                }
            }
            await updatePanel(client, interaction, session);
            return true;
        }

        if (parsed.action === 'discipline_rule_modal') {
            await acknowledgePanelInteraction(interaction);
            const minRankNumber = Number(interaction.fields.getTextInputValue('minRankNumber').trim());
            const stageInput = interaction.fields.getTextInputValue('stage').trim().toLowerCase();
            const stage = DISCIPLINE_STAGE_INPUTS.get(stageInput) || null;
            const count = Number(interaction.fields.getTextInputValue('count').trim());
            const actionInput = interaction.fields.getTextInputValue('action').trim().toLowerCase();
            const actionMatch = actionInput.match(/^(?:ранг|rank):(\d{1,4})$/u);
            const actionType = ['роли', 'roles'].includes(actionInput) ? 'update_roles' : actionMatch ? 'set_rank' : null;
            const rankNumber = actionMatch ? Number(actionMatch[1]) : null;
            const clause = interaction.fields.getTextInputValue('clause').trim().slice(0, 200) || null;
            const errors = [];
            if (!Number.isSafeInteger(minRankNumber) || minRankNumber <= 0) errors.push('Минимальный ранг должен быть положительным числом.');
            if (!DISCIPLINE_STAGES.includes(stage)) errors.push('Укажите этап: "беседа", "устный" или "письменный".');
            if (!Number.isSafeInteger(count) || count <= 0) errors.push('Количество должно быть положительным числом.');
            if (!actionType) errors.push('Укажите действие: "ранг:НОМЕР" или "роли".');
            const rankNumbers = new Set((session.draft.ranks || []).map((rank) => rank.number));
            if (Number.isSafeInteger(minRankNumber) && !rankNumbers.has(minRankNumber)) errors.push(`Ранг ${minRankNumber} не настроен.`);
            if (actionType === 'set_rank' && !rankNumbers.has(rankNumber)) errors.push(`Ранг ${rankNumber} не настроен.`);
            if (actionType === 'set_rank' && Number.isSafeInteger(minRankNumber) && rankNumber >= minRankNumber) {
                errors.push('Условное дисциплинарное правило может только понижать ранг.');
            }
            if (parsed.value === 'new' && session.draft.disciplineSettings.conditionalRules.length >= 25) {
                errors.push('Можно настроить не больше 25 условных правил.');
            }
            if (errors.length) {
                configSessionService.setErrors(session, errors);
            } else {
                const data = {
                    id: parsed.value === 'new' ? createId('discipline-rule') : parsed.value,
                    minRankNumber,
                    stage,
                    count,
                    clause,
                    action: actionType === 'update_roles'
                        ? {
                            type: 'update_roles',
                            removeRoleIds: getRule(session, parsed.value)?.action?.removeRoleIds || [],
                            addRoleIds: getRule(session, parsed.value)?.action?.addRoleIds || [],
                        }
                        : { type: 'set_rank', rankNumber },
                };
                const existing = getRule(session, parsed.value);
                if (existing) Object.assign(existing, data);
                else session.draft.disciplineSettings.conditionalRules.push(data);
                session.selectedDisciplineRuleId = data.id;
                configSessionService.setSection(session, 'disciplineRules');
                configSessionService.markChanged(session, 'Условное правило сохранено.');
            }
            await updatePanel(client, interaction, session);
            return true;
        }

        return false;
    }

    async function handle(client, interaction, session, parsed) {
        if (!String(parsed.action || '').startsWith('discipline_')) return false;
        if (interaction.isModalSubmit()) return handleModal(client, interaction, session, parsed);

        if (parsed.action === 'discipline_general_select' && interaction.isStringSelectMenu()) {
            await acknowledgePanelInteraction(interaction);
            session.selectedDisciplineGeneralKey = interaction.values[0];
            configSessionService.setStatus(session, null);
            await updatePanel(client, interaction, session);
            return true;
        }
        if (parsed.action === 'discipline_general_channel' && interaction.isChannelSelectMenu()) {
            await acknowledgePanelInteraction(interaction);
            session.draft.disciplineSettings[parsed.value] = interaction.values[0] || null;
            configSessionService.markChanged(session, 'Канал взысканий изменён.');
            await updatePanel(client, interaction, session);
            return true;
        }
        if (parsed.action === 'discipline_general_roles' && interaction.isRoleSelectMenu()) {
            await acknowledgePanelInteraction(interaction);
            session.draft.disciplineSettings[parsed.value] = Array.from(new Set(interaction.values)).sort();
            configSessionService.markChanged(session, 'Роли подтверждения снятия изменены.');
            await updatePanel(client, interaction, session);
            return true;
        }
        if (parsed.action === 'discipline_general_role' && interaction.isRoleSelectMenu()) {
            await acknowledgePanelInteraction(interaction);
            session.draft.disciplineSettings[parsed.value] = interaction.values[0] || null;
            configSessionService.markChanged(session, 'Роль переаттестации изменена.');
            await updatePanel(client, interaction, session);
            return true;
        }
        if (parsed.action === 'discipline_general_action' && interaction.isStringSelectMenu()) {
            await acknowledgePanelInteraction(interaction);
            const action = interaction.values[0];
            if (['none', 'dismiss', 'dismiss_blacklist'].includes(action)) {
                session.draft.disciplineSettings[parsed.value] = action;
                configSessionService.markChanged(session, 'Действие при повторной просрочке изменено.');
            }
            await updatePanel(client, interaction, session);
            return true;
        }
        if (parsed.action === 'discipline_general_recert_action' && interaction.isStringSelectMenu()) {
            await acknowledgePanelInteraction(interaction);
            const action = interaction.values[0];
            if (['none', 'add_written', 'dismiss', 'dismiss_blacklist'].includes(action)) {
                session.draft.disciplineSettings[parsed.value] = action;
                configSessionService.markChanged(session, 'Действие переаттестации изменено.');
            }
            await updatePanel(client, interaction, session);
            return true;
        }
        if (parsed.action === 'discipline_general_clear') {
            await acknowledgePanelInteraction(interaction);
            session.draft.disciplineSettings[parsed.value] = parsed.value.endsWith('RoleIds') ? [] : null;
            configSessionService.markChanged(session, 'Настройка взысканий очищена.');
            await updatePanel(client, interaction, session);
            return true;
        }
        if (parsed.action === 'discipline_general_integer') {
            const value = session.draft.disciplineSettings[parsed.value];
            await runDiscordRequest(() => interaction.showModal(createDisciplineIntegerModal(session, parsed.value, value)), { attempts: 1 });
            return true;
        }
        if (parsed.action === 'discipline_policy_roles' && interaction.isRoleSelectMenu()) {
            await acknowledgePanelInteraction(interaction);
            session.draft.disciplineSettings.issuePolicy[parsed.value] = Array.from(new Set(interaction.values)).sort();
            configSessionService.markChanged(session, 'Роли полномочий взысканий изменены.');
            await updatePanel(client, interaction, session);
            return true;
        }
        if (parsed.action === 'discipline_policy_toggle') {
            await acknowledgePanelInteraction(interaction);
            const policy = session.draft.disciplineSettings.issuePolicy;
            policy[parsed.value] = !policy[parsed.value];
            configSessionService.markChanged(session, 'Проверка полномочий взысканий изменена.');
            await updatePanel(client, interaction, session);
            return true;
        }
        if (parsed.action === 'discipline_policy_fallback' && interaction.isStringSelectMenu()) {
            await acknowledgePanelInteraction(interaction);
            session.draft.disciplineSettings.issuePolicy.fallbackPermissionMode = interaction.values[0] === 'policy'
                ? 'policy'
                : 'unconditional';
            configSessionService.markChanged(session, 'Режим резервных полномочий изменён.');
            await updatePanel(client, interaction, session);
            return true;
        }
        if (parsed.action === 'discipline_appeals_channel' && interaction.isChannelSelectMenu()) {
            await acknowledgePanelInteraction(interaction);
            session.draft.disciplineSettings.appeals.channelId = interaction.values[0] || null;
            configSessionService.markChanged(session, 'Канал обжалований изменён.');
            await updatePanel(client, interaction, session);
            return true;
        }
        if (parsed.action === 'discipline_appeals_roles' && interaction.isRoleSelectMenu()) {
            await acknowledgePanelInteraction(interaction);
            session.draft.disciplineSettings.appeals[parsed.value] = Array.from(new Set(interaction.values)).sort();
            configSessionService.markChanged(session, 'Роли обжалований изменены.');
            await updatePanel(client, interaction, session);
            return true;
        }
        if (parsed.action === 'discipline_appeals_toggle') {
            await acknowledgePanelInteraction(interaction);
            const appeals = session.draft.disciplineSettings.appeals;
            appeals[parsed.value] = !appeals[parsed.value];
            configSessionService.markChanged(session, 'Настройки обжалований изменены.');
            await updatePanel(client, interaction, session);
            return true;
        }
        if (parsed.action === 'discipline_stage_select' && interaction.isStringSelectMenu()) {
            await acknowledgePanelInteraction(interaction);
            session.selectedDisciplineStage = interaction.values[0];
            session.selectedDisciplineRoleCount = 1;
            configSessionService.setStatus(session, null);
            await updatePanel(client, interaction, session);
            return true;
        }
        if (parsed.action === 'discipline_stage_toggle') {
            await acknowledgePanelInteraction(interaction);
            const stage = getStage(session);
            stage[parsed.value] = !stage[parsed.value];
            configSessionService.markChanged(session, 'Настройка этапа изменена.');
            await updatePanel(client, interaction, session);
            return true;
        }
        if (parsed.action === 'discipline_stage_overdue' && interaction.isStringSelectMenu()) {
            await acknowledgePanelInteraction(interaction);
            getStage(session).overdueAction = interaction.values[0];
            configSessionService.markChanged(session, 'Действие при просрочке изменено.');
            await updatePanel(client, interaction, session);
            return true;
        }
        if (parsed.action === 'discipline_stage_number') {
            const value = getStage(session)[parsed.value];
            await runDiscordRequest(() => interaction.showModal(createDisciplineIntegerModal(session, parsed.value, value)), { attempts: 1 });
            return true;
        }
        if (parsed.action === 'discipline_role_count' && interaction.isStringSelectMenu()) {
            await acknowledgePanelInteraction(interaction);
            session.selectedDisciplineRoleCount = Number(interaction.values[0]);
            await updatePanel(client, interaction, session);
            return true;
        }
        if (parsed.action === 'discipline_role_set' && interaction.isRoleSelectMenu()) {
            await acknowledgePanelInteraction(interaction);
            getStage(session).roleByCount[String(parsed.value)] = interaction.values[0];
            session.selectedDisciplineRoleCount = Number(parsed.value);
            configSessionService.markChanged(session, 'Роль состояния взысканий изменена.');
            await updatePanel(client, interaction, session);
            return true;
        }
        if (parsed.action === 'discipline_role_clear') {
            await acknowledgePanelInteraction(interaction);
            delete getStage(session).roleByCount[String(parsed.value)];
            configSessionService.markChanged(session, 'Роль состояния взысканий очищена.');
            await updatePanel(client, interaction, session);
            return true;
        }
        if (parsed.action === 'discipline_method_select' && interaction.isStringSelectMenu()) {
            await acknowledgePanelInteraction(interaction);
            session.selectedDisciplineMethodId = interaction.values[0];
            await updatePanel(client, interaction, session);
            return true;
        }
        if (parsed.action === 'discipline_method_add') {
            await runDiscordRequest(() => interaction.showModal(createDisciplineMethodModal(session)), { attempts: 1 });
            return true;
        }
        if (parsed.action === 'discipline_method_edit') {
            const method = getMethod(session);
            if (!method) return false;
            await runDiscordRequest(() => interaction.showModal(createDisciplineMethodModal(session, method)), { attempts: 1 });
            return true;
        }
        if (parsed.action === 'discipline_method_delete') {
            await acknowledgePanelInteraction(interaction);
            const method = getMethod(session);
            if (method) {
                session.draft.disciplineSettings.workoffMethods = session.draft.disciplineSettings.workoffMethods
                    .filter((entry) => entry.id !== method.id);
                session.selectedDisciplineMethodId = null;
                configSessionService.markChanged(session, `Способ "${method.name}" удалён.`);
            }
            await updatePanel(client, interaction, session);
            return true;
        }
        if (parsed.action === 'discipline_method_stages' && interaction.isStringSelectMenu()) {
            await acknowledgePanelInteraction(interaction);
            const method = getMethod(session);
            if (method) {
                method.stages = Array.from(new Set(interaction.values.filter((value) => DISCIPLINE_STAGES.includes(value)))).sort();
                configSessionService.markChanged(session, 'Этапы способа изменены.');
            }
            await updatePanel(client, interaction, session);
            return true;
        }
        if (parsed.action === 'discipline_method_departments' && interaction.isStringSelectMenu()) {
            await acknowledgePanelInteraction(interaction);
            const method = getMethod(session);
            if (method) {
                method.departmentIds = Array.from(new Set(interaction.values)).sort();
                configSessionService.markChanged(session, 'Отделы способа изменены.');
            }
            await updatePanel(client, interaction, session);
            return true;
        }
        if (parsed.action === 'discipline_method_departments_clear') {
            await acknowledgePanelInteraction(interaction);
            const method = getMethod(session);
            if (method) {
                method.departmentIds = [];
                configSessionService.markChanged(session, 'Способ разрешён всем отделам.');
            }
            await updatePanel(client, interaction, session);
            return true;
        }
        if (parsed.action === 'discipline_rule_select' && interaction.isStringSelectMenu()) {
            await acknowledgePanelInteraction(interaction);
            session.selectedDisciplineRuleId = interaction.values[0];
            await updatePanel(client, interaction, session);
            return true;
        }
        if (parsed.action === 'discipline_rule_add') {
            await runDiscordRequest(() => interaction.showModal(createDisciplineRuleModal(session)), { attempts: 1 });
            return true;
        }
        if (parsed.action === 'discipline_rule_edit') {
            const rule = getRule(session);
            if (!rule) return false;
            await runDiscordRequest(() => interaction.showModal(createDisciplineRuleModal(session, rule)), { attempts: 1 });
            return true;
        }
        if (parsed.action === 'discipline_rule_roles' && interaction.isRoleSelectMenu()) {
            await acknowledgePanelInteraction(interaction);
            const rule = getRule(session);
            if (!rule || rule.action.type !== 'update_roles') return false;
            rule.action[parsed.value] = Array.from(new Set(interaction.values)).sort();
            configSessionService.markChanged(session, 'Роли условного правила изменены.');
            await updatePanel(client, interaction, session);
            return true;
        }
        if (parsed.action === 'discipline_rule_delete') {
            await acknowledgePanelInteraction(interaction);
            const rule = getRule(session);
            if (rule) {
                session.draft.disciplineSettings.conditionalRules = session.draft.disciplineSettings.conditionalRules
                    .filter((entry) => entry.id !== rule.id);
                session.selectedDisciplineRuleId = null;
                configSessionService.markChanged(session, 'Условное правило удалено.');
            }
            await updatePanel(client, interaction, session);
            return true;
        }
        return false;
    }

    return { handle };
}

module.exports = { createDisciplineSettingsHandlers };
