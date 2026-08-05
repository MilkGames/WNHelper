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
const vacationService = require('./service');

const COMMAND_GROUPS = new Map([
    ['invite', 'staffAudit'],
    ['rank', 'staffAudit'],
    ['uval', 'staffAudit'],
    ['massaudit', 'staffAudit'],
    ['discipline', 'discipline'],
    ['massdiscipline', 'discipline'],
    ['sendexam', 'examination'],
    ['settings', 'settings'],
    ['manualtools', 'manualTools'],
]);

function getCommandGroup(commandName) {
    return COMMAND_GROUPS.get(String(commandName || '').toLowerCase()) || null;
}

function getBlock(guildId, memberId, group, member = null) {
    if (!guildId || !memberId || !group) return { blocked: false };
    return vacationService.isAccessBlocked(guildId, memberId, group, member);
}

function buildMessage(block) {
    const request = block?.request;
    return [
        'Эта возможность недоступна во время активного отпуска.',
        request?.requestMessageLink ? `Заявка: ${request.requestMessageLink}` : null,
    ].filter(Boolean).join('\n');
}

module.exports = {
    buildMessage,
    getBlock,
    getCommandGroup,
};
