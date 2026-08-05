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
const { getOwnerUserIds } = require('../../core/config/applicationConfig');
const guildConfigService = require('../../core/config/guildConfigService');
const { SessionStore } = require('../../core/sessions/sessionStore');
const { SETTINGS_SECTION_KEYS } = require('./accessSchema');
const {
    createSettingsDraft,
    getSettingsChanges,
    prepareSettingsForStorage,
} = require('./schema');

const SESSION_TTL_MS = 30 * 60 * 1000;
const sessionStore = new SessionStore({ ttlMs: SESSION_TTL_MS });

function now() {
    return Date.now();
}

function clone(value) {
    return value == null ? value : structuredClone(value);
}

function isBotOwner(userId) {
    return getOwnerUserIds().has(String(userId || ''));
}

function memberHasRole(member, roleId) {
    if (!member || !roleId) return false;

    if (member.roles?.cache?.has) {
        return member.roles.cache.has(roleId);
    }

    if (Array.isArray(member.roles)) {
        return member.roles.includes(roleId);
    }

    return false;
}

function getSettingsAccess(member, guildId) {
    const userId = member?.id || member?.user?.id;
    if (isBotOwner(userId)) {
        return { allowed: true, fullAccess: true, sectionKeys: [...SETTINGS_SECTION_KEYS] };
    }

    const config = guildConfigService.getAny(guildId);
    const managerRoleIds = Array.isArray(config?.settingsManagerRoleIds)
        ? config.settingsManagerRoleIds
        : [];
    if (managerRoleIds.some((roleId) => memberHasRole(member, roleId))) {
        return { allowed: true, fullAccess: true, sectionKeys: [...SETTINGS_SECTION_KEYS] };
    }

    const sectionKeys = new Set();
    for (const entry of Array.isArray(config?.settingsSectionAccess) ? config.settingsSectionAccess : []) {
        if (!memberHasRole(member, entry.roleId)) continue;
        for (const key of Array.isArray(entry.sectionKeys) ? entry.sectionKeys : []) {
            if (SETTINGS_SECTION_KEYS.has(key)) sectionKeys.add(key);
        }
    }
    return {
        allowed: sectionKeys.size > 0,
        fullAccess: false,
        sectionKeys: [...sectionKeys],
    };
}

function canManageSettings(member, guildId) {
    return getSettingsAccess(member, guildId).allowed;
}

const SECTION_ROOTS = {
    main: null,
    changes: null,
    settingsAccess: 'access',
    manualToolsAccess: 'access',
    features: 'features',
    channels: 'channels',
    commonRoles: 'commonRoles',
    departments: 'departments',
    departmentRoles: 'departments',
    departmentChannel: 'departments',
    departmentDelete: 'departments',
    ranks: 'ranks',
    rankRole: 'ranks',
    rankPolicy: 'ranks',
    rankDelete: 'ranks',
    rankStaffList: 'ranks',
    exams: 'exams',
    examinationGeneral: 'exams',
    examinationChannels: 'exams',
    examinationVoiceChannels: 'exams',
    lectureTypes: 'exams',
    lectureTypeDetails: 'exams',
    lectureTypeDelete: 'exams',
    publicationPreview: null,
    publications: 'publications',
    examMode: 'exams',
    examDelete: 'exams',
    giveRoles: 'giveRoles',
    staffAudit: 'staffAudit',
    staffLists: 'staffLists',
    channelCounters: 'channelCounters',
    shiftTypes: 'shiftTypes',
    shiftTypeChannel: 'shiftTypes',
    shiftSchedule: 'shiftTypes',
    shiftAccess: 'shiftTypes',
    shiftManagers: 'shiftTypes',
    shiftPublish: 'shiftTypes',
    shiftDelete: 'shiftTypes',
    discipline: 'discipline',
    disciplineGeneral: 'discipline',
    disciplineStage: 'discipline',
    disciplineStageRoles: 'discipline',
    disciplineMethods: 'discipline',
    disciplineMethodStages: 'discipline',
    disciplineMethodDepartments: 'discipline',
    disciplineRules: 'discipline',
    vacations: 'vacations',
    diagnostics: 'diagnostics',
    vacationGeneral: 'vacations',
    vacationRoutes: 'vacations',
    vacationRouteDetails: 'vacations',
    vacationTypes: 'vacations',
    vacationTypeDetails: 'vacations',
    vacationTypeAvailability: 'vacations',
    vacationTypeLimits: 'vacations',
    vacationTypeActions: 'vacations',
    vacationTypeBehavior: 'vacations',
    vacationTypeOverdue: 'vacations',
};

