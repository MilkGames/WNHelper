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
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */
const config = require('../../../config.json');
const logger = require('../../utils/logger');
const {
    runDiscordRequest,
    sendMessageWithRetry,
} = require('../../utils/discordRequest');

const DELETE_DELAY_MS = 60 * 1000;
const WARNING_COOLDOWN_MS = 60 * 1000;

const lastWarningAtByChannel = new Map();

function shouldTreatDeleteErrorAsSuccess(error) {
    const status = Number(error?.status);
    const code = Number(error?.code);

    return status === 404 || code === 10008;
}

async function deleteMessageWithRetry(message) {
    if (!message || typeof message.delete !== 'function') return;

    await runDiscordRequest(() => message.delete(), {
        attempts: 3,
        shouldTreatErrorAsSuccess: shouldTreatDeleteErrorAsSuccess,
    });
}

function scheduleDelete(message, reason) {
    setTimeout(async () => {
        try {
            await deleteMessageWithRetry(message);
        } catch (error) {
            logger.info(`Канал выдачи ролей: не удалось удалить сообщение (${reason}): ${error}`);
        }
    }, DELETE_DELAY_MS);
}

function canSendWarning(channelId) {
    const now = Date.now();
    const lastWarningAt = lastWarningAtByChannel.get(channelId) || 0;

    if (now - lastWarningAt < WARNING_COOLDOWN_MS) {
        return false;
    }

    lastWarningAtByChannel.set(channelId, now);
    return true;
}

module.exports = async (client, message) => {
    if (!message?.guildId || !message?.channelId || !message?.author) return;
    if (message.author.bot) return;

    const serverConfig = config.servers[message.guildId];
    if (!serverConfig?.getRoleChannelId) return;

    if (message.channelId !== serverConfig.getRoleChannelId) return;

    scheduleDelete(message, 'сообщение администратора');

    if (!canSendWarning(message.channelId)) return;

    try {
        // хотелось бы, конечно, удалять банально сообщения, но ладно, буду добрым
        // ну ребят, come on, у вас единственное сообщение в канале ОТ БОТА с января 2026, неужели так сложно додуматься...
        const warning = await sendMessageWithRetry(message.channel, {
            content:
                `Уважаемый администратор!\n\n` +
                `Пожалуйста, не используйте данный канал для получения пинга другого администратора.\n` +
                `Данный канал должен быть свободен, чтобы в нём была чистая информация о выдаче ролей для новых сотрудников.\n\n` +
                `Я удалю ваше сообщение через минуту, чтобы освободить канал.\n\n` +
                `Спасибо за понимание ❤️`,
            allowedMentions: {
                parse: [],
            },
        }, {
            nonceSeed: `giveRolesChannelWarning:${message.guildId}:${message.channelId}:${message.id}`,
        });

        scheduleDelete(warning, 'предупреждение администратора');
    } catch (error) {
        logger.info(`Канал выдачи ролей: не удалось отправить предупреждение администратору: ${error}`);
    }
};