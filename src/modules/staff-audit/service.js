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
const {
    buildDismissalRecordEmbed,
    buildInviteRecordEmbed,
    buildRankRecordEmbed,
    formatActor,
    formatTarget,
} = require('./presentation');
const { getDepartments } = require('../../core/config/departmentSchema');
const { getGiveRolesSettings } = require('../give-roles');
const { getStaffAuditSettings } = require('./settings/schema');
const giveRolesService = require('../give-roles');
const { invokeAction } = require('../../core/integrations/actionRegistry');
const { assertCanManageTarget } = require('./policy');
const {
    assertPromotionDailyLimit,
    recordPromotion,
    reservePromotion,
} = require('./promotionPolicy');
const {
    getConfiguredRankRoleIds,
    getGrantDecision,
    getRank,
    getRankNumbers,
    syncMemberRankRoleSnapshot,
} = require('./ranks');
const {
    runDiscordRequest,
    sendMessageWithRetry,
} = require('../../core/discord/request');

function unique(values) {
    return Array.from(new Set((Array.isArray(values) ? values : []).filter(Boolean)));
}

function assertFeatureEnabled(config) {
    if (!config) {
        throw new StaffAuditError('Для этого сервера нет настроек.', 'no_config');
    }
    if (!config.features?.staffAudit) {
        throw new StaffAuditError('Функция "Кадровый аудит" отключена на этом сервере.', 'feature_disabled');
    }
}

async function getAuditChannel(client, guildId, config) {
    assertFeatureEnabled(config);
    const settings = getStaffAuditSettings(config);
    if (!settings.channelId) {
        throw new StaffAuditError('Основной канал кадрового аудита не настроен.', 'channel_not_configured');
    }

    const channel = await client.channels.fetch(settings.channelId).catch(() => null);
    if (!channel?.isTextBased?.() || !channel.send) {
        throw new StaffAuditError('Настроенный канал кадрового аудита не найден или недоступен боту.', 'channel_unavailable');
    }

    if (String(channel.guildId || guildId) !== String(guildId)) {
        throw new StaffAuditError('Настроенный канал кадрового аудита относится к другому серверу.', 'wrong_channel_guild');
    }

    return channel;
}

function extractStaticId(displayName) {
    const match = String(displayName || '').trim().match(/(\d+)\s*$/);
    return match ? match[1] : null;
}

function extractBaseName(displayName, staticId = null) {
    const source = String(displayName || '').trim();
    const parts = source.split('|').map((part) => part.trim()).filter(Boolean);

    if (parts.length >= 3) {
        return parts.slice(1, -1).join(' | ').trim();
    }

    if (parts.length === 2) {
        const last = parts[1];
        if (!staticId || last === String(staticId)) return parts[0];
    }

    if (staticId) {
        return source
            .replace(new RegExp(`\\s*\\|?\\s*${String(staticId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`), '')
            .trim();
    }

    return source;
}

function stripDepartmentPrefix(displayName) {
    const source = String(displayName || '').trim();
    const parts = source.split('|').map((part) => part.trim()).filter(Boolean);
    if (parts.length >= 3) return parts.slice(1).join(' | ');
    return source;
}

async function resolveMemberInput(guild, rawValue, staticOverride = null) {
    const raw = String(rawValue || '').trim();
    const mentionMatch = raw.match(/^<@!?(\d{17,20})>$/);
    const id = mentionMatch?.[1] || (/^\d{17,20}$/.test(raw) ? raw : null);

    if (!id) {
        if (!staticOverride) {
            throw new StaffAuditError(
                'Пользователь указан текстом. Укажите параметр `static`.',
                'static_required'
            );
        }
        return {
            member: null,
            memberId: null,
            displayName: raw,
            staticId: String(staticOverride).trim(),
            displayValue: raw,
        };
    }

    const member = await guild.members.fetch(id).catch(() => null);
    if (!member) {
        throw new StaffAuditError('Указанный пользователь не найден на сервере.', 'member_not_found');
    }

    const staticId = extractStaticId(member.displayName) || String(staticOverride || '').trim() || null;
    if (!staticId) {
        throw new StaffAuditError(
            'Не удалось определить статик из никнейма сотрудника. Укажите параметр `static`.',
            'static_required'
        );
    }

    return {
        member,
        memberId: member.id,
        displayName: member.displayName,
        staticId,
        displayValue: `${member}`,
    };
}