function canAccessSection(session, section) {
    if (!session) return false;
    if (section === 'main' || section === 'changes') return true;
    const root = SECTION_ROOTS[section] || section;
    if (root === 'access') return session.fullAccess === true;
    return session.fullAccess === true || session.allowedSectionKeys?.includes(root);
}

function isExpired(session) {
    return !session || now() - session.lastActivityAt >= SESSION_TTL_MS;
}

function removeSession(session) {
    if (!session) return null;
    return sessionStore.delete(session.id);
}

function getActiveByGuild(guildId) {
    return sessionStore.getByIndex('guildId', String(guildId));
}

function getById(sessionId) {
    return sessionStore.get(String(sessionId));
}

function refreshChanges(session) {
    session.changes = getSettingsChanges(session.original, session.draft);
    session.dirty = session.changes.length > 0;

    const maxPage = Math.max(Math.ceil(session.changes.length / 10) - 1, 0);
    session.changePage = Math.min(Math.max(session.changePage || 0, 0), maxPage);
    return session.changes;
}

function start({ guild, user, member = null }) {
    const guildId = String(guild.id);
    const existing = getActiveByGuild(guildId);
    if (existing) {
        return { created: false, session: existing };
    }

    const access = getSettingsAccess(member || user, guildId);
    if (!access.allowed) return { created: false, denied: true, session: null };

    const rawConfig = guildConfigService.getAny(guildId) || {
        guildId,
        _serverName: guild.name,
    };
    const original = createSettingsDraft(rawConfig);

    const timestamp = now();
    const session = {
        id: crypto.randomBytes(6).toString('hex'),
        guildId,
        userId: String(user.id),
        userTag: user.tag || user.username || String(user.id),
        fullAccess: access.fullAccess,
        allowedSectionKeys: access.sectionKeys,
        original: clone(original),
        draft: clone(original),
        changes: [],
        dirty: false,
        section: 'main',
        changePage: 0,
        selectedChannelKey: null,
        selectedSettingsAccessRoleId: null,
        selectedManualToolsAccessRoleId: null,
        selectedRoleKey: null,
        selectedDepartmentId: null,
        selectedDepartmentRoleKey: null,
        departmentPage: 0,
        selectedRankNumber: null,
        rankPage: 0,
        selectedExamId: null,
        examPage: 0,
        selectedLectureTypeId: null,
        lectureTypePage: 0,
        publicationKind: null,
        publicationChannelId: null,
        publicationExaminationMode: 'both',
        publicationMode: 'new',
        publicationExisting: null,
        selectedGiveRolesKey: null,
        giveRolesDepartmentPage: 0,
        giveRolesRankPage: 0,
        selectedStaffAuditKey: null,
        selectedDisciplineGeneralKey: null,
        selectedDisciplineStage: 'conversation',
        selectedDisciplineRoleCount: 1,
        selectedDisciplineMethodId: null,
        selectedDisciplineRuleId: null,
        staffAuditRankPage: 0,
        selectedStaffListKey: null,
        selectedChannelCounterKey: null,
        selectedShiftTypeId: null,
        shiftTypePage: 0,
        selectedShiftAccessGroupId: null,
        shiftAccessGroupPage: 0,
        selectedVacationTypeId: null,
        vacationTypePage: 0,
        selectedVacationRouteId: null,
        vacationRoutePage: 0,
        selectedVacationOverdueRuleId: null,
        errorLines: [],
        statusLine: null,
        channelId: null,
        messageId: null,
        createdAt: timestamp,
        lastActivityAt: timestamp,
    };

    sessionStore.set(session.id, session, { guildId });
    return { created: true, session };
}

function attachMessage(session, message) {
    session.channelId = String(message.channelId);
    session.messageId = String(message.id);
    session.lastActivityAt = now();
    return session;
}

function touch(session) {
    session.lastActivityAt = now();
    return session;
}

