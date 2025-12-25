const logger = require('./logger');

const FREE_SHIFT_VALUE = 'Свободно';

const SHIFT_MAP = [
    { id: 'shift-1', field: 'firstHour', number: 1, time: '10:00 - 10:55' },
    { id: 'shift-2', field: 'secondHour', number: 2, time: '11:00 - 11:55' },
    { id: 'shift-3', field: 'thirdHour', number: 3, time: '12:00 - 12:55' },
    { id: 'shift-4', field: 'fourthHour', number: 4, time: '13:00 - 13:55' },
    { id: 'shift-5', field: 'fifthHour', number: 5, time: '14:00 - 14:55' },
    { id: 'shift-6', field: 'sixthHour', number: 6, time: '15:00 - 15:55' },
    { id: 'shift-7', field: 'seventhHour', number: 7, time: '16:00 - 16:55' },
    { id: 'shift-8', field: 'eighthHour', number: 8, time: '17:00 - 17:55' },
    { id: 'shift-9', field: 'ninthHour', number: 9, time: '18:00 - 18:55' },
    { id: 'shift-10', field: 'tenthHour', number: 10, time: '19:00 - 19:55' },
    { id: 'shift-11', field: 'eleventhHour', number: 11, time: '20:00 - 20:55' },
    { id: 'shift-12', field: 'twelfthHour', number: 12, time: '21:00 - 21:55' },
    { id: 'shift-13', field: 'thirteenthHour', number: 13, time: '22:00 - 22:55' },
];

const ACCESS_STAGE_MINUTES = 10;
const ACCESS_MAX_STAGE = 2;

function uniqRoleIds(roleIds) {
    return Array.from(new Set((roleIds || []).filter(Boolean)));
}

function formatRoleMentions(roleIds) {
    const unique = uniqRoleIds(roleIds);
    if (!unique.length) return '—';
    return unique.map((id) => `<@&${id}>`).join(' ');
}

function getMoscowDateKey(date = new Date()) {
    // YYYY-MM-DD
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Moscow',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(date);
}

function daysBetween(dateKeyA, dateKeyB) {
    // YYYY-MM-DD
    const a = new Date(`${dateKeyA}T00:00:00Z`).getTime();
    const b = new Date(`${dateKeyB}T00:00:00Z`).getTime();
    const diffMs = b - a;
    return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}

function buildRoleGroups(serverConfig = {}) {
    const main = uniqRoleIds([serverConfig.AMDRoleId]);
    const high = uniqRoleIds([serverConfig.depHeadAMDRoleId, serverConfig.headAMDRoleId]);
    const part = uniqRoleIds([serverConfig.partWorkAMDRoleId]);

    const safeMain = main.length ? main : uniqRoleIds([serverConfig.headAMDRoleId, serverConfig.depHeadAMDRoleId]);
    const safeHigh = high.length ? high : safeMain;
    const safePart = part.length ? part : safeMain;

    return {
        main: safeMain,
        high: safeHigh,
        part: safePart,
    };
}

function getMemberCategory(member, serverConfig = {}) {
    if (!member) return null;

    const headId = serverConfig.headAMDRoleId;
    const depHeadId = serverConfig.depHeadAMDRoleId;
    const partId = serverConfig.partWorkAMDRoleId;
    const mainId = serverConfig.AMDRoleId;

    // bugfix #1: забыл что старший состав также имеет роль AMD
    const hasHigh = Boolean(headId && member.roles.cache.has(headId)) || Boolean(depHeadId && member.roles.cache.has(depHeadId));
    if (hasHigh) return 'high';

    const hasPart = Boolean(partId && member.roles.cache.has(partId));
    if (hasPart) return 'part';

    const hasMain = Boolean(mainId && member.roles.cache.has(mainId));
    if (hasMain) return 'main';

    return null;
}

function buildAccessPlan(serverConfig = {}, rotationIndex = 0) {
    const groups = buildRoleGroups(serverConfig);
    const idx = ((rotationIndex % 3) + 3) % 3;

    let stageCategories;
    if (idx === 0) {
        // День 1: main -> +high -> +part
        stageCategories = [
            ['main'],
            ['main', 'high'],
            ['main', 'high', 'part'],
        ];
    } else if (idx === 1) {
        // День 2: high -> +part -> +main
        stageCategories = [
            ['high'],
            ['high', 'part'],
            ['high', 'part', 'main'],
        ];
    } else {
        // День 3: part -> +main -> +high
        stageCategories = [
            ['part'],
            ['part', 'main'],
            ['part', 'main', 'high'],
        ];
    }

    const stages = stageCategories.map((cats) => {
        const ids = [];
        for (const cat of cats) {
            if (cat === 'main') ids.push(...(groups.main || []));
            if (cat === 'high') ids.push(...(groups.high || []));
            if (cat === 'part') ids.push(...(groups.part || []));
        }
        return uniqRoleIds(ids);
    });

    return {
        rotationIndex: idx,
        stages,
        stageCategories,
        firstAccessRoleIds: stages[0],
    };
}

