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

const config = require('../../config.json');
const giveRoles = require('../models/giveRoles');
const blackListGiveRoles = require('../models/blackListGiveRoles');
const logger = require('./logger');

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

async function createGiveRolesRequest(client, guildId, userId, nickname, staticId, inviteUserId) {
	const serverCfg = config.servers[guildId];
	if (!serverCfg) return { ok: false, code: 'no_config' };

	if (!validateNickname(nickname)) return { ok: false, code: 'bad_nickname' };
	if (!validateStatic(staticId)) return { ok: false, code: 'bad_static' };

	const query = { guildId, userId };

	const ifBlackListGiveRoles = await blackListGiveRoles.findOne(query);
	if (ifBlackListGiveRoles) return { ok: false, code: 'blacklist' };

	const ifGiveRoles = await giveRoles.findOne(query);
	if (ifGiveRoles) {
		return {
			ok: false,
			code: 'exists',
			inviteUserId: ifGiveRoles.invite_nick,
		};
	}

	const confirmChannelId = serverCfg.confirmRoleChannelId;
	const channel = await client.channels.fetch(confirmChannelId).catch(() => null);
	if (!channel) return { ok: false, code: 'no_channel' };

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

	const inviteMention = `<@${inviteUserId}>`;

	const sentMessage = await channel.send({
		content: inviteMention,
		embeds: [embed],
		components: [row],
	});

	const messageId = sentMessage.id;

	const newGiveRoles = new giveRoles({
		guildId,
		messageId,
		userId,
		nickname,
		static: staticId,
		invite_nick: inviteUserId,
	});

	await newGiveRoles.save();

	return { ok: true, code: 'success', inviteUserId };
}

module.exports.createGiveRolesRequest = createGiveRolesRequest;
module.exports.validateNickname = validateNickname;
module.exports.validateStatic = validateStatic;