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
const StaffAuditError = require('./error');

const ALLOWED_ARGUMENTS = {
    invite: new Set(['member', 'static', 'rank', 'department', 'reason']),
    rank: new Set(['member', 'static', 'from', 'rank', 'reason', 'keep_department']),
    uval: new Set(['member', 'static', 'reason']),
};

function unescapeQuoted(value) {
    return String(value || '').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function parseArguments(source, lineNumber) {
    const args = {};
    const input = String(source || '');
    const regex = /\s*([a-zA-Z_][a-zA-Z0-9_]*):(?:"((?:\\.|[^"\\])*)"|(\S+))/gy;
    let cursor = 0;

    while (cursor < input.length) {
        regex.lastIndex = cursor;
        const match = regex.exec(input);
        if (!match) {
            if (!input.slice(cursor).trim()) break;
            const fragment = input.slice(cursor).trim().slice(0, 80);
            throw new StaffAuditError(
                `Строка ${lineNumber}: не удалось разобрать фрагмент "${fragment}". ` +
                'Используйте формат key:value, а значения с пробелами заключайте в кавычки.',
                'mass_audit_invalid_syntax'
            );
        }

        const key = match[1].toLowerCase();
        if (Object.prototype.hasOwnProperty.call(args, key)) {
            throw new StaffAuditError(
                `Строка ${lineNumber}: параметр ${key} указан несколько раз.`,
                'mass_audit_duplicate_argument'
            );
        }
        args[key] = match[2] !== undefined ? unescapeQuoted(match[2]) : match[3];
        cursor = regex.lastIndex;
    }

    return args;
}

function assertAllowedArguments(action, args, lineNumber) {
    const allowed = ALLOWED_ARGUMENTS[action];
    const unknown = Object.keys(args).filter((key) => !allowed.has(key));
    if (unknown.length) {
        throw new StaffAuditError(
            `Строка ${lineNumber}: неизвестные параметры для ${action}: ${unknown.join(', ')}.`,
            'mass_audit_unknown_argument'
        );
    }
}

function normalizeMember(value) {
    const raw = String(value || '').trim();
    const mention = raw.match(/^<@!?(\d{17,20})>$/);
    const memberId = mention?.[1] || (/^\d{17,20}$/.test(raw) ? raw : null);
    if (!memberId) {
        throw new StaffAuditError('Параметр member должен содержать Discord ID или упоминание.', 'mass_audit_invalid_member');
    }
    return memberId;
}

function parseLine(line, lineNumber) {
    const trimmed = String(line || '').trim();
    if (!trimmed || trimmed.startsWith('#')) return null;
    const actionMatch = trimmed.match(/^\/?(invite|rank|uval)\b/i);
    if (!actionMatch) {
        throw new StaffAuditError(`Строка ${lineNumber}: неизвестное действие.`, 'mass_audit_unknown_action');
    }

    const action = actionMatch[1].toLowerCase();
    const args = parseArguments(trimmed.slice(actionMatch[0].length), lineNumber);
    assertAllowedArguments(action, args, lineNumber);

    let memberId;
    try {
        memberId = normalizeMember(args.member);
    } catch (error) {
        if (error instanceof StaffAuditError) {
            error.userMessage = `Строка ${lineNumber}: ${error.userMessage}`;
        }
        throw error;
    }
    const reason = String(args.reason || '').trim();

    if (action === 'invite') {
        const rankNumber = args.rank === undefined ? null : Number(args.rank);
        if (rankNumber !== null && (!Number.isSafeInteger(rankNumber) || rankNumber <= 0)) {
            throw new StaffAuditError(`Строка ${lineNumber}: rank должен быть положительным числом.`, 'mass_audit_invalid_rank');
        }
        return {
            lineNumber,
            action,
            memberId,
            staticId: args.static ? String(args.static).trim() : null,
            rankNumber,
            departmentId: args.department ? String(args.department).trim() : null,
            reason: reason || 'Собеседование',
        };
    }

    if (action === 'rank') {
        const rankNumber = Number(args.rank);
        if (!Number.isSafeInteger(rankNumber) || rankNumber <= 0) {
            throw new StaffAuditError(`Строка ${lineNumber}: для rank требуется целевой rank.`, 'mass_audit_invalid_rank');
        }
        if (!reason) {
            throw new StaffAuditError(`Строка ${lineNumber}: для rank требуется reason.`, 'mass_audit_reason_required');
        }
        const keepDepartmentValue = String(args.keep_department || '').toLowerCase();
        if (keepDepartmentValue && !['true', 'false'].includes(keepDepartmentValue)) {
            throw new StaffAuditError(
                `Строка ${lineNumber}: keep_department должен быть true или false.`,
                'mass_audit_invalid_boolean'
            );
        }
        const fromRankNumber = args.from === undefined ? null : Number(args.from);
        if (fromRankNumber !== null && (!Number.isSafeInteger(fromRankNumber) || fromRankNumber <= 0)) {
            throw new StaffAuditError(`Строка ${lineNumber}: from должен быть положительным числом.`, 'mass_audit_invalid_from_rank');
        }
        return {
            lineNumber,
            action,
            memberId,
            staticId: args.static ? String(args.static).trim() : null,
            fromRankNumber,
            rankNumber,
            reason,
            keepDepartment: keepDepartmentValue === 'true',
        };
    }

    if (!reason) {
        throw new StaffAuditError(`Строка ${lineNumber}: для uval требуется reason.`, 'mass_audit_reason_required');
    }
    return {
        lineNumber,
        action,
        memberId,
        staticId: args.static ? String(args.static).trim() : null,
        reason,
    };
}

function parseMassAuditText(text) {
    const lines = String(text || '').split(/\r?\n/);
    const items = [];
    for (let index = 0; index < lines.length; index += 1) {
        const item = parseLine(lines[index], index + 1);
        if (item) items.push(item);
    }
    if (!items.length) {
        throw new StaffAuditError('Список массового кадрового аудита пуст.', 'mass_audit_empty');
    }
    return items;
}

module.exports = { parseMassAuditText };
