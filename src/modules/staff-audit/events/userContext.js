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
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    ModalBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require('discord.js');
const { getDepartments } = require('../../../core/config/departmentSchema');
const { getRanks } = require('../../../core/config/rankSchema');
const StaffAuditError = require('../error');
const guildConfigService = require('../../../core/config/guildConfigService');
const giveRolesService = require('../../give-roles');
const { getMemberRankMatches } = require('../ranks');
const staffAuditService = require('../service');
const staffAuditOperations = require('../operations');
const {
    deferReplyWithRetry,
    editReplyWithRetry,
    replyWithRetry,
    showModalWithRetry,
} = require('../../../core/discord/request');
const logger = require('../../../core/logging/logger');
const { buildPublicErrorMessage } = require('../../../core/ui/errorMessage');

const sessions = new Map();
const SESSION_TTL_MS = 15 * 60_000;
const COMMAND_TO_ACTION = new Map([
    ['Принять сотрудника', 'invite'],
    ['Изменить ранг', 'rank'],
    ['Уволить сотрудника', 'uval'],
]);

function createId() {
    return typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function customId(sessionId, action) {
    return `staffUserAction:${sessionId}:${action}`;
}

function getSession(id) {
    const session = sessions.get(id);
    if (!session) return null;
    if (Date.now() - session.updatedAt > SESSION_TTL_MS) {
        sessions.delete(id);
        return null;
    }
    session.updatedAt = Date.now();
    return session;
}

function parseCustomId(value) {
    const match = String(value || '').match(/^staffUserAction:([^:]+):(.+)$/);
    return match ? { sessionId: match[1], action: match[2] } : null;
}

function buildInvitePanel(session, config) {
    const ranks = getRanks(config);
    const departments = getDepartments(config);
    const initial = giveRolesService.getManualAssignment(config);
    session.rankNumber ||= initial.rank?.number || ranks[0]?.number || null;
    session.departmentId ||= initial.department?.id || departments[0]?.id || null;

    const components = [];
    if (ranks.length) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(customId(session.id, 'invite_rank'))
                .setPlaceholder('Ранг')
                .addOptions(ranks.slice(0, 25).map((rank) => ({
                    label: `${rank.number} - ${rank.name}`.slice(0, 100),
                    value: String(rank.number),
                    default: rank.number === session.rankNumber,
                })))
        ));
    }
    if (departments.length) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(customId(session.id, 'invite_department'))
                .setPlaceholder('Отдел')
                .addOptions(departments.slice(0, 25).map((department) => ({
                    label: `${department.shortName} - ${department.fullName}`.slice(0, 100),
                    value: department.id,
                    default: department.id === session.departmentId,
                })))
        ));
    }
    components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(customId(session.id, 'invite_continue'))
            .setLabel('Продолжить')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(!session.rankNumber || !session.departmentId)
    ));
    return {
        content: [
            `Принятие <@${session.targetMemberId}>.`,
            'Выберите ранг и отдел.',
            '',
            '-# Интерфейс действителен 15 минут.',
        ].join('\n'),
        components,
        allowedMentions: { parse: [] },
    };
}

function buildRankPanel(session, config) {
    const ranks = getRanks(config);
    const hasRanksWithoutRoles = ranks.some((rank) => !rank.roleId);
    const components = [];

    if (hasRanksWithoutRoles) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(customId(session.id, 'rank_from'))
                .setPlaceholder('Текущий ранг')
                .addOptions(ranks.slice(0, 25).map((rank) => ({
                    label: `${rank.number} - ${rank.name}`.slice(0, 100),
                    value: String(rank.number),
                    default: rank.number === session.fromRankNumber,
                })))
        ));
    }

    components.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(customId(session.id, 'rank_target'))
            .setPlaceholder('Новый ранг')
            .addOptions(ranks.slice(0, 25).map((rank) => ({
                label: `${rank.number} - ${rank.name}`.slice(0, 100),
                value: String(rank.number),
                default: rank.number === session.rankNumber,
            })))
    ));
    components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(customId(session.id, 'rank_department'))
            .setLabel(session.keepDepartment ? 'Отдел: не менять' : 'Отдел: автосмена')
            .setStyle(session.keepDepartment ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(customId(session.id, 'rank_continue'))
            .setLabel('Продолжить')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(!session.rankNumber || !session.fromRankNumber),
    ));
    return {
        content: [
            `Изменение ранга <@${session.targetMemberId}>.`,
            hasRanksWithoutRoles
                ? 'На сервере есть ранги без Discord-ролей, поэтому текущий ранг нужно подтвердить вручную.'
                : `Текущий ранг определён автоматически: ${session.fromRankNumber}.`,
            '',
            '-# Интерфейс действителен 15 минут.',
        ].join('\n'),
        components,
        allowedMentions: { parse: [] },
    };
}

