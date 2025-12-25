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
const config = require('../../../../config.json');
const { ApplicationCommandOptionType, PermissionFlagsBits, EmbedBuilder } = require('discord.js');

const logger = require('../../../utils/logger');

async function editReply(type, interaction, member, kachannel) {
	let content;

	switch (type) {
		case 1:
			content = `Вы указали пользователя на которого хотите отписать инвайт не пингом.
Укажите переменную "static" для того, чтобы команда сработала.
-# Сообщение удалится через 30 секунд.`;
			break;

		case 2:
			content = `Невозможно определить статик.
Укажите переменную "static" для того, чтобы команда сработала.
-# Сообщение удалится через 30 секунд.`;
			break;

		case 3:
			content = `Отпись кадрового аудита на принятие ${member} успешно создана в канале ${kachannel}!
-# Сообщение удалится через 30 секунд.`;
			break;

		default:
			content = `Готово.
-# Сообщение удалится через 30 секунд.`;
			break;
	}

	await interaction.editReply({
		content,
		ephemeral: true,
	});

	setTimeout(async () => {
		try {
			await interaction.deleteReply();
		} catch (error) {
			logger.info(`Не удалось удалить ответ: ${error}`);
		}
	}, 30000);
}

async function resolveMemberDisplayName(guild, userId) {
	try {
		const m = await guild.members.fetch(userId);
		return {
			mention: `${m}`,
			displayName: m.displayName,
		};
	} catch (_) {
		return null;
	}
}

async function sendKaInviteRecord(client, params) {
	try {
		const guildId = params.guildId;
		const serverCfg = config.servers[guildId];
		if (!serverCfg) {
			logger.info(`invite.js: нет настроек сервера ${guildId} в config.json`);
			return false;
		}

		const guild = await client.guilds.fetch(guildId);

		const kachannel = params.kaChannel
			? params.kaChannel
			: await client.channels.fetch(serverCfg.kaChannelId).catch(() => null);

		if (!kachannel) {
			logger.info(`invite.js: не удалось получить канал КА для сервера ${guildId}`);
			return false;
		}

		const inviterId = String(params.inviterId || '').trim();
		const acceptedId = params.acceptedId != null ? String(params.acceptedId).trim() : null;
		const acceptedText = params.acceptedText != null ? String(params.acceptedText) : null;

		const staticId = params.staticId != null ? String(params.staticId) : null;
		const rank = params.rank != null ? String(params.rank) : null;
		const reason = params.reason != null ? String(params.reason) : null;

		if (!inviterId) {
			logger.info('invite.js: inviterId не задан, запись КА не отправлена');
			return false;
		}
		if (!staticId || !rank || !reason) {
			logger.info('invite.js: не заданы обязательные поля (staticId/rank/reason), запись КА не отправлена');
			return false;
		}
		if (!acceptedId && !acceptedText) {
			logger.info('invite.js: не задан acceptedId/acceptedText, запись КА не отправлена');
			return false;
		}

		let inviterMention = `<@${inviterId}>`;
		let inviterDisplayName = params.inviterDisplayName ?? null;

		if (!inviterDisplayName) {
			const resolvedInviter = await resolveMemberDisplayName(guild, inviterId);
			if (!resolvedInviter) {
				logger.info(`invite.js: не удалось получить ник пригласившего (inviterId=${inviterId}), запись КА не отправлена`);
				return false;
			}
			inviterMention = resolvedInviter.mention;
			inviterDisplayName = resolvedInviter.displayName;
		}

		let acceptedMention = null;
		let acceptedDisplayName = params.acceptedDisplayName ?? null;

		if (acceptedId) {
			acceptedMention = `<@${acceptedId}>`;

			if (!acceptedDisplayName) {
				const resolvedAccepted = await resolveMemberDisplayName(guild, acceptedId);
				if (!resolvedAccepted) {
					logger.info(`invite.js: не удалось получить ник принятого (acceptedId=${acceptedId}), запись КА не отправлена`);
					return false;
				}
				acceptedMention = resolvedAccepted.mention;
				acceptedDisplayName = resolvedAccepted.displayName;
			}
		}

		const inviteEmbed = new EmbedBuilder()
			.setColor(0x3498DB)
			.setTitle('Кадровый аудит • Принятие')
			.addFields(
				{ name: 'Принял(-а):', value: `${inviterMention} | ${inviterDisplayName} | ||${inviterId}||` },
			)
			.setTimestamp()
			.setFooter({ text: 'WN Helper by Michael Lindberg. Discord: milkgames', iconURL: 'https://i.imgur.com/zdxWb0s.jpeg' });

		if (acceptedId) {
			inviteEmbed.addFields(
				{ name: 'Принят(-а):', value: `${acceptedMention} | ${acceptedDisplayName} | ||${acceptedId}||` },
			);
		} else {
			inviteEmbed.addFields(
				{ name: 'Принят(-а):', value: `${acceptedText}` },
			);
		}

		inviteEmbed.addFields(
			{ name: 'Номер ID карты:', value: `${staticId}`, inline: true },
			{ name: 'Действие:', value: `Принят на ${rank}`, inline: true },
			{ name: 'Причина:', value: `${reason}` },
		);

		await kachannel.send({ embeds: [inviteEmbed] });
		return true;
	} catch (error) {
		logger.info(`invite.js: ошибка при отправке записи принятия в КА: ${error}`);
		return false;
	}
}

