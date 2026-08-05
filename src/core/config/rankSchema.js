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
const GRANT_POLICY_MODES = new Set(['unrestricted', 'roles', 'disabled']);

function hasValue(value) {
    return value !== null && value !== undefined && value !== '';
}

function normalizeId(value) {
    return hasValue(value) ? String(value) : null;
}

function normalizeIdList(values) {
    return Array.from(new Set(
        (Array.isArray(values) ? values : [])
            .map((value) => String(value || '').trim())
            .filter(Boolean)
    )).sort();
}

function normalizePositiveInteger(value, fallback = null) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function normalizeNullablePositiveInteger(value) {
    if (!hasValue(value)) return null;
    return normalizePositiveInteger(value, null);
}

function normalizeStaffListMetadata(metadata) {
    const source = metadata && typeof metadata === 'object' ? metadata : {};
    return {
        showInLeadership: source.showInLeadership === true,
        maxMembers: normalizeNullablePositiveInteger(source.maxMembers),
        showAppointmentTerm: source.showAppointmentTerm === true,
    };
}

function normalizeGrantPolicy(policy) {
    const rawMode = String(policy?.mode || '').trim();
    const mode = GRANT_POLICY_MODES.has(rawMode) ? rawMode : rawMode || null;
    return {
        mode,
        roleIds: mode === 'roles' ? normalizeIdList(policy?.roleIds) : [],
    };
}

function normalizeRank(rank) {
    return {
        number: normalizePositiveInteger(rank?.number),
        name: String(rank?.name || '').trim(),
        roleId: normalizeId(rank?.roleId),
        grantPolicy: normalizeGrantPolicy(rank?.grantPolicy),
        staffList: normalizeStaffListMetadata(rank?.staffList),
    };
}

function sortRanks(ranks) {
    return [...ranks].sort((left, right) => left.number - right.number);
}

function getRanks(config) {
    return sortRanks((Array.isArray(config?.ranks) ? config.ranks : []).map(normalizeRank));
}

function prepareRanksForStorage(ranks) {
    return sortRanks(
        (Array.isArray(ranks) ? ranks : []).map(normalizeRank)
    );
}

function getRankChanges(beforeRanks, afterRanks) {
    const before = prepareRanksForStorage(beforeRanks);
    const after = prepareRanksForStorage(afterRanks);
    const previousByNumber = new Map(before.map((rank) => [rank.number, rank]));
    const nextByNumber = new Map(after.map((rank) => [rank.number, rank]));
    const changes = [];

    for (const rank of after) {
        if (!previousByNumber.has(rank.number)) {
            changes.push({
                section: 'ranks',
                action: 'added',
                rank,
                rankNumber: rank.number,
                rankName: rank.name,
            });
        }
    }

    for (const rank of before) {
        if (!nextByNumber.has(rank.number)) {
            changes.push({
                section: 'ranks',
                action: 'removed',
                rank,
                rankNumber: rank.number,
                rankName: rank.name,
            });
        }
    }

    for (const rank of after) {
        const previous = previousByNumber.get(rank.number);
        if (!previous) continue;

        if (previous.name !== rank.name) {
            changes.push({
                section: 'ranks',
                action: 'updated',
                rankNumber: rank.number,
                rankName: rank.name,
                key: 'name',
                label: 'название',
                before: previous.name,
                after: rank.name,
                valueType: 'text',
            });
        }

        if (previous.roleId !== rank.roleId) {
            changes.push({
                section: 'ranks',
                action: 'updated',
                rankNumber: rank.number,
                rankName: rank.name,
                key: 'roleId',
                label: 'Discord-роль',
                before: previous.roleId,
                after: rank.roleId,
                valueType: 'role',
            });
        }

        for (const field of [
            { key: 'showInLeadership', label: 'показывать в руководящем составе', valueType: 'boolean' },
            { key: 'maxMembers', label: 'лимит в руководящем составе', valueType: 'number' },
            { key: 'showAppointmentTerm', label: 'показывать срок назначения', valueType: 'boolean' },
        ]) {
            if (previous.staffList[field.key] === rank.staffList[field.key]) continue;
            changes.push({
                section: 'ranks',
                action: 'updated',
                rankNumber: rank.number,
                rankName: rank.name,
                key: `staffList.${field.key}`,
                label: field.label,
                before: previous.staffList[field.key],
                after: rank.staffList[field.key],
                valueType: field.valueType,
            });
        }

        if (previous.grantPolicy.mode !== rank.grantPolicy.mode) {
            changes.push({
                section: 'ranks',
                action: 'updated',
                rankNumber: rank.number,
                rankName: rank.name,
                key: 'grantPolicy.mode',
                label: 'правило выдачи',
                before: previous.grantPolicy.mode,
                after: rank.grantPolicy.mode,
                valueType: 'grantPolicy',
            });
        }

        const previousRoleIds = new Set(previous.grantPolicy.roleIds);
        const nextRoleIds = new Set(rank.grantPolicy.roleIds);
        for (const roleId of rank.grantPolicy.roleIds) {
            if (!previousRoleIds.has(roleId)) {
                changes.push({
                    section: 'ranks',
                    action: 'policyRoleAdded',
                    rankNumber: rank.number,
                    rankName: rank.name,
                    roleId,
                });
            }
        }
        for (const roleId of previous.grantPolicy.roleIds) {
            if (!nextRoleIds.has(roleId)) {
                changes.push({
                    section: 'ranks',
                    action: 'policyRoleRemoved',
                    rankNumber: rank.number,
                    rankName: rank.name,
                    roleId,
                });
            }
        }
    }

    return changes;
}

module.exports = {
    GRANT_POLICY_MODES,
    getRankChanges,
    getRanks,
    normalizeGrantPolicy,
    normalizeStaffListMetadata,
    prepareRanksForStorage,
};