function getCurrentAccessStage(sentAtMs, nowMs = Date.now()) {
    if (!sentAtMs) return 0;
    const elapsedMs = Math.max(0, nowMs - sentAtMs);
    const elapsedMinutes = Math.floor(elapsedMs / (60 * 1000));
    return Math.min(ACCESS_MAX_STAGE, Math.floor(elapsedMinutes / ACCESS_STAGE_MINUTES));
}

function getNextStageEtaMinutes(sentAtMs, stageIdx, nowMs = Date.now()) {
    if (stageIdx >= ACCESS_MAX_STAGE) return null;
    const nextStageStartMs = sentAtMs + (stageIdx + 1) * ACCESS_STAGE_MINUTES * 60 * 1000;
    const diffMs = nextStageStartMs - nowMs;
    return Math.max(0, Math.ceil(diffMs / (60 * 1000)));
}

async function resolveShiftDisplay(client, value) {
    if (!value || value === FREE_SHIFT_VALUE) return FREE_SHIFT_VALUE;
    if (/^\d{17,20}$/.test(String(value))) {
		return `<@${value}>`;
	}
    return value;
}

async function buildShiftLines(client, shiftsRecord) {
    const resolved = await Promise.all(
        SHIFT_MAP.map(async (shift) => {
            const value = shiftsRecord?.[shift.field] || FREE_SHIFT_VALUE;
            const display = await resolveShiftDisplay(client, value);
            return `${shift.number}) ${shift.time}: ${display}`;
        })
    );
    return resolved;
}

function buildAccessSection({ plan, sentAtMs, nowMs }) {
    const stageIdx = getCurrentAccessStage(sentAtMs, nowMs);
    const currentRoleIds = plan.stages[stageIdx] || [];
    const nextEta = getNextStageEtaMinutes(sentAtMs, stageIdx, nowMs);
    const nextRoleIds = stageIdx < ACCESS_MAX_STAGE ? plan.stages[stageIdx + 1] : null;

    const currentCategories = (plan.stageCategories && plan.stageCategories[stageIdx]) || [];
    const nextCategories = (plan.stageCategories && stageIdx < ACCESS_MAX_STAGE) ? plan.stageCategories[stageIdx + 1] : null;

    const lines = [
        '',
        `Сегодня доступ к сменам в первую очередь получает ${formatRoleMentions(plan.firstAccessRoleIds)}.`,
        `Сейчас доступ открыт для: ${formatRoleMentions(currentRoleIds)}.`,
    ];

    if (nextEta !== null && nextRoleIds) {
        lines.push(`Следующее расширение доступа через ~${nextEta} мин: ${formatRoleMentions(nextRoleIds)}.`);
    }

    return {
        stageIdx,
        currentRoleIds,
        nextRoleIds,
        nextEtaMinutes: nextEta,
        currentCategories,
        nextCategories,
        lines,
    };
}

function buildScheduleMessageContent({
    formattedDate,
    shiftLines,
    serverConfig,
    rotationIndex,
    sentAtMs,
    nowMs = Date.now(),
}) {
    const plan = buildAccessPlan(serverConfig, rotationIndex);
    const access = buildAccessSection({ plan, sentAtMs, nowMs });

    const moderationRoleMention = serverConfig.headAMDRoleId
        ? `<@&${serverConfig.headAMDRoleId}>`
        : '—';

    return [
        `:white_check_mark: Смены на ${formattedDate}:`,
        '',
        ...shiftLines,
        '',
        '**Нажмите на кнопку, соответствующую времени смены, чтобы занять текущее время для отправления объявлений.**',
        `Пользователи с ролью ${moderationRoleMention} также могут нажать на кнопку, чтобы убрать сотрудника из списка.`,
        'В очень редких случаях кнопки могут оставаться неактивными после того, как вы на них нажали.',
        'Это визуальный баг, используйте Ctrl+R, чтобы перезапустить Discord и кнопки вновь будут активными.',
        ...access.lines,
        '-# WN Helper by Michael Lindberg. Discord: milkgames',
    ].join('\n');
}

module.exports = {
    FREE_SHIFT_VALUE,
    SHIFT_MAP,
    ACCESS_STAGE_MINUTES,
    ACCESS_MAX_STAGE,
    formatRoleMentions,
    uniqRoleIds,
    getMoscowDateKey,
    daysBetween,
    buildAccessPlan,
    getCurrentAccessStage,
    buildShiftLines,
    buildScheduleMessageContent,
    buildAccessSection,
    getMemberCategory,

};
