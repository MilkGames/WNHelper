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
const { getRanks } = require('../../core/config/rankSchema');
const { runDiscordRequest } = require('../../core/discord/request');

function memberHasAnyRole(member, roleIds) {
    const configuredRoleIds = Array.isArray(roleIds) ? roleIds : [];
    if (member?.roles?.cache?.has) {
        return configuredRoleIds.some((roleId) => member.roles.cache.has(roleId));
    }

    if (Array.isArray(member?.roles)) {
        return configuredRoleIds.some((roleId) => member.roles.includes(roleId));
    }

    return false;
}

function getRank(config, rankNumber) {
    const number = Number(rankNumber);
    return getRanks(config).find((rank) => rank.number === number) || null;
}

function getPreviousRank(config, rankNumber) {
    const number = Number(rankNumber);
    const lowerRanks = getRanks(config).filter((rank) => rank.number < number);
    return lowerRanks.length ? lowerRanks[lowerRanks.length - 1] : null;
}

function getRankNumbers(config) {
    return getRanks(config).map((rank) => rank.number);
}

function getMemberRankMatches(member, config) {
    return getRanks(config).filter((rank) => (
        rank.roleId && member?.roles?.cache?.has?.(rank.roleId)
    ));
}

function getMemberRank(member, config) {
    const matches = getMemberRankMatches(member, config);
    return matches.length === 1 ? matches[0] : null;
}

function getGrantDecision(member, config, rankNumber) {
    const rank = getRank(config, rankNumber);
    if (!rank) {
        return {
            allowed: false,
            rank: null,
            reason: `Ранг ${rankNumber} отсутствует в настройках сервера.`,
        };
    }

    const policy = rank.grantPolicy || { mode: null, roleIds: [] };
    if (policy.mode === 'disabled') {
        return {
            allowed: false,
            rank,
            reason: `Выдача ранга ${rank.number} "${rank.name}" через бота запрещена.`,
        };
    }

    if (policy.mode === 'unrestricted') {
        return { allowed: true, rank, reason: null };
    }

    if (policy.mode === 'roles') {
        if (!policy.roleIds.length) {
            return {
                allowed: false,
                rank,
                reason: `Для ранга ${rank.number} "${rank.name}" не настроены роли выдачи.`,
            };
        }

        const allowed = memberHasAnyRole(member, policy.roleIds);
        return {
            allowed,
            rank,
            reason: allowed
                ? null
                : `У вас нет роли, которой разрешено выдавать ранг ${rank.number} "${rank.name}".`,
        };
    }

    return {
        allowed: false,
        rank,
        reason: `Для ранга ${rank.number} "${rank.name}" не настроено правило выдачи.`,
    };
}

function getConfiguredRankRoleIds(config) {
    return [...new Set(
        getRanks(config)
            .map((rank) => rank.roleId)
            .filter(Boolean)
    )];
}

function assertRankRolesManageable(member, roleIds) {
    for (const roleId of roleIds) {
        const role = member.guild.roles.cache.get(roleId);
        if (!role) {
            throw new Error(`Роль ранга ${roleId} не найдена на сервере ${member.guild.id}`);
        }
        if (!role.editable) {
            throw new Error(`Бот не может управлять ролью ранга "${role.name}" (${role.id})`);
        }
    }
}

async function syncMemberRankRoleSnapshot(member, {
    rankNumber,
    targetRoleId = null,
    configuredRoleIds = [],
}) {
    const normalizedTargetRoleId = targetRoleId ? String(targetRoleId) : null;
    const normalizedConfiguredRoleIds = [...new Set(
        (Array.isArray(configuredRoleIds) ? configuredRoleIds : [])
            .map(String)
            .filter(Boolean)
    )];
    const existingRankRoleIds = normalizedConfiguredRoleIds
        .filter((roleId) => member.roles.cache.has(roleId));
    const roleIdsToRemove = existingRankRoleIds
        .filter((roleId) => roleId !== normalizedTargetRoleId);
    const roleIdsToManage = [
        ...roleIdsToRemove,
        ...(normalizedTargetRoleId && !member.roles.cache.has(normalizedTargetRoleId)
            ? [normalizedTargetRoleId]
            : []),
    ];
    assertRankRolesManageable(member, roleIdsToManage);

    const rolesToRemove = roleIdsToRemove
        .map((roleId) => member.guild.roles.cache.get(roleId));
    if (rolesToRemove.length) {
        await runDiscordRequest(() => member.roles.remove(
            rolesToRemove,
            `WN Helper: изменение ранга на ${rankNumber}`
        ));
    }

    if (normalizedTargetRoleId && !member.roles.cache.has(normalizedTargetRoleId)) {
        const targetRole = member.guild.roles.cache.get(normalizedTargetRoleId);
        await runDiscordRequest(() => member.roles.add(
            targetRole,
            `WN Helper: изменение ранга на ${rankNumber}`
        ));
    }

    return { changed: roleIdsToManage.length > 0 };
}

async function syncMemberRankRole(member, config, rankNumber) {
    const targetRank = getRank(config, rankNumber);
    if (!targetRank) {
        throw new Error(`Ранг ${rankNumber} отсутствует в настройках сервера`);
    }

    const result = await syncMemberRankRoleSnapshot(member, {
        rankNumber: targetRank.number,
        targetRoleId: targetRank.roleId,
        configuredRoleIds: getConfiguredRankRoleIds(config),
    });
    return { ...result, targetRank };
}

module.exports = {
    getConfiguredRankRoleIds,
    getGrantDecision,
    getMemberRank,
    getMemberRankMatches,
    getPreviousRank,
    getRank,
    getRankNumbers,
    syncMemberRankRole,
    syncMemberRankRoleSnapshot,
};
