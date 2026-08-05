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
const { EmbedBuilder } = require('discord.js');
const { getDepartments } = require('../../core/config/departmentSchema');
const { getRanks } = require('../../core/config/rankSchema');
const logger = require('../../core/logging/logger');
const { MOSCOW_TIME_ZONE } = require('../../core/runtime/constants');
const { DEFAULT_FOOTER, getDefaultFooter } = require('../../core/ui/defaultFooter');
const { getStaffListSettings } = require('./settings/schema');

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_FIELDS_PER_EMBED = 25;
const SAFE_EMBED_TEXT_LIMIT = 5_600;
const SAFE_FIELD_VALUE_LIMIT = 950;
const UPDATE_INFO_TEXT = '-# Информация обновляется автоматически.';
const SECTION_SPACING_SUFFIX = '\n\u200B';
const HIGH_STAFF_TITLE = 'Руководящий и старший составы Weazel News';
const DEPARTMENT_COLORS = [0x2ECC71, 0xE67E22, 0xFFC0CB, 0x3498DB, 0x9B59B6, 0x1ABC9C];

function memberHasRole(member, roleId) {
    return Boolean(roleId) && Boolean(member?.roles?.cache?.has?.(roleId));
}

function memberHasAnyRank(member, serverConfig, rankNumbers) {
    const allowedNumbers = new Set(Array.isArray(rankNumbers) ? rankNumbers : []);
    return getRanks(serverConfig).some((rank) => (
        allowedNumbers.has(rank.number) && rank.roleId && memberHasRole(member, rank.roleId)
    ));
}

function getLeadershipRanks(serverConfig) {
    return getRanks(serverConfig)
        .filter((rank) => rank.roleId && rank.staffList?.showInLeadership)
        .sort((left, right) => right.number - left.number);
}

function getRankMembers(members, rank) {
    if (!rank?.roleId) return [];
    return Array.from(members?.values ? members.values() : members || [])
        .filter((member) => memberHasRole(member, rank.roleId));
}

function getDepartmentColor(department, index = 0) {
    return department.color || DEPARTMENT_COLORS[index % DEPARTMENT_COLORS.length];
}

function getDepartmentRoles(department) {
    return {
        staff: department.roles?.memberRoleId || null,
        partWork: department.roles?.partTimeRoleId || null,
        curator: department.roles?.curatorRoleId || null,
        depHead: department.roles?.deputyHeadRoleId || null,
        head: department.roles?.headRoleId || null,
    };
}

function isDepartmentCurator(member, serverConfig, department) {
    if (department.curatorsEnabled === false) return false;

    const roles = getDepartmentRoles(department);
    if (roles.curator) return memberHasRole(member, roles.curator);

    const settings = getStaffListSettings(serverConfig);
    return (
        memberHasRole(member, roles.head) &&
        memberHasAnyRank(member, serverConfig, settings.curatorManagementRankNumbers)
    );
}

function getDepartmentStaffGroups(members, serverConfig, department) {
    const roles = getDepartmentRoles(department);
    const availableMembers = Array.from(members?.values ? members.values() : members || [])
        .filter((member) => !member.user?.bot);
    const curatorsEnabled = department.curatorsEnabled !== false;
    const headsEnabled = (department.limits?.heads ?? 1) > 0;
    const deputyHeadsEnabled = (department.limits?.deputyHeads ?? 1) > 0;
    const curators = curatorsEnabled
        ? availableMembers.filter((member) => isDepartmentCurator(member, serverConfig, department))
        : [];
    const curatorIds = new Set(curators.map((member) => member.id));
    const heads = headsEnabled
        ? availableMembers.filter((member) => !curatorIds.has(member.id) && memberHasRole(member, roles.head))
        : [];
    const headIds = new Set(heads.map((member) => member.id));
    const depHeads = deputyHeadsEnabled
        ? availableMembers.filter((member) => (
            !curatorIds.has(member.id) &&
            !headIds.has(member.id) &&
            memberHasRole(member, roles.depHead)
        ))
        : [];
    const depHeadIds = new Set(depHeads.map((member) => member.id));
    const staff = availableMembers.filter((member) => (
        !curatorIds.has(member.id) &&
        !headIds.has(member.id) &&
        !depHeadIds.has(member.id) &&
        memberHasRole(member, roles.staff)
    ));
    const staffIds = new Set(staff.map((member) => member.id));
    const partWork = availableMembers.filter((member) => (
        !curatorIds.has(member.id) &&
        !headIds.has(member.id) &&
        !depHeadIds.has(member.id) &&
        !staffIds.has(member.id) &&
        memberHasRole(member, roles.partWork)
    ));

    return { curators, heads, depHeads, staff, partWork };
}

