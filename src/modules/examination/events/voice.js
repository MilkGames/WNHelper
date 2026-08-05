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
const examinationService = require('../service');
const logger = require('../../../core/logging/logger');

module.exports = async (client, oldState, newState) => {
    try {
        await examinationService.handleVoiceStateUpdate(client, oldState, newState);
    } catch (error) {
        logger.error('Ошибка автоматического подтверждения входа в голосовой канал', {
            guildId: newState?.guild?.id || oldState?.guild?.id || null,
            memberId: newState?.id || oldState?.id || null,
        }, error);
    }
};