module.exports = {
	name: 'invite',
	description: 'Принять игрока во фракцию.',
	options: [
		{
			name: 'member',
			description: 'Игрок, которого приняли во фракцию.',
			required: true,
			type: ApplicationCommandOptionType.String,
		},
		{
			name: 'static',
			description: 'Статик игрока, которого приняли во фракцию.',
			type: ApplicationCommandOptionType.String,
		},
		{
			name: 'rank',
			description: 'Ранг, на который принимают игрока.',
			type: ApplicationCommandOptionType.String,
		},
		{
			name: 'reason',
			description: 'Причина, по которой человека приняли.',
			type: ApplicationCommandOptionType.String,
		},
	],
	permissionsRequired: [],
	botPermissions: [PermissionFlagsBits.ManageRoles],

	// Хелпер для других модулей
	sendKaInviteRecord,

	callback: async (client, interaction) => {
		try {
			await interaction.deferReply({ ephemeral: true });

			const guildId = interaction.guildId;
			const guild = await client.guilds.fetch(guildId);

			const userId = interaction.user.id;
			const userPing = await guild.members.fetch(userId);
			const userNick = userPing.displayName;

			const testmember = interaction.options.getString('member', true);
			const memberId = testmember.replace(/[<@!>]/g, '');

			const kachannel = await client.channels.fetch(config.servers[guildId].kaChannelId);

			let memberNick;
			let member;
			let staticId;

			if (testmember === memberId) {
				member = testmember;
				staticId = interaction.options.getString('static') ?? null;
				memberNick = null;

				if (!staticId) {
					await editReply(1, interaction, member, kachannel);
					return;
				}
			} else {
				member = await guild.members.fetch(memberId);
				memberNick = member.displayName;

				const match = memberNick.match(/(\d+)$/);
				if (match) {
					staticId = match[1];
				} else {
					staticId = interaction.options.getString('static') ?? null;
					if (!staticId) {
						await editReply(2, interaction, member, kachannel);
						return;
					}
				}
			}

			const rank = interaction.options.getString('rank') ?? '1';
			const reason = interaction.options.getString('reason') ?? 'Собеседование';

			let ok;
			if (memberNick) {
				ok = await sendKaInviteRecord(client, {
					guildId,
					kaChannel: kachannel,
					inviterId: userId,
					inviterDisplayName: userNick,
					acceptedId: memberId,
					acceptedDisplayName: memberNick,
					staticId,
					rank,
					reason,
				});
			} else {
				ok = await sendKaInviteRecord(client, {
					guildId,
					kaChannel: kachannel,
					inviterId: userId,
					inviterDisplayName: userNick,
					acceptedText: member,
					staticId,
					rank,
					reason,
				});
			}

			if (!ok) {
				await interaction.editReply({
					content: 'Не удалось отправить запись в кадровый аудит (проверьте доступы/данные).',
					ephemeral: true,
				});
				return;
			}

			if (kachannel?.id === interaction.channelId) {
				await interaction.editReply({ content: 'Meow!', ephemeral: true });
				await interaction.deleteReply();
			} else {
				await editReply(3, interaction, member, kachannel);
			}
		} catch (error) {
			logger.info(`Произошла ошибка отписи инвайта в КА: ${error}`);

			try {
				if (interaction.deferred || interaction.replied) {
					await interaction.editReply({
						content: `Произошла ошибка отписи инвайта в КА: ${error}`,
						ephemeral: true,
					});
				} else {
					await interaction.reply({
						content: `Произошла ошибка отписи инвайта в КА: ${error}`,
						ephemeral: true,
					});
				}
			} catch (_) {
				// noop
			}
		}
	},
};
