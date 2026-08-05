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
const {
    deferReplyWithRetry,
    editReplyWithRetry,
} = require('../../../core/discord/request');
const logger = require('../../../core/logging/logger');
const { buildPublicErrorMessage } = require('../../../core/ui/errorMessage');

module.exports = {
    name: 'uval',
    description: 'Уволить сотрудника и создать запись кадрового аудита.',
    options: [
        {
            name: 'member',
            description: 'Тег Discord или имя сотрудника.',
            required: true,
            type: ApplicationCommandOptionType.String,
        },
        {
            name: 'reason',
            description: 'Причина увольнения.',
            required: true,
            type: ApplicationCommandOptionType.String,
        },
        {
            name: 'static',
            description: 'Статик сотрудника, если его нельзя определить из никнейма.',
            type: ApplicationCommandOptionType.String,
        },
    ],
    botPermissions: [PermissionFlagsBits.ManageRoles],

    callback: async (client, interaction) => {
        await deferReplyWithRetry(interaction, {
            flags: MessageFlags.Ephemeral,
        });

        const guildId = interaction.guildId;
        const config = guildConfigService.get(guildId);

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
            const reason = interaction.options.getString('reason', true);
            const result = await staffAuditService.dismissMember(client, {
                guild,
                config,
                actor,
                target,
                reason,
                nonceSeed: `kaUval:${guildId}:${interaction.id}`,
                source: 'slash_uval',
            });

            await editReplyWithRetry(interaction, {
                content: result.status === 'pending_approval'
                    ? `Лимит увольнений исчерпан. Увольнение ${target.displayValue} отправлено на подтверждение.`
                    : `Увольнение ${target.displayValue} обработано.`,
                allowedMentions: { parse: [] },
            });
        } catch (error) {
            logger[error instanceof staffAuditService.StaffAuditError ? 'warn' : 'error']('Ошибка команды /uval', {
                guildId,
                userId: interaction.user.id,
            }, error);

            await editReplyWithRetry(interaction, {
                content: buildPublicErrorMessage(error, 'Не удалось выполнить увольнение. Ошибка записана в лог.'),
                allowedMentions: { parse: [] },
            });
        }
    },
};