function markChanged(session, statusLine = null) {
    refreshChanges(session);
    session.errorLines = [];
    session.statusLine = statusLine;
    return touch(session);
}

function setSection(session, section) {
    if (!canAccessSection(session, section)) return false;
    session.section = section;
    session.errorLines = [];
    session.statusLine = null;
    if (section !== 'changes') session.changePage = 0;
    touch(session);
    return true;
}

function setChangePage(session, page) {
    refreshChanges(session);
    const maxPage = Math.max(Math.ceil(session.changes.length / 10) - 1, 0);
    session.changePage = Math.min(Math.max(Number(page) || 0, 0), maxPage);
    session.errorLines = [];
    session.statusLine = null;
    return touch(session);
}

function setErrors(session, errors) {
    session.errorLines = Array.isArray(errors) ? errors : [];
    session.statusLine = null;
    return touch(session);
}

function setStatus(session, statusLine) {
    session.errorLines = [];
    session.statusLine = statusLine || null;
    return touch(session);
}

function getChanges(session) {
    refreshChanges(session);
    return clone(session.changes);
}

async function save(session) {
    const preparedDraft = prepareSettingsForStorage(session.draft);
    const latestConfig = guildConfigService.getAny(session.guildId) || {
        guildId: session.guildId,
        _serverName: session.draft._serverName,
    };
    const document = prepareSettingsForStorage(latestConfig);
    document.guildId = session.guildId;
    document._serverName = preparedDraft._serverName;

    const allowed = session.fullAccess
        ? new Set([...SETTINGS_SECTION_KEYS, 'access'])
        : new Set(session.allowedSectionKeys || []);

    if (allowed.has('access')) {
        document.settingsManagerRoleIds = preparedDraft.settingsManagerRoleIds;
        document.settingsSectionAccess = preparedDraft.settingsSectionAccess;
        document.manualToolsAccess = preparedDraft.manualToolsAccess;
    }
    if (allowed.has('features')) document.features = preparedDraft.features;
    if (allowed.has('channels')) document.channels = preparedDraft.channels;
    if (allowed.has('commonRoles')) document.commonRoles = preparedDraft.commonRoles;
    if (allowed.has('departments')) document.departments = preparedDraft.departments;
    if (allowed.has('ranks')) document.ranks = preparedDraft.ranks;
    if (allowed.has('exams')) {
        document.exams = preparedDraft.exams;
        document.examinationSettings = preparedDraft.examinationSettings;
    }
    if (allowed.has('giveRoles')) document.giveRolesSettings = preparedDraft.giveRolesSettings;
    if (allowed.has('staffAudit')) document.staffAuditSettings = preparedDraft.staffAuditSettings;
    if (allowed.has('staffLists')) document.staffListSettings = preparedDraft.staffListSettings;
    if (allowed.has('channelCounters')) document.channelCounterSettings = preparedDraft.channelCounterSettings;
    if (allowed.has('shiftTypes')) document.shiftTypes = preparedDraft.shiftTypes;
    if (allowed.has('discipline')) document.disciplineSettings = preparedDraft.disciplineSettings;
    if (allowed.has('vacations')) document.vacationSettings = preparedDraft.vacationSettings;

    const saved = await guildConfigService.replace(session.guildId, document);
    removeSession(session);
    return saved;
}

function cancel(session) {
    return removeSession(session);
}

function forceClose(guildId) {
    return removeSession(sessionStore.getByIndex('guildId', String(guildId)));
}

function forceCloseByUser(guildId, userId) {
    const session = sessionStore.getByIndex('guildId', String(guildId));
    if (!session || String(session.userId) !== String(userId)) return null;
    return removeSession(session);
}

function buildMessageLink(session) {
    if (!session?.guildId || !session?.channelId || !session?.messageId) return null;
    return `https://discord.com/channels/${session.guildId}/${session.channelId}/${session.messageId}`;
}

module.exports = {
    SESSION_TTL_MS,
    attachMessage,
    buildMessageLink,
    canAccessSection,
    canManageSettings,
    cancel,
    forceClose,
    forceCloseByUser,
    getActiveByGuild,
    getById,
    getChanges,
    getSettingsAccess,
    isBotOwner,
    markChanged,
    save,
    setChangePage,
    setErrors,
    setSection,
    setStatus,
    start,
    touch,
};
