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
const { readDatabase: readDb } = require('./database');
const DisciplineError = require('./error');

function normalizeName(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeStaticId(value) {
    const text = String(value || '').trim();
    if (!/^\d{1,12}$/.test(text)) {
        throw new DisciplineError('Статик должен содержать только цифры.', 'external_static_invalid');
    }
    return text;
}

function createExternalTargetId(guildId, staticId) {
    const normalizedGuildId = String(guildId || '').trim();
    const normalizedStatic = normalizeStaticId(staticId);
    if (normalizedGuildId) {
        const digest = crypto.createHash('sha256')
            .update(`${normalizedGuildId}:${normalizedStatic}`)
            .digest('hex')
            .slice(0, 32);
        return `external-discipline-${digest}`;
    }
    return typeof crypto.randomUUID === 'function'
        ? `external-discipline-${crypto.randomUUID()}`
        : `external-discipline-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getExternalIdentitySnapshot(caseRecord) {
    const snapshot = caseRecord?.externalSnapshot || {};
    return {
        externalTargetId: caseRecord?.externalTargetId || caseRecord?.linkedFromExternalTargetId || snapshot.externalTargetId || null,
        staticId: caseRecord?.externalStaticId || caseRecord?.memberStaticId || snapshot.staticId || null,
        displayName: caseRecord?.externalDisplayName || snapshot.displayName || caseRecord?.memberDisplayName || null,
        memberId: caseRecord?.linkedFromExternalTargetId && caseRecord?.memberId ? String(caseRecord.memberId) : null,
        memberDisplayName: caseRecord?.linkedFromExternalTargetId && caseRecord?.memberId
            ? String(caseRecord.memberDisplayName || caseRecord.memberId)
            : null,
    };
}

function findExternalIdentity(guildId, { externalTargetId = null, staticId = null } = {}) {
    const normalizedGuildId = String(guildId || '');
    const normalizedStatic = staticId == null ? null : normalizeStaticId(staticId);
    const expectedId = externalTargetId
        ? String(externalTargetId)
        : normalizedStatic && normalizedGuildId
            ? createExternalTargetId(normalizedGuildId, normalizedStatic)
            : null;
    const db = readDb();
    const matches = [];
    for (const caseRecord of db.disciplineCases || []) {
        if (String(caseRecord.guildId) !== normalizedGuildId) continue;
        const identity = getExternalIdentitySnapshot(caseRecord);
        const idMatches = expectedId && String(identity.externalTargetId || '') === expectedId;
        const staticMatches = normalizedStatic && String(identity.staticId || '') === normalizedStatic;
        if (idMatches || staticMatches) matches.push(identity);
    }
    const linked = matches.find((identity) => identity.memberId);
    if (linked) return linked;
    if (matches.length) return matches[0];
    return expectedId || normalizedStatic ? {
        externalTargetId: expectedId || createExternalTargetId(normalizedGuildId, normalizedStatic),
        staticId: normalizedStatic,
        displayName: null,
        memberId: null,
        memberDisplayName: null,
    } : null;
}

function createExternalTarget({ guildId, displayName, staticId, externalTargetId = null }) {
    const name = normalizeName(displayName);
    if (!name) throw new DisciplineError('Укажите имя и фамилию сотрудника.', 'external_name_required');
    if (name.length > 100) {
        throw new DisciplineError('Имя внешнего сотрудника не должно превышать 100 символов.', 'external_name_too_long');
    }
    const normalizedStatic = normalizeStaticId(staticId);
    const id = String(
        externalTargetId || createExternalTargetId(guildId, normalizedStatic)
    );
    return {
        type: 'external',
        targetKey: `external:${id}`,
        externalTargetId: id,
        memberId: null,
        displayName: name,
        staticId: normalizedStatic,
    };
}


function resolveExternalTarget({ guildId, displayName, staticId, externalTargetId = null }) {
    const external = createExternalTarget({ guildId, displayName, staticId, externalTargetId });
    const identity = findExternalIdentity(guildId, {
        externalTargetId: external.externalTargetId,
        staticId: external.staticId,
    });
    if (identity?.memberId) {
        return createMemberTarget(identity.memberId, identity.memberDisplayName || identity.displayName || displayName);
    }
    if (identity?.externalTargetId && identity.externalTargetId !== external.externalTargetId) {
        return createExternalTarget({
            guildId,
            displayName: identity.displayName || displayName,
            staticId: identity.staticId || staticId,
            externalTargetId: identity.externalTargetId,
        });
    }
    return external;
}

function getLinkedMemberForExternal(guildId, externalTargetId, staticId = null) {
    const identity = findExternalIdentity(guildId, { externalTargetId, staticId });
    return identity?.memberId ? {
        memberId: identity.memberId,
        displayName: identity.memberDisplayName || identity.displayName || identity.memberId,
    } : null;
}

function createMemberTarget(memberOrId, displayName = null) {
    const id = typeof memberOrId === 'string' ? memberOrId : memberOrId?.id;
    if (!/^\d{17,20}$/.test(String(id || ''))) {
        throw new DisciplineError('Некорректный Discord ID сотрудника.', 'member_id_invalid');
    }
    const name = displayName || memberOrId?.displayName || memberOrId?.user?.username || String(id);
    return {
        type: 'member',
        targetKey: `member:${id}`,
        memberId: String(id),
        externalTargetId: null,
        displayName: String(name),
        staticId: null,
    };
}

function resolveSingleTargetInput({ guildId, memberInput, staticId = null }) {
    const raw = String(memberInput || '').trim();
    if (!raw) {
        throw new DisciplineError('Укажите тег Discord, ID или имя сотрудника.', 'discipline_target_required');
    }

    const mention = raw.match(/^<@!?(\d{17,20})>$/);
    const memberId = mention?.[1] || (/^\d{17,20}$/.test(raw) ? raw : null);
    if (memberId) return createMemberTarget(memberId);

    const normalizedStatic = String(staticId || '').trim();
    if (!normalizedStatic) {
        throw new DisciplineError(
            'Если в `member` указано имя сотрудника, заполните параметр `static`.',
            'external_static_required'
        );
    }

    return resolveExternalTarget({
        guildId,
        displayName: raw,
        staticId: normalizedStatic,
    });
}

function normalizeDescriptor(source, guildId = null) {
    if (!source) return null;
    if (typeof source === 'string') {
        const raw = source.trim();
        const mention = raw.match(/^<@!?(\d{17,20})>$/);
        if (mention || /^\d{17,20}$/.test(raw)) return createMemberTarget(mention?.[1] || raw);
        const external = raw.match(/^(.+?)\s*\|\s*(\d{1,12})$/);
        if (external) return resolveExternalTarget({ guildId, displayName: external[1], staticId: external[2] });
        return null;
    }
    if (source.type === 'external' || source.externalTargetId || (!source.memberId && source.staticId)) {
        return resolveExternalTarget({
            guildId,
            displayName: source.displayName,
            staticId: source.staticId,
            externalTargetId: source.externalTargetId,
        });
    }
    if (source.type === 'member' || source.memberId) {
        return createMemberTarget(source.memberId, source.displayName);
    }
    return null;
}

function normalizeTargets(values, guildId = null) {
    const result = [];
    const seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
        const target = normalizeDescriptor(value, guildId);
        if (!target) continue;
        const dedupeKey = target.type === 'external'
            ? `external-static:${String(guildId || '')}:${target.staticId}`
            : target.targetKey;
        if (seen.has(dedupeKey)) {
            throw new DisciplineError(
                `Сотрудник ${formatTarget(target)} указан в списке повторно.`,
                target.type === 'external' ? 'mass_duplicate_external' : 'mass_duplicate_member'
            );
        }
        seen.add(dedupeKey);
        result.push(target);
    }
    return result;
}

function parseTargetText(text, guildId = null) {
    const targets = [];
    const invalidLines = [];
    const lines = String(text || '').split(/\r?\n/);
    for (const original of lines) {
        const line = original.trim();
        if (!line) continue;
        const externalMatch = line.match(/^(.+?)\s*\|\s*(\d{1,12})$/);
        if (externalMatch) {
            targets.push(resolveExternalTarget({
                guildId,
                displayName: externalMatch[1],
                staticId: externalMatch[2],
            }));
            continue;
        }
        const ids = line.match(/\d{17,20}/g) || [];
        if (ids.length) {
            for (const id of ids) targets.push(createMemberTarget(id));
            continue;
        }
        invalidLines.push(line);
    }
    const normalized = normalizeTargets(targets, guildId);
    if (!normalized.length && invalidLines.length) {
        throw new DisciplineError(
            `Не удалось распознать сотрудников. Используйте Discord ID, упоминание или "Имя Фамилия | статик".\n${invalidLines.slice(0, 5).join('\n')}`,
            'mass_targets_invalid'
        );
    }
    if (!normalized.length) {
        throw new DisciplineError('В списке не найдено ни одного сотрудника.', 'mass_targets_empty');
    }
    if (invalidLines.length) {
        const error = new DisciplineError(
            `Некоторые строки не распознаны:\n${invalidLines.slice(0, 10).join('\n')}`,
            'mass_targets_partially_invalid'
        );
        error.targets = normalized;
        error.invalidLines = invalidLines;
        throw error;
    }
    return normalized;
}

function getCaseTargetKey(caseRecord) {
    if (caseRecord?.memberId) return `member:${caseRecord.memberId}`;
    if (caseRecord?.externalTargetId) return `external:${caseRecord.externalTargetId}`;
    return null;
}

function matchesCaseTarget(caseRecord, targetKey) {
    return Boolean(targetKey && getCaseTargetKey(caseRecord) === String(targetKey));
}

function formatTarget(target, { mention = true } = {}) {
    if (!target) return 'неизвестно';
    if (target.type === 'external' || (!target.memberId && target.externalTargetId)) {
        return `${target.displayName || 'неизвестно'} | ${target.staticId || 'без статика'}`;
    }
    const id = String(target.memberId || '');
    const name = String(target.displayName || id || 'неизвестно');
    return mention && id ? `<@${id}> | ${name} | ||${id}||` : `${name} | ||${id}||`;
}

function targetFromCase(caseRecord) {
    if (caseRecord?.memberId) {
        return createMemberTarget(caseRecord.memberId, caseRecord.memberDisplayName);
    }
    return {
        type: 'external',
        targetKey: `external:${caseRecord.externalTargetId}`,
        externalTargetId: caseRecord.externalTargetId,
        memberId: null,
        displayName: caseRecord.externalDisplayName || caseRecord.memberDisplayName,
        staticId: caseRecord.externalStaticId || caseRecord.memberStaticId,
    };
}

module.exports = {
    createExternalTarget,
    findExternalIdentity,
    getLinkedMemberForExternal,
    createMemberTarget,
    formatTarget,
    getCaseTargetKey,
    matchesCaseTarget,
    normalizeName,
    normalizeStaticId,
    normalizeTargets,
    parseTargetText,
    resolveExternalTarget,
    resolveSingleTargetInput,
    targetFromCase,
};
