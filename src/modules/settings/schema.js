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
const { ChannelType } = require('discord.js');
const {
    DEPARTMENT_ROLE_DEFINITIONS,
    getDepartmentChanges,
    getDepartments,
    prepareDepartmentsForStorage,
} = require('../../core/config/departmentSchema');
const {
    getRankChanges,
    getRanks,
    prepareRanksForStorage,
} = require('../staff-audit');
const {
    getExamChanges,
    getExams,
    prepareExamsForStorage,
} = require('../examination');
const {
    getExaminationSettings,
    getExaminationSettingsChanges,
    prepareExaminationSettingsForStorage,
} = require('../examination');
const {
    getDisciplineSettings,
    getDisciplineSettingsChanges,
    prepareDisciplineSettingsForStorage,
} = require('../discipline');
const {
    getGiveRolesSettings,
    getGiveRolesSettingsChanges,
    prepareGiveRolesSettingsForStorage,
} = require('../give-roles');
const {
    getStaffAuditSettings,
    getStaffAuditSettingsChanges,
    prepareStaffAuditSettingsForStorage,
} = require('../staff-audit');
const {
    getStaffListSettings,
    getStaffListSettingsChanges,
    prepareStaffListSettingsForStorage,
} = require('../staff-lists');
const {
    getChannelCounterSettings,
    getChannelCounterSettingsChanges,
    prepareChannelCounterSettingsForStorage,
} = require('../channel-counters');
const {
    SETTINGS_SECTION_DEFINITIONS,
    getSettingsAccessChanges,
    normalizeSettingsSectionAccess,
} = require('./accessSchema');
const {
    getManualToolsAccessChanges,
    normalizeManualToolsAccess,
} = require('../manual-tools');
const {
    getVacationSettings,
    getVacationSettingsChanges,
    prepareVacationSettingsForStorage,
} = require('../vacations');
const {
    getShiftTypeChanges,
    getShiftTypes,
    prepareShiftTypesForStorage,
} = require('../shifts');

const FEATURE_DEFINITIONS = [
    { key: 'giveRoles', label: 'Выдача ролей' },
    { key: 'staffAudit', label: 'Кадровый аудит' },
    { key: 'discipline', label: 'Взыскания' },
    { key: 'exams', label: 'Экзаменация' },
    { key: 'shifts', label: 'Смены' },
    { key: 'staffLists', label: 'Составы' },
    { key: 'channelCounters', label: 'Счётчики' },
    { key: 'vacations', label: 'Отпуска' },
];

const TEXT_CHANNEL_TYPES = [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
];

const CHANNEL_DEFINITIONS = [
    {
        key: 'getRoleChannelId',
        label: 'Запросы на выдачу ролей (принятие)',
        channelTypes: TEXT_CHANNEL_TYPES,
    },
    {
        key: 'confirmRoleChannelId',
        label: 'Запросы на выдачу ролей (подтверждение)',
        channelTypes: TEXT_CHANNEL_TYPES,
    },
    {
        key: 'examChannelId',
        label: 'Экзамены (основной канал)',
        channelTypes: TEXT_CHANNEL_TYPES,
    },
    {
        key: 'examResultChannelId',
        label: 'Экзамены (результаты)',
        channelTypes: TEXT_CHANNEL_TYPES,
    },
];

const COMMON_ROLE_DEFINITIONS = [
    { key: 'weazelNewsRoleId', label: 'Основная роль Weazel News' },
    { key: 'examinerRoleId', label: 'Экзаменатор' },
];



function hasValue(value) {
    return value !== null && value !== undefined && value !== '';
}

function normalizeId(value) {
    return hasValue(value) ? String(value) : null;
}

function normalizeIdList(values) {
    return Array.from(new Set(
        (Array.isArray(values) ? values : [])
            .map((value) => String(value || '').trim())
            .filter(Boolean)
    )).sort();
}

function getConfiguredValue(config, section, key) {
    return normalizeId(config?.[section]?.[key]);
}



