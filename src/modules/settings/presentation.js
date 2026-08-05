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
    ButtonBuilder,
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
    CHANNEL_DEFINITIONS,
    COMMON_ROLE_DEFINITIONS,
    FEATURE_DEFINITIONS,
    SETTINGS_SECTION_DEFINITIONS,
    formatSettingsChange,
} = require('./schema');
const {
    DEPARTMENT_ROLE_DEFINITIONS,
    getDepartments,
} = require('../../core/config/departmentSchema');
const { getRanks } = require('../staff-audit');
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
const {
    MANUAL_TOOLS_SUBCOMMAND_DEFINITIONS,
} = require('../manual-tools');
const { createShiftSettingsRenderer } = require('../shifts');
const { createDisciplineSettingsRenderer } = require('../discipline');
const { createVacationSettingsRenderer } = require('../vacations');
const { buildDiagnostics } = require('./diagnostics');
const { formatBreadcrumb } = require('../../core/ui/presentation');
const { canPublishDiscordRules } = require('./publication');

const CHANGE_PAGE_SIZE = 10;
const DEPARTMENT_PAGE_SIZE = 25;
const RANK_PAGE_SIZE = 10;
const EXAM_PAGE_SIZE = 5;
const LECTURE_TYPE_PAGE_SIZE = 10;
const GIVE_ROLES_SELECT_PAGE_SIZE = 25;
const STAFF_AUDIT_SELECT_PAGE_SIZE = 25;
const VISIBLE_CHANNEL_DEFINITIONS = CHANNEL_DEFINITIONS;
const VISIBLE_COMMON_ROLE_DEFINITIONS = COMMON_ROLE_DEFINITIONS;

function canAccessWindow(session, key) {
    return session.fullAccess === true || session.allowedSectionKeys?.includes(key);
}

function chunk(values, size) {
    const result = [];
    for (let index = 0; index < values.length; index += size) {
        result.push(values.slice(index, index + size));
    }
    return result;
}
const SECTION_LABELS = {
    main: 'Главное',
    features: 'Функции',
    channels: 'Каналы',
    commonRoles: 'Общие роли',
    settingsAccess: 'Доступ к /settings',
    manualToolsAccess: 'Доступ к /manualtools',
    departments: 'Отделы',
    departmentRoles: 'Роли отдела',
    departmentChannel: 'Канал состава отдела',
    departmentDelete: 'Удаление отдела',
    ranks: 'Ранги',
    rankRole: 'Роль ранга',
    rankPolicy: 'Правило выдачи ранга',
    rankDelete: 'Удаление ранга',
    rankStaffList: 'Отображение ранга в составе',
    exams: 'Экзаменация',
    examinationGeneral: 'Экзаменация: общее',
    examinationChannels: 'Экзаменация: каналы',
    examinationVoiceChannels: 'Экзаменация: voice-каналы',
    lectureTypes: 'Экзаменация: типы лекций',
    lectureTypeDetails: 'Экзаменация: настройка лекции',
    lectureTypeDelete: 'Экзаменация: удаление лекции',
    publicationPreview: 'Публикация сообщения',
    examMode: 'Режим проверки экзамена',
    examDelete: 'Удаление экзамена',
    giveRoles: 'Выдача ролей',
    staffAudit: 'Кадровый аудит',
    discipline: 'Взыскания',
    disciplineGeneral: 'Взыскания: общее',
    disciplineStage: 'Взыскания: этапы',
    disciplineStageRoles: 'Взыскания: роли',
    disciplineMethods: 'Взыскания: методы',
    disciplineMethodStages: 'Метод: этапы',
    disciplineMethodDepartments: 'Метод: отделы',
    disciplineRules: 'Взыскания: условные правила',
    vacations: 'Отпуска',
    vacationGeneral: 'Отпуска: общее',
    vacationRoutes: 'Отпуска: маршруты',
    vacationRouteDetails: 'Отпуска: маршрут',
    vacationTypes: 'Отпуска: типы',
    vacationTypeDetails: 'Отпуска: тип',
    vacationTypeAvailability: 'Отпуска: доступность',
    vacationTypeLimits: 'Отпуска: лимиты',
    vacationTypeActions: 'Отпуска: роли и доступ',
    vacationTypeBehavior: 'Отпуска: поведение',
    vacationTypeOverdue: 'Отпуска: просрочка',
    staffLists: 'Составы',
    channelCounters: 'Счётчики',
    shiftTypes: 'Смены',
    shiftTypeChannel: 'Канал смен',
    shiftSchedule: 'Расписание смен',
    shiftAccess: 'Доступ к сменам',
    shiftManagers: 'Управление сменами',
    shiftPublish: 'Публикация смен',
    shiftDelete: 'Удаление смен',
    diagnostics: 'Диагностика',
    publications: 'Публикации',
    changes: 'Изменения',
};

const {
    createShiftAccessGroupModal,
    createShiftScheduleModal,
    createShiftTypeModal,
    renderShiftAccess,
    renderShiftDelete,
    renderShiftManagers,
    renderShiftPublish,
    renderShiftSchedule,
    renderShiftTypeChannel,
    renderShiftTypes,
} = createShiftSettingsRenderer({
    customId,
    createButton,
    createFooterRow,
    formatStatus,
    getSelectedShiftType,
    getSelectedShiftAccessGroup,
});

const {
    createDisciplineIntegerModal,
    createDisciplineMethodModal,
    createDisciplineRuleModal,
    renderDiscipline,
    renderDisciplineAppeals,
    renderDisciplineGeneral,
    renderDisciplineMethodDepartments,
    renderDisciplineMethodStages,
    renderDisciplineMethods,
    renderDisciplinePolicy,
    renderDisciplineRuleRoles,
    renderDisciplineRules,
    renderDisciplineStage,
    renderDisciplineStageRoles,
} = createDisciplineSettingsRenderer({
    customId,
    createButton,
    createFooterRow,
    formatStatus,
    getDepartments,
});

const {
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
} = createVacationSettingsRenderer({
    customId,
    createButton,
    createFooterRow,
    formatStatus,
    getRanks,
});

function customId(session, action, value = null) {
    const normalizedAction = String(action || '');
    const normalizedValue = value == null ? null : String(value);
    const suffix = normalizedValue == null ? '' : `:${normalizedValue}`;
    const fullCustomId = `settings:${session.id}:${normalizedAction}${suffix}`;
    if (fullCustomId.length <= 100) return fullCustomId;

    session.customIdPayloads ||= {};
    session.customIdCounter = Number(session.customIdCounter || 0) + 1;
    const token = session.customIdCounter.toString(36);
    session.customIdPayloads[token] = {
        action: normalizedAction,
        value: normalizedValue,
    };
    return `settings:${session.id}:ref:${token}`;
}

function createButton(session, action, label, style = ButtonStyle.Secondary, value = null) {
    return new ButtonBuilder()
        .setCustomId(customId(session, action, value))
        .setLabel(label)
        .setStyle(style);
}

function createFooterRow(session, { includeClear = null, backSection = 'main' } = {}) {
    const row = new ActionRowBuilder();

    if (includeClear) {
        row.addComponents(createButton(session, includeClear.action, 'Очистить', ButtonStyle.Danger, includeClear.value));
    }

    row.addComponents(
        createButton(session, 'nav', 'Назад', ButtonStyle.Secondary, backSection),
        createButton(session, 'save', 'Сохранить', ButtonStyle.Success),
        createButton(session, 'cancel', 'Отменить', ButtonStyle.Danger),
    );

    return row;
}

function formatStatus(session) {
    const changeCount = Array.isArray(session.changes) ? session.changes.length : 0;
    const lines = [
        `Редактирует: <@${session.userId}>`,
        `Путь: ${formatBreadcrumb(['/settings', ...(SECTION_LABELS[session.section] || 'Раздел').split(':').map((part) => part.trim())])}`,
        `Несохранённые изменения: ${changeCount ? `да (${changeCount})` : 'нет'}`,
    ];

    if (session.statusLine) {
        lines.push('', `Результат: ${session.statusLine}`);
    }

    if (session.errorLines?.length) {
        lines.push('', 'Ошибки:');
        for (const error of session.errorLines) {
            lines.push(`• ${error}`);
        }
    }

    return lines.join('\n');
}

function getSelectedDepartment(session) {
    return (session.draft.departments || [])
        .find((department) => department.id === session.selectedDepartmentId) || null;
}

function getSelectedRank(session) {
    return (session.draft.ranks || [])
        .find((rank) => rank.number === session.selectedRankNumber) || null;
}


function getSelectedExam(session) {
    return (session.draft.exams || [])
        .find((exam) => exam.id === session.selectedExamId) || null;
}

function getSelectedLectureType(session) {
    return (session.draft.examinationSettings?.lectureTypes || [])
        .find((entry) => entry.id === session.selectedLectureTypeId) || null;
}

function getSelectedShiftType(session) {
    return (session.draft.shiftTypes || [])
        .find((shiftType) => shiftType.id === session.selectedShiftTypeId) || null;
}

function getSelectedShiftAccessGroup(session) {
    const shiftType = getSelectedShiftType(session);
    return (shiftType?.accessGroups || [])
        .find((group) => group.id === session.selectedShiftAccessGroupId) || null;
}

function formatRankName(rank) {
    if (!rank) return 'не выбран';
    return `${rank.number} - ${rank.name}`;
}

function formatGrantPolicy(policy) {
    if (policy?.mode === 'roles') return 'только выбранные роли';
    if (policy?.mode === 'disabled') return 'выдача запрещена';
    if (policy?.mode === 'unrestricted') return 'без дополнительных ограничений';
    return 'не настроено';
}

function formatDepartmentName(department) {
    if (!department) return 'не выбран';
    return department.fullName
        ? `${department.shortName} - ${department.fullName}`
        : department.shortName;
}


function formatExamName(exam) {
    return exam?.name || 'без названия';
}

function formatExamCheckMode(mode) {
    return mode === 'manualScore' ? 'ручной ввод балла' : 'автоматический результат';
}


function renderMain(session, guild) {
    const enabledFeatures = FEATURE_DEFINITIONS.filter(({ key }) => session.draft.features?.[key]).length;
    const configuredChannels = VISIBLE_CHANNEL_DEFINITIONS.filter(({ key }) => session.draft.channels?.[key]).length;
    const configuredRoles = VISIBLE_COMMON_ROLE_DEFINITIONS.filter(({ key }) => session.draft.commonRoles?.[key]).length;
    const managerRoles = session.draft.settingsManagerRoleIds?.length || 0;
    const manualToolsRules = session.draft.manualToolsAccess?.length || 0;
    const departments = session.draft.departments?.length || 0;
    const ranks = session.draft.ranks?.length || 0;
    const exams = session.draft.exams?.length || 0;
    const shiftTypes = session.draft.shiftTypes?.length || 0;
    const vacationTypes = session.draft.vacationSettings?.types?.length || 0;

    const content = [
        `## Настройки WN Helper - ${guild.name}`,
        formatStatus(session),
        '',
        `Функции: ${enabledFeatures}/${FEATURE_DEFINITIONS.length}`,
        `Каналы: ${configuredChannels}/${VISIBLE_CHANNEL_DEFINITIONS.length}`,
        `Общие роли: ${configuredRoles}/${VISIBLE_COMMON_ROLE_DEFINITIONS.length}`,
        `Отделы: ${departments}`,
        `Ранги: ${ranks}`,
        `Экзамены: ${exams}`,
        `Расписаний смен: ${shiftTypes}`,
        `Типов отпусков: ${vacationTypes}`,
        `Выдача ролей: ${session.draft.features?.giveRoles ? 'включена' : 'отключена'}`,
        `Кадровый аудит: ${session.draft.features?.staffAudit ? 'включён' : 'отключён'}`,
        `Составы: ${session.draft.features?.staffLists ? 'включены' : 'отключены'}`,
        `Счётчики: ${session.draft.features?.channelCounters ? 'включены' : 'отключены'}`,
        `Роли с полным доступом к настройкам: ${managerRoles}`,
        `Правила доступа к /manualtools: ${manualToolsRules}`,
        '',
        'Все изменения применятся только после нажатия "Сохранить".',
    ].join('\n');

    const orderedWindows = [
        ['features', 'Функции'],
        ['channels', 'Каналы'],
        ['commonRoles', 'Общие роли'],
        ...(session.fullAccess ? [
            ['settingsAccess', 'Доступ к /settings'],
            ['manualToolsAccess', 'Доступ к /manualtools'],
        ] : []),
        ['departments', 'Отделы'],
        ['ranks', 'Ранги'],
        ['exams', 'Экзаменация'],
        ['giveRoles', 'Выдача ролей'],
        ['staffAudit', 'Кадровый аудит'],
        ['discipline', 'Взыскания'],
        ['staffLists', 'Составы'],
        ['channelCounters', 'Счётчики'],
        ['shiftTypes', 'Смены'],
        ['vacations', 'Отпуска'],
        ['diagnostics', 'Диагностика'],
        ...(canPublishDiscordRules(guild.id) ? [['publications', 'Публикации']] : []),
    ].filter(([key]) => canAccessWindow(session, key));

    const navigationRows = chunk(orderedWindows, 5).map((items) => (
        new ActionRowBuilder().addComponents(
            ...items.map(([key, label]) => createButton(session, 'nav', label, ButtonStyle.Primary, key))
        )
    ));

    const actionRow = new ActionRowBuilder().addComponents(
        createButton(session, 'nav', 'Изменения', ButtonStyle.Secondary, 'changes'),
        createButton(session, 'save', 'Сохранить', ButtonStyle.Success),
        createButton(session, 'cancel', 'Отменить', ButtonStyle.Danger),
    );

    return {
        content,
        components: [...navigationRows, actionRow].slice(0, 5),
    };
}

