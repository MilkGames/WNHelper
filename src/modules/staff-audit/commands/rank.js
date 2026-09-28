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
const {
    ApplicationCommandOptionType,
    MessageFlags,
    PermissionFlagsBits,
} = require('discord.js');
const guildConfigService = require('../../../core/config/guildConfigService');
const staffAuditService = require('../service');
const staffAuditOperations = require('../operations');
const {
    deferReplyWithRetry,
    editReplyWithRetry,
} = require('../../../core/discord/request');
const logger = require('../../../core/logging/logger');
const { buildPublicErrorMessage } = require('../../../core/ui/errorMessage');

module.exports = {
    name: 'rank',
    description: 'Изменить ранг сотрудника и создать запись кадрового аудита.',
    options: [
        {
            name: 'member',
            description: 'Discord ID или текстовое имя сотрудника.',
            required: true,
            type: ApplicationCommandOptionType.String,
        },
        {
            name: 'action',
            description: 'Переход между рангами в формате 2-3 или 4-2.',
            required: true,
            type: ApplicationCommandOptionType.String,
        },
        {
            name: 'reason',
            description: 'Причина изменения ранга.',
            required: true,
            type: ApplicationCommandOptionType.String,
        },
        {
            name: 'static',
            description: 'Статик сотрудника, если его нельзя определить из никнейма.',
            type: ApplicationCommandOptionType.String,
        },
        {
            name: 'keep_department',
            description: 'Не изменять отдел и префикс никнейма при переходе.',
            type: ApplicationCommandOptionType.Boolean,
        },
    ],
    botPermissions: [PermissionFlagsBits.ManageRoles],

    callback: async (client, interaction) => {
        await deferReplyWithRetry(interaction, {
            flags: MessageFlags.Ephemeral,
        });

        const guildId = interaction.guildId;
        const config = guildConfigService.get(guildId);
        let operation = null;

        try {
            staffAuditService.assertFeatureEnabled(config);
            const guild = interaction.guild || await client.guilds.fetch(guildId);
            const actor = await guild.members.fetch(interaction.user.id);
            await staffAuditService.getAuditChannel(client, guildId, config);

            const target = await staffAuditService.resolveMemberInput(
                guild,
                interaction.options.getString('member', true),
                interaction.options.getString('static')
            );
            const actionInput = interaction.options.getString('action', true);
            operation = await staffAuditOperations.reserveOperation({
                type: 'rank',
                guildId,
                actorId: actor.id,
                target,
                payload: {
                    actionInput,
                    reason: interaction.options.getString('reason', true),
                    keepDepartment: interaction.options.getBoolean('keep_department') === true,
                },
                sourceId: `slashRank:${guildId}:${interaction.id}`,
            });
            const completed = await staffAuditOperations.executeOperation(client, operation.operationId);
            const rankAction = staffAuditService.parseRankAction(actionInput, config);

            await editReplyWithRetry(interaction, {
                content: `Изменение ранга ${target.displayValue} обработано: ${rankAction.formattedAction}. Запись создана в канале <#${completed.channelId}>.`,
                allowedMentions: { parse: [] },
            });
        } catch (error) {
            logger[error instanceof staffAuditService.StaffAuditError ? 'warn' : 'error']('Ошибка команды /rank', {
                guildId,
                userId: interaction.user.id,
            }, error);

            await editReplyWithRetry(interaction, {
                content: `${buildPublicErrorMessage(error, 'Не удалось изменить ранг. Ошибка записана в лог.')}${operation?.operationId ? `\nID операции: ${operation.operationId}` : ''}`,
                allowedMentions: { parse: [] },
            });
        }
    },
};
