/*
 * WN Helper Discord Bot
 * Copyright (C) 2024 MilkGames
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
	EmbedBuilder,
	ButtonBuilder,
	ActionRowBuilder,
	ButtonStyle,
} = require('discord.js');

const crypto = require('crypto');

const config = require('../../config.json');
const giveRoles = require('../models/giveRoles');
const blackListGiveRoles = require('../models/blackListGiveRoles');
const { sendMessageWithRetry } = require('./discordRequest');

function validateNickname(nickname) {
	if (!nickname) return false;
	if (nickname.includes('_')) return false;
	if (!nickname.includes(' ')) return false;
	return true;
}

function validateStatic(staticId) {
	if (!staticId) return false;
	if (!/^\d+$/.test(staticId)) return false;
	if (staticId.length < 2 || staticId.length > 10) return false;
	return true;
}

const ACTIVE_REQUEST_STATUSES = ['creating', 'pending', 'processing', undefined, null];
const CREATING_STALE_MS = 2 * 60 * 1000;
const PENDING_FETCH_GRACE_MS = 30 * 1000;

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

	const hasButtons = Array.isArray(message.components) && message.components.some((row) => {
		return Array.isArray(row.components) && row.components.length > 0;
	});

	const title = String(message.embeds?.[0]?.title || '');
	return hasButtons && title.includes('НА РАССМОТРЕНИИ');
}

async function cleanupBrokenActiveRequest({ guildId, userId, channel }) {
	const existing = await giveRoles.findOne({
		guildId,
		userId,
		status: { $in: ACTIVE_REQUEST_STATUSES },
	});

	if (!existing) {
		return { activeExists: false };
	}

	const status = existing.status || 'pending';
	const ageMs = getRecordAgeMs(existing);

	if (status === 'processing') {
		return { activeExists: true };
	}

	if (status === 'creating') {
		if (ageMs <= CREATING_STALE_MS) {
			return { activeExists: true };
		}

		await giveRoles.deleteOne({ guildId, userId, status: 'creating' });
		return { activeExists: false, cleaned: true };
	}

	if (existing.messageId && channel && typeof channel.messages?.fetch === 'function') {
		const message = await channel.messages.fetch(existing.messageId).catch(() => null);
		if (isActiveGiveRolesMessage(message)) {
			return { activeExists: true };
		}

		await giveRoles.deleteOne({ guildId, userId, status: existing.status });
		return { activeExists: false, cleaned: true };
	}

	if (ageMs <= PENDING_FETCH_GRACE_MS) {
		return { activeExists: true };
	}

	await giveRoles.deleteOne({ guildId, userId, status: existing.status });
	return { activeExists: false, cleaned: true };
}

async function createGiveRolesRequest(client, guildId, userId, nickname, staticId) {
	const serverCfg = config.servers[guildId];
	if (!serverCfg) return { ok: false, code: 'no_config' };

	if (!validateNickname(nickname)) return { ok: false, code: 'bad_nickname' };
	if (!validateStatic(staticId)) return { ok: false, code: 'bad_static' };

	const query = { guildId, userId };

	const ifBlackListGiveRoles = await blackListGiveRoles.findOne(query);
	if (ifBlackListGiveRoles) return { ok: false, code: 'blacklist' };

	const confirmChannelId = serverCfg.confirmRoleChannelId;
	const channel = await client.channels.fetch(confirmChannelId).catch(() => null);
	if (!channel) {
		return { ok: false, code: 'no_channel' };
	}

	const cleanup = await cleanupBrokenActiveRequest({ guildId, userId, channel });
	if (cleanup.activeExists) {
		return {
			ok: false,
			code: 'exists',
		};
	}

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

	if (!reservation.inserted) {
		return {
			ok: false,
			code: 'exists',
		};
	}

	try {

		const userPing = await client.users.fetch(userId).catch(() => null);
		const userMention = userPing ? `${userPing}` : `<@${userId}>`;

		const embed = new EmbedBuilder()
			.setColor(0x3498DB)
			.setTitle('Заявка на выдачу ролей - НА РАССМОТРЕНИИ')
			.setDescription(
				`Заявка от ${userMention}. Discord ID: ${userId}.\n` +
				`Уважаемый сотрудник Weazel News!\n` +
				`Обратите внимание на то как записаны Имя Фамилия и статик персонажа!\n` +
				`Проверьте данные дважды перед тем, как одобрять заявку!\n` +
				`Пользователь оставил следующие данные:`
			)
			.addFields(
				{ name: 'Имя Фамилия:', value: nickname },
				{ name: 'Статик:', value: staticId },
			)
			.setTimestamp()
			.setFooter({ text: 'WN Helper by Michael Lindberg. Discord: milkgames', iconURL: 'https://i.imgur.com/zdxWb0s.jpeg' });

		const row = new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId('role-confirm')
				.setLabel('Одобрить')
				.setStyle(ButtonStyle.Success),
			new ButtonBuilder()
				.setCustomId('role-db')
				.setLabel('Одобрить (ДБ)')
				.setStyle(ButtonStyle.Success),
			new ButtonBuilder()
				.setCustomId('role-decline')
				.setLabel('Отклонить')
				.setStyle(ButtonStyle.Danger),
			new ButtonBuilder()
				.setCustomId('role-block')
				.setLabel('Заблокировать')
				.setStyle(ButtonStyle.Danger),
		);

		const sentMessage = await sendMessageWithRetry(channel, {
			embeds: [embed],
			components: [row],
		}, {
			nonceSeed: `giveRoles:${guildId}:${userId}:${requestId}`,
		});

		if (!sentMessage || !sentMessage.id) {
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

		return { ok: true, code: 'success' };
	} catch (error) {
		await giveRoles.deleteOne({ guildId, userId, status: 'creating', requestId }).catch(() => {});
		throw error;
	}
}

module.exports.createGiveRolesRequest = createGiveRolesRequest;
module.exports.validateNickname = validateNickname;
module.exports.validateStatic = validateStatic;