function renderFeatures(session, guild) {
    const content = [
        `## Настройки WN Helper - ${guild.name}`,
        formatStatus(session),
        '',
        'Нажатие на кнопку переключает состояние функции в текущей сессии.',
        ...FEATURE_DEFINITIONS.map(({ key, label }) => (
            `${session.draft.features?.[key] ? '✅' : '❌'} ${label}`
        )),
    ].join('\n');

    const firstRow = new ActionRowBuilder();
    const secondRow = new ActionRowBuilder();

    FEATURE_DEFINITIONS.forEach((definition, index) => {
        const enabled = Boolean(session.draft.features?.[definition.key]);
        const button = createButton(
            session,
            'feature',
            `${enabled ? '✅' : '❌'} ${definition.label}`,
            enabled ? ButtonStyle.Success : ButtonStyle.Secondary,
            definition.key
        );

        (index < 3 ? firstRow : secondRow).addComponents(button);
    });

    return {
        content,
        components: [firstRow, secondRow, createFooterRow(session)],
    };
}

function renderChannels(session, guild) {
    const selected = VISIBLE_CHANNEL_DEFINITIONS.find(({ key }) => key === session.selectedChannelKey) || null;
    const content = [
        `## Настройки WN Helper - ${guild.name}`,
        formatStatus(session),
        '',
        ...VISIBLE_CHANNEL_DEFINITIONS.map(({ key, label }) => {
            const prefix = selected?.key === key ? '→' : '•';
            const channelId = session.draft.channels?.[key];
            return `${prefix} ${label}: ${channelId ? `<#${channelId}>` : 'не выбран'}`;
        }),
        '',
        selected
            ? `Выбрана настройка: **${selected.label}**. Укажи канал ниже либо нажми "Очистить".`
            : 'Сначала выбери, какой канал нужно изменить.',
    ].join('\n');

    const settingSelect = new StringSelectMenuBuilder()
        .setCustomId(customId(session, 'channel_select'))
        .setPlaceholder('Выбрать настройку канала')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(VISIBLE_CHANNEL_DEFINITIONS.map(({ key, label }) => ({
            label,
            value: key,
            default: selected?.key === key,
        })));

    const components = [new ActionRowBuilder().addComponents(settingSelect)];

    if (selected) {
        const channelSelect = new ChannelSelectMenuBuilder()
            .setCustomId(customId(session, 'channel_set', selected.key))
            .setPlaceholder(`Выбрать: ${selected.label}`)
            .setMinValues(1)
            .setMaxValues(1)
            .setChannelTypes(...selected.channelTypes);

        components.push(new ActionRowBuilder().addComponents(channelSelect));
    }

    components.push(createFooterRow(session, selected ? {
        includeClear: {
            action: 'channel_clear',
            value: selected.key,
        },
    } : {}));

    return { content, components };
}

function renderCommonRoles(session, guild) {
    const selected = VISIBLE_COMMON_ROLE_DEFINITIONS.find(({ key }) => key === session.selectedRoleKey) || null;
    const content = [
        `## Настройки WN Helper - ${guild.name}`,
        formatStatus(session),
        '',
        ...VISIBLE_COMMON_ROLE_DEFINITIONS.map(({ key, label }) => {
            const prefix = selected?.key === key ? '→' : '•';
            const roleId = session.draft.commonRoles?.[key];
            return `${prefix} ${label}: ${roleId ? `<@&${roleId}>` : 'не выбрана'}`;
        }),
        '',
        selected
            ? `Выбрана настройка: **${selected.label}**. Укажи роль ниже либо нажми "Очистить".`
            : 'Сначала выбери, какую роль нужно изменить.',
    ].join('\n');

    const settingSelect = new StringSelectMenuBuilder()
        .setCustomId(customId(session, 'role_select'))
        .setPlaceholder('Выбрать настройку роли')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(VISIBLE_COMMON_ROLE_DEFINITIONS.map(({ key, label }) => ({
            label,
            value: key,
            default: selected?.key === key,
        })));

    const components = [new ActionRowBuilder().addComponents(settingSelect)];

    if (selected) {
        const roleSelect = new RoleSelectMenuBuilder()
            .setCustomId(customId(session, 'role_set', selected.key))
            .setPlaceholder(`Выбрать: ${selected.label}`)
            .setMinValues(1)
            .setMaxValues(1);

        components.push(new ActionRowBuilder().addComponents(roleSelect));
    }

    components.push(createFooterRow(session, selected ? {
        includeClear: {
            action: 'role_clear',
            value: selected.key,
        },
    } : {}));

    return { content, components };
}

function renderSettingsAccess(session, guild) {
    const managerRoleIds = session.draft.settingsManagerRoleIds || [];
    const limitedEntries = session.draft.settingsSectionAccess || [];
    const selectedRoleId = session.selectedSettingsAccessRoleId;
    const selected = limitedEntries.find((entry) => entry.roleId === selectedRoleId) || null;
    const sectionLabels = new Map(SETTINGS_SECTION_DEFINITIONS.map((entry) => [entry.key, entry.label]));
    const content = [
        `## Настройки WN Helper - ${guild.name}`,
        formatStatus(session),
        '',
        '### Полный доступ',
        managerRoleIds.length
            ? managerRoleIds.map((roleId) => `• <@&${roleId}>`).join('\n')
            : '• роли не выбраны',
        '',
        '### Ограниченный доступ по окнам',
        limitedEntries.length
            ? limitedEntries.map((entry) => (
                `• <@&${entry.roleId}>: ${entry.sectionKeys.map((key) => sectionLabels.get(key) || 'Неизвестный раздел').join(', ')}`
            )).join('\n')
            : '• правила не добавлены',
        '',
        selectedRoleId
            ? `Редактируется: <@&${selectedRoleId}>`
            : 'Выберите роль, затем разрешённые окна.',
        'Ограниченные роли не получают доступ к окнам управления доступом и не могут принудительно закрывать чужую сессию.',
    ].join('\n');

    const components = [];
    components.push(new ActionRowBuilder().addComponents(
        new RoleSelectMenuBuilder()
            .setCustomId(customId(session, 'settings_access_set'))
            .setPlaceholder('Роли с полным доступом к /settings')
            .setMinValues(1)
            .setMaxValues(25)
    ));
    components.push(new ActionRowBuilder().addComponents(
        createButton(session, 'settings_access_clear', 'Очистить полный доступ', ButtonStyle.Danger, 'all')
    ));
    components.push(new ActionRowBuilder().addComponents(
        new RoleSelectMenuBuilder()
            .setCustomId(customId(session, 'settings_access_limited_role'))
            .setPlaceholder('Роль для ограниченного доступа')
            .setMinValues(1)
            .setMaxValues(1)
    ));

    if (selectedRoleId) {
        const select = new StringSelectMenuBuilder()
            .setCustomId(customId(session, 'settings_access_limited_sections', selectedRoleId))
            .setPlaceholder('Разрешённые окна')
            .setMinValues(1)
            .setMaxValues(SETTINGS_SECTION_DEFINITIONS.length)
            .addOptions(SETTINGS_SECTION_DEFINITIONS.map((entry) => ({
                label: entry.label,
                value: entry.key,
                default: selected?.sectionKeys?.includes(entry.key) || false,
            })));
        components.push(new ActionRowBuilder().addComponents(select));
    }

    components.push(createFooterRow(session, selectedRoleId ? {
        includeClear: {
            action: 'settings_access_limited_remove',
            value: selectedRoleId,
        },
    } : {}));

    return { content, components: components.slice(0, 5) };
}

function renderManualToolsAccess(session, guild) {
    const entries = session.draft.manualToolsAccess || [];
    const selectedRoleId = session.selectedManualToolsAccessRoleId;
    const selected = entries.find((entry) => entry.roleId === selectedRoleId) || null;
    const labels = new Map(MANUAL_TOOLS_SUBCOMMAND_DEFINITIONS
        .map((entry) => [entry.key, entry.label]));
    const visibleEntries = entries.slice(0, 15);
    const selectedLabels = selected?.subcommandKeys
        ?.map((key) => labels.get(key) || key)
        .filter(Boolean) || [];
    const content = [
        `## Настройки WN Helper - ${guild.name}`,
        formatStatus(session),
        '',
        '### Доступ к /manualtools',
        entries.length
            ? [
                ...visibleEntries.map((entry) => (
                    `• <@&${entry.roleId}>: подкоманд - ${entry.subcommandKeys.length}`
                )),
                ...(entries.length > visibleEntries.length
                    ? [`• ещё правил: ${entries.length - visibleEntries.length}`]
                    : []),
            ].join('\n')
            : '• правила не добавлены',
        '',
        selectedRoleId
            ? `Редактируется: <@&${selectedRoleId}>`
            : 'Выберите роль, затем разрешённые подкоманды.',
        ...(selectedRoleId
            ? [selectedLabels.length
                ? `Разрешено: ${selectedLabels.join(', ')}`
                : 'Для выбранной роли подкоманды пока не разрешены.']
            : []),
        'Команды остановки инстанса и восстановления базы всегда остаются доступными только владельцам бота.',
        'Если для роли не выбрана ни одна подкоманда, правило доступа не сохраняется.',
    ].join('\n');

    const components = [new ActionRowBuilder().addComponents(
        new RoleSelectMenuBuilder()
            .setCustomId(customId(session, 'manual_tools_access_role'))
            .setPlaceholder('Роль для доступа к /manualtools')
            .setMinValues(1)
            .setMaxValues(1)
    )];

    if (selectedRoleId) {
        const select = new StringSelectMenuBuilder()
            .setCustomId(customId(session, 'manual_tools_access_subcommands', selectedRoleId))
            .setPlaceholder('Разрешённые подкоманды')
            .setMinValues(1)
            .setMaxValues(MANUAL_TOOLS_SUBCOMMAND_DEFINITIONS.length)
            .addOptions(MANUAL_TOOLS_SUBCOMMAND_DEFINITIONS.map((entry) => ({
                label: entry.label,
                value: entry.key,
                default: selected?.subcommandKeys?.includes(entry.key) || false,
            })));
        components.push(new ActionRowBuilder().addComponents(select));
    }

    components.push(createFooterRow(session, selectedRoleId ? {
        includeClear: {
            action: 'manual_tools_access_remove',
            value: selectedRoleId,
        },
    } : {}));

    return { content, components };
}

function renderDepartments(session, guild) {
    const departments = session.draft.departments || [];
    const pageCount = Math.max(Math.ceil(departments.length / DEPARTMENT_PAGE_SIZE), 1);
    const page = Math.min(Math.max(session.departmentPage || 0, 0), pageCount - 1);
    const pageDepartments = departments.slice(page * DEPARTMENT_PAGE_SIZE, (page + 1) * DEPARTMENT_PAGE_SIZE);
    const selected = getSelectedDepartment(session);
    const lines = [
        `## Настройки WN Helper - ${guild.name}`,
        formatStatus(session),
        '',
        `Настроено отделов: ${departments.length}.`,
    ];

    if (!departments.length) {
        lines.push('Отделы пока не добавлены.');
    } else {
        lines.push(`Список, страница ${page + 1}/${pageCount}:`);
        for (const department of pageDepartments) {
            const prefix = selected?.id === department.id ? '→' : '•';
            lines.push(`${prefix} ${formatDepartmentName(department)}`);
        }
    }

    if (selected) {
        lines.push(
            '',
            `Выбран отдел: **${formatDepartmentName(selected)}**.`,
            `Цвет состава: **${selected.color || 'автоматический'}**.`,
            `Кураторы: **${selected.curatorsEnabled === false ? 'выключены' : 'включены'}**.`,
            `Лимиты руководства: глав - **${selected.limits?.heads ?? 1}**, заместителей - **${selected.limits?.deputyHeads ?? 1}**.`
        );
    } else {
        lines.push('', 'Выбери отдел из списка либо добавь новый.');
    }

    const components = [];
    if (pageDepartments.length) {
        const select = new StringSelectMenuBuilder()
            .setCustomId(customId(session, 'department_select'))
            .setPlaceholder('Выбрать отдел')
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(pageDepartments.map((department) => ({
                label: formatDepartmentName(department).slice(0, 100),
                value: department.id,
                default: selected?.id === department.id,
            })));
        components.push(new ActionRowBuilder().addComponents(select));
    }

    const actions = new ActionRowBuilder().addComponents(
        createButton(session, 'department_add', 'Добавить', ButtonStyle.Success),
        createButton(session, 'department_edit', 'Основные настройки', ButtonStyle.Primary)
            .setDisabled(!selected),
        createButton(session, 'nav', 'Роли', ButtonStyle.Primary, 'departmentRoles')
            .setDisabled(!selected),
        createButton(session, 'nav', 'Канал состава', ButtonStyle.Primary, 'departmentChannel')
            .setDisabled(!selected),
        createButton(session, 'nav', 'Удалить', ButtonStyle.Danger, 'departmentDelete')
            .setDisabled(!selected),
    );
    components.push(actions);

    if (pageCount > 1) {
        components.push(new ActionRowBuilder().addComponents(
            createButton(session, 'department_page', 'Предыдущая страница', ButtonStyle.Secondary, page - 1)
                .setDisabled(page <= 0),
            createButton(session, 'department_page', 'Следующая страница', ButtonStyle.Secondary, page + 1)
                .setDisabled(page >= pageCount - 1),
        ));
    }

    components.push(createFooterRow(session));
    return { content: lines.join('\n'), components };
}