async function sendInviteRecord(client, {
    guildId,
    config,
    actor,
    target,
    rankNumber,
    reason,
    departmentName = null,
    nonceSeed,
}) {
    const channel = await getAuditChannel(client, guildId, config);
    const embed = buildInviteRecordEmbed({ actor, target, rankNumber, reason, departmentName });
    await sendMessageWithRetry(channel, {
        embeds: [embed],
        allowedMentions: { parse: [] },
    }, {
        nonceSeed,
    });
    return channel;
}

async function sendRankRecord(client, {
    guildId,
    config,
    actor,
    target,
    action,
    reason,
    nonceSeed,
}) {
    const channel = await getAuditChannel(client, guildId, config);
    const embed = buildRankRecordEmbed({ actor, target, action, reason });
    await sendMessageWithRetry(channel, {
        embeds: [embed],
        allowedMentions: { parse: [] },
    }, {
        nonceSeed,
    });
    return channel;
}

async function sendDismissalRecord(client, {
    guildId,
    config,
    actor,
    target,
    reason,
    nonceSeed,
}) {
    const channel = await getAuditChannel(client, guildId, config);
    const embed = buildDismissalRecordEmbed({ actor, target, reason });
    await sendMessageWithRetry(channel, {
        embeds: [embed],
        allowedMentions: { parse: [] },
    }, {
        nonceSeed,
    });
    return channel;
}

function parseRankAction(actionInput, config) {
    const match = String(actionInput || '').trim().match(/^(\d+)\s*-\s*(\d+)$/);
    if (!match) {
        throw new StaffAuditError('Параметр "action" должен быть указан в формате "2-3" или "4-2".', 'invalid_action');
    }

    const fromNumber = Number(match[1]);
    const toNumber = Number(match[2]);
    if (fromNumber === toNumber) {
        throw new StaffAuditError('Начальный и конечный ранги должны отличаться.', 'same_rank');
    }

    const fromRank = getRank(config, fromNumber);
    const toRank = getRank(config, toNumber);
    if (!fromRank || !toRank) {
        const available = getRankNumbers(config);
        throw new StaffAuditError(
            `Один из рангов отсутствует в настройках. Доступные ранги: ${available.length ? available.join(', ') : 'ранги не настроены'}.`,
            'rank_not_found'
        );
    }

    const promotion = toNumber > fromNumber;
    return {
        fromNumber,
        toNumber,
        fromRank,
        toRank,
        promotion,
        formattedAction: `${promotion ? 'Повышен' : 'Понижен'} ${fromNumber}-${toNumber}`,
    };
}