function buildModal(session, action) {
    const modal = new ModalBuilder()
        .setCustomId(customId(session.id, `${action}_modal`))
        .setTitle(action === 'invite' ? 'Принятие сотрудника' : action === 'rank' ? 'Изменение ранга' : 'Увольнение');
    const reason = new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('Причина')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(action !== 'invite')
        .setMaxLength(1000);
    if (action === 'invite') reason.setValue('Собеседование');
    modal.addComponents(new ActionRowBuilder().addComponents(reason));
    if (action === 'invite') {
        modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('static')
                .setLabel('Статик (если отсутствует в никнейме)')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setMaxLength(20)
        ));
    }
    return modal;
}

async function createSession(client, interaction, action) {
    const config = guildConfigService.get(interaction.guildId);
    staffAuditService.assertFeatureEnabled(config);
    const guild = interaction.guild || await client.guilds.fetch(interaction.guildId);
    const targetMember = await guild.members.fetch(interaction.targetId).catch(() => null);
    if (!targetMember) throw new StaffAuditError('Сотрудник не найден на сервере.', 'member_not_found');

    const matches = getMemberRankMatches(targetMember, config);
    if (matches.length > 1) {
        throw new StaffAuditError('У сотрудника найдено несколько ролей рангов.', 'target_multiple_ranks');
    }

    const session = {
        id: createId(),
        action,
        guildId: interaction.guildId,
        actorId: interaction.user.id,
        targetMemberId: interaction.targetId,
        updatedAt: Date.now(),
        fromRankNumber: matches[0]?.number || null,
        rankNumber: null,
        departmentId: null,
        keepDepartment: false,
    };
    sessions.set(session.id, session);

    if (action === 'uval') {
        await showModalWithRetry(interaction, buildModal(session, 'uval'), { attempts: 1 });
        return;
    }

    await replyWithRetry(interaction, {
        ...(action === 'invite' ? buildInvitePanel(session, config) : buildRankPanel(session, config)),
        flags: MessageFlags.Ephemeral,
    });
}

async function executeInvite(client, interaction, session) {
    const config = guildConfigService.get(session.guildId);
    const guild = interaction.guild || await client.guilds.fetch(session.guildId);
    const actor = await guild.members.fetch(interaction.user.id);
    const target = await staffAuditService.resolveMemberInput(
        guild,
        session.targetMemberId,
        interaction.fields.getTextInputValue('static') || null
    );
    const reason = interaction.fields.getTextInputValue('reason').trim() || 'Собеседование';
    let operation = await staffAuditOperations.reserveOperation({
        type: 'invite',
        guildId: guild.id,
        actorId: actor.id,
        target,
        payload: {
            rankNumber: session.rankNumber,
            departmentId: session.departmentId,
            reason,
        },
        sourceId: `userContextInvite:${guild.id}:${session.id}`,
    });
    try {
        operation = await staffAuditOperations.executeOperation(client, operation.operationId);
    } catch (error) {
        error.operationId = operation.operationId;
        throw error;
    }
    return `Сотрудник принят. Запись создана в канале <#${operation.channelId}>.`;
}

async function executeRank(client, interaction, session) {
    const config = guildConfigService.get(session.guildId);
    const guild = interaction.guild || await client.guilds.fetch(session.guildId);
    const actor = await guild.members.fetch(interaction.user.id);
    const member = await guild.members.fetch(session.targetMemberId);
    const matches = getMemberRankMatches(member, config);
    if (matches.length > 1) throw new StaffAuditError('У сотрудника найдено несколько ролей рангов.', 'target_multiple_ranks');
    if (!session.fromRankNumber) throw new StaffAuditError('Не выбран текущий ранг сотрудника.', 'current_rank_missing');
    if (matches.length === 1 && matches[0].number !== session.fromRankNumber) {
        throw new StaffAuditError(
            `Выбранный текущий ранг ${session.fromRankNumber} не совпадает с ролью ранга ${matches[0].number}.`,
            'current_rank_mismatch'
        );
    }

    const target = await staffAuditService.resolveMemberInput(guild, member.id);
    let operation = await staffAuditOperations.reserveOperation({
        type: 'rank',
        guildId: guild.id,
        actorId: actor.id,
        target,
        payload: {
            actionInput: `${session.fromRankNumber}-${session.rankNumber}`,
            reason: interaction.fields.getTextInputValue('reason').trim(),
            keepDepartment: session.keepDepartment === true,
        },
        sourceId: `userContextRank:${guild.id}:${session.id}`,
    });
    try {
        operation = await staffAuditOperations.executeOperation(client, operation.operationId);
    } catch (error) {
        error.operationId = operation.operationId;
        throw error;
    }
    return `Ранг изменён: ${operation.rankSnapshot.formattedAction}. Запись создана в канале <#${operation.channelId}>.`;
}