function renderDepartmentRoles(session, guild) {
    const department = getSelectedDepartment(session);
    if (!department) {
        session.section = 'departments';
        return renderDepartments(session, guild);
    }

    const selectedRole = DEPARTMENT_ROLE_DEFINITIONS
        .find(({ key }) => key === session.selectedDepartmentRoleKey) || null;
    const lines = [
        `## Настройки WN Helper - ${guild.name}`,
        formatStatus(session),
        '',
        `Отдел: **${formatDepartmentName(department)}**`,
        ...DEPARTMENT_ROLE_DEFINITIONS.map(({ key, label }) => {
            const prefix = selectedRole?.key === key ? '→' : '•';
            const roleId = department.roles?.[key];
            return `${prefix} ${label}: ${roleId ? `<@&${roleId}>` : 'не выбрана'}`;
        }),
        '',
        department.curatorsEnabled === false
            ? 'Кураторы этого отдела выключены и не выводятся в составах.'
            : department.roles?.curatorRoleId
                ? 'Куратор определяется по отдельной роли.'
                : 'Роль куратора не выбрана: куратор определяется по руководящей роли вместе с ролью главы отдела.',
        '',
        selectedRole
            ? `Выбрана настройка: **${selectedRole.label}**. Укажи роль ниже либо нажми "Очистить".`
            : 'Сначала выбери, какую роль отдела нужно изменить.',
    ];

    const fieldSelect = new StringSelectMenuBuilder()
        .setCustomId(customId(session, 'department_role_select'))
        .setPlaceholder('Выбрать роль отдела')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(DEPARTMENT_ROLE_DEFINITIONS.map(({ key, label }) => ({
            label,
            value: key,
            default: selectedRole?.key === key,
        })));

    const components = [new ActionRowBuilder().addComponents(fieldSelect)];
    if (selectedRole) {
        const roleSelect = new RoleSelectMenuBuilder()
            .setCustomId(customId(session, 'department_role_set', `${department.id}:${selectedRole.key}`))
            .setPlaceholder(`Выбрать: ${selectedRole.label}`)
            .setMinValues(1)
            .setMaxValues(1);
        components.push(new ActionRowBuilder().addComponents(roleSelect));
    }

    components.push(new ActionRowBuilder().addComponents(
        createButton(
            session,
            'department_curators_toggle',
            department.curatorsEnabled === false ? 'Кураторы: выключены' : 'Кураторы: включены',
            department.curatorsEnabled === false ? ButtonStyle.Secondary : ButtonStyle.Success,
            department.id
        )
    ));

    components.push(createFooterRow(session, {
        backSection: 'departments',
        includeClear: selectedRole ? {
            action: 'department_role_clear',
            value: `${department.id}:${selectedRole.key}`,
        } : null,
    }));

    return { content: lines.join('\n'), components };
}

function renderDepartmentChannel(session, guild) {
    const department = getSelectedDepartment(session);
    if (!department) {
        session.section = 'departments';
        return renderDepartments(session, guild);
    }

    const content = [
        `## Настройки WN Helper - ${guild.name}`,
        formatStatus(session),
        '',
        `Отдел: **${formatDepartmentName(department)}**`,
        `Канал состава: ${department.staffChannelId ? `<#${department.staffChannelId}>` : 'не выбран'}`,
        '',
        'Выбери текстовый канал ниже либо нажми "Очистить".',
    ].join('\n');

    const channelSelect = new ChannelSelectMenuBuilder()
        .setCustomId(customId(session, 'department_channel_set', department.id))
        .setPlaceholder('Выбрать канал состава отдела')
        .setMinValues(1)
        .setMaxValues(1)
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

    return {
        content,
        components: [
            new ActionRowBuilder().addComponents(channelSelect),
            createFooterRow(session, {
                backSection: 'departments',
                includeClear: {
                    action: 'department_channel_clear',
                    value: department.id,
                },
            }),
        ],
    };
}

function renderDepartmentDelete(session, guild) {
    const department = getSelectedDepartment(session);
    if (!department) {
        session.section = 'departments';
        return renderDepartments(session, guild);
    }

    const content = [
        `## Настройки WN Helper - ${guild.name}`,
        formatStatus(session),
        '',
        `Будет удалён отдел **${formatDepartmentName(department)}**.`,
        'Удаление попадёт только в текущую сессию и применится после сохранения настроек.',
    ].join('\n');

    const row = new ActionRowBuilder().addComponents(
        createButton(session, 'department_delete_confirm', 'Удалить отдел', ButtonStyle.Danger, department.id),
        createButton(session, 'nav', 'Назад', ButtonStyle.Secondary, 'departments'),
        createButton(session, 'save', 'Сохранить', ButtonStyle.Success),
        createButton(session, 'cancel', 'Отменить', ButtonStyle.Danger),
    );

    return { content, components: [row] };
}

function createDepartmentModal(session, department = null) {
    const isEdit = Boolean(department);
    const modal = new ModalBuilder()
        .setCustomId(customId(session, 'department_modal', department?.id || 'new'))
        .setTitle(isEdit ? 'Изменение отдела' : 'Добавление отдела');

    const shortName = new TextInputBuilder()
        .setCustomId('shortName')
        .setLabel('Сокращение')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(20);
    if (department?.shortName) shortName.setValue(department.shortName);

    const fullName = new TextInputBuilder()
        .setCustomId('fullName')
        .setLabel('Полное название')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100);
    if (department?.fullName) fullName.setValue(department.fullName);

    const heads = new TextInputBuilder()
        .setCustomId('heads')
        .setLabel('Максимальное количество глав')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(department?.limits?.heads ?? 1));

    const deputyHeads = new TextInputBuilder()
        .setCustomId('deputyHeads')
        .setLabel('Максимальное количество заместителей главы')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue(String(department?.limits?.deputyHeads ?? 1));

    const color = new TextInputBuilder()
        .setCustomId('color')
        .setLabel('Цвет состава отдела (#RRGGBB)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(7)
        .setPlaceholder('#2ECC71');
    if (department?.color) color.setValue(department.color);

    modal.addComponents(
        new ActionRowBuilder().addComponents(shortName),
        new ActionRowBuilder().addComponents(fullName),
        new ActionRowBuilder().addComponents(heads),
        new ActionRowBuilder().addComponents(deputyHeads),
        new ActionRowBuilder().addComponents(color),
    );

    return modal;
}


function renderRanks(session, guild) {
    const ranks = session.draft.ranks || [];
    const pageCount = Math.max(Math.ceil(ranks.length / RANK_PAGE_SIZE), 1);
    const page = Math.min(Math.max(session.rankPage || 0, 0), pageCount - 1);
    const pageRanks = ranks.slice(page * RANK_PAGE_SIZE, (page + 1) * RANK_PAGE_SIZE);
    const selected = getSelectedRank(session);
    const lines = [
        `## Настройки WN Helper - ${guild.name}`,
        formatStatus(session),
        '',
        `Настроено рангов: ${ranks.length}.`,
    ];

    if (!ranks.length) {
        lines.push('Ранги пока не добавлены.');
    } else {
        lines.push(`Список, страница ${page + 1}/${pageCount}:`);
        for (const rank of pageRanks) {
            const prefix = selected?.number === rank.number ? '→' : '•';
            const role = rank.roleId ? `<@&${rank.roleId}>` : 'без Discord-роли';
            const staffList = rank.staffList?.showInLeadership
                ? `в руководящем составе${rank.staffList.maxMembers ? `, лимит ${rank.staffList.maxMembers}` : ''}${rank.staffList.showAppointmentTerm ? ', со сроком назначения' : ''}`
                : 'не показывается в руководящем составе';
            lines.push(`${prefix} ${formatRankName(rank)} - ${role}; ${formatGrantPolicy(rank.grantPolicy)}; ${staffList}.`);
        }
    }

    lines.push('', selected
        ? `Выбран ранг: **${formatRankName(selected)}**.`
        : 'Выбери ранг из списка либо добавь новый.');

    const components = [];
    if (pageRanks.length) {
        const select = new StringSelectMenuBuilder()
            .setCustomId(customId(session, 'rank_select'))
            .setPlaceholder('Выбрать ранг')
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(pageRanks.map((rank) => ({
                label: formatRankName(rank).slice(0, 100),
                value: String(rank.number),
                default: selected?.number === rank.number,
            })));
        components.push(new ActionRowBuilder().addComponents(select));
    }

    components.push(new ActionRowBuilder().addComponents(
        createButton(session, 'rank_add', 'Добавить', ButtonStyle.Success),
        createButton(session, 'rank_edit', 'Название и номер', ButtonStyle.Primary)
            .setDisabled(!selected),
        createButton(session, 'nav', 'Discord-роль', ButtonStyle.Primary, 'rankRole')
            .setDisabled(!selected),
        createButton(session, 'nav', 'Правило выдачи', ButtonStyle.Primary, 'rankPolicy')
            .setDisabled(!selected),
        createButton(session, 'nav', 'Удалить', ButtonStyle.Danger, 'rankDelete')
            .setDisabled(!selected),
    ));

    const rulesRow = new ActionRowBuilder().addComponents(
        createButton(session, 'nav', 'Отображение в составе', ButtonStyle.Secondary, 'rankStaffList')
            .setDisabled(!selected),
    );
    if (pageCount > 1) {
        rulesRow.addComponents(
            createButton(session, 'rank_page', 'Предыдущая страница', ButtonStyle.Secondary, page - 1)
                .setDisabled(page <= 0),
            createButton(session, 'rank_page', 'Следующая страница', ButtonStyle.Secondary, page + 1)
                .setDisabled(page >= pageCount - 1),
        );
    }
    components.push(rulesRow);
    components.push(createFooterRow(session));
    return { content: lines.join('\n'), components };
}

function renderRankRole(session, guild) {
    const rank = getSelectedRank(session);
    if (!rank) {
        session.section = 'ranks';
        return renderRanks(session, guild);
    }

    const content = [
        `## Настройки WN Helper - ${guild.name}`,
        formatStatus(session),
        '',
        `Ранг: **${formatRankName(rank)}**`,
        `Discord-роль: ${rank.roleId ? `<@&${rank.roleId}>` : 'не выбрана'}`,
        '',
        'Если роль не выбрана, бот создаёт запись в кадровом аудите, но не изменяет роли сотрудника.',
    ].join('\n');

    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId(customId(session, 'rank_role_set', rank.number))
        .setPlaceholder('Выбрать Discord-роль ранга')
        .setMinValues(1)
        .setMaxValues(1);

    return {
        content,
        components: [
            new ActionRowBuilder().addComponents(roleSelect),
            createFooterRow(session, {
                backSection: 'ranks',
                includeClear: {
                    action: 'rank_role_clear',
                    value: rank.number,
                },
            }),
        ],
    };
}

