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
const DisciplineError = require('../error');
const disciplineInteractionService = require('../interactionService');
const { replyWithRetry } = require('../../../core/discord/request');
const logger = require('../../../core/logging/logger');
const { buildPublicErrorMessage } = require('../../../core/ui/errorMessage');

module.exports = {
    name: 'discipline',
    description: 'Оформить дисциплинарное взыскание сотруднику.',
    options: [
        {
            name: 'member',
            description: 'Тег Discord, ID или имя сотрудника.',
            required: true,
            type: ApplicationCommandOptionType.String,
        },
        {
            name: 'static',
            description: 'Статик сотрудника, если в member указано имя.',
            required: false,
            type: ApplicationCommandOptionType.String,
        },
    ],
    botPermissions: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.SendMessagesInThreads,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageRoles,
    ],

    callback: async (client, interaction) => {
        try {
            await disciplineInteractionService.startIssue(client, interaction);
        } catch (error) {
            logger[error instanceof DisciplineError ? 'warn' : 'error']('Ошибка запуска /discipline', {
                guildId: interaction.guildId,
                userId: interaction.user.id,
                memberInput: interaction.options.getString('member') || null,
                externalStatic: interaction.options.getString('static') || null,
            }, error);
            await replyWithRetry(interaction, {
                content: buildPublicErrorMessage(error, 'Не удалось открыть оформление взыскания.'),
                flags: MessageFlags.Ephemeral,
                allowedMentions: { parse: [] },
            }).catch(() => undefined);
        }
    },
};
