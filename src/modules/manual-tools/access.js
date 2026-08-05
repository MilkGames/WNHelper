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
const { getOwnerUserIds } = require('../../core/config/applicationConfig');
const guildConfigService = require('../../core/config/guildConfigService');

const MANUAL_TOOLS_SUBCOMMAND_DEFINITIONS = [
    { key: 'reset_giveroles', label: 'Сбросить активную заявку выдачи ролей' },
    { key: 'unblock_giveroles', label: 'Разблокировать отправку заявок' },
    { key: 'retry_uval', label: 'Продолжить неудавшееся увольнение' },
    { key: 'retry_staff_action', label: 'Продолжить кадровую операцию' },
    { key: 'retry_massaudit', label: 'Продолжить массовый кадровый аудит' },
    { key: 'retry_massdiscipline', label: 'Продолжить массовое взыскание' },
    { key: 'retry_exam_request', label: 'Восстановить заявку экзаменации' },
    { key: 'retry_vacation', label: 'Восстановить заявку на отпуск' },
    { key: 'instance_status', label: 'Посмотреть состояние процесса' },
    { key: 'database_status', label: 'Посмотреть состояние базы данных' },
    { key: 'webhook_status', label: 'Посмотреть состояние webhook и очередей' },
    { key: 'pending_status', label: 'Посмотреть незавершённые операции' },
    { key: 'refresh', label: 'Запустить ручную синхронизацию' },
];

const OWNER_ONLY_SUBCOMMANDS = new Set([
    'shutdown_instance',
    'database_compare',
    'database_resolve',
    'database_apply',
]);
const MANUAL_TOOLS_SUBCOMMAND_KEYS = new Set(
    MANUAL_TOOLS_SUBCOMMAND_DEFINITIONS.map((entry) => entry.key)
);

function normalizeRoleId(value) {
    const result = String(value || '').trim();
    return result || null;
}

function normalizeSubcommandKeys(values) {
    return Array.from(new Set(
        (Array.isArray(values) ? values : [])
            .map((value) => String(value || '').trim())
            .filter((value) => MANUAL_TOOLS_SUBCOMMAND_KEYS.has(value))
    )).sort();
}

function normalizeManualToolsAccess(entries) {
    const byRole = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
        const roleId = normalizeRoleId(entry?.roleId);
        if (!roleId) continue;
        const previous = byRole.get(roleId) || [];
        byRole.set(roleId, normalizeSubcommandKeys([
            ...previous,
            ...(entry?.subcommandKeys || []),
        ]));
    }

    return [...byRole.entries()]
        .map(([roleId, subcommandKeys]) => ({ roleId, subcommandKeys }))
        .filter((entry) => entry.subcommandKeys.length > 0)
        .sort((left, right) => left.roleId.localeCompare(right.roleId));
}

function getManualToolsAccessChanges(beforeEntries, afterEntries) {
    const before = new Map(normalizeManualToolsAccess(beforeEntries)
        .map((entry) => [entry.roleId, entry.subcommandKeys]));
    const after = new Map(normalizeManualToolsAccess(afterEntries)
        .map((entry) => [entry.roleId, entry.subcommandKeys]));
    const roleIds = new Set([...before.keys(), ...after.keys()]);
    const changes = [];

    for (const roleId of roleIds) {
        const previous = before.get(roleId) || [];
        const next = after.get(roleId) || [];
        if (JSON.stringify(previous) === JSON.stringify(next)) continue;
        changes.push({
            section: 'manualToolsAccess',
            key: 'manualToolsAccess',
            label: 'Доступ к /manualtools',
            roleId,
            before: previous,
            after: next,
            valueType: 'manualToolsSubcommands',
        });
    }

    return changes;
}

function memberHasRole(member, roleId) {
    if (!member || !roleId) return false;
    if (member.roles?.cache?.has) return member.roles.cache.has(roleId);
    if (Array.isArray(member.roles)) return member.roles.includes(roleId);
    return false;
}

function isOwnerUser(userId) {
    return getOwnerUserIds().has(String(userId || ''));
}

function canUseManualTool(member, guildId, subcommand) {
    const userId = member?.id || member?.user?.id;
    if (isOwnerUser(userId)) return true;
    if (OWNER_ONLY_SUBCOMMANDS.has(subcommand)) return false;
    if (!MANUAL_TOOLS_SUBCOMMAND_KEYS.has(subcommand)) return false;

    const config = guildConfigService.getAny(guildId);
    return normalizeManualToolsAccess(config?.manualToolsAccess).some((entry) => (
        entry.subcommandKeys.includes(subcommand) && memberHasRole(member, entry.roleId)
    ));
}

module.exports = {
    MANUAL_TOOLS_SUBCOMMAND_DEFINITIONS,
    MANUAL_TOOLS_SUBCOMMAND_KEYS,
    OWNER_ONLY_SUBCOMMANDS,
    canUseManualTool,
    getManualToolsAccessChanges,
    isOwnerUser,
    normalizeManualToolsAccess,
};