function renderRankPolicy(session, guild) {
    const rank = getSelectedRank(session);
    if (!rank) {
        session.section = 'ranks';
        return renderRanks(session, guild);
    }

    const policy = rank.grantPolicy || { mode: null, roleIds: [] };
    const lines = [
        `## Настройки WN Helper - ${guild.name}`,
        formatStatus(session),
        '',
        `Ранг: **${formatRankName(rank)}**`,
        `Текущее правило: **${formatGrantPolicy(policy)}**.`,
    ];

    if (policy.mode === 'unrestricted') {
        lines.push('Дополнительная проверка ролей не выполняется. Доступ к команде настраивается через интеграции Discord.');
    } else if (policy.mode === 'roles') {
        lines.push('Разрешённые роли:');
        lines.push(policy.roleIds.length
            ? policy.roleIds.map((roleId) => `• <@&${roleId}>`).join('\n')
            : '• роли не выбраны');
        lines.push('', 'Выбор ниже полностью заменяет список ролей этого ранга.');
    } else if (policy.mode === 'disabled') {
        lines.push('Этот ранг нельзя выдать через команду бота.');
    } else {
        lines.push('Правило выдачи не настроено. Выбери один из вариантов ниже.');
    }

    const modeRow = new ActionRowBuilder().addComponents(
        createButton(session, 'rank_policy_mode', 'Без ограничений', policy.mode === 'unrestricted' ? ButtonStyle.Success : ButtonStyle.Secondary, 'unrestricted'),
        createButton(session, 'rank_policy_mode', 'Только выбранные роли', policy.mode === 'roles' ? ButtonStyle.Success : ButtonStyle.Secondary, 'roles'),
        createButton(session, 'rank_policy_mode', 'Запретить выдачу', policy.mode === 'disabled' ? ButtonStyle.Danger : ButtonStyle.Secondary, 'disabled'),
    );

    const components = [modeRow];
    if (policy.mode === 'roles') {
        components.push(new ActionRowBuilder().addComponents(
            new RoleSelectMenuBuilder()
                .setCustomId(customId(session, 'rank_policy_roles_set', rank.number))
                .setPlaceholder('Выбрать роли, которым разрешена выдача')
                .setMinValues(1)
                .setMaxValues(25)
        ));
    }

    components.push(createFooterRow(session, {
        backSection: 'ranks',
        includeClear: policy.mode === 'roles' ? {
            action: 'rank_policy_roles_clear',
            value: rank.number,
        } : null,
    }));

    return { content: lines.join('\n'), components };
}

function renderRankStaffList(session, guild) {
    const rank = getSelectedRank(session);
    if (!rank) {
        session.section = 'ranks';
        return renderRanks(session, guild);
    }

    const metadata = rank.staffList || {
        showInLeadership: false,
        maxMembers: null,
        showAppointmentTerm: false,
    };
    const content = [
        `## Настройки WN Helper - ${guild.name}`,
        formatStatus(session),
        '',
        `Ранг: **${formatRankName(rank)}**`,
        `Показывать в руководящем составе: **${metadata.showInLeadership ? 'да' : 'нет'}**`,
        `Лимит сотрудников: **${metadata.maxMembers ?? 'не установлен'}**`,
        `Показывать срок назначения: **${metadata.showAppointmentTerm ? 'да' : 'нет'}**`,
        '',
        'Срок назначения берётся из общей настройки составов.',
    ].join('\n');

    return {
        content,
        components: [
            new ActionRowBuilder().addComponents(
                createButton(
                    session,
                    'rank_staff_list_toggle',
                    metadata.showInLeadership ? 'Не показывать в составе' : 'Показывать в составе',
                    metadata.showInLeadership ? ButtonStyle.Danger : ButtonStyle.Success,
                    'show'
                ),
                createButton(
                    session,
                    'rank_staff_list_toggle',
                    metadata.showAppointmentTerm ? 'Скрыть срок назначения' : 'Показывать срок назначения',
                    metadata.showAppointmentTerm ? ButtonStyle.Danger : ButtonStyle.Secondary,
                    'term'
                ).setDisabled(!metadata.showInLeadership),
                createButton(session, 'rank_staff_list_limit_edit', 'Изменить лимит', ButtonStyle.Primary),
                createButton(session, 'rank_staff_list_limit_clear', 'Убрать лимит', ButtonStyle.Danger)
                    .setDisabled(metadata.maxMembers == null),
            ),
            createFooterRow(session, { backSection: 'ranks' }),
        ],
    };
}

function createRankStaffListLimitModal(session, rank) {
    const modal = new ModalBuilder()
        .setCustomId(customId(session, 'rank_staff_list_limit_modal', rank.number))
        .setTitle('Лимит руководящего состава');
    const input = new TextInputBuilder()
        .setCustomId('maxMembers')
        .setLabel('Максимальное количество сотрудников')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(4)
        .setPlaceholder('1');
    if (rank.staffList?.maxMembers) input.setValue(String(rank.staffList.maxMembers));
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return modal;
}

function renderRankDelete(session, guild) {
    const rank = getSelectedRank(session);
    if (!rank) {
        session.section = 'ranks';
        return renderRanks(session, guild);
    }

    const content = [
        `## Настройки WN Helper - ${guild.name}`,
        formatStatus(session),
        '',
        `Будет удалён ранг **${formatRankName(rank)}**.`,
        'Удаление попадёт только в текущую сессию и применится после сохранения настроек.',
    ].join('\n');

    return {
        content,
        components: [new ActionRowBuilder().addComponents(
            createButton(session, 'rank_delete_confirm', 'Удалить ранг', ButtonStyle.Danger, rank.number),
            createButton(session, 'nav', 'Назад', ButtonStyle.Secondary, 'ranks'),
            createButton(session, 'save', 'Сохранить', ButtonStyle.Success),
            createButton(session, 'cancel', 'Отменить', ButtonStyle.Danger),
        )],
    };
}

function createRankModal(session, rank = null) {
    const modal = new ModalBuilder()
        .setCustomId(customId(session, 'rank_modal', rank?.number ?? 'new'))
        .setTitle(rank ? 'Изменение ранга' : 'Добавление ранга');

    const number = new TextInputBuilder()
        .setCustomId('number')
        .setLabel('Номер ранга')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(4);
    if (rank?.number) number.setValue(String(rank.number));

    const name = new TextInputBuilder()
        .setCustomId('name')
        .setLabel('Название ранга')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(80);
    if (rank?.name) name.setValue(rank.name);

    modal.addComponents(
        new ActionRowBuilder().addComponents(number),
        new ActionRowBuilder().addComponents(name),
    );
    return modal;
}

function renderExams(session, guild) {
    const exams = session.draft.exams || [];
    const pageCount = Math.max(Math.ceil(exams.length / EXAM_PAGE_SIZE), 1);
    const page = Math.min(Math.max(session.examPage || 0, 0), pageCount - 1);
    const pageExams = exams.slice(page * EXAM_PAGE_SIZE, (page + 1) * EXAM_PAGE_SIZE);
    const selected = getSelectedExam(session);
    const selectedIndex = selected ? exams.findIndex((exam) => exam.id === selected.id) : -1;
    const lines = [
        `## Настройки WN Helper - ${guild.name}`,
        formatStatus(session),
        '',
        `Настроено экзаменов: ${exams.length}. Порядок используется в подсказках команды /sendexam.`,
    ];

    if (!exams.length) {
        lines.push('Экзамены пока не добавлены.');
    } else {
        lines.push(`Список, страница ${page + 1}/${pageCount}:`);
        for (const [pageIndex, exam] of pageExams.entries()) {
            const index = page * EXAM_PAGE_SIZE + pageIndex;
            const prefix = selected?.id === exam.id ? '→' : '•';
            const quickLink = exam.quickCheckUrl ? 'ссылка настроена' : 'без быстрой ссылки';
            lines.push(
                `${prefix} ${index + 1}. ${formatExamName(exam)} - testId: ${exam.testId || 'не указан'}; ` +
                `${exam.passScore ?? '?'}/${exam.maxScore ?? '?'}; попыток: ${exam.maxAttempts === 0 ? 'без ограничений' : (exam.maxAttempts ?? 2)}; ` +
                `пересдачи: ${exam.retestEnabled ? 'включены' : 'выключены'}; ${formatExamCheckMode(exam.checkMode)}; ${quickLink}.`
            );
        }
    }

    lines.push('', selected
        ? `Выбран экзамен: **${formatExamName(selected)}**.`
        : 'Выбери экзамен из списка либо добавь новый.');

    const components = [];
    if (pageExams.length) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(customId(session, 'exam_select'))
                .setPlaceholder('Выбрать экзамен')
                .setMinValues(1)
                .setMaxValues(1)
                .addOptions(pageExams.map((exam) => ({
                    label: formatExamName(exam).slice(0, 100),
                    description: `testId: ${exam.testId || 'не указан'}`.slice(0, 100),
                    value: exam.id,
                    default: selected?.id === exam.id,
                })))
        ));
    }

    components.push(new ActionRowBuilder().addComponents(
        createButton(session, 'exam_add', 'Добавить', ButtonStyle.Success),
        createButton(session, 'exam_edit', 'Название и ссылки', ButtonStyle.Primary).setDisabled(!selected),
        createButton(session, 'exam_scores_edit', 'Баллы', ButtonStyle.Primary).setDisabled(!selected),
        createButton(session, 'nav', 'Режим проверки', ButtonStyle.Primary, 'examMode').setDisabled(!selected),
        createButton(session, 'nav', 'Удалить', ButtonStyle.Danger, 'examDelete').setDisabled(!selected),
    ));

    components.push(new ActionRowBuilder().addComponents(
        createButton(session, 'exam_move', 'Выше', ButtonStyle.Secondary, 'up').setDisabled(selectedIndex <= 0),
        createButton(session, 'exam_move', 'Ниже', ButtonStyle.Secondary, 'down').setDisabled(selectedIndex < 0 || selectedIndex >= exams.length - 1),
        createButton(session, 'nav', 'Общие настройки', ButtonStyle.Primary, 'examinationGeneral'),
    ));

    if (pageCount > 1) {
        components.push(new ActionRowBuilder().addComponents(
            createButton(session, 'exam_page', 'Предыдущая страница', ButtonStyle.Secondary, page - 1).setDisabled(page <= 0),
            createButton(session, 'exam_page', 'Следующая страница', ButtonStyle.Secondary, page + 1).setDisabled(page >= pageCount - 1),
        ));
    }

    components.push(createFooterRow(session));
    return { content: lines.join('\n'), components };
}

function renderExamMode(session, guild) {
    const exam = getSelectedExam(session);
    if (!exam) {
        session.section = 'exams';
        return renderExams(session, guild);
    }

    const content = [
        `## Настройки WN Helper - ${guild.name}`,
        formatStatus(session),
        '',
        `Экзамен: **${formatExamName(exam)}**`,
        `Текущий режим: **${formatExamCheckMode(exam.checkMode)}**.`,
        `Пересдачи: **${exam.retestEnabled ? 'включены' : 'выключены'}**.`,
        '',
        exam.checkMode === 'manualScore'
            ? 'После выбора сдающего экзаменатор вводит балл, а бот сам определяет итог по проходному баллу.'
            : 'Баллы приходят из вебхука. Экзаменатор подтверждает либо переопределяет итог кнопками.',
    ].join('\n');

    return {
        content,
        components: [
            new ActionRowBuilder().addComponents(
                createButton(session, 'exam_mode_set', 'Автоматический результат', exam.checkMode === 'automatic' ? ButtonStyle.Success : ButtonStyle.Secondary, 'automatic'),
                createButton(session, 'exam_mode_set', 'Ручной ввод балла', exam.checkMode === 'manualScore' ? ButtonStyle.Success : ButtonStyle.Secondary, 'manualScore'),
            ),
            new ActionRowBuilder().addComponents(
                createButton(
                    session,
                    'exam_retest_toggle',
                    exam.retestEnabled ? 'Выключить пересдачи' : 'Включить пересдачи',
                    exam.retestEnabled ? ButtonStyle.Danger : ButtonStyle.Success,
                    exam.id
                ).setDisabled(exam.maxAttempts === 0)
            ),
            createFooterRow(session, { backSection: 'exams' }),
        ],
    };
}

function renderExamDelete(session, guild) {
    const exam = getSelectedExam(session);
    if (!exam) {
        session.section = 'exams';
        return renderExams(session, guild);
    }

    const content = [
        `## Настройки WN Helper - ${guild.name}`,
        formatStatus(session),
        '',
        `Будет удалён экзамен **${formatExamName(exam)}**.`,
        `testId: ${exam.testId || 'не указан'}`,
        'Удаление применится только после сохранения настроек.',
    ].join('\n');

    return {
        content,
        components: [new ActionRowBuilder().addComponents(
            createButton(session, 'exam_delete_confirm', 'Удалить экзамен', ButtonStyle.Danger, exam.id),
            createButton(session, 'nav', 'Назад', ButtonStyle.Secondary, 'exams'),
            createButton(session, 'save', 'Сохранить', ButtonStyle.Success),
            createButton(session, 'cancel', 'Отменить', ButtonStyle.Danger),
        )],
    };
}

function createExamModal(session, exam = null) {
    const modal = new ModalBuilder()
        .setCustomId(customId(session, 'exam_modal', exam?.id || 'new'))
        .setTitle(exam ? 'Изменение экзамена' : 'Добавление экзамена');

    const name = new TextInputBuilder()
        .setCustomId('name')
        .setLabel('Название экзамена')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100);
    if (exam?.name) name.setValue(exam.name);

    const testId = new TextInputBuilder()
        .setCustomId('testId')
        .setLabel('testId из Online Test Pad')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100);
    if (exam?.testId) testId.setValue(exam.testId);

    const quickCheckUrl = new TextInputBuilder()
        .setCustomId('quickCheckUrl')
        .setLabel('Ссылка быстрой проверки (необязательно)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(1000);
    if (exam?.quickCheckUrl) quickCheckUrl.setValue(exam.quickCheckUrl);

    modal.addComponents(
        new ActionRowBuilder().addComponents(name),
        new ActionRowBuilder().addComponents(testId),
        new ActionRowBuilder().addComponents(quickCheckUrl),
    );
    return modal;
}

