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
const PUBLIC_SENSITIVE_REPLACEMENTS = [
    {
        pattern: /(https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/)([^\s/?#]+)/giu,
        replacement: '$1[СКРЫТО]',
    },
    {
        pattern: /(\bBearer\s+)([A-Za-z0-9._~+\/-]+)/giu,
        replacement: '$1[СКРЫТО]',
    },
    {
        pattern: /(["']?(?:authorization|token|secret|password|webhook[_-]?key|test[_-]?key|api[_-]?key)["']?\s*[:=]\s*["'])([^"']+)(["'])/giu,
        replacement: '$1[СКРЫТО]$3',
    },
    {
        pattern: /((?:authorization|token|secret|password|webhook[_-]?key|test[_-]?key|api[_-]?key)\s*[:=]\s*)([^\s,;]+)/giu,
        replacement: '$1[СКРЫТО]',
    },
];

function getKnownSecrets() {
    return ['token', 'WEBHOOK_KEY', 'TEST_KEY']
        .map((key) => String(process.env[key] || '').trim())
        .filter((value) => value.length >= 4);
}

function sanitizePublicText(value) {
    let result = String(value || '').trim();
    for (const secret of getKnownSecrets()) {
        result = result.split(secret).join('[СКРЫТО]');
    }
    for (const { pattern, replacement } of PUBLIC_SENSITIVE_REPLACEMENTS) {
        result = result.replace(pattern, replacement);
    }
    return result;
}

function limitPublicText(value, maxLength = 1_900) {
    const result = String(value || '');
    if (result.length <= maxLength) return result;
    return `${result.slice(0, Math.max(0, maxLength - 1))}…`;
}

function buildPublicErrorMessage(error, fallback) {
    const safeFallback = sanitizePublicText(fallback || 'Произошла внутренняя ошибка.');
    const businessMessage = sanitizePublicText(error?.userMessage);
    if (businessMessage) return limitPublicText(businessMessage);

    const technicalMessage = sanitizePublicText(error?.message);
    if (!technicalMessage) return limitPublicText(safeFallback);
    return limitPublicText(`${safeFallback}\nТехническая причина: ${technicalMessage}`);
}

module.exports = {
    buildPublicErrorMessage,
    sanitizePublicText,
};