function createSettingsDraft(config) {
    const source = config && typeof config === 'object' ? config : {};

    return {
        guildId: normalizeId(source.guildId),
        _serverName: String(source._serverName || ''),
        settingsManagerRoleIds: normalizeIdList(source.settingsManagerRoleIds),
        settingsSectionAccess: normalizeSettingsSectionAccess(source.settingsSectionAccess),
        manualToolsAccess: normalizeManualToolsAccess(source.manualToolsAccess),
        features: Object.fromEntries(
            FEATURE_DEFINITIONS.map(({ key }) => [key, source.features?.[key] === true])
        ),
        channels: Object.fromEntries(
            CHANNEL_DEFINITIONS.map(({ key }) => [key, getConfiguredValue(source, 'channels', key)])
        ),
        commonRoles: Object.fromEntries(
            COMMON_ROLE_DEFINITIONS.map(({ key }) => [key, getConfiguredValue(source, 'commonRoles', key)])
        ),
        departments: getDepartments(source),
        ranks: getRanks(source),
        exams: getExams(source),
        examinationSettings: getExaminationSettings(source),
        vacationSettings: getVacationSettings(source),
        giveRolesSettings: getGiveRolesSettings(source),
        staffAuditSettings: getStaffAuditSettings(source),
        disciplineSettings: getDisciplineSettings(source),
        staffListSettings: getStaffListSettings(source),
        channelCounterSettings: getChannelCounterSettings(source),
        shiftTypes: getShiftTypes(source),
    };
}

function prepareSettingsForStorage(draft) {
    const source = createSettingsDraft(draft);

    return {
        guildId: source.guildId,
        _serverName: source._serverName,
        settingsManagerRoleIds: normalizeIdList(source.settingsManagerRoleIds),
        settingsSectionAccess: normalizeSettingsSectionAccess(source.settingsSectionAccess),
        manualToolsAccess: normalizeManualToolsAccess(source.manualToolsAccess),
        features: Object.fromEntries(
            FEATURE_DEFINITIONS.map(({ key }) => [key, Boolean(source.features?.[key])])
        ),
        channels: Object.fromEntries(
            CHANNEL_DEFINITIONS.map(({ key }) => [key, normalizeId(source.channels?.[key])])
        ),
        commonRoles: Object.fromEntries(
            COMMON_ROLE_DEFINITIONS.map(({ key }) => [key, normalizeId(source.commonRoles?.[key])])
        ),
        departments: prepareDepartmentsForStorage(source.departments),
        ranks: prepareRanksForStorage(source.ranks),
        exams: prepareExamsForStorage(source.exams),
        examinationSettings: prepareExaminationSettingsForStorage(source.examinationSettings),
        vacationSettings: prepareVacationSettingsForStorage(source.vacationSettings),
        giveRolesSettings: prepareGiveRolesSettingsForStorage(source.giveRolesSettings),
        staffAuditSettings: prepareStaffAuditSettingsForStorage(source.staffAuditSettings),
        disciplineSettings: prepareDisciplineSettingsForStorage(source.disciplineSettings),
        staffListSettings: prepareStaffListSettingsForStorage(source.staffListSettings),
        channelCounterSettings: prepareChannelCounterSettingsForStorage(source.channelCounterSettings),
        shiftTypes: prepareShiftTypesForStorage(source.shiftTypes),
    };
}