function createMemberSorter(serverConfig, guildId) {
    const ranks = getRanks(serverConfig)
        .filter((rank) => rank.roleId)
        .sort((first, second) => second.number - first.number);
    const rankCache = new Map();
    const loggedConflicts = new Set();

    function getMemberRank(member) {
        if (rankCache.has(member.id)) return rankCache.get(member.id);

        const matchingRanks = ranks.filter((rank) => memberHasRole(member, rank.roleId));
        if (matchingRanks.length > 1 && !loggedConflicts.has(member.id)) {
            loggedConflicts.add(member.id);
            logger.warn('У участника найдено несколько ролей рангов при построении состава', {
                guildId,
                userId: member.id,
                ranks: matchingRanks.map((rank) => rank.number),
            });
        }

        const rankNumber = matchingRanks[0]?.number ?? null;
        rankCache.set(member.id, rankNumber);
        return rankNumber;
    }

    return (firstMember, secondMember) => {
        const firstRank = getMemberRank(firstMember);
        const secondRank = getMemberRank(secondMember);

        if (firstRank !== secondRank) {
            if (firstRank === null) return 1;
            if (secondRank === null) return -1;
            return secondRank - firstRank;
        }

        return String(firstMember.displayName || firstMember.user?.username || '')
            .localeCompare(
                String(secondMember.displayName || secondMember.user?.username || ''),
                ['ru', 'en'],
                { sensitivity: 'base' }
            );
    };
}

function getMemberLines(members, max, sorter) {
    const list = Array.from(members || []).sort(sorter);
    const lines = list.map((member) => `> <@${member.user.id}>`);

    if (max > 0 && list.length > max) {
        lines.unshift(`> ⚠ Превышение лимита: ${list.length}/${max}.`);
    }

    if (max > 0) {
        for (let index = list.length; index < max; index += 1) {
            lines.push('> Место вакантно.');
        }
    } else if (!lines.length) {
        lines.push('> Отсутствует(-ют).');
    }

    return lines;
}

function chunkLines(lines, maxLength = SAFE_FIELD_VALUE_LIMIT) {
    const chunks = [];
    let current = '';

    for (const rawLine of lines) {
        const line = rawLine === '' ? '' : String(rawLine ?? ' ');
        const candidate = current.length > 0 ? `${current}\n${line}` : line;
        if (candidate.length <= maxLength) {
            current = candidate;
            continue;
        }

        if (current) chunks.push(current);
        current = line.length <= maxLength ? line : line.slice(0, maxLength);
    }

    if (current) chunks.push(current);
    return chunks.length ? chunks : ['> Отсутствует(-ют).'];
}

function createMemberFields(name, members, max, sorter, { inline = false } = {}) {
    const chunks = chunkLines(getMemberLines(members, max, sorter));
    return chunks.map((value, index) => ({
        name: index === 0 ? name : `${name.replace(/:$/, '')} - продолжение:`,
        value,
        inline,
    }));
}

function createTitledMemberFields(title, label, members, max, sorter) {
    const chunks = chunkLines([
        `**${label}:**`,
        ...getMemberLines(members, max, sorter),
    ]);

    return chunks.map((value, index) => ({
        name: index === 0 ? title : `${label} - продолжение:`,
        value,
        inline: false,
    }));
}

function appendUpdateInfo(fields) {
    const lastField = fields.at(-1);
    if (!lastField) return fields;

    lastField.value = `${lastField.value}\n${UPDATE_INFO_TEXT}`;
    return fields;
}

