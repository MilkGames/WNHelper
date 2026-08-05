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
const { getDepartments } = require('../../core/config/departmentSchema');
const { getGiveRolesSettings } = require('./settings/schema');
const { getRanks } = require('../../core/config/rankSchema');
const { isLeaderOpenDoorPeriod } = require('../staff-lists');
const { runDiscordRequest } = require('../../core/discord/request');
const logger = require('../../core/logging/logger');

const APPROVE_ACTIONS = new Set(['role-confirm', 'role-db']);

function unique(values) {
    return Array.from(new Set((Array.isArray(values) ? values : []).filter(Boolean)));
}

function memberHasAnyRole(member, roleIds) {
    const configuredRoleIds = Array.isArray(roleIds) ? roleIds : [];
    return configuredRoleIds.some((roleId) => member?.roles?.cache?.has?.(roleId));
}

function getInitialRank(config) {
    return getRanks(config)[0] || null;
}

function getDbRank(config, settings = getGiveRolesSettings(config)) {
    if (!settings.dbRankNumber) return null;
    return getRanks(config).find((rank) => rank.number === settings.dbRankNumber) || null;
}

function getInviteDepartment(config, settings = getGiveRolesSettings(config)) {
    if (!settings.inviteDepartmentId) return null;
    return getDepartments(config)
        .find((department) => department.id === settings.inviteDepartmentId) || null;
}

function validateRoleExists(guild, roleId, label, errors) {
    if (!roleId) {
        errors.push(`${label}: роль не выбрана.`);
        return null;
    }

    const role = guild?.roles?.cache?.get(roleId) || null;
    if (!role) {
        errors.push(`${label}: роль ${roleId} не найдена на сервере.`);
    }
    return role;
}

function validateChannelExists(guild, channelId, label, errors) {
    if (!channelId) {
        errors.push(`${label}: канал не выбран.`);
        return null;
    }

    const channel = guild?.channels?.cache?.get(channelId) || null;
    if (!channel) {
        errors.push(`${label}: канал ${channelId} не найден на сервере.`);
    }
    return channel;
}

function getBaseErrors(guild, config) {
    const errors = [];
    if (!config) {
        errors.push('Конфигурация сервера отсутствует.');
        return errors;
    }

    if (!config.features?.giveRoles) {
        errors.push('Функция "Выдача ролей" отключена.');
    }

    return errors;
}

function getAccessErrors(guild, config, action) {
    const errors = getBaseErrors(guild, config);
    const settings = getGiveRolesSettings(config);
    const roleIds = action === 'role-block'
        ? settings.blockerRoleIds
        : settings.reviewerRoleIds;
    const label = action === 'role-block'
        ? 'Роли блокировки заявителей'
        : 'Роли обработки заявок';

    if (!roleIds.length) {
        errors.push(`${label}: роли не выбраны.`);
    }

    for (const roleId of roleIds) {
        validateRoleExists(guild, roleId, label, errors);
    }

    return errors;
}

function getAssignment(config, action) {
    const settings = getGiveRolesSettings(config);
    const department = getInviteDepartment(config, settings);
    const rank = action === 'role-db'
        ? getDbRank(config, settings)
        : getInitialRank(config);
    const roleIds = unique([
        config?.commonRoles?.weazelNewsRoleId,
        rank?.roleId,
        department?.roles?.memberRoleId,
        ...(action === 'role-db' ? settings.dbAdditionalRoleIds : []),
    ]);

    return {
        action,
        settings,
        department,
        rank,
        roleIds,
        reason: action === 'role-db' ? 'ДБ' : 'Собеседование',
    };
}

function getManualAssignment(config, {
    rankNumber = null,
    departmentId = null,
    reason = 'Собеседование',
} = {}) {
    const settings = getGiveRolesSettings(config);
    const departments = getDepartments(config);
    const ranks = getRanks(config);
    const defaultDepartment = getInviteDepartment(config, settings);
    const department = departmentId
        ? departments.find((entry) => entry.id === departmentId) || null
        : defaultDepartment;
    const rank = rankNumber
        ? ranks.find((entry) => entry.number === Number(rankNumber)) || null
        : getInitialRank(config);

    return {
        action: 'manual-invite',
        settings,
        department,
        defaultDepartment,
        rank,
        roleIds: unique([
            config?.commonRoles?.weazelNewsRoleId,
            rank?.roleId,
            department?.roles?.memberRoleId,
        ]),
        roleIdsToRemove: unique(
            departmentId &&
            defaultDepartment?.id !== department?.id &&
            defaultDepartment?.roles?.memberRoleId
                ? [defaultDepartment.roles.memberRoleId]
                : []
        ),
        reason,
        departmentOverridden: Boolean(departmentId),
    };
}

