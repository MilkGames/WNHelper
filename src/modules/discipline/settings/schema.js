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

const DISCIPLINE_STAGES = ['conversation', 'oral', 'written'];
const DISCIPLINE_STAGE_LABELS = {
    conversation: 'Беседа',
    oral: 'Устный выговор',
    written: 'Письменный выговор',
};
const OVERDUE_ACTIONS = new Set([
    'none',
    'add_oral',
    'add_written',
    'replace_oral',
    'replace_written',
    'dismiss',
    'dismiss_blacklist',
]);
const NONCOMPLIANCE_OVERDUE_ACTIONS = new Set([
    'none',
    'dismiss',
    'dismiss_blacklist',
]);
const FALLBACK_PERMISSION_MODES = new Set(['unconditional', 'policy']);
const RECERTIFICATION_EXPIRY_ACTIONS = new Set([
    'none',
    'add_written',
    'dismiss',
    'dismiss_blacklist',
]);

function createId(prefix) {
    return typeof crypto.randomUUID === 'function'
        ? `${prefix}-${crypto.randomUUID()}`
        : `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeId(value) {
    const text = String(value || '').trim();
    return text || null;
}

function normalizeIdList(values) {
    return Array.from(new Set(
        (Array.isArray(values) ? values : [])
            .map((value) => String(value || '').trim())
            .filter(Boolean)
    )).sort();
}

function normalizePositiveInteger(value, fallback, { min = 1, max = 3650 } = {}) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= min && number <= max ? number : fallback;
}

function normalizeRoleByCount(value, threshold) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const result = {};
    for (let count = 1; count < threshold; count += 1) {
        const roleId = normalizeId(source[count] ?? source[String(count)]);
        if (roleId) result[String(count)] = roleId;
    }
    return result;
}

function getDefaultStage(stage) {
    if (stage === 'conversation') {
        return {
            enabled: true,
            threshold: 2,
            roleByCount: {},
            blocksPromotion: false,
            blocksOrdinaryDismissal: false,
            autoExpireEnabled: false,
            autoExpireDays: 7,
            workoffEnabled: false,
            deadlineDays: 5,
            overdueAction: 'none',
        };
    }
    if (stage === 'oral') {
        return {
            enabled: true,
            threshold: 2,
            roleByCount: {},
            blocksPromotion: true,
            blocksOrdinaryDismissal: true,
            autoExpireEnabled: false,
            autoExpireDays: null,
            workoffEnabled: true,
            deadlineDays: 5,
            overdueAction: 'add_written',
        };
    }
    return {
        enabled: true,
        threshold: 3,
        roleByCount: {},
        blocksPromotion: true,
        blocksOrdinaryDismissal: true,
        autoExpireEnabled: false,
        autoExpireDays: null,
        workoffEnabled: true,
        deadlineDays: 5,
        overdueAction: 'add_written',
    };
}

function normalizeStage(stage, value) {
    const defaults = getDefaultStage(stage);
    const source = value && typeof value === 'object' ? value : {};
    const threshold = stage === 'conversation'
        ? normalizePositiveInteger(source.threshold, defaults.threshold, { min: 2, max: 10 })
        : defaults.threshold;
    const overdueAction = OVERDUE_ACTIONS.has(source.overdueAction)
        ? source.overdueAction
        : defaults.overdueAction;
    return {
        enabled: stage === 'conversation' ? source.enabled !== false : true,
        threshold,
        roleByCount: normalizeRoleByCount(source.roleByCount, threshold),
        blocksPromotion: source.blocksPromotion === true || (source.blocksPromotion === undefined && defaults.blocksPromotion),
        blocksOrdinaryDismissal: source.blocksOrdinaryDismissal === true ||
            (source.blocksOrdinaryDismissal === undefined && defaults.blocksOrdinaryDismissal),
        autoExpireEnabled: stage === 'conversation' ? source.autoExpireEnabled === true : false,
        autoExpireDays: stage === 'conversation'
            ? normalizePositiveInteger(source.autoExpireDays, defaults.autoExpireDays, { min: 1, max: 3650 })
            : null,
        workoffEnabled: source.workoffEnabled === true || (source.workoffEnabled === undefined && defaults.workoffEnabled),
        deadlineDays: normalizePositiveInteger(source.deadlineDays, defaults.deadlineDays, { min: 1, max: 365 }),
        overdueAction,
    };
}

function normalizeWorkoffMethod(method) {
    const name = String(method?.name || '').trim().slice(0, 100);
    const stages = Array.from(new Set(
        (Array.isArray(method?.stages) ? method.stages : [])
            .filter((stage) => DISCIPLINE_STAGES.includes(stage))
    )).sort();
    return {
        id: normalizeId(method?.id),
        name,
        stages: stages.length ? stages : ['oral'],
        departmentIds: normalizeIdList(method?.departmentIds),
    };
}

function normalizeConditionalRule(rule) {
    const stage = DISCIPLINE_STAGES.includes(rule?.stage) ? rule.stage : 'written';
    const actionType = rule?.action?.type === 'update_roles' ? 'update_roles' : 'set_rank';
    return {
        id: normalizeId(rule?.id),
        minRankNumber: normalizePositiveInteger(rule?.minRankNumber, 1, { min: 1, max: 1000 }),
        stage,
        count: normalizePositiveInteger(rule?.count, 2, { min: 1, max: 10 }),
        clause: String(rule?.clause || '').trim().slice(0, 200) || null,
        action: actionType === 'update_roles' ? {
            type: 'update_roles',
            removeRoleIds: normalizeIdList(rule?.action?.removeRoleIds),
            addRoleIds: normalizeIdList(rule?.action?.addRoleIds),
        } : {
            type: 'set_rank',
            rankNumber: normalizePositiveInteger(rule?.action?.rankNumber, 1, { min: 1, max: 1000 }),
        },
    };
}

function normalizeIssuePolicy(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
        enabled: source.enabled === true,
        leadershipRoleIds: normalizeIdList(source.leadershipRoleIds),
        examinerRoleIds: normalizeIdList(source.examinerRoleIds),
        departmentLeadershipEnabled: source.departmentLeadershipEnabled !== false,
        fallbackPermissionMode: FALLBACK_PERMISSION_MODES.has(source.fallbackPermissionMode)
            ? source.fallbackPermissionMode
            : 'unconditional',
    };
}

function normalizeAppealSettings(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
        enabled: source.enabled === true,
        channelId: normalizeId(source.channelId),
        finalReviewerRoleIds: normalizeIdList(source.finalReviewerRoleIds),
        workoffReviewerRoleIds: normalizeIdList(source.workoffReviewerRoleIds),
        pauseWorkoffDeadline: source.pauseWorkoffDeadline === true,
    };
}

function getDisciplineSettings(config) {
    const source = config?.disciplineSettings && typeof config.disciplineSettings === 'object'
        ? config.disciplineSettings
        : {};
    return {
        channelId: normalizeId(source.channelId),
        removalChannelId: normalizeId(source.removalChannelId),
        removalApproverRoleIds: normalizeIdList(source.removalApproverRoleIds),
        massApprovalRoleIds: normalizeIdList(source.massApprovalRoleIds),
        massApprovalBypassRoleIds: normalizeIdList(source.massApprovalBypassRoleIds),
        massMaxTargets: normalizePositiveInteger(source.massMaxTargets, 25, { min: 2, max: 25 }),
        massApprovalTimeoutMinutes: normalizePositiveInteger(source.massApprovalTimeoutMinutes, 30, { min: 5, max: 1440 }),
        maxIssueDelayDays: normalizePositiveInteger(source.maxIssueDelayDays, 7, { min: 1, max: 365 }),
        noncomplianceOverdueAction: NONCOMPLIANCE_OVERDUE_ACTIONS.has(source.noncomplianceOverdueAction)
            ? source.noncomplianceOverdueAction
            : 'dismiss_blacklist',
        recertificationRoleId: normalizeId(source.recertificationRoleId),
        recertificationDeadlineDays: normalizePositiveInteger(source.recertificationDeadlineDays, 7, { min: 1, max: 365 }),
        recertificationExpiryAction: RECERTIFICATION_EXPIRY_ACTIONS.has(source.recertificationExpiryAction)
            ? source.recertificationExpiryAction
            : 'none',
        issuePolicy: normalizeIssuePolicy(source.issuePolicy),
        appeals: normalizeAppealSettings(source.appeals),
        stages: Object.fromEntries(
            DISCIPLINE_STAGES.map((stage) => [stage, normalizeStage(stage, source.stages?.[stage])])
        ),
        workoffMethods: (Array.isArray(source.workoffMethods) ? source.workoffMethods : [])
            .map(normalizeWorkoffMethod)
            .filter((method) => method.id && method.name)
            .sort((left, right) => left.name.localeCompare(right.name, 'ru')),
        conditionalRules: (Array.isArray(source.conditionalRules) ? source.conditionalRules : [])
            .map(normalizeConditionalRule)
            .filter((rule) => rule.id),
    };
}

function prepareDisciplineSettingsForStorage(settings) {
    return getDisciplineSettings({ disciplineSettings: settings });
}

function pushUpdated(changes, key, label, before, after, valueType = 'text', extra = {}) {
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    changes.push({
        section: 'discipline',
        action: 'updated',
        key,
        label,
        before,
        after,
        valueType,
        ...extra,
    });
}

function getDisciplineSettingsChanges(beforeSettings, afterSettings) {
    const before = prepareDisciplineSettingsForStorage(beforeSettings);
    const after = prepareDisciplineSettingsForStorage(afterSettings);
    const changes = [];

    for (const [key, label, valueType] of [
        ['channelId', 'Канал взысканий', 'channel'],
        ['removalChannelId', 'Канал запросов на снятие', 'channel'],
        ['removalApproverRoleIds', 'Роли подтверждения снятия', 'roles'],
        ['massApprovalRoleIds', 'Роли подтверждения массовых взысканий', 'roles'],
        ['massApprovalBypassRoleIds', 'Роли обхода подтверждения массовых взысканий', 'roles'],
        ['massMaxTargets', 'Максимум сотрудников в массовом взыскании', 'number'],
        ['massApprovalTimeoutMinutes', 'Срок подтверждения массового взыскания', 'minutes'],
        ['maxIssueDelayDays', 'Максимальная давность нарушения', 'days'],
        ['noncomplianceOverdueAction', 'Повторная просрочка взыскания за неисполнение', 'action'],
        ['recertificationRoleId', 'Роль переаттестации', 'role'],
        ['recertificationDeadlineDays', 'Срок переаттестации', 'days'],
        ['recertificationExpiryAction', 'Действие при просрочке переаттестации', 'action'],
    ]) {
        pushUpdated(changes, key, label, before[key], after[key], valueType);
    }

    for (const [key, label, valueType] of [
        ['enabled', 'Проверка полномочий на выдачу', 'boolean'],
        ['leadershipRoleIds', 'Роли руководящего состава', 'roles'],
        ['examinerRoleIds', 'Роли экзаменаторов', 'roles'],
        ['departmentLeadershipEnabled', 'Полномочия старшего состава отдела', 'boolean'],
        ['fallbackPermissionMode', 'Проверка резервных ролей', 'text'],
    ]) {
        pushUpdated(
            changes,
            `issuePolicy.${key}`,
            label,
            before.issuePolicy[key],
            after.issuePolicy[key],
            valueType
        );
    }

    for (const [key, label, valueType] of [
        ['enabled', 'Обжалования взысканий', 'boolean'],
        ['channelId', 'Канал обжалований', 'channel'],
        ['finalReviewerRoleIds', 'Кто принимает окончательное решение', 'roles'],
        ['workoffReviewerRoleIds', 'Кто рассматривает изменение отработки', 'roles'],
        ['pauseWorkoffDeadline', 'Пауза срока при обжаловании', 'boolean'],
    ]) {
        pushUpdated(
            changes,
            `appeals.${key}`,
            label,
            before.appeals[key],
            after.appeals[key],
            valueType
        );
    }

    for (const stage of DISCIPLINE_STAGES) {
        const stageLabel = DISCIPLINE_STAGE_LABELS[stage];
        for (const [key, label, valueType] of [
            ['enabled', 'включён', 'boolean'],
            ['threshold', 'порог преобразования', 'number'],
            ['blocksPromotion', 'блокирует повышение', 'boolean'],
            ['blocksOrdinaryDismissal', 'блокирует обычное увольнение', 'boolean'],
            ['autoExpireEnabled', 'автоистечение включено', 'boolean'],
            ['autoExpireDays', 'срок автоистечения', 'days'],
            ['workoffEnabled', 'отработка включена', 'boolean'],
            ['deadlineDays', 'срок отработки', 'days'],
            ['overdueAction', 'действие при просрочке', 'action'],
        ]) {
            pushUpdated(
                changes,
                `stages.${stage}.${key}`,
                `${stageLabel}: ${label}`,
                before.stages[stage][key],
                after.stages[stage][key],
                valueType,
                { stage }
            );
        }
        const counts = new Set([
            ...Object.keys(before.stages[stage].roleByCount || {}),
            ...Object.keys(after.stages[stage].roleByCount || {}),
        ]);
        for (const count of [...counts].sort((a, b) => Number(a) - Number(b))) {
            pushUpdated(
                changes,
                `stages.${stage}.roleByCount.${count}`,
                `${stageLabel}: роль для ${count} активн.`,
                before.stages[stage].roleByCount?.[count] || null,
                after.stages[stage].roleByCount?.[count] || null,
                'role',
                { stage, count: Number(count) }
            );
        }
    }

    const beforeMethods = new Map(before.workoffMethods.map((method) => [method.id, method]));
    const afterMethods = new Map(after.workoffMethods.map((method) => [method.id, method]));
    for (const [id, method] of afterMethods) {
        const previous = beforeMethods.get(id);
        if (!previous) {
            changes.push({ section: 'discipline', action: 'methodAdded', key: id, label: method.name, method });
            continue;
        }
        pushUpdated(changes, `method.${id}.name`, `Способ "${method.name}": название`, previous.name, method.name, 'text', { methodId: id });
        pushUpdated(changes, `method.${id}.stages`, `Способ "${method.name}": этапы`, previous.stages, method.stages, 'stages', { methodId: id });
        pushUpdated(changes, `method.${id}.departments`, `Способ "${method.name}": отделы`, previous.departmentIds, method.departmentIds, 'departments', { methodId: id });
    }
    for (const [id, method] of beforeMethods) {
        if (!afterMethods.has(id)) changes.push({ section: 'discipline', action: 'methodRemoved', key: id, label: method.name, method });
    }

    const beforeRules = new Map(before.conditionalRules.map((rule) => [rule.id, rule]));
    const afterRules = new Map(after.conditionalRules.map((rule) => [rule.id, rule]));
    for (const [id, rule] of afterRules) {
        const previous = beforeRules.get(id);
        if (!previous) changes.push({ section: 'discipline', action: 'ruleAdded', key: id, rule });
        else if (JSON.stringify(previous) !== JSON.stringify(rule)) {
            changes.push({ section: 'discipline', action: 'ruleUpdated', key: id, before: previous, after: rule });
        }
    }
    for (const [id, rule] of beforeRules) {
        if (!afterRules.has(id)) changes.push({ section: 'discipline', action: 'ruleRemoved', key: id, rule });
    }

    return changes;
}

module.exports = {
    FALLBACK_PERMISSION_MODES,
    DISCIPLINE_STAGES,
    DISCIPLINE_STAGE_LABELS,
    NONCOMPLIANCE_OVERDUE_ACTIONS,
    OVERDUE_ACTIONS,
    RECERTIFICATION_EXPIRY_ACTIONS,
    createId,
    getDisciplineSettings,
    getDisciplineSettingsChanges,
    normalizeAppealSettings,
    normalizeIssuePolicy,
    prepareDisciplineSettingsForStorage,
};
