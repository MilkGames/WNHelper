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
const guard = require('../accessGuard');
const { replyWithRetry } = require('../../../core/discord/request');

function componentGroup(interaction) {
    const customId = String(interaction.customId || '');
    const normalized = customId.toLowerCase();

    if (!normalized || normalized.startsWith('vacation:')) return null;

    // TODO: УБРАТЬ ЭТО ОТСЮДА И ПОФИКСИТЬ ЭТОТ БАГ
    if (
        normalized.startsWith('disciplineremoval:approve') ||
        normalized.startsWith('disciplineremoval:reject') ||
        normalized.startsWith('disciplineremovalreject') ||
        normalized.startsWith('disciplineappeal:approve') ||
        normalized.startsWith('disciplineappeal:reject') ||
        normalized.startsWith('disciplineappealdecision')
    ) {
        return null;
    }
    // ------------------------------------------------------

    if (normalized.startsWith('settings:')) return 'settings';
    if (normalized.startsWith('shift:')) return 'shifts';
    if (
        normalized.startsWith('examination:') ||
        normalized.startsWith('exam:') ||
        normalized.startsWith('examreq:')
    ) return 'examination';
    if (
        normalized.startsWith('discipline:') ||
        normalized.startsWith('disciplineissue:') ||
        normalized.startsWith('disciplineaction:') ||
        normalized.startsWith('disciplineremoval') ||
        normalized.startsWith('massdiscipline:') ||
        normalized.startsWith('massdisciplineapproval:')
    ) return 'discipline';
    if (
        normalized.startsWith('staffauditbatch:') ||
        normalized.startsWith('userstaffaudit:') ||
        normalized.startsWith('uvalapproval:')
    ) return 'staffAudit';
    if (normalized.startsWith('giveroles:') || normalized.startsWith('gr-')) return 'giveRoles';
    return null;
}

function contextGroup(interaction) {
    if (interaction.isMessageContextMenuCommand?.() || interaction.isUserContextMenuCommand?.()) {
        return 'staffAudit';
    }
    return null;
}

module.exports = async (client, interaction) => {
    if (!interaction?.inGuild?.()) return;
    if (interaction.isChatInputCommand?.() || interaction.isAutocomplete?.()) return;
    const group = componentGroup(interaction) || contextGroup(interaction);
    if (!group) return;
    const member = interaction.member?.roles?.cache
        ? interaction.member
        : await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    const block = guard.getBlock(interaction.guildId, interaction.user.id, group, member);
    if (!block.blocked) return;
    interaction.__wnStopPropagation = true;
    const payload = {
        content: guard.buildMessage(block),
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
    };
    if (interaction.deferred || interaction.replied) return;
    await replyWithRetry(interaction, payload).catch(() => undefined);
};