function getDepartmentTransition(member, config, rankAction, keepDepartment) {
    const settings = getStaffAuditSettings(config);
    const threshold = settings.departmentTransitionRankNumber;
    if (
        keepDepartment ||
        !threshold ||
        !rankAction.promotion ||
        rankAction.fromNumber >= threshold ||
        rankAction.toNumber < threshold
    ) {
        return null;
    }

    const giveRolesSettings = getGiveRolesSettings(config);
    const departments = getDepartments(config);
    const trainingDepartment = departments
        .find((department) => department.id === giveRolesSettings.inviteDepartmentId) || null;
    if (!trainingDepartment?.roles?.memberRoleId) {
        throw new StaffAuditError(
            'Не настроен стажировочный отдел, который должен сниматься при переходе ранга.',
            'training_department_not_configured'
        );
    }

    const destinationDepartments = departments.filter((department) => {
        const roleId = department.roles?.memberRoleId;
        return Boolean(
            roleId &&
            department.id !== trainingDepartment.id &&
            member.roles.cache.has(roleId)
        );
    });

    if (!destinationDepartments.length) {
        throw new StaffAuditError(
            'У сотрудника не найдена роль постоянного отдела. Укажите `keep_department: true` или сначала выдайте роль нужного отдела.',
            'destination_department_not_found'
        );
    }
    if (destinationDepartments.length > 1) {
        throw new StaffAuditError(
            'У сотрудника найдено несколько ролей постоянных отделов. Бот не может выбрать отдел автоматически.',
            'multiple_destination_departments'
        );
    }

    const destinationDepartment = destinationDepartments[0];
    const trainingRole = member.guild.roles.cache.get(trainingDepartment.roles.memberRoleId) || null;
    if (member.roles.cache.has(trainingDepartment.roles.memberRoleId) && (!trainingRole || !trainingRole.editable)) {
        throw new StaffAuditError('Бот не может снять роль стажировочного отдела.', 'training_role_not_editable');
    }
    if (!member.manageable) {
        throw new StaffAuditError('Бот не может изменить никнейм этого сотрудника.', 'member_not_manageable');
    }

    const staticId = extractStaticId(member.displayName);
    if (!staticId) {
        throw new StaffAuditError('Не удалось определить статик из никнейма сотрудника.', 'static_not_found');
    }

    const baseName = extractBaseName(member.displayName, staticId);
    return {
        trainingDepartment,
        trainingRole,
        destinationDepartment,
        nickname: giveRolesService.buildMemberNickname(destinationDepartment, baseName, staticId),
    };
}

async function applyDepartmentTransition(member, transition) {
    if (!transition) return;

    const trainingRoleId = transition.trainingRoleId || transition.trainingRole?.id || null;
    if (trainingRoleId && member.roles.cache.has(trainingRoleId)) {
        const trainingRole = member.guild.roles.cache.get(trainingRoleId);
        if (!trainingRole || !trainingRole.editable) {
            throw new StaffAuditError('Бот не может снять роль стажировочного отдела.', 'training_role_not_editable');
        }
        await runDiscordRequest(() => member.roles.remove(
            trainingRole,
            'WN Helper: выход из стажировочного отдела'
        ));
    }

    if (transition.nickname && member.displayName !== transition.nickname) {
        await runDiscordRequest(() => member.setNickname(transition.nickname));
    }
}

function createRankOperationSnapshot(config, rankAction, transition) {
    return {
        fromRankNumber: rankAction.fromNumber,
        toRankNumber: rankAction.toNumber,
        promotion: rankAction.promotion,
        formattedAction: rankAction.formattedAction,
        targetRoleId: rankAction.toRank.roleId || null,
        configuredRoleIds: getConfiguredRankRoleIds(config),
        transition: transition ? {
            trainingRoleId: transition.trainingRole?.id || null,
            nickname: transition.nickname,
        } : null,
    };
}

async function applyRankOperationSnapshot(member, snapshot) {
    if (!member || !snapshot) return;
    await syncMemberRankRoleSnapshot(member, {
        rankNumber: snapshot.toRankNumber,
        targetRoleId: snapshot.targetRoleId,
        configuredRoleIds: snapshot.configuredRoleIds,
    });
    await applyDepartmentTransition(member, snapshot.transition);
}

