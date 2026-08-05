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
const { MessageFlags } = require('discord.js');
const guildConfigService = require('../../../core/config/guildConfigService');
const { getPreviousRank, getRank, getRankNumbers } = require('../ranks');
const staffAuditService = require('../service');
const staffAuditOperations = require('../operations');
const {
    deferReplyWithRetry,
    editReplyWithRetry,
} = require('../../../core/discord/request');
const logger = require('../../../core/logging/logger');
const { buildPublicErrorMessage } = require('../../../core/ui/errorMessage');

function getEmbedFields(message) {
    const embed = message?.embeds?.[0];
    const data = embed?.data ?? embed ?? {};
    return Array.isArray(data.fields) ? data.fields : [];
}

function extractDiscordIdFromFixedField(message) {
    const fields = getEmbedFields(message);
    if (!fields.length) return null;
    const value = String(fields[fields.length - 1]?.value || '');
    return value.match(/(\d{17,20})/)?.[1] || null;
}

function extractTargetRankFromFixedField(message) {
    const fields = getEmbedFields(message);
    const value = String(fields[1]?.value || '');
    const match = value.match(/(\d+)/);
    return match ? Number(match[1]) : null;
}

function buildMessageLink(message) {
    return `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
}

async function respondError(interaction, error) {
    const operationSuffix = error?.operationId ? `\nID операции: ${error.operationId}` : '';
    await editReplyWithRetry(interaction, {
        content: `${buildPublicErrorMessage(error, 'Не удалось выполнить контекстную команду. Ошибка записана в лог.')}${operationSuffix}`,
        allowedMentions: { parse: [] },
    });
}

module.exports = async (client, interaction) => {
    if (!interaction.isMessageContextMenuCommand()) return;

    await deferReplyWithRetry(interaction, {
        flags: MessageFlags.Ephemeral,
    });

    const targetMessage = interaction.targetMessage;
    const guildId = interaction.guildId;
    const config = guildConfigService.get(guildId);

    try {
        staffAuditService.assertFeatureEnabled(config);
        if (!targetMessage?.embeds?.length) {
            throw new staffAuditService.StaffAuditError(
                'В сообщении нет нужного embed. Контекстная команда работает только с утверждённой формой отчёта или заявления.',
                'embed_missing'
            );
        }

        const memberId = extractDiscordIdFromFixedField(targetMessage);
        if (!memberId) {
            throw new staffAuditService.StaffAuditError(
                'Не удалось считать Discord ID из последнего поля embed.',
                'member_id_missing'
            );
        }

        const guild = interaction.guild || await client.guilds.fetch(guildId);
        const actor = await guild.members.fetch(interaction.user.id);
        const targetMember = await guild.members.fetch(memberId).catch(() => null);
        if (!targetMember) {
            throw new staffAuditService.StaffAuditError(
                'Сотрудник из сообщения не найден на сервере.',
                'member_not_found'
            );
        }

        const reason = buildMessageLink(targetMessage);

        if (interaction.commandName === 'Повысить по отчёту') {
            const targetRankNumber = extractTargetRankFromFixedField(targetMessage);
            const targetRank = targetRankNumber ? getRank(config, targetRankNumber) : null;
            if (!targetRank) {
                const available = getRankNumbers(config);
                throw new staffAuditService.StaffAuditError(
                    `Не удалось считать настроенный целевой ранг из второго поля embed. Доступные ранги: ${available.length ? available.join(', ') : 'ранги не настроены'}.`,
                    'target_rank_missing'
                );
            }

            const previousRank = getPreviousRank(config, targetRank.number);
            if (!previousRank) {
                throw new staffAuditService.StaffAuditError(
                    `Для ранга ${targetRank.number} "${targetRank.name}" нет предыдущего настроенного ранга.`,
                    'previous_rank_missing'
                );
            }

            const staticId = staffAuditService.extractStaticId(targetMember.displayName);
            if (!staticId) {
                throw new staffAuditService.StaffAuditError(
                    'Не удалось определить статик из никнейма сотрудника.',
                    'static_not_found'
                );
            }

            const target = {
                member: targetMember,
                memberId: targetMember.id,
                displayName: targetMember.displayName,
                staticId,
                displayValue: `${targetMember}`,
            };
            let operation = await staffAuditOperations.reserveOperation({
                type: 'rank',
                guildId,
                actorId: actor.id,
                target,
                payload: {
                    actionInput: `${previousRank.number}-${targetRank.number}`,
                    reason,
                    keepDepartment: false,
                    sourceAck: {
                        channelId: targetMessage.channelId,
                        messageId: targetMessage.id,
                        emoji: '✅',
                    },
                },
                sourceId: `messageContextRank:${guildId}:${targetMessage.id}`,
            });
            try {
                operation = await staffAuditOperations.executeOperation(client, operation.operationId);
            } catch (error) {
                error.operationId = operation.operationId;
                throw error;
            }

            await editReplyWithRetry(interaction, {
                content: `Сотрудник повышен: ${operation.rankSnapshot.formattedAction}. Запись создана в канале <#${operation.channelId}>.`,
                allowedMentions: { parse: [] },
            });
            return;
        }

        if (interaction.commandName === 'Уволить по заявлению') {
            const staticId = staffAuditService.extractStaticId(targetMember.displayName);
            if (!staticId) {
                throw new staffAuditService.StaffAuditError(
                    'Не удалось определить статик из никнейма сотрудника.',
                    'static_not_found'
                );
            }

            const target = {
                member: targetMember,
                memberId: targetMember.id,
                displayName: targetMember.displayName,
                staticId,
                displayValue: `${targetMember}`,
            };
            const result = await staffAuditService.dismissMember(client, {
                guild,
                config,
                actor,
                target,
                reason,
                nonceSeed: `kaUvalRequest:${guildId}:${interaction.id}`,
                source: 'message_context_dismissal',
                sourceAck: {
                    channelId: targetMessage.channelId,
                    messageId: targetMessage.id,
                    emoji: '✅',
                },
            });
            await editReplyWithRetry(interaction, {
                content: result.status === 'pending_approval'
                    ? 'Лимит увольнений исчерпан. Увольнение отправлено на подтверждение.'
                    : 'Сотрудник уволен.',
                allowedMentions: { parse: [] },
            });
            return;
        }

        throw new staffAuditService.StaffAuditError('Неизвестная контекстная команда.', 'unknown_context_command');
    } catch (error) {
        logger[error instanceof staffAuditService.StaffAuditError ? 'warn' : 'error']('Ошибка контекстной команды кадрового аудита', {
            guildId,
            userId: interaction.user.id,
            commandName: interaction.commandName,
            messageId: targetMessage?.id || null,
        }, error);
        await respondError(interaction, error);
    }
};