function createExamScoresModal(session, exam) {
    const modal = new ModalBuilder()
        .setCustomId(customId(session, 'exam_scores_modal', exam.id))
        .setTitle(`Баллы: ${formatExamName(exam)}`.slice(0, 45));

    const maxScore = new TextInputBuilder()
        .setCustomId('maxScore')
        .setLabel('Максимальный балл')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(6);
    if (exam.maxScore != null) maxScore.setValue(String(exam.maxScore));

    const passScore = new TextInputBuilder()
        .setCustomId('passScore')
        .setLabel('Проходной балл')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(6);
    if (exam.passScore != null) passScore.setValue(String(exam.passScore));

    const maxAttempts = new TextInputBuilder()
        .setCustomId('maxAttempts')
        .setLabel('Максимум попыток (0 - без ограничений)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(3);
    maxAttempts.setValue(String(exam.maxAttempts ?? 2));

    modal.addComponents(
        new ActionRowBuilder().addComponents(maxScore),
        new ActionRowBuilder().addComponents(passScore),
        new ActionRowBuilder().addComponents(maxAttempts),
    );
    return modal;
}


function renderExaminationGeneral(session, guild) {
    const settings = session.draft.examinationSettings || {
        lectureRequestChannelId: null,
        retestRequestChannelId: null,
        lectureResultChannelId: null,
        retestResultChannelId: null,
        lectureVoiceChannelId: null,
        retestVoiceChannelId: null,
        voiceJoinTimeoutMinutes: 10,
        pendingReminderMinutes: 0,
        lectureTypes: [],
    };
    const retestExams = (session.draft.exams || [])
        .filter((exam) => exam.retestEnabled && exam.maxAttempts > 0);
    const commonExamResultChannelId = session.draft.channels?.examResultChannelId;
    const retestResultChannelText = settings.retestResultChannelId
        ? `<#${settings.retestResultChannelId}>`
        : commonExamResultChannelId
            ? `не выбран - используется общий канал результатов экзаменов <#${commonExamResultChannelId}>`
            : 'не выбран; общий канал результатов экзаменов также не настроен';
    const content = [
        `## Настройки WN Helper - ${guild.name}`,
        formatStatus(session),
        '',
        `Канал заявок на лекции: ${settings.lectureRequestChannelId ? `<#${settings.lectureRequestChannelId}>` : 'не выбран'}.`,
        `Канал заявок на пересдачи: ${settings.retestRequestChannelId ? `<#${settings.retestRequestChannelId}>` : 'не выбран'}.`,
        `Канал итогов лекций: ${settings.lectureResultChannelId ? `<#${settings.lectureResultChannelId}>` : 'не выбран'}.`,
        `Канал итогов пересдач: ${retestResultChannelText}.`,
        `Voice лекций: ${settings.lectureVoiceChannelId ? `<#${settings.lectureVoiceChannelId}>` : 'не выбран'}.`,
        `Voice пересдач: ${settings.retestVoiceChannelId ? `<#${settings.retestVoiceChannelId}>` : 'не выбран'}.`,
        `Время ожидания входа: **${settings.voiceJoinTimeoutMinutes || 10} мин.**`,
        `Повторный пинг по заявке: **${settings.pendingReminderMinutes > 0 ? `${settings.pendingReminderMinutes} мин.` : 'отключён'}**`,
        `Типов лекций: ${(settings.lectureTypes || []).length}.`,
        `Экзаменов с пересдачами: ${retestExams.length}.`,
        '',
        'Канал общей панели выбирается непосредственно перед публикацией.',
        'После принятия заявки бот автоматически отслеживает вход сотрудника и экзаменатора в voice соответствующего типа.',
    ].join('\n');

    return {
        content,
        components: [
            new ActionRowBuilder().addComponents(
                createButton(session, 'nav', 'Каналы', ButtonStyle.Primary, 'examinationChannels'),
                createButton(session, 'nav', 'Voice-каналы', ButtonStyle.Primary, 'examinationVoiceChannels'),
                createButton(session, 'nav', 'Типы лекций', ButtonStyle.Primary, 'lectureTypes'),
                createButton(session, 'examination_timeout_edit', 'Время ожидания', ButtonStyle.Secondary),
                createButton(session, 'publication_start', 'Опубликовать панель', ButtonStyle.Success, 'examination'),
            ),
            createFooterRow(session, { backSection: 'exams' }),
        ],
    };
}

function renderExaminationChannels(session, guild) {
    const settings = session.draft.examinationSettings || {};
    const commonExamResultChannelId = session.draft.channels?.examResultChannelId;
    const retestResultChannelText = settings.retestResultChannelId
        ? `<#${settings.retestResultChannelId}>`
        : commonExamResultChannelId
            ? `не выбран - используется <#${commonExamResultChannelId}>`
            : 'не выбран; общий канал результатов экзаменов также не настроен';
    const textChannelSelect = (key, placeholder) => new ChannelSelectMenuBuilder()
        .setCustomId(customId(session, 'examination_channel_set', key))
        .setPlaceholder(placeholder)
        .setMinValues(0)
        .setMaxValues(1)
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

    return {
        content: [
            `## Настройки WN Helper - ${guild.name}`,
            formatStatus(session),
            '',
            `Заявки на лекции: ${settings.lectureRequestChannelId ? `<#${settings.lectureRequestChannelId}>` : 'не выбран'}.`,
            `Заявки на пересдачи: ${settings.retestRequestChannelId ? `<#${settings.retestRequestChannelId}>` : 'не выбран'}.`,
            `Итоги лекций: ${settings.lectureResultChannelId ? `<#${settings.lectureResultChannelId}>` : 'не выбран'}.`,
            `Итоги пересдач: ${retestResultChannelText}.`,
            '',
            'Чтобы очистить значение, отправьте select без выбранного канала.',
        ].join('\n'),
        components: [
            new ActionRowBuilder().addComponents(textChannelSelect('lectureRequestChannelId', 'Канал заявок на лекции')),
            new ActionRowBuilder().addComponents(textChannelSelect('retestRequestChannelId', 'Канал заявок на пересдачи')),
            new ActionRowBuilder().addComponents(textChannelSelect('lectureResultChannelId', 'Канал итогов лекций')),
            new ActionRowBuilder().addComponents(textChannelSelect('retestResultChannelId', 'Отдельный канал итогов пересдач (необязательно)')),
            createFooterRow(session, { backSection: 'examinationGeneral' }),
        ],
    };
}

function renderExaminationVoiceChannels(session, guild) {
    const settings = session.draft.examinationSettings || {};
    const voiceChannelSelect = (key, placeholder) => new ChannelSelectMenuBuilder()
        .setCustomId(customId(session, 'examination_channel_set', key))
        .setPlaceholder(placeholder)
        .setMinValues(0)
        .setMaxValues(1)
        .setChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice);

    return {
        content: [
            `## Настройки WN Helper - ${guild.name}`,
            formatStatus(session),
            '',
            `Voice лекций: ${settings.lectureVoiceChannelId ? `<#${settings.lectureVoiceChannelId}>` : 'не выбран'}.`,
            `Voice пересдач: ${settings.retestVoiceChannelId ? `<#${settings.retestVoiceChannelId}>` : 'не выбран'}.`,
            '',
            'Один и тот же канал можно выбрать для обоих сценариев.',
            'Чтобы очистить значение, отправьте select без выбранного канала.',
        ].join('\n'),
        components: [
            new ActionRowBuilder().addComponents(
                voiceChannelSelect('lectureVoiceChannelId', 'Голосовой канал лекций')
            ),
            new ActionRowBuilder().addComponents(
                voiceChannelSelect('retestVoiceChannelId', 'Голосовой канал пересдач')
            ),
            createFooterRow(session, { backSection: 'examinationGeneral' }),
        ],
    };
}

function renderLectureTypes(session, guild) {
    const lectureTypes = session.draft.examinationSettings?.lectureTypes || [];
    const pageCount = Math.max(Math.ceil(lectureTypes.length / LECTURE_TYPE_PAGE_SIZE), 1);
    const page = Math.min(Math.max(session.lectureTypePage || 0, 0), pageCount - 1);
    const pageItems = lectureTypes.slice(
        page * LECTURE_TYPE_PAGE_SIZE,
        (page + 1) * LECTURE_TYPE_PAGE_SIZE
    );
    const selected = getSelectedLectureType(session);
    const selectedIndex = selected
        ? lectureTypes.findIndex((entry) => entry.id === selected.id)
        : -1;
    const lines = [
        `## Настройки WN Helper - ${guild.name}`,
        formatStatus(session),
        '',
        `Настроено типов лекций: ${lectureTypes.length}.`,
    ];
    if (!lectureTypes.length) {
        lines.push('Типы лекций пока не добавлены.');
    } else {
        lines.push(`Список, страница ${page + 1}/${pageCount}:`);
        for (const [pageIndex, entry] of pageItems.entries()) {
            const index = page * LECTURE_TYPE_PAGE_SIZE + pageIndex;
            const department = entry.departmentId
                ? getDepartments(session.draft).find((item) => item.id === entry.departmentId)
                : null;
            const routing = department
                ? `[${department.shortName}]`
                : `${(entry.pingRoleIds || []).length} рол.`;
            lines.push(`${selected?.id === entry.id ? '→' : '•'} ${index + 1}. ${entry.name} - ${routing}`);
        }
    }
    lines.push('', selected ? `Выбран тип лекции: **${selected.name}**.` : 'Выберите тип лекции либо добавьте новый.');

    const components = [];
    if (pageItems.length) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(customId(session, 'lecture_type_select'))
                .setPlaceholder('Выбрать тип лекции')
                .setMinValues(1)
                .setMaxValues(1)
                .addOptions(pageItems.map((entry) => ({
                    label: entry.name.slice(0, 100),
                    value: entry.id,
                    default: selected?.id === entry.id,
                })))
        ));
    }
    components.push(new ActionRowBuilder().addComponents(
        createButton(session, 'lecture_type_add', 'Добавить', ButtonStyle.Success),
        createButton(session, 'lecture_type_edit', 'Переименовать', ButtonStyle.Primary).setDisabled(!selected),
        createButton(session, 'nav', 'Настроить', ButtonStyle.Secondary, 'lectureTypeDetails').setDisabled(!selected),
        createButton(session, 'nav', 'Удалить', ButtonStyle.Danger, 'lectureTypeDelete').setDisabled(!selected),
    ));
    components.push(new ActionRowBuilder().addComponents(
        createButton(session, 'lecture_type_move', 'Выше', ButtonStyle.Secondary, 'up').setDisabled(selectedIndex <= 0),
        createButton(session, 'lecture_type_move', 'Ниже', ButtonStyle.Secondary, 'down').setDisabled(
            selectedIndex < 0 || selectedIndex >= lectureTypes.length - 1
        ),
    ));
    if (pageCount > 1) {
        components.push(new ActionRowBuilder().addComponents(
            createButton(session, 'lecture_type_page', 'Предыдущая страница', ButtonStyle.Secondary, page - 1).setDisabled(page <= 0),
            createButton(session, 'lecture_type_page', 'Следующая страница', ButtonStyle.Secondary, page + 1).setDisabled(page >= pageCount - 1),
        ));
    }
    components.push(createFooterRow(session, { backSection: 'examinationGeneral' }));
    return { content: lines.join('\n'), components };
}