function getManualAssignmentErrors(guild, config, options = {}) {
    const errors = [];
    const assignment = getManualAssignment(config, options);

    if (!config) {
        errors.push('Конфигурация сервера отсутствует.');
        return { errors, assignment };
    }

    validateRoleExists(guild, config.commonRoles?.weazelNewsRoleId, 'Основная роль Weazel News', errors);

    if (!assignment.department) {
        errors.push(options.departmentId
            ? `Выбранный отдел ${options.departmentId} не найден.`
            : 'Отдел при принятии не выбран.');
    } else {
        validateRoleExists(
            guild,
            assignment.department.roles?.memberRoleId,
            `Основной состав отдела "${assignment.department.shortName}"`,
            errors
        );
    }

    if (!assignment.rank) {
        errors.push(options.rankNumber
            ? `Выбранный ранг ${options.rankNumber} не найден.`
            : 'Не найден начальный ранг.');
    } else if (assignment.rank.roleId) {
        validateRoleExists(
            guild,
            assignment.rank.roleId,
            `Ранг ${assignment.rank.number} "${assignment.rank.name}"`,
            errors
        );
    }

    return { errors, assignment };
}

function getAssignmentErrors(guild, config, action) {
    const errors = getBaseErrors(guild, config);
    const assignment = getAssignment(config, action);

    validateRoleExists(guild, config?.commonRoles?.weazelNewsRoleId, 'Основная роль Weazel News', errors);

    if (!assignment.settings.inviteDepartmentId) {
        errors.push('Отдел при принятии не выбран.');
    } else if (!assignment.department) {
        errors.push(`Выбранный отдел ${assignment.settings.inviteDepartmentId} не найден.`);
    } else {
        validateRoleExists(
            guild,
            assignment.department.roles?.memberRoleId,
            `Основной состав отдела "${assignment.department.shortName}"`,
            errors
        );
    }

    if (action === 'role-db') {
        if (!assignment.settings.dbRankNumber) {
            errors.push('Ранг при ДБ не выбран.');
        } else if (!assignment.rank) {
            errors.push(`Ранг при ДБ ${assignment.settings.dbRankNumber} не найден.`);
        } else if (assignment.rank.roleId) {
            validateRoleExists(
                guild,
                assignment.rank.roleId,
                `Ранг ${assignment.rank.number} "${assignment.rank.name}"`,
                errors
            );
        }

        for (const roleId of assignment.settings.dbAdditionalRoleIds) {
            validateRoleExists(guild, roleId, 'Дополнительная роль при ДБ', errors);
        }
    } else if (!assignment.rank) {
        errors.push('Не найден начальный ранг.');
    } else if (assignment.rank.roleId) {
        validateRoleExists(
            guild,
            assignment.rank.roleId,
            `Начальный ранг ${assignment.rank.number} "${assignment.rank.name}"`,
            errors
        );
    }

    return { errors, assignment };
}

function appendOptionalSettingsErrors(guild, config, errors) {
    const settings = getGiveRolesSettings(config);

    if (settings.dbRankNumber) {
        const dbValidation = getAssignmentErrors(guild, config, 'role-db');
        for (const error of dbValidation.errors) {
            if (!errors.includes(error)) errors.push(error);
        }
    }

    for (const roleId of settings.blockerRoleIds) {
        validateRoleExists(guild, roleId, 'Роль блокировки заявителей', errors);
    }
}

function getCreateMessageErrors(guild, config) {
    const { errors } = getAssignmentErrors(guild, config, 'role-confirm');
    const settings = getGiveRolesSettings(config);

    validateChannelExists(guild, config?.channels?.getRoleChannelId, 'Канал подачи заявок', errors);
    validateChannelExists(guild, config?.channels?.confirmRoleChannelId, 'Канал подтверждения заявок', errors);

    if (!settings.reviewerRoleIds.length) {
        errors.push('Роли обработки заявок не выбраны.');
    }
    for (const roleId of settings.reviewerRoleIds) {
        validateRoleExists(guild, roleId, 'Роль обработки заявок', errors);
    }

    appendOptionalSettingsErrors(guild, config, errors);
    return errors;
}

function getRequestSubmissionErrors(guild, config) {
    const { errors } = getAssignmentErrors(guild, config, 'role-confirm');
    const settings = getGiveRolesSettings(config);

    validateChannelExists(guild, config?.channels?.confirmRoleChannelId, 'Канал подтверждения заявок', errors);

    if (!settings.reviewerRoleIds.length) {
        errors.push('Роли обработки заявок не выбраны.');
    }
    for (const roleId of settings.reviewerRoleIds) {
        validateRoleExists(guild, roleId, 'Роль обработки заявок', errors);
    }

    appendOptionalSettingsErrors(guild, config, errors);
    return errors;
}

function canUseAction(member, config, action) {
    const settings = getGiveRolesSettings(config);
    const roleIds = action === 'role-block'
        ? settings.blockerRoleIds
        : settings.reviewerRoleIds;

    return memberHasAnyRole(member, roleIds);
}