function createEmbedPaginator(color, title) {
    const pages = [];
    let current = null;

    function startPage() {
        current = {
            title: pages.length === 0 ? title : `${title} - продолжение`,
            fields: [],
            textLength: title.length + DEFAULT_FOOTER.text.length,
        };
        pages.push(current);
    }

    function addGroup(fields) {
        const normalizedFields = fields.filter(Boolean);
        const groupLength = normalizedFields.reduce(
            (sum, field) => sum + String(field.name || '').length + String(field.value || '').length,
            0
        );

        if (!current) startPage();
        if (
            current.fields.length > 0 &&
            (
                current.fields.length + normalizedFields.length > MAX_FIELDS_PER_EMBED ||
                current.textLength + groupLength > SAFE_EMBED_TEXT_LIMIT
            )
        ) {
            startPage();
        }

        for (const field of normalizedFields) {
            if (
                current.fields.length >= MAX_FIELDS_PER_EMBED ||
                current.textLength + String(field.name || '').length + String(field.value || '').length > SAFE_EMBED_TEXT_LIMIT
            ) {
                startPage();
            }

            current.fields.push(field);
            current.textLength += String(field.name || '').length + String(field.value || '').length;
        }
    }

    function addSeparatedGroup(fields) {
        const normalizedFields = fields.filter(Boolean);
        if (!normalizedFields.length) return;

        const groupLength = normalizedFields.reduce(
            (sum, field) => sum + String(field.name || '').length + String(field.value || '').length,
            0
        );

        if (!current) startPage();
        if (
            current.fields.length > 0 &&
            (
                current.fields.length + normalizedFields.length > MAX_FIELDS_PER_EMBED ||
                current.textLength + SECTION_SPACING_SUFFIX.length + groupLength > SAFE_EMBED_TEXT_LIMIT
            )
        ) {
            startPage();
        }

        if (current.fields.length > 0) {
            const previousField = current.fields.at(-1);
            previousField.value = `${previousField.value}${SECTION_SPACING_SUFFIX}`;
            current.textLength += SECTION_SPACING_SUFFIX.length;
        }

        addGroup(normalizedFields);
    }

    function build() {
        if (!pages.length) startPage();

        return pages.map((page) => {
            const embed = new EmbedBuilder()
                .setColor(color)
                .setTitle(page.title)
                .setTimestamp()
                .setFooter(getDefaultFooter());
            if (page.fields.length) embed.addFields(page.fields);
            return embed;
        });
    }

    return { addGroup, addSeparatedGroup, build };
}

function parseIsoDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!match) return null;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));

    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
    ) {
        return null;
    }

    return date;
}

function formatDate(date) {
    return new Intl.DateTimeFormat('ru-RU', {
        timeZone: 'UTC',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
    }).format(date);
}

function getMoscowToday() {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: MOSCOW_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)));
}

function formatDayCount(dayCount) {
    const absolute = Math.abs(dayCount);
    const lastTwoDigits = absolute % 100;
    const lastDigit = absolute % 10;

    if (lastTwoDigits >= 11 && lastTwoDigits <= 14) return `${dayCount} дней`;
    if (lastDigit === 1) return `${dayCount} день`;
    if (lastDigit >= 2 && lastDigit <= 4) return `${dayCount} дня`;
    return `${dayCount} дней`;
}

function getLeaderTermInfo(appointmentDateString, leaderTermDays = 30, todayDate = null) {
    const appointmentDate = parseIsoDate(appointmentDateString);
    if (!appointmentDate) {
        return {
            appointmentDate: 'Не указана.',
            term: 'Срок не указан.',
            termEndDate: 'Невозможно рассчитать.',
        };
    }

    const today = todayDate instanceof Date ? todayDate : getMoscowToday();
    if (appointmentDate.getTime() > today.getTime()) {
        return {
            appointmentDate: formatDate(appointmentDate),
            term: 'Срок ещё не начался.',
            termEndDate: 'Невозможно рассчитать.',
        };
    }

    const normalizedTermDays = Math.max(1, Number(leaderTermDays) || 30);
    const daysPassed = Math.floor((today.getTime() - appointmentDate.getTime()) / DAY_MS);
    const termNumber = Math.floor(daysPassed / normalizedTermDays) + 1;
    const termEndDate = new Date(
        appointmentDate.getTime() + (termNumber * normalizedTermDays - 1) * DAY_MS
    );

    return {
        appointmentDate: formatDate(appointmentDate),
        term: `${termNumber}-й срок, ${formatDayCount(daysPassed)} на должности.`,
        termEndDate: formatDate(termEndDate),
    };
}