function renderLectureTypeDetails(session, guild) {
    const lectureType = getSelectedLectureType(session);
    if (!lectureType) {
        session.section = 'lectureTypes';
        return renderLectureTypes(session, guild);
    }
    const departments = getDepartments(session.draft);
    const department = lectureType.departmentId
        ? departments.find((entry) => entry.id === lectureType.departmentId) || null
        : null;
    const derivedRoleIds = department
        ? [department.roles?.headRoleId, department.roles?.deputyHeadRoleId].filter(Boolean)
        : [];
    const explicitRoleIds = lectureType.pingRoleIds || [];
    const activeRoleIds = department ? derivedRoleIds : explicitRoleIds;

    const departmentSelect = new StringSelectMenuBuilder()
        .setCustomId(customId(session, 'lecture_type_department_set'))
        .setPlaceholder('Отдел не выбран - используются роли ниже')
        .setMinValues(0)
        .setMaxValues(1)
        .addOptions(departments.slice(0, 25).map((entry) => ({
            label: entry.shortName.slice(0, 100),
            description: String(entry.fullName || entry.shortName).slice(0, 100),
            value: entry.id,
            default: entry.id === lectureType.departmentId,
        })));
    const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId(customId(session, 'lecture_type_roles_set'))
        .setPlaceholder('Роли для пинга, когда отдел не выбран')
        .setMinValues(0)
        .setMaxValues(10);
    if (explicitRoleIds.length && typeof roleSelect.setDefaultRoles === 'function') {
        roleSelect.setDefaultRoles(...explicitRoleIds);
    }

    return {
        content: [
            `## Настройки WN Helper - ${guild.name}`,
            formatStatus(session),
            '',
            `Тип лекции: **${lectureType.name}**.`,
            `Отдел: ${department ? `**${department.shortName} - ${department.fullName}**` : 'не выбран'}.`,
            `Активные роли обработки: ${activeRoleIds.length ? activeRoleIds.map((id) => `<@&${id}>`).join(', ') : '**не выбраны**'}.`,
            '',
            department
                ? 'При выбранном отделе пингуются его действующие роли главы и заместителя главы.'
                : 'Если отдел не выбран, необходимо выбрать хотя бы одну роль для пинга.',
            'Выбор отдела очищает явные роли, а выбор ролей убирает отдел: используется только один способ маршрутизации.',
        ].join('\n'),
        components: [
            ...(departments.length ? [new ActionRowBuilder().addComponents(departmentSelect)] : []),
            new ActionRowBuilder().addComponents(roleSelect),
            new ActionRowBuilder().addComponents(
                createButton(session, 'lecture_type_department_clear', 'Убрать отдел', ButtonStyle.Secondary)
                    .setDisabled(!lectureType.departmentId),
                createButton(session, 'lecture_type_roles_clear', 'Очистить роли', ButtonStyle.Danger)
                    .setDisabled(!explicitRoleIds.length),
                createButton(session, 'lecture_type_edit', 'Переименовать', ButtonStyle.Primary),
            ),
            createFooterRow(session, { backSection: 'lectureTypes' }),
        ],
    };
}

function renderLectureTypeDelete(session, guild) {
    const lectureType = getSelectedLectureType(session);
    if (!lectureType) {
        session.section = 'lectureTypes';
        return renderLectureTypes(session, guild);
    }
    return {
        content: [
            `## Настройки WN Helper - ${guild.name}`,
            formatStatus(session),
            '',
            `Будет удалён тип лекции **${lectureType.name}**.`,
            'Удаление применится только после сохранения настроек.',
        ].join('\n'),
        components: [new ActionRowBuilder().addComponents(
            createButton(session, 'lecture_type_delete_confirm', 'Удалить', ButtonStyle.Danger, lectureType.id),
            createButton(session, 'nav', 'Назад', ButtonStyle.Secondary, 'lectureTypes'),
            createButton(session, 'save', 'Сохранить', ButtonStyle.Success),
            createButton(session, 'cancel', 'Отменить', ButtonStyle.Danger),
        )],
    };
}

function createLectureTypeModal(session, lectureType = null) {
    const modal = new ModalBuilder()
        .setCustomId(customId(session, 'lecture_type_modal', lectureType?.id || 'new'))
        .setTitle(lectureType ? 'Изменение типа лекции' : 'Добавление типа лекции');
    const name = new TextInputBuilder()
        .setCustomId('name')
        .setLabel('Название лекции')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100);
    if (lectureType?.name) name.setValue(lectureType.name);
    modal.addComponents(new ActionRowBuilder().addComponents(name));
    return modal;
}

function createExaminationTimeoutModal(session) {
    const current = session.draft.examinationSettings?.voiceJoinTimeoutMinutes || 10;
    const reminder = session.draft.examinationSettings?.pendingReminderMinutes || 0;
    return new ModalBuilder()
        .setCustomId(customId(session, 'examination_timeout_modal'))
        .setTitle('Сроки экзаменации')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('minutes')
                    .setLabel('Ожидание voice, минуты (1-180)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMinLength(1)
                    .setMaxLength(3)
                    .setValue(String(current))
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('pendingReminderMinutes')
                    .setLabel('Повторный пинг, минуты (0 - выкл.)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMinLength(1)
                    .setMaxLength(4)
                    .setValue(String(reminder))
            )
        );
}

function renderPublicationPreview(session, guild) {
    const kind = session.publicationKind;
    const definitions = {
        examination: {
            title: 'Общая панель экзаменации',
            returnSection: 'examinationGeneral',
            description: 'Состав кнопок выбирается перед публикацией.',
            fixedChannelId: null,
        },
        giveRoles: {
            title: 'Панель заявок на выдачу ролей',
            returnSection: 'giveRoles',
            description: 'Сообщение с кнопкой подачи заявки на начальные роли.',
            fixedChannelId: session.draft.channels?.getRoleChannelId || null,
        },
        kaInfo: {
            title: 'Справка кадрового аудита',
            returnSection: 'staffAudit',
            description: 'Шесть сообщений с подробной справкой по кадровым командам.',
            fixedChannelId: null,
        },
        vacation: {
            title: 'Панель отпусков',
            returnSection: 'vacations',
            description: 'Сообщение с одной кнопкой подачи заявки на отпуск.',
            fixedChannelId: null,
        },
        discordRules: {
            title: 'Правила Discord',
            returnSection: 'publications',
            description: 'Официальные правила тестового сервера WN Helper.',
            fixedChannelId: null,
        },
    };
    const definition = definitions[kind];
    if (!definition) {
        session.section = 'main';
        return renderMain(session, guild);
    }
    const existing = session.publicationExisting || null;
    const publicationMode = session.publicationMode === 'update' && existing ? 'update' : 'new';
    const channelId = publicationMode === 'update'
        ? existing.channelId
        : definition.fixedChannelId || session.publicationChannelId || null;
    const hasUnsavedChanges = (session.changes || []).length > 0;
    const examinationMode = ['lecture', 'retest', 'both'].includes(session.publicationExaminationMode)
        ? session.publicationExaminationMode
        : 'both';
    const examinationModeLabel = {
        lecture: 'только лекции',
        retest: 'только пересдачи',
        both: 'лекции и пересдачи',
    }[examinationMode];
    const content = [
        `## Настройки WN Helper - ${guild.name}`,
        formatStatus(session),
        '',
        `Публикация: **${definition.title}**`,
        definition.description,
        `Режим: **${publicationMode === 'update' ? 'обновить существующее сообщение' : 'опубликовать новое сообщение'}**.`,
        existing
            ? `Текущее сообщение: https://discord.com/channels/${guild.id}/${existing.channelId}/${existing.messageIds?.[0] || ''}`
            : 'Ранее опубликованное сообщение не зарегистрировано.',
        ...(kind === 'examination' ? [`Кнопки панели: **${examinationModeLabel}**.`] : []),
        `Канал: ${channelId ? `<#${channelId}>` : 'не выбран'}.`,
        '',
        hasUnsavedChanges
            ? 'Сначала сохраните изменения настроек, затем повторите публикацию.'
            : 'После подтверждения сообщение будет сразу отправлено в выбранный канал.',
    ].join('\n');
    const components = [];
    if (kind === 'examination') {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(customId(session, 'publication_examination_mode'))
                .setPlaceholder('Выбрать состав панели')
                .setMinValues(1)
                .setMaxValues(1)
                .addOptions(
                    { label: 'Только лекции', value: 'lecture', default: examinationMode === 'lecture' },
                    { label: 'Только пересдачи', value: 'retest', default: examinationMode === 'retest' },
                    { label: 'Лекции и пересдачи', value: 'both', default: examinationMode === 'both' },
                )
        ));
    }
    components.push(new ActionRowBuilder().addComponents(
        createButton(session, 'publication_mode', 'Новое сообщение', ButtonStyle.Primary, 'new')
            .setDisabled(publicationMode === 'new'),
        createButton(session, 'publication_mode', 'Обновить существующее', ButtonStyle.Secondary, 'update')
            .setDisabled(publicationMode === 'update' || !existing),
    ));
    if (publicationMode === 'new' && !definition.fixedChannelId) {
        components.push(new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
                .setCustomId(customId(session, 'publication_channel_set', kind))
                .setPlaceholder('Выбрать канал публикации')
                .setMinValues(1)
                .setMaxValues(1)
                .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        ));
    }
    components.push(new ActionRowBuilder().addComponents(
        createButton(
            session,
            'publication_confirm',
            publicationMode === 'update' ? 'Обновить' : 'Опубликовать',
            ButtonStyle.Success,
            kind
        )
            .setDisabled(!channelId || hasUnsavedChanges),
        createButton(session, 'publication_back', 'Назад', ButtonStyle.Secondary, definition.returnSection),
        createButton(session, 'cancel', 'Закрыть настройки', ButtonStyle.Danger),
    ));
    return { content, components };
}

function renderGiveRoles(session, guild) {
    const settings = session.draft.giveRolesSettings || {};
    const selected = GIVE_ROLES_SETTING_DEFINITIONS
        .find(({ key }) => key === session.selectedGiveRolesKey) || null;
    const departments = session.draft.departments || [];
    const ranks = session.draft.ranks || [];
    const department = departments
        .find((entry) => entry.id === settings.inviteDepartmentId) || null;
    const dbRank = ranks
        .find((entry) => entry.number === settings.dbRankNumber) || null;

    const formatRoleList = (roleIds) => (
        Array.isArray(roleIds) && roleIds.length
            ? roleIds.map((roleId) => `<@&${roleId}>`).join(', ')
            : 'не выбраны'
    );

    const values = {
        inviteDepartmentId: department ? formatDepartmentName(department) : 'не выбран',
        dbRankNumber: dbRank ? formatRankName(dbRank) : 'не выбран',
        dbAdditionalRoleIds: formatRoleList(settings.dbAdditionalRoleIds),
        reviewerRoleIds: formatRoleList(settings.reviewerRoleIds),
        blockerRoleIds: formatRoleList(settings.blockerRoleIds),
    };

    const lines = [
        `## Настройки WN Helper - ${guild.name}`,
        formatStatus(session),
        '',
        ...GIVE_ROLES_SETTING_DEFINITIONS.map(({ key, label }) => {
            const prefix = selected?.key === key ? '→' : '•';
            return `${prefix} ${label}: ${values[key]}`;
        }),
        '',
        settings.dbRankNumber
            ? 'Кнопка "Одобрить (ДБ)" будет доступна в новых заявках.'
            : 'Ранг при ДБ не выбран: кнопка "Одобрить (ДБ)" не будет отображаться.',
        settings.blockerRoleIds?.length
            ? 'Кнопка "Заблокировать" будет доступна в новых заявках.'
            : 'Роли блокировки не выбраны: кнопка "Заблокировать" не будет отображаться.',
        '',
        selected
            ? `Выбрана настройка: **${selected.label}**. Укажи значение ниже либо нажми "Очистить".`
            : 'Сначала выбери настройку выдачи ролей.',
    ];

    const fieldSelect = new StringSelectMenuBuilder()
        .setCustomId(customId(session, 'give_roles_field_select'))
        .setPlaceholder('Выбрать настройку выдачи ролей')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(GIVE_ROLES_SETTING_DEFINITIONS.map(({ key, label }) => ({
            label,
            value: key,
            default: selected?.key === key,
        })));

    const components = [new ActionRowBuilder().addComponents(fieldSelect)];

    if (selected?.key === 'inviteDepartmentId' && departments.length) {
        const pageCount = Math.max(Math.ceil(departments.length / GIVE_ROLES_SELECT_PAGE_SIZE), 1);
        const page = Math.min(Math.max(session.giveRolesDepartmentPage || 0, 0), pageCount - 1);
        const pageDepartments = departments.slice(
            page * GIVE_ROLES_SELECT_PAGE_SIZE,
            (page + 1) * GIVE_ROLES_SELECT_PAGE_SIZE
        );
        session.giveRolesDepartmentPage = page;

        const departmentSelect = new StringSelectMenuBuilder()
            .setCustomId(customId(session, 'give_roles_department_set'))
            .setPlaceholder(`Выбрать отдел при принятии (${page + 1}/${pageCount})`)
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(pageDepartments.map((entry) => ({
                label: formatDepartmentName(entry).slice(0, 100),
                value: entry.id,
                default: entry.id === settings.inviteDepartmentId,
            })));
        components.push(new ActionRowBuilder().addComponents(departmentSelect));

        if (pageCount > 1) {
            components.push(new ActionRowBuilder().addComponents(
                createButton(
                    session,
                    'give_roles_page',
                    'Предыдущая страница',
                    ButtonStyle.Secondary,
                    `department:${page - 1}`
                ).setDisabled(page <= 0),
                createButton(
                    session,
                    'give_roles_page',
                    'Следующая страница',
                    ButtonStyle.Secondary,
                    `department:${page + 1}`
                ).setDisabled(page >= pageCount - 1),
            ));
        }
    }

    if (selected?.key === 'dbRankNumber' && ranks.length) {
        const pageCount = Math.max(Math.ceil(ranks.length / GIVE_ROLES_SELECT_PAGE_SIZE), 1);
        const page = Math.min(Math.max(session.giveRolesRankPage || 0, 0), pageCount - 1);
        const pageRanks = ranks.slice(
            page * GIVE_ROLES_SELECT_PAGE_SIZE,
            (page + 1) * GIVE_ROLES_SELECT_PAGE_SIZE
        );
        session.giveRolesRankPage = page;

        const rankSelect = new StringSelectMenuBuilder()
            .setCustomId(customId(session, 'give_roles_rank_set'))
            .setPlaceholder(`Выбрать ранг при ДБ (${page + 1}/${pageCount})`)
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(pageRanks.map((rank) => ({
                label: formatRankName(rank).slice(0, 100),
                value: String(rank.number),
                default: rank.number === settings.dbRankNumber,
            })));
        components.push(new ActionRowBuilder().addComponents(rankSelect));

        if (pageCount > 1) {
            components.push(new ActionRowBuilder().addComponents(
                createButton(
                    session,
                    'give_roles_page',
                    'Предыдущая страница',
                    ButtonStyle.Secondary,
                    `rank:${page - 1}`
                ).setDisabled(page <= 0),
                createButton(
                    session,
                    'give_roles_page',
                    'Следующая страница',
                    ButtonStyle.Secondary,
                    `rank:${page + 1}`
                ).setDisabled(page >= pageCount - 1),
            ));
        }
    }

    if (selected?.valueType === 'roles') {
        const roleSelect = new RoleSelectMenuBuilder()
            .setCustomId(customId(session, 'give_roles_roles_set', selected.key))
            .setPlaceholder(`Выбрать: ${selected.label}`)
            .setMinValues(1)
            .setMaxValues(25);
        components.push(new ActionRowBuilder().addComponents(roleSelect));
    }

    components.push(new ActionRowBuilder().addComponents(
        createButton(session, 'publication_start', 'Опубликовать панель заявок', ButtonStyle.Primary, 'giveRoles')
    ));

    components.push(createFooterRow(session, selected ? {
        includeClear: {
            action: 'give_roles_clear',
            value: selected.key,
        },
    } : {}));

    return { content: lines.join('\n'), components };
}

