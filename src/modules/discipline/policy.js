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
const { getDisciplineSettings } = require('./settings/schema');
const DisciplineError = require('./error');

function memberHasRole(member, roleId) {
    return Boolean(roleId && member?.roles?.cache?.has?.(roleId));
}

function memberHasAnyRole(member, roleIds) {
    return (Array.isArray(roleIds) ? roleIds : []).some((roleId) => memberHasRole(member, roleId));
}

function getDepartmentPermission(actor, target, config) {
    if (!actor || !target) return null;
    for (const department of getDepartments(config)) {
        const actorIsLeadership = memberHasRole(actor, department.roles?.headRoleId) ||
            memberHasRole(actor, department.roles?.deputyHeadRoleId);
        if (!actorIsLeadership) continue;
        const targetBelongs = memberHasRole(target, department.roles?.memberRoleId) ||
            memberHasRole(target, department.roles?.partTimeRoleId);
        if (!targetBelongs) continue;
        return {
            allowed: true,
            reason: 'department_leadership',
            departmentId: department.id,
        };
    }
    return null;
}

function evaluateIssuePermission(actor, target, config, { externalTarget = false } = {}) {
    const policy = getDisciplineSettings(config).issuePolicy;
    if (!policy.enabled) return { allowed: true, reason: 'policy_disabled' };
    if (!actor) return { allowed: false, reason: 'actor_missing' };

    if (memberHasAnyRole(actor, policy.leadershipRoleIds)) {
        return { allowed: true, reason: 'leadership' };
    }

    if (memberHasAnyRole(actor, policy.examinerRoleIds)) {
        if (!externalTarget && target && memberHasAnyRole(target, policy.leadershipRoleIds)) {
            return { allowed: false, reason: 'examiner_cannot_target_leadership' };
        }
        return { allowed: true, reason: 'examiner' };
    }

    if (policy.departmentLeadershipEnabled && !externalTarget) {
        const departmentPermission = getDepartmentPermission(actor, target, config);
        if (departmentPermission) return departmentPermission;
    }

    return { allowed: false, reason: 'no_matching_authority' };
}

function assertCanIssueDiscipline(actor, target, config, options = {}) {
    const decision = evaluateIssuePermission(actor, target, config, options);
    if (decision.allowed) return decision;
    const messages = {
        actor_missing: 'Не удалось определить сотрудника, который выдаёт взыскание.',
        examiner_cannot_target_leadership: 'Экзаменатор не может выдавать взыскания руководящему составу.',
        no_matching_authority: 'У вас нет полномочий выдавать взыскание этому сотруднику.',
    };
    throw new DisciplineError(
        messages[decision.reason] || 'У вас нет полномочий выдавать это взыскание.',
        `discipline_issue_${decision.reason}`
    );
}

function canUseFallbackPermission(member, caseRecord, config) {
    const settings = getDisciplineSettings(config);
    if (settings.issuePolicy.fallbackPermissionMode === 'unconditional') return true;
    if (!caseRecord?.memberId) {
        return evaluateIssuePermission(member, null, config, { externalTarget: true }).allowed;
    }
    const target = member?.guild?.members?.cache?.get?.(String(caseRecord.memberId)) || null;
    if (!target) return false;
    return evaluateIssuePermission(member, target, config).allowed;
}

module.exports = {
    assertCanIssueDiscipline,
    canUseFallbackPermission,
    evaluateIssuePermission,
    getDepartmentPermission,
    memberHasAnyRole,
};