function buildDepartmentEmbeds(members, serverConfig, department, index = 0, guildId = '') {
    const groups = getDepartmentStaffGroups(members, serverConfig, department);
    const sorter = createMemberSorter(serverConfig, guildId);
    const title = `Состав отдела ${department.fullName}`;
    const paginator = createEmbedPaginator(getDepartmentColor(department, index), title);
    const headLimit = department.limits?.heads ?? 1;
    const deputyHeadLimit = department.limits?.deputyHeads ?? 1;
    const fieldGroups = [];

    if (department.curatorsEnabled !== false) {
        fieldGroups.push(createMemberFields('Куратор отдела:', groups.curators, 0, sorter));
    }
    if (headLimit > 0) {
        fieldGroups.push(createMemberFields('Глава отдела:', groups.heads, headLimit, sorter));
    }
    if (deputyHeadLimit > 0) {
        fieldGroups.push(createMemberFields(
            'Заместители главы отдела:',
            groups.depHeads,
            deputyHeadLimit,
            sorter
        ));
    }

    fieldGroups.push(createMemberFields('Основной состав:', groups.staff, 0, sorter));
    fieldGroups.push(createMemberFields('Сотрудники при подработке:', groups.partWork, 0, sorter));

    appendUpdateInfo(fieldGroups.at(-1));
    fieldGroups.forEach((fields) => paginator.addGroup(fields));

    return paginator.build();
}

function buildLeadershipRankFields(rank, members, sorter, leaderAppointmentDate, leaderTermDays) {
    const lines = getMemberLines(members, rank.staffList?.maxMembers || 0, sorter);

    if (rank.staffList?.showAppointmentTerm) {
        const termInfo = getLeaderTermInfo(leaderAppointmentDate, leaderTermDays);
        lines.push(`> Дата назначения: ${termInfo.appointmentDate}`);
        lines.push(`> ${termInfo.term}`);
        lines.push(`> Дата окончания текущего срока: ${termInfo.termEndDate}`);
    }

    return chunkLines(lines).map((value, index) => ({
        name: index === 0 ? `${rank.name}:` : `${rank.name} - продолжение:`,
        value,
        inline: false,
    }));
}

function buildDepartmentLeadershipFields(groups, department, sorter) {
    const fields = [];
    const departmentTitle = `${department.shortName} - ${department.fullName}`;
    const headLimit = department.limits?.heads ?? 1;
    const deputyHeadLimit = department.limits?.deputyHeads ?? 1;
    let titleAttached = false;

    function addSection(label, members, max) {
        if (!titleAttached) {
            fields.push(...createTitledMemberFields(
                departmentTitle,
                label,
                members,
                max,
                sorter
            ));
            titleAttached = true;
            return;
        }

        fields.push(...createMemberFields(`${label}:`, members, max, sorter));
    }

    if (department.curatorsEnabled !== false) {
        addSection('Куратор отдела', groups.curators, 0);
    }
    if (headLimit > 0) {
        addSection('Глава отдела', groups.heads, headLimit);
    }
    if (deputyHeadLimit > 0) {
        addSection('Заместители главы отдела', groups.depHeads, deputyHeadLimit);
    }

    return fields;
}

function buildHighStaffEmbeds(members, serverConfig, guildId = '') {
    const paginator = createEmbedPaginator(0xF1C40F, HIGH_STAFF_TITLE);
    const sorter = createMemberSorter(serverConfig, guildId);
    const leadershipRanks = getLeadershipRanks(serverConfig);
    const assignedGlobalMembers = new Set();
    const settings = getStaffListSettings(serverConfig);
    const globalFieldGroups = [];

    for (const rank of leadershipRanks) {
        const rankMembers = getRankMembers(members, rank)
            .filter((member) => !member.user?.bot && !assignedGlobalMembers.has(member.id));
        rankMembers.forEach((member) => assignedGlobalMembers.add(member.id));
        globalFieldGroups.push(buildLeadershipRankFields(
            rank,
            rankMembers,
            sorter,
            settings.leaderAppointmentDate,
            settings.leaderTermDays
        ));
    }

    if (!leadershipRanks.length) {
        globalFieldGroups.push([{
            name: 'Руководство:',
            value: '> Руководящие ранги не настроены.',
            inline: false,
        }]);
    }

    const departmentFieldGroups = getDepartments(serverConfig)
        .map((department) => {
            const groups = getDepartmentStaffGroups(members, serverConfig, department);
            return buildDepartmentLeadershipFields(groups, department, sorter);
        })
        .filter((fields) => fields.length > 0);

    const lastGroup = departmentFieldGroups.at(-1) || globalFieldGroups.at(-1);
    appendUpdateInfo(lastGroup);

    globalFieldGroups.forEach((fields) => paginator.addGroup(fields));
    departmentFieldGroups.forEach((fields) => paginator.addSeparatedGroup(fields));

    return paginator.build();
}

module.exports = {
    HIGH_STAFF_TITLE,
    buildDepartmentEmbeds,
    buildHighStaffEmbeds,
    getDepartmentStaffGroups,
    getLeaderTermInfo,
};