function getSettingsChanges(beforeDraft, afterDraft) {
    const before = createSettingsDraft(beforeDraft);
    const after = createSettingsDraft(afterDraft);
    const changes = [];

    for (const { key, label } of FEATURE_DEFINITIONS) {
        const previousValue = Boolean(before.features?.[key]);
        const nextValue = Boolean(after.features?.[key]);
        if (previousValue === nextValue) continue;

        changes.push({
            section: 'features',
            key,
            label,
            before: previousValue,
            after: nextValue,
        });
    }

    for (const { key, label } of CHANNEL_DEFINITIONS) {
        const previousValue = normalizeId(before.channels?.[key]);
        const nextValue = normalizeId(after.channels?.[key]);
        if (previousValue === nextValue) continue;

        changes.push({
            section: 'channels',
            key,
            label,
            before: previousValue,
            after: nextValue,
        });
    }

    for (const { key, label } of COMMON_ROLE_DEFINITIONS) {
        const previousValue = normalizeId(before.commonRoles?.[key]);
        const nextValue = normalizeId(after.commonRoles?.[key]);
        if (previousValue === nextValue) continue;

        changes.push({
            section: 'commonRoles',
            key,
            label,
            before: previousValue,
            after: nextValue,
        });
    }

    const previousManagerRoles = normalizeIdList(before.settingsManagerRoleIds);
    const nextManagerRoles = normalizeIdList(after.settingsManagerRoleIds);
    const previousSet = new Set(previousManagerRoles);
    const nextSet = new Set(nextManagerRoles);

    for (const roleId of nextManagerRoles) {
        if (!previousSet.has(roleId)) {
            changes.push({
                section: 'access',
                key: 'settingsManagerRoleIds',
                label: 'Доступ к /settings',
                action: 'added',
                roleId,
            });
        }
    }

    for (const roleId of previousManagerRoles) {
        if (!nextSet.has(roleId)) {
            changes.push({
                section: 'access',
                key: 'settingsManagerRoleIds',
                label: 'Доступ к /settings',
                action: 'removed',
                roleId,
            });
        }
    }

    changes.push(...getSettingsAccessChanges(before.settingsSectionAccess, after.settingsSectionAccess));
    changes.push(...getManualToolsAccessChanges(before.manualToolsAccess, after.manualToolsAccess));

    changes.push(...getDepartmentChanges(before.departments, after.departments));
    changes.push(...getRankChanges(before.ranks, after.ranks));

    changes.push(...getExamChanges(before.exams, after.exams));
    changes.push(...getExaminationSettingsChanges(before.examinationSettings, after.examinationSettings));
    changes.push(...getVacationSettingsChanges(before.vacationSettings, after.vacationSettings));

    const giveRolesChanges = getGiveRolesSettingsChanges(
        before.giveRolesSettings,
        after.giveRolesSettings
    );
    for (const change of giveRolesChanges) {
        if (change.valueType === 'department') {
            change.beforeName = before.departments
                .find((department) => department.id === change.before)?.fullName || null;
            change.afterName = after.departments
                .find((department) => department.id === change.after)?.fullName || null;
        }
    }
    changes.push(...giveRolesChanges);

    changes.push(...getStaffAuditSettingsChanges(
        before.staffAuditSettings,
        after.staffAuditSettings
    ));
    const disciplineChanges = getDisciplineSettingsChanges(
        before.disciplineSettings,
        after.disciplineSettings
    );
    const beforeDepartmentNames = new Map(before.departments.map((department) => [department.id, department.fullName]));
    const afterDepartmentNames = new Map(after.departments.map((department) => [department.id, department.fullName]));
    const resolveDepartmentNames = (ids, preferred, fallback) => (Array.isArray(ids) ? ids : []).map((id) => (
        preferred.get(id) || fallback.get(id) || `удалённый отдел (${id})`
    ));
    for (const change of disciplineChanges) {
        if (change.valueType === 'departments') {
            change.beforeDepartmentNames = resolveDepartmentNames(change.before, beforeDepartmentNames, afterDepartmentNames);
            change.afterDepartmentNames = resolveDepartmentNames(change.after, afterDepartmentNames, beforeDepartmentNames);
        }
        if (change.method?.departmentIds) {
            change.methodDepartmentNames = resolveDepartmentNames(
                change.method.departmentIds,
                change.action === 'methodRemoved' ? beforeDepartmentNames : afterDepartmentNames,
                change.action === 'methodRemoved' ? afterDepartmentNames : beforeDepartmentNames
            );
        }
    }
    changes.push(...disciplineChanges);
    changes.push(...getStaffListSettingsChanges(
        before.staffListSettings,
        after.staffListSettings
    ));
    changes.push(...getChannelCounterSettingsChanges(
        before.channelCounterSettings,
        after.channelCounterSettings
    ));
    changes.push(...getShiftTypeChanges(before.shiftTypes, after.shiftTypes));

    return changes;
}

