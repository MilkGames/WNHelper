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

const { getDatabaseStatus } = require('../core/database/status');
const { replyWithRetry } = require('../core/discord/request');

const RECOVERY_SUBCOMMANDS = new Set([
    'instance_status',
    'shutdown_instance',
    'database_status',
    'database_compare',
    'database_resolve',
    'database_apply',
]);
const SAFE_COMPONENT_PREFIXES = [
    'wn-db-recovery:',
    'wn-shutdown:',
];

function isSafeInteraction(interaction) {
    if (interaction.isChatInputCommand?.() || interaction.isAutocomplete?.()) {
        if (interaction.commandName !== 'manualtools') return false;
        const subcommand = interaction.options?.getSubcommand?.(false);
        return RECOVERY_SUBCOMMANDS.has(subcommand);
    }

    const customId = String(interaction.customId || '');
    return SAFE_COMPONENT_PREFIXES.some((prefix) => customId.startsWith(prefix));
}

module.exports = async (_client, interaction) => {
    const status = getDatabaseStatus();
    if (!status.recoveryMode && !status.maintenance) return;
    if (isSafeInteraction(interaction)) return;

    interaction.__wnStopPropagation = true;
    if (interaction.isAutocomplete?.()) {
        await interaction.respond([]).catch(() => undefined);
        return;
    }

    await replyWithRetry(interaction, {
        content: status.recoveryMode
            ? 'Бот работает в режиме восстановления базы данных. Доступны только служебные действия восстановления.'
            : `Изменения временно недоступны: ${status.maintenanceReason || 'техническое обслуживание'}.`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
    }).catch(() => undefined);
};