function buildMemberNickname(department, nickname, staticId) {
    const departmentPrefix = String(department?.shortName || '').trim();
    const fullName = String(nickname || '').trim().replace(/\s+/g, ' ');
    const staticText = String(staticId || '').trim();
    const prefix = `${departmentPrefix} | `;
    const suffix = ` | ${staticText}`;
    const maxNameLength = Math.max(1, 32 - prefix.length - suffix.length);

    let displayName = fullName;
    if (displayName.length > maxNameLength) {
        const parts = displayName.split(' ').filter(Boolean);
        if (parts.length > 1) {
            displayName = `${parts[0]} ${parts.slice(1).map((part) => `${part[0]}.`).join(' ')}`;
        }
    }

    if (displayName.length > maxNameLength) {
        displayName = displayName.slice(0, maxNameLength).trimEnd();
    }

    return `${prefix}${displayName}${suffix}`.slice(0, 32);
}

function getMemberAssignmentErrors(member, assignment) {
    const errors = [];
    if (!member) return errors;

    for (const roleId of assignment.roleIds) {
        const role = member.guild.roles.cache.get(roleId);
        if (!role) {
            errors.push(`Роль ${roleId} не найдена на сервере.`);
            continue;
        }
        if (!member.roles.cache.has(roleId) && !role.editable) {
            errors.push(`Бот не может выдать роль "${role.name}" (${role.id}).`);
        }
    }

    for (const roleId of assignment.roleIdsToRemove || []) {
        const role = member.guild.roles.cache.get(roleId);
        if (!role) {
            errors.push(`Снимаемая роль ${roleId} не найдена на сервере.`);
            continue;
        }
        if (member.roles.cache.has(roleId) && !role.editable) {
            errors.push(`Бот не может снять роль "${role.name}" (${role.id}).`);
        }
    }

    return errors;
}

function assertRolesManageable(member, roleIds) {
    for (const roleId of roleIds) {
        const role = member.guild.roles.cache.get(roleId);
        if (!role) {
            throw new Error(`Роль ${roleId} не найдена на сервере ${member.guild.id}`);
        }
        if (!member.roles.cache.has(roleId) && !role.editable) {
            throw new Error(`Бот не может выдать роль "${role.name}" (${role.id})`);
        }
    }
}

async function applyAssignment(member, assignment, nickname, staticId) {
    assertRolesManageable(member, assignment.roleIds);
    const removableRoleIds = (assignment.roleIdsToRemove || [])
        .filter((roleId) => member.roles.cache.has(roleId));
    assertRolesManageable(member, removableRoleIds);

    const rolesToRemove = removableRoleIds
        .filter((roleId) => member.roles.cache.has(roleId))
        .map((roleId) => member.guild.roles.cache.get(roleId));
    if (rolesToRemove.length) {
        await runDiscordRequest(() => member.roles.remove(
            rolesToRemove,
            `WN Helper: принятие сотрудника (${assignment.reason})`
        ));
    }

    const rolesToAdd = assignment.roleIds
        .filter((roleId) => !member.roles.cache.has(roleId))
        .map((roleId) => member.guild.roles.cache.get(roleId));

    if (rolesToAdd.length) {
        await runDiscordRequest(() => member.roles.add(
            rolesToAdd,
            `WN Helper: принятие сотрудника (${assignment.reason})`
        ));
    }

    const newNickname = buildMemberNickname(
        assignment.department,
        nickname,
        staticId
    );

    try {
        await runDiscordRequest(() => member.setNickname(newNickname));
    } catch (error) {
        logger.warn('Не удалось изменить ник после выдачи ролей', {
            guildId: member.guild.id,
            userId: member.id,
            nickname: newNickname,
        }, error);
    }

    return newNickname;
}

function isDbApprovalPeriodActive(config, timestamp = Date.now()) {
    return isLeaderOpenDoorPeriod(config, timestamp);
}

function shouldShowDbButton(config, timestamp = Date.now()) {
    const settings = getGiveRolesSettings(config);
    const rank = getDbRank(config, settings);
    return Boolean(
        settings.dbRankNumber &&
        rank &&
        isDbApprovalPeriodActive(config, timestamp)
    );
}

function shouldShowBlockButton(config) {
    return getGiveRolesSettings(config).blockerRoleIds.length > 0;
}

module.exports = {
    APPROVE_ACTIONS,
    applyAssignment,
    buildMemberNickname,
    canUseAction,
    getAccessErrors,
    getAssignment,
    getAssignmentErrors,
    getCreateMessageErrors,
    getInitialRank,
    getInviteDepartment,
    getManualAssignment,
    getManualAssignmentErrors,
    getMemberAssignmentErrors,
    getRequestSubmissionErrors,
    isDbApprovalPeriodActive,
    memberHasAnyRole,
    shouldShowBlockButton,
    shouldShowDbButton,
};