function formatGrantPolicyMode(mode) {
    if (mode === 'roles') return 'только выбранные роли';
    if (mode === 'disabled') return 'выдача запрещена';
    if (mode === 'unrestricted') return 'без дополнительных ограничений';
    return 'не настроено';
}

function formatSettingsChange(change) {
    if (!change) return 'Неизвестное изменение.';

    if (change.section === 'features') {
        return `Функция "${change.label}": ${change.before ? 'включена' : 'отключена'} → ${change.after ? 'включена' : 'отключена'}.`;
    }

    if (change.section === 'channels') {
        const before = change.before ? `<#${change.before}>` : 'не выбран';
        const after = change.after ? `<#${change.after}>` : 'не выбран';
        return `Канал "${change.label}": ${before} → ${after}.`;
    }

    if (change.section === 'commonRoles') {
        const before = change.before ? `<@&${change.before}>` : 'не выбрана';
        const after = change.after ? `<@&${change.after}>` : 'не выбрана';
        return `Роль "${change.label}": ${before} → ${after}.`;
    }

    if (change.section === 'access') {
        if (change.valueType === 'settingsSections') {
            const before = Array.isArray(change.before) && change.before.length
                ? change.before.join(', ')
                : 'нет доступа';
            const after = Array.isArray(change.after) && change.after.length
                ? change.after.join(', ')
                : 'нет доступа';
            return `Ограниченный доступ к /settings для <@&${change.roleId}>: ${before} → ${after}.`;
        }
        return change.action === 'added'
            ? `Доступ к /settings: добавлена роль <@&${change.roleId}>.`
            : `Доступ к /settings: удалена роль <@&${change.roleId}>.`;
    }

    if (change.section === 'manualToolsAccess') {
        const before = Array.isArray(change.before) && change.before.length
            ? change.before.map((key) => `/manualtools ${key}`).join(', ')
            : 'нет доступа';
        const after = Array.isArray(change.after) && change.after.length
            ? change.after.map((key) => `/manualtools ${key}`).join(', ')
            : 'нет доступа';
        return `Доступ к /manualtools для <@&${change.roleId}>: ${before} → ${after}.`;
    }

    if (change.section === 'ranks') {
        const rankLabel = `Ранг ${change.rankNumber} "${change.rankName}"`;
        if (change.action === 'added') {
            const role = change.rank?.roleId ? `<@&${change.rank.roleId}>` : 'без Discord-роли';
            return `Добавлен ${rankLabel}: ${role}; правило выдачи - ${formatGrantPolicyMode(change.rank?.grantPolicy?.mode)}.`;
        }
        if (change.action === 'removed') {
            return `Удалён ${rankLabel}.`;
        }
        if (change.action === 'policyRoleAdded') {
            return `${rankLabel}: к персональному правилу выдачи добавлена роль <@&${change.roleId}>.`;
        }
        if (change.action === 'policyRoleRemoved') {
            return `${rankLabel}: из персонального правила выдачи удалена роль <@&${change.roleId}>.`;
        }

        const formatValue = (value) => {
            if (change.valueType === 'role') return value ? `<@&${value}>` : 'не выбрана';
            if (change.valueType === 'grantPolicy') return formatGrantPolicyMode(value);
            if (change.valueType === 'boolean') return value ? 'да' : 'нет';
            if (change.valueType === 'number') return value == null ? 'без лимита' : String(value);
            return String(value ?? 'не указано');
        };
        return `${rankLabel}, ${change.label}: ${formatValue(change.before)} → ${formatValue(change.after)}.`;
    }


    if (change.section === 'exams') {
        const examLabel = `Экзамен "${change.examName}"`;
        if (change.action === 'added') {
            const mode = change.exam?.checkMode === 'manualScore' ? 'ручной ввод балла' : 'автоматический результат';
            return `Добавлен ${examLabel}: testId ${change.exam?.testId}; ${change.exam?.passScore}/${change.exam?.maxScore}; ${mode}.`;
        }
        if (change.action === 'removed') {
            return `Удалён ${examLabel}.`;
        }
        if (change.action === 'moved') {
            return `${examLabel}: позиция в списке ${change.before + 1} → ${change.after + 1}.`;
        }

        const formatValue = (value) => {
            if (change.valueType === 'checkMode') {
                return value === 'manualScore' ? 'ручной ввод балла' : 'автоматический результат';
            }
            if (change.valueType === 'url') return value || 'не указана';
            if (change.valueType === 'boolean') return value ? 'включены' : 'выключены';
            if (change.valueType === 'attempts') return Number(value) === 0 ? 'без ограничений' : String(value);
            return String(value ?? 'не указано');
        };
        return `${examLabel}, ${change.label}: ${formatValue(change.before)} → ${formatValue(change.after)}.`;
    }

    if (change.section === 'examination') {
        if (change.action === 'lectureTypeAdded') {
            return `Экзаменация: добавлен тип лекции "${change.lectureTypeName}".`;
        }
        if (change.action === 'lectureTypeRemoved') {
            return `Экзаменация: удалён тип лекции "${change.lectureTypeName}".`;
        }
        if (change.action === 'lectureTypeUpdated') {
            const formatValue = (value) => {
                if (change.valueType === 'department') return value || 'не выбран';
                if (change.valueType === 'roles') {
                    return Array.isArray(value) && value.length
                        ? value.map((roleId) => `<@&${roleId}>`).join(', ')
                        : 'не выбраны';
                }
                return String(value ?? 'не указано');
            };
            return `Экзаменация: тип лекции "${change.lectureTypeName}", ${change.label}: ${formatValue(change.before)} → ${formatValue(change.after)}.`;
        }
        if (change.action === 'lectureTypeMoved') {
            return `Экзаменация: тип лекции "${change.lectureTypeName}" перемещён с позиции ${change.before + 1} на ${change.after + 1}.`;
        }
        const formatValue = (value) => {
            if (change.valueType === 'channel') return value ? `<#${value}>` : 'не выбран';
            if (change.valueType === 'number') return String(value ?? 'не указано');
            return String(value ?? 'не указано');
        };
        return `Экзаменация, "${change.label}": ${formatValue(change.before)} → ${formatValue(change.after)}.`;
    }

    if (change.section === 'vacations') {
        const formatValue = (value) => {
            if (change.valueType === 'channel') return value ? `<#${value}>` : 'не выбран';
            if (change.valueType === 'roles') {
                return Array.isArray(value) && value.length
                    ? value.map((roleId) => `<@&${roleId}>`).join(' ')
                    : 'не выбраны';
            }
            return String(value ?? 'не указано');
        };
        if (change.action === 'typeAdded') return `Отпуска: добавлен тип "${change.vacationType?.name || change.vacationType?.id}".`;
        if (change.action === 'typeRemoved') return `Отпуска: удалён тип "${change.vacationType?.name || change.vacationType?.id}".`;
        if (change.action === 'typeUpdated') return `Отпуска: изменён тип "${change.after?.name || change.after?.id}".`;
        if (change.action === 'routeAdded') return `Отпуска: добавлен маршрут согласования "${change.route?.name || change.route?.id}".`;
        if (change.action === 'routeRemoved') return `Отпуска: удалён маршрут согласования "${change.route?.name || change.route?.id}".`;
        if (change.action === 'routeUpdated') return `Отпуска: изменён маршрут согласования "${change.after?.name || change.after?.id}".`;
        if (change.action === 'routeMoved') {
            return `Отпуска: маршрут согласования "${change.route?.name || change.route?.id}" перемещён с позиции ${change.before + 1} на ${change.after + 1}.`;
        }
        return `Отпуска, "${change.label}": ${formatValue(change.before)} → ${formatValue(change.after)}.`;
    }

    if (change.section === 'giveRoles') {
        if (change.action === 'roleAdded') {
            return `Выдача ролей, "${change.label}": добавлена роль <@&${change.roleId}>.`;
        }
        if (change.action === 'roleRemoved') {
            return `Выдача ролей, "${change.label}": удалена роль <@&${change.roleId}>.`;
        }

        const formatValue = (value) => {
            if (change.valueType === 'rank') return value ? `${value} ранг` : 'не выбран';
            if (change.valueType === 'department') {
                if (!value) return 'не выбран';
                if (value === change.before && change.beforeName) return `"${change.beforeName}"`;
                if (value === change.after && change.afterName) return `"${change.afterName}"`;
                return value;
            }
            return String(value ?? 'не указано');
        };
        return `Выдача ролей, "${change.label}": ${formatValue(change.before)} → ${formatValue(change.after)}.`;
    }

    if (change.section === 'staffAudit') {
        if (change.action === 'roleAdded') {
            return `Кадровый аудит, "${change.label}": добавлена роль <@&${change.roleId}>.`;
        }
        if (change.action === 'roleRemoved') {
            return `Кадровый аудит, "${change.label}": удалена роль <@&${change.roleId}>.`;
        }

        const formatValue = (value) => {
            if (change.valueType === 'channel') return value ? `<#${value}>` : 'не выбран';
            if (change.valueType === 'rank') return value ? `${value} ранг` : 'не выбран';
            return String(value ?? 'не указано');
        };
        return `Кадровый аудит, "${change.label}": ${formatValue(change.before)} → ${formatValue(change.after)}.`;
    }

    if (change.section === 'discipline') {
        const actionLabels = {
            none: 'ничего не делать',
            add_oral: 'добавить устный выговор',
            add_written: 'добавить письменный выговор',
            replace_oral: 'заменить на устный выговор',
            replace_written: 'заменить на письменный выговор',
            dismiss: 'уволить',
            dismiss_blacklist: 'уволить с ЧС',
        };
        const stageLabels = {
            conversation: 'Беседа',
            oral: 'Устный выговор',
            written: 'Письменный выговор',
        };
        const formatValue = (value) => {
            if (change.valueType === 'channel') return value ? `<#${value}>` : 'не выбран';
            if (change.valueType === 'role') return value ? `<@&${value}>` : 'не выбрана';
            if (change.valueType === 'roles') {
                return Array.isArray(value) && value.length
                    ? value.map((roleId) => `<@&${roleId}>`).join(' ')
                    : 'не выбраны';
            }
            if (change.valueType === 'boolean') return value ? 'включено' : 'выключено';
            if (change.valueType === 'days') return value == null ? 'не задано' : `${value} дн.`;
            if (change.valueType === 'action') return actionLabels[value] || 'неизвестное действие';
            if (change.valueType === 'stages') {
                return Array.isArray(value) && value.length
                    ? value.map((stage) => stageLabels[stage] || 'Неизвестный этап').join(', ')
                    : 'не выбраны';
            }
            if (change.valueType === 'departments') {
                const names = value === change.before
                    ? change.beforeDepartmentNames
                    : change.afterDepartmentNames;
                return Array.isArray(names) && names.length ? names.join(', ') : 'все отделы';
            }
            if (Array.isArray(value)) return value.length ? value.join(', ') : 'не выбраны';
            return String(value ?? 'не указано');
        };
        const formatMethod = (method) => {
            const stages = (method?.stages || []).map((stage) => stageLabels[stage] || 'Неизвестный этап').join(', ') || 'этапы не выбраны';
            const departments = method?.departmentIds?.length
                ? (change.methodDepartmentNames || method.departmentIds).join(', ')
                : 'все отделы';
            return `${stages}; ${departments}`;
        };
        const formatRule = (rule) => (
            `ранг ≥ ${rule?.minRankNumber}, ${stageLabels[rule?.stage] || 'Неизвестный этап'} × ${rule?.count} ` +
            `→ ранг ${rule?.action?.rankNumber}` +
            (rule?.clause ? `; пункт ${rule.clause}` : '')
        );
        if (change.action === 'methodAdded') return `Взыскания: добавлен способ отработки "${change.label}" (${formatMethod(change.method)}).`;
        if (change.action === 'methodRemoved') return `Взыскания: удалён способ отработки "${change.label}" (${formatMethod(change.method)}).`;
        if (change.action === 'ruleAdded') return `Взыскания: добавлено условное правило (${formatRule(change.rule)}).`;
        if (change.action === 'ruleRemoved') return `Взыскания: удалено условное правило (${formatRule(change.rule)}).`;
        if (change.action === 'ruleUpdated') return `Взыскания: условное правило изменено: ${formatRule(change.before)} → ${formatRule(change.after)}.`;
        return `Взыскания, "${change.label}": ${formatValue(change.before)} → ${formatValue(change.after)}.`;
    }

    if (change.section === 'staffLists') {
        const formatValue = (value) => {
            if (change.valueType === 'channel') return value ? `<#${value}>` : 'не выбран';
            if (change.valueType === 'date') return value || 'не указана';
            if (change.valueType === 'rankList') {
                return Array.isArray(value) && value.length
                    ? value.map((number) => `${number} ранг`).join(', ')
                    : 'не выбраны';
            }
            return String(value ?? 'не указано');
        };
        return `Составы, "${change.label}": ${formatValue(change.before)} → ${formatValue(change.after)}.`;
    }

    if (change.section === 'channelCounters') {
        const formatValue = (value) => value ? `<#${value}>` : 'не выбран';
        return `Счётчики, "${change.label}": ${formatValue(change.before)} → ${formatValue(change.after)}.`;
    }

    if (change.section === 'shiftTypes') {
        const typeLabel = `Расписание смен "${change.shiftTypeName || change.shiftTypeId}"`;
        const formatTypeSummary = (shiftType) => {
            if (!shiftType) return '';
            const channel = shiftType.channelId ? `<#${shiftType.channelId}>` : 'канал не выбран';
            const limit = shiftType.maxSlotsPerMember === 0
                ? 'без лимита на сотрудника'
                : `лимит ${shiftType.maxSlotsPerMember} на сотрудника`;
            return [
                shiftType.enabled ? 'включено' : 'выключено',
                channel,
                `цвет ${shiftType.color}`,
                `шапка ${shiftType.headerTemplate}`,
                `публикация ${shiftType.publication?.time}; после начала смен - на следующий день`,
                `слоты ${shiftType.schedule?.startTime}-${shiftType.schedule?.endTime} по ${shiftType.schedule?.slotDurationMinutes} мин.`,
                limit,
                `групп доступа: ${shiftType.accessGroups?.length || 0}`,
                `ролей управления: ${shiftType.managerRoleIds?.length || 0}`,
                `ротация: ${shiftType.rotateAccessDaily ? 'включена' : 'выключена'}`,
            ].join('; ');
        };
        const formatGroupSummary = (group) => {
            if (!group) return '';
            const roles = group.roleIds?.length
                ? group.roleIds.map((roleId) => `<@&${roleId}>`).join(' ')
                : 'роли не выбраны';
            return `задержка ${group.delayMinutes} мин.; ${roles}`;
        };
        if (change.action === 'added') {
            return `Добавлено ${typeLabel}: ${formatTypeSummary(change.shiftType)}.`;
        }
        if (change.action === 'removed') {
            return `Удалено ${typeLabel}: ${formatTypeSummary(change.shiftType)}.`;
        }
        if (change.action === 'moved') {
            return `${typeLabel}: позиция в списке ${change.before + 1} → ${change.after + 1}.`;
        }
        if (change.action === 'roleAdded') {
            return `${typeLabel}, ${change.label}: добавлена роль <@&${change.roleId}>.`;
        }
        if (change.action === 'roleRemoved') {
            return `${typeLabel}, ${change.label}: удалена роль <@&${change.roleId}>.`;
        }
        if (change.action === 'accessGroupAdded') {
            return `${typeLabel}: добавлена группа доступа "${change.groupName}" (${formatGroupSummary(change.group)}).`;
        }
        if (change.action === 'accessGroupRemoved') {
            return `${typeLabel}: удалена группа доступа "${change.groupName}" (${formatGroupSummary(change.group)}).`;
        }
        if (change.action === 'accessGroupRoleAdded') {
            return `${typeLabel}, группа "${change.groupName}": добавлена роль <@&${change.roleId}>.`;
        }
        if (change.action === 'accessGroupRoleRemoved') {
            return `${typeLabel}, группа "${change.groupName}": удалена роль <@&${change.roleId}>.`;
        }

        const formatValue = (value) => {
            if (change.valueType === 'channel') return value ? `<#${value}>` : 'не выбран';
            if (change.valueType === 'boolean') return value ? 'включено' : 'выключено';
            if (change.valueType === 'color') return value || 'не указан';
            return String(value ?? 'не указано');
        };
        if (change.action === 'accessGroupUpdated') {
            return `${typeLabel}, группа "${change.groupName}", ${change.label}: ${formatValue(change.before)} → ${formatValue(change.after)}.`;
        }
        return `${typeLabel}, ${change.label}: ${formatValue(change.before)} → ${formatValue(change.after)}.`;
    }

    if (change.section === 'departments') {
        const formatDepartmentSummary = (department) => {
            if (!department) return '';

            const parts = [
                `полное название: ${department.fullName}`,
                `цвет состава: ${department.color || 'автоматический'}`,
                `кураторы: ${department.curatorsEnabled === false ? 'выключены' : 'включены'}`,
                `глав: ${department.limits?.heads}`,
                `заместителей главы: ${department.limits?.deputyHeads}`,
            ];

            if (department.staffChannelId) parts.push(`канал: <#${department.staffChannelId}>`);

            for (const { key, label } of DEPARTMENT_ROLE_DEFINITIONS) {
                const roleId = department.roles?.[key];
                if (roleId) parts.push(`${label.toLocaleLowerCase('ru')}: <@&${roleId}>`);
            }

            return parts.join('; ');
        };

        if (change.action === 'added') {
            return `Добавлен отдел "${change.departmentName}" (${formatDepartmentSummary(change.department)}).`;
        }

        if (change.action === 'removed') {
            return `Удалён отдел "${change.departmentName}" (${formatDepartmentSummary(change.department)}).`;
        }

        const formatValue = (value) => {
            if (change.valueType === 'role') return value ? `<@&${value}>` : 'не выбрана';
            if (change.valueType === 'channel') return value ? `<#${value}>` : 'не выбран';
            if (change.valueType === 'color') return value || 'автоматический';
            if (change.valueType === 'boolean') return value ? 'включены' : 'выключены';
            return String(value ?? 'не указано');
        };

        return `Отдел "${change.departmentName}", ${change.label}: ${formatValue(change.before)} → ${formatValue(change.after)}.`;
    }

    return `${change.label || 'Настройка'} изменена.`;
}

module.exports = {
    CHANNEL_DEFINITIONS,
    COMMON_ROLE_DEFINITIONS,
    FEATURE_DEFINITIONS,
    SETTINGS_SECTION_DEFINITIONS,
    createSettingsDraft,
    formatSettingsChange,
    getSettingsChanges,
    prepareSettingsForStorage,
};