async function changeRank(client, {
    guild,
    config,
    actor,
    target,
    actionInput,
    reason,
    keepDepartment = false,
    nonceSeed,
    currentRankConfirmed = false,
    bypassDisciplinePromotionBlock = false,
    bypassPromotionDailyLimit = false,
    promotionSourceId = nonceSeed,
    skipDiscord = false,
    skipAudit = false,
    skipPromotionRecord = false,
    beforeDiscordApply = null,
}) {
    assertFeatureEnabled(config);
    if (!target?.displayName || !target?.staticId) {
        throw new StaffAuditError(
            'Не удалось определить сотрудника или его статик для изменения ранга.',
            'invalid_target'
        );
    }

    const rankAction = parseRankAction(actionInput, config);
    if (!skipDiscord && rankAction.promotion && target.member && !bypassPromotionDailyLimit) {
        assertPromotionDailyLimit({
            guildId: guild.id,
            targetMemberId: target.member.id,
            actor,
            config,
            sourceId: promotionSourceId,
        });
    }
    if (!skipDiscord && rankAction.promotion && target.member && !bypassDisciplinePromotionBlock) {
        await invokeAction('discipline.assertPromotionAllowed', guild.id, target.member.id, config);
    }
    if (target.member) {
        assertCanManageTarget(actor, target.member, config, {
            currentTargetRankNumber: currentRankConfirmed ? rankAction.fromNumber : null,
            targetRankNumber: rankAction.toNumber,
            actionLabel: rankAction.promotion ? 'повысить' : 'понизить',
        });
    }
    const grantDecision = getGrantDecision(actor, config, rankAction.toNumber);
    if (!grantDecision.allowed) {
        throw new StaffAuditError(grantDecision.reason, 'rank_access_denied');
    }

    let transition = null;
    if (target.member && !skipDiscord) {
        if (rankAction.fromRank.roleId && !target.member.roles.cache.has(rankAction.fromRank.roleId)) {
            throw new StaffAuditError(
                `У сотрудника отсутствует роль начального ранга ${rankAction.fromNumber} "${rankAction.fromRank.name}".`,
                'previous_rank_role_missing'
            );
        }

        transition = getDepartmentTransition(
            target.member,
            config,
            rankAction,
            keepDepartment
        );

        const operationSnapshot = createRankOperationSnapshot(config, rankAction, transition);
        if (rankAction.promotion && !bypassPromotionDailyLimit) {
            await reservePromotion({
                guildId: guild.id,
                targetMemberId: target.member.id,
                actor,
                config,
                fromRankNumber: rankAction.fromNumber,
                toRankNumber: rankAction.toNumber,
                sourceId: promotionSourceId,
            });
        }
        if (typeof beforeDiscordApply === 'function') {
            await beforeDiscordApply(operationSnapshot);
        }
        await applyRankOperationSnapshot(target.member, operationSnapshot);
        if (!skipPromotionRecord && rankAction.promotion) {
            await recordPromotion({
                guildId: guild.id,
                targetMemberId: target.member.id,
                actorId: actor.id,
                fromRankNumber: rankAction.fromNumber,
                toRankNumber: rankAction.toNumber,
                sourceId: promotionSourceId,
            });
        }
    }

    const channel = skipAudit ? null : await sendRankRecord(client, {
        guildId: guild.id,
        config,
        actor,
        target,
        action: rankAction.formattedAction,
        reason,
        nonceSeed,
    });

    return {
        channel,
        rankAction,
        target,
        transition,
    };
}

async function dismissMember(client, {
    guild,
    config,
    actor,
    target,
    reason,
    nonceSeed,
    source = 'slash_uval',
    sourceAck = null,
    expectedTargetStateHash = null,
    bypassActiveDiscipline = false,
    forceApproval = false,
    executeAsApprover = false,
    skipInitialHierarchy = false,
    bypassLimitApproval = false,
    deferApprovalRequest = false,
}) {
    assertFeatureEnabled(config);
    return invokeAction('offboarding.requestDismissal', client, {
        guild,
        config,
        actor,
        target,
        reason,
        nonceSeed,
        source,
        sourceAck,
        expectedTargetStateHash,
        bypassActiveDiscipline,
        forceApproval,
        executeAsApprover,
        skipInitialHierarchy,
        bypassLimitApproval,
        deferApprovalRequest,
    });
}


module.exports = {
    StaffAuditError,
    applyRankOperationSnapshot,
    assertFeatureEnabled,
    changeRank,
    dismissMember,
    extractBaseName,
    extractStaticId,
    getAuditChannel,
    createRankOperationSnapshot,
    parseRankAction,
    resolveMemberInput,
    sendDismissalRecord,
    sendInviteRecord,
    sendRankRecord,
    stripDepartmentPrefix,
    unique,
};