function renderStaffAudit(session, guild) {
    const settings = session.draft.staffAuditSettings || {};
    const selected = STAFF_AUDIT_SETTING_DEFINITIONS
        .find(({ key }) => key === session.selectedStaffAuditKey) || null;
    const ranks = session.draft.ranks || [];
    const transitionRank = ranks
        .find((rank) => rank.number === settings.departmentTransitionRankNumber) || null;

    const formatRoleList = (roleIds) => (
        Array.isArray(roleIds) && roleIds.length
            ? roleIds.map((roleId) => `<@&${roleId}>`).join(', ')
            : 'не выбраны'
    );

    const values = {
        channelId: settings.channelId ? `<#${settings.channelId}>` : 'не выбран',
        deleteRequestChannelId: settings.deleteRequestChannelId
            ? `<#${settings.deleteRequestChannelId}>`
            : 'не выбран',
        deleteNotifyRoleIds: formatRoleList(settings.deleteNotifyRoleIds),
        departmentTransitionRankNumber: transitionRank
            ? formatRankName(transitionRank)
            : 'не выбран',
        dismissalKeepRoleIds: formatRoleList(settings.dismissalKeepRoleIds),
        massAuditMaxItems: String(settings.massAuditMaxItems),
        dismissalApprovalChannelId: settings.dismissalApprovalChannelId
            ? `<#${settings.dismissalApprovalChannelId}>`
            : 'не выбран',
        dismissalApprovalRoleIds: formatRoleList(settings.dismissalApprovalRoleIds),
        dismissalLimitExemptRoleIds: formatRoleList(settings.dismissalLimitExemptRoleIds),
        dismissalLimitCount: String(settings.dismissalLimitCount),
        dismissalLimitWindowMinutes: String(settings.dismissalLimitWindowMinutes),
        promotionLimitBypassRoleIds: formatRoleList(settings.promotionLimitBypassRoleIds),
    };

    const lines = [
        `## Настройки WN Helper - ${guild.name}`,
        formatStatus(session),
        '',
        ...STAFF_AUDIT_SETTING_DEFINITIONS.map(({ key, label }) => {
            const prefix = selected?.key === key ? '→' : '•';
            return `${prefix} ${label}: ${values[key]}`;
        }),
        '',
        'Правила каждого ранга определяют допустимость его выдачи, а доступ к одиночным командам настраивается через интеграции Discord.',
        `Лимит увольнений: ${settings.dismissalLimitCount} за ${settings.dismissalLimitWindowMinutes} мин. на одного исполнителя.`,
        settings.departmentTransitionRankNumber
            ? `Автосмена стажировочного отдела срабатывает при пересечении ${settings.departmentTransitionRankNumber} ранга.`
            : 'Автосмена стажировочного отдела через /rank отключена.',
        '',
        selected
            ? `Выбрана настройка: **${selected.label}**. Укажи значение ниже либо нажми "Очистить".`
            : 'Сначала выбери настройку кадрового аудита.',
    ];

    const fieldSelect = new StringSelectMenuBuilder()
        .setCustomId(customId(session, 'staff_audit_field_select'))
        .setPlaceholder('Выбрать настройку кадрового аудита')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(STAFF_AUDIT_SETTING_DEFINITIONS.map(({ key, label }) => ({
            label,
            value: key,
            default: selected?.key === key,
        })));

    const components = [new ActionRowBuilder().addComponents(fieldSelect)];

    if (selected?.valueType === 'channel') {
        const channelSelect = new ChannelSelectMenuBuilder()
            .setCustomId(customId(session, 'staff_audit_channel_set', selected.key))
            .setPlaceholder(`Выбрать: ${selected.label}`)
            .setMinValues(1)
            .setMaxValues(1)
            .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
        components.push(new ActionRowBuilder().addComponents(channelSelect));
    }

    if (selected?.valueType === 'roles') {
        const roleSelect = new RoleSelectMenuBuilder()
            .setCustomId(customId(session, 'staff_audit_roles_set', selected.key))
            .setPlaceholder(`Выбрать: ${selected.label}`)
            .setMinValues(1)
            .setMaxValues(25);
        components.push(new ActionRowBuilder().addComponents(roleSelect));
    }

    if (selected?.valueType === 'integer') {
        components.push(new ActionRowBuilder().addComponents(
            createButton(session, 'staff_audit_integer_edit', 'Изменить значение', ButtonStyle.Primary, selected.key)
        ));
    }

    if (selected?.valueType === 'rank' && ranks.length) {
        const pageCount = Math.max(Math.ceil(ranks.length / STAFF_AUDIT_SELECT_PAGE_SIZE), 1);
        const page = Math.min(Math.max(session.staffAuditRankPage || 0, 0), pageCount - 1);
        const pageRanks = ranks.slice(
            page * STAFF_AUDIT_SELECT_PAGE_SIZE,
            (page + 1) * STAFF_AUDIT_SELECT_PAGE_SIZE
        );
        session.staffAuditRankPage = page;

        const rankSelect = new StringSelectMenuBuilder()
            .setCustomId(customId(session, 'staff_audit_rank_set'))
            .setPlaceholder(`Выбрать переходный ранг (${page + 1}/${pageCount})`)
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(pageRanks.map((rank) => ({
                label: formatRankName(rank).slice(0, 100),
                value: String(rank.number),
                default: rank.number === settings.departmentTransitionRankNumber,
            })));
        components.push(new ActionRowBuilder().addComponents(rankSelect));

        if (pageCount > 1) {
            components.push(new ActionRowBuilder().addComponents(
                createButton(
                    session,
                    'staff_audit_rank_page',
                    'Предыдущая страница',
                    ButtonStyle.Secondary,
                    String(page - 1)
                ).setDisabled(page <= 0),
                createButton(
                    session,
                    'staff_audit_rank_page',
                    'Следующая страница',
                    ButtonStyle.Secondary,
                    String(page + 1)
                ).setDisabled(page >= pageCount - 1),
            ));
        }
    }

    components.push(new ActionRowBuilder().addComponents(
        createButton(session, 'publication_start', 'Опубликовать справку КА', ButtonStyle.Primary, 'kaInfo')
    ));

    components.push(createFooterRow(session, selected ? {
        includeClear: {
            action: 'staff_audit_clear',
            value: selected.key,
        },
    } : {}));

    return { content: lines.join('\n'), components };
}


function createStaffListDateModal(session) {
    const modal = new ModalBuilder()
        .setCustomId(customId(session, 'staff_lists_date_modal'))
        .setTitle('Дата назначения директора');
    const input = new TextInputBuilder()
        .setCustomId('leaderAppointmentDate')
        .setLabel('Дата в формате YYYY-MM-DD')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(10)
        .setMaxLength(10)
        .setPlaceholder('2026-07-01');
    const currentValue = session.draft.staffListSettings?.leaderAppointmentDate;
    if (currentValue) input.setValue(currentValue);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return modal;
}

function createStaffAuditIntegerModal(session, key) {
    const definition = STAFF_AUDIT_SETTING_DEFINITIONS.find((entry) => entry.key === key);
    if (!definition || definition.valueType !== 'integer') return null;

    const modal = new ModalBuilder()
        .setCustomId(customId(session, 'staff_audit_integer_modal', key))
        .setTitle(definition.label.slice(0, 45));

    const input = new TextInputBuilder()
        .setCustomId('value')
        .setLabel(definition.label.slice(0, 45))
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(6)
        .setValue(String(session.draft.staffAuditSettings?.[key] ?? ''));

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return modal;
}

function renderStaffLists(session, guild) {
    const settings = session.draft.staffListSettings || {};
    const selected = STAFF_LIST_SETTING_DEFINITIONS
        .find(({ key }) => key === session.selectedStaffListKey) || null;
    const values = {
        highStaffChannelId: settings.highStaffChannelId
            ? `<#${settings.highStaffChannelId}>`
            : 'не выбран',
        leaderAppointmentDate: settings.leaderAppointmentDate || 'не указана',
        leaderTermDays: `${settings.leaderTermDays || 30} дн.`,
        curatorManagementRankNumbers: settings.curatorManagementRankNumbers?.length
            ? settings.curatorManagementRankNumbers.map((number) => `${number} ранг`).join(', ')
            : 'не выбраны',
    };
    const lines = [
        `## Настройки WN Helper - ${guild.name}`,
        formatStatus(session),
        '',
        ...STAFF_LIST_SETTING_DEFINITIONS.map(({ key, label }) => {
            const prefix = selected?.key === key ? '→' : '•';
            return `${prefix} ${label}: ${values[key]}`;
        }),
        '',
        'Каналы составов конкретных отделов настраиваются внутри раздела "Отделы".',
        'Ранги руководящего состава и отображение срока настраиваются внутри раздела "Ранги".',
        '',
        selected
            ? `Выбрана настройка: **${selected.label}**. Укажи значение ниже либо нажми "Очистить".`
            : 'Сначала выбери настройку составов.',
    ];

    const fieldSelect = new StringSelectMenuBuilder()
        .setCustomId(customId(session, 'staff_lists_field_select'))
        .setPlaceholder('Выбрать настройку составов')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(STAFF_LIST_SETTING_DEFINITIONS.map(({ key, label }) => ({
            label,
            value: key,
            default: selected?.key === key,
        })));
    const components = [new ActionRowBuilder().addComponents(fieldSelect)];

    if (selected?.valueType === 'channel') {
        const channelSelect = new ChannelSelectMenuBuilder()
            .setCustomId(customId(session, 'staff_lists_channel_set', selected.key))
            .setPlaceholder(`Выбрать: ${selected.label}`)
            .setMinValues(1)
            .setMaxValues(1)
            .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
        components.push(new ActionRowBuilder().addComponents(channelSelect));
    }

    if (selected?.valueType === 'date') {
        components.push(new ActionRowBuilder().addComponents(
            createButton(session, 'staff_lists_date_edit', 'Изменить дату', ButtonStyle.Primary)
        ));
    }

    if (selected?.valueType === 'integer' && selected.key === 'leaderTermDays') {
        components.push(new ActionRowBuilder().addComponents(
            createButton(
                session,
                'staff_lists_term_toggle',
                `Использовать ${settings.leaderTermDays === 31 ? 30 : 31} дн.`,
                ButtonStyle.Primary
            )
        ));
    }

    if (selected?.valueType === 'rankList') {
        const ranks = session.draft.ranks || [];
        if (ranks.length) {
            components.push(new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(customId(session, 'staff_lists_ranks_set', selected.key))
                    .setPlaceholder('Выбрать ранги руководства')
                    .setMinValues(1)
                    .setMaxValues(Math.min(ranks.length, 25))
                    .addOptions(ranks.slice(0, 25).map((rank) => ({
                        label: formatRankName(rank).slice(0, 100),
                        value: String(rank.number),
                        default: settings.curatorManagementRankNumbers?.includes(rank.number),
                    })))
            ));
        } else {
            lines.push('', 'Сначала добавь хотя бы один ранг.');
        }
    }

    components.push(createFooterRow(session, selected ? {
        includeClear: {
            action: 'staff_lists_clear',
            value: selected.key,
        },
    } : {}));

    return { content: lines.join('\n'), components };
}

