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
const { getDepartments } = require('../../../core/config/departmentSchema');
const { getRanks } = require('../../../core/config/rankSchema');
const guildConfigService = require('../../../core/config/guildConfigService');
const staffAuditService = require('../service');
const staffAuditOperations = require('../operations');
const {
    deferReplyWithRetry,
    editReplyWithRetry,
} = require('../../../core/discord/request');
const logger = require('../../../core/logging/logger');
const { buildPublicErrorMessage } = require('../../../core/ui/errorMessage');

function filterAutocomplete(items, query, labelBuilder, valueBuilder) {
    const normalized = String(query || '').trim().toLocaleLowerCase('ru');
    return items
        .filter((item) => !normalized || labelBuilder(item).toLocaleLowerCase('ru').includes(normalized))
        .slice(0, 25)
        .map((item) => ({
            name: labelBuilder(item).slice(0, 100),
            value: valueBuilder(item),
        }));
}

module.exports = {
    name: 'invite',
    description: 'Принять игрока во фракцию и создать запись кадрового аудита.',
    options: [
        {
            name: 'member',
            description: 'Тег Discord или имя сотрудника.',
            required: true,
            type: ApplicationCommandOptionType.String,
        },
        {
            name: 'rank',
            description: 'Ранг сотрудника. По умолчанию используется начальный ранг.',
            type: ApplicationCommandOptionType.String,
            autocomplete: true,
        },
        {
            name: 'reason',
            description: 'Причина принятия. По умолчанию: Собеседование.',
            type: ApplicationCommandOptionType.String,
        },
        {
            name: 'static',
            description: 'Статик сотрудника, если его нельзя определить из никнейма.',
            type: ApplicationCommandOptionType.String,
        },
        {
            name: 'department',
            description: 'Отдел вместо стандартного стажировочного отдела.',
            type: ApplicationCommandOptionType.String,
            autocomplete: true,
        },
    ],
    botPermissions: [PermissionFlagsBits.ManageRoles],

    autocomplete: async (client, interaction) => {
        const focused = interaction.options.getFocused(true);
        const config = guildConfigService.get(interaction.guildId);
        if (!config) {
            await interaction.respond([]);
            return;
        }

        if (focused.name === 'rank') {
            await interaction.respond(filterAutocomplete(
                getRanks(config),
                focused.value,
                (rank) => `${rank.number} - ${rank.name}${rank.roleId ? '' : ' (без Discord-роли)'}`,
                (rank) => String(rank.number)
            ));
            return;
        }

        if (focused.name === 'department') {
            await interaction.respond(filterAutocomplete(
                getDepartments(config),
                focused.value,
                (department) => `${department.shortName} - ${department.fullName}`,
                (department) => department.id
            ));
            return;
        }

        await interaction.respond([]);
    },

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

            const rawRank = interaction.options.getString('rank');
            const rankNumber = rawRank ? Number(rawRank) : null;
            if (rawRank && (!Number.isSafeInteger(rankNumber) || rankNumber <= 0)) {
                throw new staffAuditService.StaffAuditError(
                    'Выберите ранг из списка настроенных рангов.',
                    'invalid_rank'
                );
            }
            const departmentId = interaction.options.getString('department') || null;
            const reason = interaction.options.getString('reason')?.trim() || 'Собеседование';
            const target = await staffAuditService.resolveMemberInput(
                guild,
                interaction.options.getString('member', true),
                interaction.options.getString('static')
            );

            operation = await staffAuditOperations.reserveOperation({
                type: 'invite',
                guildId,
                actorId: actor.id,
                target,
                payload: {
                    rankNumber,
                    departmentId,
                    reason,
                },
                sourceId: `slashInvite:${guildId}:${interaction.id}`,
            });
            const completed = await staffAuditOperations.executeOperation(client, operation.operationId);

            await editReplyWithRetry(interaction, {
                content: `Принятие ${target.displayValue} обработано. Запись создана в канале <#${completed.channelId}>.`,
                allowedMentions: { parse: [] },
            });
        } catch (error) {
            logger[error instanceof staffAuditService.StaffAuditError ? 'warn' : 'error']('Ошибка команды /invite', {
                guildId,
                userId: interaction.user.id,
            }, error);

            await editReplyWithRetry(interaction, {
                content: `${buildPublicErrorMessage(error, 'Не удалось выполнить принятие. Ошибка записана в лог.')}${operation?.operationId ? `\nID операции: ${operation.operationId}` : ''}`,
                allowedMentions: { parse: [] },
            });
        }
    },
};
