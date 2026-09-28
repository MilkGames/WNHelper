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
    rank: new Set(['member', 'static', 'action', 'reason', 'keep_department']),
    uval: new Set(['member', 'static', 'reason']),
};

function unescapeQuoted(value) {
    return String(value || '').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function findNextArgumentStart(input, startIndex) {
    const regex = /\s+([a-zA-Z_][a-zA-Z0-9_]*):/g;
    regex.lastIndex = startIndex;
    const match = regex.exec(input);
    return match ? match.index : input.length;
}

function parseQuotedValue(input, startIndex, lineNumber) {
    let cursor = startIndex + 1;
    let escaped = false;

    while (cursor < input.length) {
        const char = input[cursor];
        if (escaped) {
            escaped = false;
            cursor += 1;
            continue;
        }
        if (char === '\\') {
            escaped = true;
            cursor += 1;
            continue;
        }
        if (char === '"') {
            return {
                value: unescapeQuoted(input.slice(startIndex + 1, cursor)),
                cursor: cursor + 1,
            };
        }
        cursor += 1;
    }

    throw new StaffAuditError(
        `Строка ${lineNumber}: не закрыта кавычка в значении параметра.`,
        'mass_audit_unclosed_quote'
    );
}

function parseArguments(source, lineNumber) {
    const args = {};
    const input = String(source || '');
    let cursor = 0;

    while (cursor < input.length) {
        while (cursor < input.length && /\s/u.test(input[cursor])) cursor += 1;
        if (cursor >= input.length) break;

        const keyMatch = input.slice(cursor).match(/^([a-zA-Z_][a-zA-Z0-9_]*):/u);
        if (!keyMatch) {
            const fragment = input.slice(cursor).trim().slice(0, 80);
            throw new StaffAuditError(
                `Строка ${lineNumber}: не удалось разобрать фрагмент "${fragment}". ` +
                'Используйте формат key:value.',
                'mass_audit_invalid_syntax'
            );
        }

        const key = keyMatch[1].toLowerCase();
        if (Object.prototype.hasOwnProperty.call(args, key)) {
            throw new StaffAuditError(
                `Строка ${lineNumber}: параметр ${key} указан несколько раз.`,
                'mass_audit_duplicate_argument'
            );
        }

        cursor += keyMatch[0].length;
        if (cursor >= input.length) {
            throw new StaffAuditError(
                `Строка ${lineNumber}: параметр ${key} не содержит значения.`,
                'mass_audit_empty_argument'
            );
        }

        let parsed;
        if (input[cursor] === '"') {
            parsed = parseQuotedValue(input, cursor, lineNumber);
        } else if (key === 'member') {
            const end = findNextArgumentStart(input, cursor);
            parsed = {
                value: input.slice(cursor, end).trim(),
                cursor: end,
            };
        } else {
            const valueMatch = input.slice(cursor).match(/^(\S+)/u);
            parsed = {
                value: valueMatch?.[1] || '',
                cursor: cursor + (valueMatch?.[1]?.length || 0),
            };
        }

        if (!parsed.value) {
            throw new StaffAuditError(
                `Строка ${lineNumber}: параметр ${key} не содержит значения.`,
                'mass_audit_empty_argument'
            );
        }

        args[key] = parsed.value;
        cursor = parsed.cursor;
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

function normalizeMember(value, staticId, lineNumber) {
    const raw = String(value || '').trim();
    if (!raw) {
        throw new StaffAuditError(`Строка ${lineNumber}: параметр member обязателен.`, 'mass_audit_member_required');
    }

    const mention = raw.match(/^<@!?(\d{17,20})>$/u);
    const memberId = mention?.[1] || (/^\d{17,20}$/u.test(raw) ? raw : null);
    if (memberId) {
        return {
            memberInput: memberId,
            memberId,
            targetKey: `member:${memberId}`,
        };
    }

    if (!staticId) {
        throw new StaffAuditError(
            `Строка ${lineNumber}: текстовое значение member требует параметр static.`,
            'mass_audit_static_required'
        );
    }

    return {
        memberInput: raw,
        memberId: null,
        targetKey: `external:${String(staticId).trim()}`,
    };
}

function parseRankAction(value, lineNumber) {
    const match = String(value || '').trim().match(/^(\d+)\s*-\s*(\d+)$/u);
    if (!match) {
        throw new StaffAuditError(
            `Строка ${lineNumber}: параметр action должен быть указан в формате 2-3 или 4-2.`,
            'mass_audit_invalid_action'
        );
    }

    const fromRankNumber = Number(match[1]);
    const rankNumber = Number(match[2]);
    if (!Number.isSafeInteger(fromRankNumber) || !Number.isSafeInteger(rankNumber) || fromRankNumber <= 0 || rankNumber <= 0) {
        throw new StaffAuditError(
            `Строка ${lineNumber}: номера рангов в action должны быть положительными числами.`,
            'mass_audit_invalid_action'
        );
    }
    if (fromRankNumber === rankNumber) {
        throw new StaffAuditError(
            `Строка ${lineNumber}: начальный и конечный ранги в action должны отличаться.`,
            'mass_audit_same_rank'
        );
    }

    return {
        actionInput: `${fromRankNumber}-${rankNumber}`,
        fromRankNumber,
        rankNumber,
    };
}

function parseLine(line, lineNumber) {
    const trimmed = String(line || '').trim();
    if (!trimmed || trimmed.startsWith('#')) return null;
    const actionMatch = trimmed.match(/^\/?(invite|rank|uval)\b/iu);
    if (!actionMatch) {
        throw new StaffAuditError(`Строка ${lineNumber}: неизвестное действие.`, 'mass_audit_unknown_action');
    }

    const action = actionMatch[1].toLowerCase();
    const args = parseArguments(trimmed.slice(actionMatch[0].length), lineNumber);
    assertAllowedArguments(action, args, lineNumber);

    const staticId = args.static ? String(args.static).trim() : null;
    const member = normalizeMember(args.member, staticId, lineNumber);
    const reason = String(args.reason || '').trim();

    if (action === 'invite') {
        const rankNumber = args.rank === undefined ? null : Number(args.rank);
        if (rankNumber !== null && (!Number.isSafeInteger(rankNumber) || rankNumber <= 0)) {
            throw new StaffAuditError(`Строка ${lineNumber}: rank должен быть положительным числом.`, 'mass_audit_invalid_rank');
        }
        return {
            lineNumber,
            action,
            ...member,
            staticId,
            rankNumber,
            departmentId: args.department ? String(args.department).trim() : null,
            reason: reason || 'Собеседование',
        };
    }

    if (action === 'rank') {
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
        return {
            lineNumber,
            action,
            ...member,
            staticId,
            ...parseRankAction(args.action, lineNumber),
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
        ...member,
        staticId,
        reason,
    };
}

function parseMassAuditText(text) {
    const lines = String(text || '').split(/\r?\n/u);
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