function renderChannelCounters(session, guild) {
    const settings = session.draft.channelCounterSettings || {};
    const selected = CHANNEL_COUNTER_SETTING_DEFINITIONS
        .find(({ key }) => key === session.selectedChannelCounterKey) || null;
    const lines = [
        `## Настройки WN Helper - ${guild.name}`,
        formatStatus(session),
        '',
        ...CHANNEL_COUNTER_SETTING_DEFINITIONS.map(({ key, label }) => {
            const prefix = selected?.key === key ? '→' : '•';
            const channelId = settings[key];
            return `${prefix} ${label}: ${channelId ? `<#${channelId}>` : 'не выбран'}`;
        }),
        '',
        'Каждый счётчик работает независимо. Названия фиксированы: "Сотрудников: N" и "Участников: N".',
        '',
        selected
            ? `Выбрана настройка: **${selected.label}**. Укажи канал ниже либо нажми "Очистить".`
            : 'Сначала выбери настройку счётчика.',
    ];

    const fieldSelect = new StringSelectMenuBuilder()
        .setCustomId(customId(session, 'channel_counters_field_select'))
        .setPlaceholder('Выбрать счётчик')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(CHANNEL_COUNTER_SETTING_DEFINITIONS.map(({ key, label }) => ({
            label,
            value: key,
            default: selected?.key === key,
        })));
    const components = [new ActionRowBuilder().addComponents(fieldSelect)];

    if (selected) {
        const channelSelect = new ChannelSelectMenuBuilder()
            .setCustomId(customId(session, 'channel_counters_channel_set', selected.key))
            .setPlaceholder(`Выбрать: ${selected.label}`)
            .setMinValues(1)
            .setMaxValues(1)
            .setChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice);
        components.push(new ActionRowBuilder().addComponents(channelSelect));
    }

    components.push(createFooterRow(session, selected ? {
        includeClear: {
            action: 'channel_counters_clear',
            value: selected.key,
        },
    } : {}));

    return { content: lines.join('\n'), components };
}

function renderPublications(session, guild) {
    const allowed = canPublishDiscordRules(guild.id);
    const lines = [
        `## Настройки WN Helper - ${guild.name}`,
        formatStatus(session),
        '',
        formatBreadcrumb(['Настройки', 'Публикации']),
        '',
        allowed
            ? 'Здесь публикуются постоянные служебные сообщения тестового сервера.'
            : 'На этом сервере нет доступных специальных публикаций.',
    ];
    const components = [];
    if (allowed) {
        components.push(new ActionRowBuilder().addComponents(
            createButton(session, 'publication_start', 'Правила Discord', ButtonStyle.Primary, 'discordRules')
        ));
    }
    components.push(createFooterRow(session));
    return { content: lines.join('\n'), components };
}

function renderDiagnostics(session, guild) {
    const diagnostics = buildDiagnostics(guild, session.original);
    const lines = [
        `## Настройки WN Helper - ${guild.name}`,
        formatStatus(session),
        '',
    ];

    for (const section of diagnostics.sections) {
        lines.push(`### ${section.title}`);
        for (const line of section.lines) lines.push(`- ${line}`);
        lines.push('');
    }

    lines.push('### Обнаруженные проблемы');
    if (diagnostics.problems.length) {
        for (const problem of diagnostics.problems.slice(0, 15)) lines.push(`- ${problem}`);
        if (diagnostics.problems.length > 15) {
            lines.push(`- Дополнительно обнаружено проблем: ${diagnostics.problems.length - 15}`);
        }
    } else {
        lines.push('- Явных проблем не обнаружено.');
    }

    return {
        content: lines.join('\n').slice(0, 1_950),
        components: [
            new ActionRowBuilder().addComponents(
                createButton(session, 'diagnostics_export_config', 'Экспорт конфигурации', ButtonStyle.Primary)
            ),
            createFooterRow(session),
        ],
    };
}

function renderChanges(session, guild) {
    const changes = Array.isArray(session.changes) ? session.changes : [];
    const pageCount = Math.max(Math.ceil(changes.length / CHANGE_PAGE_SIZE), 1);
    const page = Math.min(Math.max(session.changePage || 0, 0), pageCount - 1);
    const pageChanges = changes.slice(page * CHANGE_PAGE_SIZE, (page + 1) * CHANGE_PAGE_SIZE);

    const lines = [
        `## Настройки WN Helper - ${guild.name}`,
        formatStatus(session),
        '',
    ];

    if (!changes.length) {
        lines.push('Изменений пока нет.');
    } else {
        lines.push(`Изменения, страница ${page + 1}/${pageCount}:`);
        pageChanges.forEach((change, index) => {
            lines.push(`${page * CHANGE_PAGE_SIZE + index + 1}. ${formatSettingsChange(change)}`);
        });
    }

    const components = [];
    if (pageCount > 1) {
        const previousButton = createButton(session, 'changes_page', 'Назад по списку', ButtonStyle.Secondary, page - 1)
            .setDisabled(page <= 0);
        const nextButton = createButton(session, 'changes_page', 'Вперёд по списку', ButtonStyle.Secondary, page + 1)
            .setDisabled(page >= pageCount - 1);
        components.push(new ActionRowBuilder().addComponents(previousButton, nextButton));
    }

    components.push(createFooterRow(session));
    return { content: lines.join('\n'), components };
}

function renderSettingsPanel(session, guild) {
    let payload;

    switch (session.section) {
        case 'features':
            payload = renderFeatures(session, guild);
            break;
        case 'channels':
            payload = renderChannels(session, guild);
            break;
        case 'commonRoles':
            payload = renderCommonRoles(session, guild);
            break;
        case 'settingsAccess':
            payload = renderSettingsAccess(session, guild);
            break;
        case 'manualToolsAccess':
            payload = renderManualToolsAccess(session, guild);
            break;
        case 'departments':
            payload = renderDepartments(session, guild);
            break;
        case 'departmentRoles':
            payload = renderDepartmentRoles(session, guild);
            break;
        case 'departmentChannel':
            payload = renderDepartmentChannel(session, guild);
            break;
        case 'departmentDelete':
            payload = renderDepartmentDelete(session, guild);
            break;
        case 'ranks':
            payload = renderRanks(session, guild);
            break;
        case 'rankRole':
            payload = renderRankRole(session, guild);
            break;
        case 'rankPolicy':
            payload = renderRankPolicy(session, guild);
            break;
        case 'rankDelete':
            payload = renderRankDelete(session, guild);
            break;
        case 'rankStaffList':
            payload = renderRankStaffList(session, guild);
            break;
        case 'exams':
            payload = renderExams(session, guild);
            break;
        case 'examinationGeneral':
            payload = renderExaminationGeneral(session, guild);
            break;
        case 'examinationChannels':
            payload = renderExaminationChannels(session, guild);
            break;
        case 'examinationVoiceChannels':
            payload = renderExaminationVoiceChannels(session, guild);
            break;
        case 'lectureTypes':
            payload = renderLectureTypes(session, guild);
            break;
        case 'lectureTypeDetails':
            payload = renderLectureTypeDetails(session, guild);
            break;
        case 'lectureTypeDelete':
            payload = renderLectureTypeDelete(session, guild);
            break;
        case 'publicationPreview':
            payload = renderPublicationPreview(session, guild);
            break;
        case 'examMode':
            payload = renderExamMode(session, guild);
            break;
        case 'examDelete':
            payload = renderExamDelete(session, guild);
            break;
        case 'giveRoles':
            payload = renderGiveRoles(session, guild);
            break;
        case 'staffAudit':
            payload = renderStaffAudit(session, guild);
            break;
        case 'discipline':
            payload = renderDiscipline(session, guild);
            break;
        case 'disciplineGeneral':
            payload = renderDisciplineGeneral(session, guild);
            break;
        case 'disciplinePolicy':
            payload = renderDisciplinePolicy(session, guild);
            break;
        case 'disciplineAppeals':
            payload = renderDisciplineAppeals(session, guild);
            break;
        case 'disciplineStage':
            payload = renderDisciplineStage(session, guild);
            break;
        case 'disciplineStageRoles':
            payload = renderDisciplineStageRoles(session, guild);
            break;
        case 'disciplineMethods':
            payload = renderDisciplineMethods(session, guild);
            break;
        case 'disciplineMethodStages':
            payload = renderDisciplineMethodStages(session, guild);
            break;
        case 'disciplineMethodDepartments':
            payload = renderDisciplineMethodDepartments(session, guild);
            break;
        case 'disciplineRules':
            payload = renderDisciplineRules(session, guild);
            break;
        case 'disciplineRuleRoles':
            payload = renderDisciplineRuleRoles(session, guild);
            break;
        case 'staffLists':
            payload = renderStaffLists(session, guild);
            break;
        case 'channelCounters':
            payload = renderChannelCounters(session, guild);
            break;
        case 'shiftTypes':
            payload = renderShiftTypes(session, guild);
            break;
        case 'shiftTypeChannel':
            payload = renderShiftTypeChannel(session, guild);
            break;
        case 'shiftSchedule':
            payload = renderShiftSchedule(session, guild);
            break;
        case 'shiftAccess':
            payload = renderShiftAccess(session, guild);
            break;
        case 'shiftManagers':
            payload = renderShiftManagers(session, guild);
            break;
        case 'shiftPublish':
            payload = renderShiftPublish(session, guild);
            break;
        case 'shiftDelete':
            payload = renderShiftDelete(session, guild);
            break;
        case 'vacations':
            payload = renderVacations(session, guild);
            break;
        case 'vacationGeneral':
            payload = renderVacationGeneral(session, guild);
            break;
        case 'vacationRoutes':
            payload = renderVacationRoutes(session, guild);
            break;
        case 'vacationRouteDetails':
            payload = renderVacationRouteDetails(session, guild);
            break;
        case 'vacationTypes':
            payload = renderVacationTypes(session, guild);
            break;
        case 'vacationTypeDetails':
            payload = renderVacationTypeDetails(session, guild);
            break;
        case 'vacationTypeAvailability':
            payload = renderVacationTypeAvailability(session, guild);
            break;
        case 'vacationTypeLimits':
            payload = renderVacationTypeLimits(session, guild);
            break;
        case 'vacationTypeActions':
            payload = renderVacationTypeActions(session, guild);
            break;
        case 'vacationTypeBehavior':
            payload = renderVacationTypeBehavior(session, guild);
            break;
        case 'vacationTypeOverdue':
            payload = renderVacationTypeOverdue(session, guild);
            break;
        case 'diagnostics':
            payload = renderDiagnostics(session, guild);
            break;
        case 'publications':
            payload = renderPublications(session, guild);
            break;
        case 'changes':
            payload = renderChanges(session, guild);
            break;
        default:
            payload = renderMain(session, guild);
            break;
    }

    return {
        ...payload,
        allowedMentions: { parse: [] },
    };
}

function appendClosedChanges(lines, changes, saved) {
    if (!Array.isArray(changes) || !changes.length) return;

    lines.push('', saved ? 'Сохранённые изменения:' : 'Отменённые изменения:');
    let shown = 0;

    for (const change of changes) {
        const line = `• ${formatSettingsChange(change)}`;
        const candidate = [...lines, line].join('\n');
        if (candidate.length > 1_850) break;
        lines.push(line);
        shown += 1;
    }

    if (shown < changes.length) {
        lines.push(`• …ещё ${changes.length - shown}. Полный список записан в лог.`);
    }
}

function renderClosedPanel({ guildName, userId, saved, reason = null, changes = [] }) {
    const lines = [
        `## Настройки WN Helper - ${guildName}`,
        `Редактировал: <@${userId}>`,
        '',
        saved
            ? 'Настройки сохранены и применены.'
            : (reason || 'Редактирование настроек отменено.'),
    ];

    appendClosedChanges(lines, changes, saved);

    return {
        content: lines.join('\n'),
        components: [],
        allowedMentions: { parse: [] },
    };
}

module.exports = {
    createDepartmentModal,
    createDisciplineIntegerModal,
    createDisciplineMethodModal,
    createDisciplineRuleModal,
    createExamModal,
    createExamScoresModal,
    createExaminationTimeoutModal,
    createLectureTypeModal,
    createRankModal,
    createRankStaffListLimitModal,
    createStaffAuditIntegerModal,
    createStaffListDateModal,
    createVacationOverdueModal,
    createVacationRouteModal,
    createVacationTypeModal,
    createShiftAccessGroupModal,
    createShiftScheduleModal,
    createShiftTypeModal,
    renderClosedPanel,
    renderSettingsPanel,
};