async function executeDismissal(client, interaction, session) {
    const config = guildConfigService.get(session.guildId);
    const guild = interaction.guild || await client.guilds.fetch(session.guildId);
    const actor = await guild.members.fetch(interaction.user.id);
    const target = await staffAuditService.resolveMemberInput(guild, session.targetMemberId);
    const result = await staffAuditService.dismissMember(client, {
        guild,
        config,
        actor,
        target,
        reason: interaction.fields.getTextInputValue('reason').trim(),
        source: 'user_context_dismissal',
        nonceSeed: `userContextUval:${guild.id}:${interaction.id}`,
    });
    return result.status === 'pending_approval'
        ? `Лимит увольнений исчерпан. Операция отправлена на подтверждение.\nID увольнения: ${result.operation.uvalId}`
        : 'Сотрудник уволен.';
}

module.exports = async (client, interaction) => {
    if (interaction.isUserContextMenuCommand() && COMMAND_TO_ACTION.has(interaction.commandName)) {
        try {
            await createSession(client, interaction, COMMAND_TO_ACTION.get(interaction.commandName));
        } catch (error) {
            logger[error instanceof StaffAuditError ? 'warn' : 'error']('Ошибка запуска пользовательского кадрового действия', {
                guildId: interaction.guildId,
                userId: interaction.user?.id,
                targetMemberId: interaction.targetId,
                commandName: interaction.commandName,
            }, error);
            await replyWithRetry(interaction, {
                content: buildPublicErrorMessage(error, 'Не удалось открыть кадровое действие.'),
                flags: MessageFlags.Ephemeral,
                allowedMentions: { parse: [] },
            }).catch(() => undefined);
        }
        return;
    }

    const parsed = parseCustomId(interaction.customId);
    if (!parsed) return;
    const session = getSession(parsed.sessionId);
    if (!session || session.actorId !== interaction.user.id || session.guildId !== interaction.guildId) {
        await replyWithRetry(interaction, {
            content: 'Сессия кадрового действия истекла.',
            flags: MessageFlags.Ephemeral,
        }).catch(() => undefined);
        return;
    }

    try {
        const config = guildConfigService.get(session.guildId);
        staffAuditService.assertFeatureEnabled(config);

        if (interaction.isStringSelectMenu()) {
            if (parsed.action === 'invite_rank') session.rankNumber = Number(interaction.values[0]);
            if (parsed.action === 'invite_department') session.departmentId = interaction.values[0];
            if (parsed.action === 'rank_from') session.fromRankNumber = Number(interaction.values[0]);
            if (parsed.action === 'rank_target') session.rankNumber = Number(interaction.values[0]);
            await interaction.deferUpdate();
            await editReplyWithRetry(interaction, session.action === 'invite'
                ? buildInvitePanel(session, config)
                : buildRankPanel(session, config));
            return;
        }

        if (interaction.isButton()) {
            if (parsed.action === 'invite_continue' || parsed.action === 'rank_continue') {
                await showModalWithRetry(
                    interaction,
                    buildModal(session, parsed.action.startsWith('invite') ? 'invite' : 'rank'),
                    { attempts: 1 }
                );
                return;
            }
            await interaction.deferUpdate();
            if (parsed.action === 'rank_department') {
                session.keepDepartment = !session.keepDepartment;
                await editReplyWithRetry(interaction, buildRankPanel(session, config));
            }
            return;
        }

        if (interaction.isModalSubmit()) {
            await deferReplyWithRetry(interaction, { flags: MessageFlags.Ephemeral });
            let message;
            if (parsed.action === 'invite_modal') message = await executeInvite(client, interaction, session);
            else if (parsed.action === 'rank_modal') message = await executeRank(client, interaction, session);
            else if (parsed.action === 'uval_modal') message = await executeDismissal(client, interaction, session);
            else return;
            sessions.delete(session.id);
            await editReplyWithRetry(interaction, { content: message, components: [], allowedMentions: { parse: [] } });
        }
    } catch (error) {
        logger[error instanceof StaffAuditError ? 'warn' : 'error']('Ошибка пользовательского контекстного кадрового действия', {
            guildId: interaction.guildId,
            userId: interaction.user?.id,
            targetMemberId: session.targetMemberId,
            action: parsed.action,
        }, error);
        const operationSuffix = error?.operationId ? `\nID операции: ${error.operationId}` : '';
        const content = `${buildPublicErrorMessage(error, 'Не удалось выполнить кадровое действие.')}${operationSuffix}`;
        if (interaction.deferred || interaction.replied) {
            await editReplyWithRetry(interaction, { content, components: [], allowedMentions: { parse: [] } }).catch(() => undefined);
        } else {
            await replyWithRetry(interaction, {
                content,
                flags: MessageFlags.Ephemeral,
                allowedMentions: { parse: [] },
            }).catch(() => undefined);
        }
    }
};
