/*
 * WN Helper Discord Bot
 * Copyright (C) 2024-2026 MilkGames
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
const crypto = require('crypto');
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
} = require('discord.js');
const blackListGiveRoles = require('./database').blackListGiveRoles;
const giveRoles = require('./database').giveRoles;
const giveRolesService = require('./service');
const guildConfigService = require('../../core/config/guildConfigService');
const { editMessageWithRetry, runDiscordRequest, sendMessageWithRetry } = require('../../core/discord/request');
const logger = require('../../core/logging/logger');
const { getDefaultFooter } = require('../../core/ui/defaultFooter');
const { buildGiveRolesRequestCustomId } = require('./customId');

const ACTIVE_REQUEST_STATUSES = ['creating', 'pending', 'processing', undefined, null];
const CREATING_STALE_MS = 2 * 60 * 1000;
const PENDING_FETCH_GRACE_MS = 30 * 1000;

function validateNickname(nickname) {
    const parts = String(nickname || '').trim().split(/\s+/);
    if (parts.length !== 2) return false;

    return parts.every((part) => /^[A-Z][A-Za-z]*(?:['’\-][A-Z][A-Za-z]*)*$/.test(part));
}

function validateStatic(staticId) {
    if (!staticId) return false;
    if (!/^\d+$/.test(staticId)) return false;
    if (staticId.length < 2 || staticId.length > 10) return false;
    return true;
}

function createRequestId() {
    return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
}

function getRecordAgeMs(record) {
    const timestamp = Number(record?.updatedAt || record?.createdAt || 0);
    if (!timestamp) return Number.MAX_SAFE_INTEGER;
    return Math.max(0, Date.now() - timestamp);
}

function isActiveGiveRolesMessage(message) {
    if (!message) return false;

    const hasButtons = Array.isArray(message.components) && message.components.some((row) => (
        Array.isArray(row.components) && row.components.length > 0
    ));
    const title = String(message.embeds?.[0]?.title || '');
    return hasButtons && title.includes('НА РАССМОТРЕНИИ');
}

async function cleanupBrokenActiveRequest({ guildId, userId, channel }) {
    const existing = await giveRoles.findOne({
        guildId,
        userId,
        status: { $in: ACTIVE_REQUEST_STATUSES },
    });

    if (!existing) return { activeExists: false };

    const status = existing.status || 'pending';
    const ageMs = getRecordAgeMs(existing);

    if (status === 'processing') {
        return { activeExists: true };
    }

    if (status === 'creating') {
        if (ageMs <= CREATING_STALE_MS) return { activeExists: true };

        await giveRoles.deleteOne({ guildId, userId, status: 'creating' });
        return { activeExists: false, cleaned: true };
    }

    if (existing.messageId && channel?.messages?.fetch) {
        let message;
        try {
            message = await channel.messages.fetch(existing.messageId);
        } catch (error) {
            if (Number(error?.code) !== 10_008) {
                logger.warn('Выдача ролей: не удалось проверить существующую заявку в Discord', {
                    guildId,
                    userId,
                    messageId: existing.messageId,
                }, error);
                return { activeExists: true, fetchFailed: true };
            }
            message = null;
        }

        if (isActiveGiveRolesMessage(message)) return { activeExists: true };

        await giveRoles.deleteOne({ guildId, userId, status: existing.status });
        return { activeExists: false, cleaned: true };
    }

    if (ageMs <= PENDING_FETCH_GRACE_MS) return { activeExists: true };

    await giveRoles.deleteOne({ guildId, userId, status: existing.status });
    return { activeExists: false, cleaned: true };
}

function buildRequestComponents(serverConfig, requestId, timestamp = Date.now()) {
    const buttons = [
        new ButtonBuilder()
            .setCustomId(buildGiveRolesRequestCustomId('role-confirm', requestId))
            .setLabel('Одобрить')
            .setStyle(ButtonStyle.Success),
    ];

    if (giveRolesService.shouldShowDbButton(serverConfig, timestamp)) {
        buttons.push(
            new ButtonBuilder()
                .setCustomId(buildGiveRolesRequestCustomId('role-db', requestId))
                .setLabel('Одобрить (ДБ)')
                .setStyle(ButtonStyle.Success)
        );
    }

    buttons.push(
        new ButtonBuilder()
            .setCustomId(buildGiveRolesRequestCustomId('role-decline', requestId))
            .setLabel('Отклонить')
            .setStyle(ButtonStyle.Danger)
    );

    if (giveRolesService.shouldShowBlockButton(serverConfig)) {
        buttons.push(
            new ButtonBuilder()
                .setCustomId(buildGiveRolesRequestCustomId('role-block', requestId))
                .setLabel('Заблокировать')
                .setStyle(ButtonStyle.Danger)
        );
    }

    return [new ActionRowBuilder().addComponents(buttons)];
}

function buildPendingEmbed(userId, nickname, staticId, createdAt = Date.now()) {
    return new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle('Заявка на выдачу ролей - НА РАССМОТРЕНИИ')
        .setDescription(
            `Заявка от <@${userId}>. Discord ID: ${userId}.\n` +
            `Уважаемый сотрудник Weazel News!\n` +
            `Обратите внимание на то как записаны Имя Фамилия и статик персонажа!\n` +
            `Проверьте данные дважды перед тем, как одобрять заявку!\n` +
            `Пользователь оставил следующие данные:`
        )
        .addFields(
            { name: 'Имя Фамилия:', value: nickname },
            { name: 'Статик:', value: staticId }
        )
        .setTimestamp(new Date(Number(createdAt) || Date.now()))
        .setFooter(getDefaultFooter());
}

async function createGiveRolesRequest(client, guildId, userId, nickname, staticId) {
    const serverConfig = guildConfigService.get(guildId);
    if (!serverConfig) return { ok: false, code: 'no_config' };

    if (!validateNickname(nickname)) return { ok: false, code: 'bad_nickname' };
    if (!validateStatic(staticId)) return { ok: false, code: 'bad_static' };

    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return { ok: false, code: 'no_guild' };

    const configurationErrors = giveRolesService.getRequestSubmissionErrors(guild, serverConfig);
    if (configurationErrors.length) {
        logger.warn('Выдача ролей: отправка заявки невозможна из-за настроек', {
            guildId,
            userId,
            errors: configurationErrors,
        });
        return {
            ok: false,
            code: 'config_error',
            errors: configurationErrors,
        };
    }

    const query = { guildId, userId };
    const blacklisted = await blackListGiveRoles.findOne(query);
    if (blacklisted) return { ok: false, code: 'blacklist' };

    const channel = await client.channels.fetch(serverConfig.channels?.confirmRoleChannelId).catch(() => null);
    if (!channel?.messages || typeof channel.send !== 'function') {
        return { ok: false, code: 'no_channel' };
    }

    const cleanup = await cleanupBrokenActiveRequest({ guildId, userId, channel });
    if (cleanup.activeExists) return { ok: false, code: 'exists' };

    const now = Date.now();
    const requestId = createRequestId();
    const reservation = await giveRoles.insertOneIfAbsent(
        {
            guildId,
            userId,
            status: { $in: ACTIVE_REQUEST_STATUSES },
        },
        {
            guildId,
            messageId: null,
            requestId,
            userId,
            nickname,
            static: staticId,
            status: 'creating',
            createdAt: now,
            updatedAt: now,
        }
    );

    if (!reservation.inserted) return { ok: false, code: 'exists' };

    let sentMessage = null;
    try {
        sentMessage = await sendMessageWithRetry(channel, {
            embeds: [buildPendingEmbed(userId, nickname, staticId, now)],
            components: buildRequestComponents(serverConfig, requestId),
            allowedMentions: { parse: [] },
        }, {
            nonceSeed: `giveRoles:${guildId}:${userId}:${requestId}`,
        });

        if (!sentMessage?.id) {
            throw new Error('Discord не вернул ID сообщения заявки');
        }

        const updated = await giveRoles.updateOne(
            { guildId, userId, status: 'creating', requestId },
            {
                messageId: sentMessage.id,
                status: 'pending',
                updatedAt: Date.now(),
            }
        );

        if (!updated.matchedCount) {
            throw new Error('Не удалось сохранить messageId заявки после отправки сообщения');
        }

        return { ok: true, code: 'success', requestId, messageId: sentMessage.id };
    } catch (error) {
        await giveRoles.deleteOne({ guildId, userId, status: 'creating', requestId }).catch(() => undefined);

        if (sentMessage?.delete) {
            await runDiscordRequest(() => sentMessage.delete()).catch((deleteError) => {
                logger.warn('Выдача ролей: не удалось удалить сообщение несохранённой заявки', {
                    guildId,
                    userId,
                    messageId: sentMessage.id,
                }, deleteError);
            });
        }

        throw error;
    }
}


async function closeMemberRequests(client, guildId, memberId) {
    const records = await giveRoles.find({ guildId: String(guildId), userId: String(memberId) });
    for (const record of records) {
        if (record.messageId && record.channelId) {
            const channel = await client.channels.fetch(record.channelId).catch(() => null);
            const message = await channel?.messages?.fetch?.(record.messageId).catch(() => null);
            if (message) {
                await editMessageWithRetry(message, {
                    components: [],
                    allowedMentions: { parse: [] },
                }).catch(() => undefined);
            }
        }
        const query = record.requestId
            ? { requestId: record.requestId }
            : { guildId: String(guildId), userId: String(memberId) };
        await giveRoles.deleteOne(query);
    }
    return records.length;
}

module.exports = {
    buildRequestComponents,
    closeMemberRequests,
    createGiveRolesRequest,
    validateNickname,
    validateStatic,
};
