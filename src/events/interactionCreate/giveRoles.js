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
	ActionRowBuilder,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle,
} = require('discord.js');

const giveRoles = require('../../models/giveRoles');
const blackListGiveRoles = require('../../models/blackListGiveRoles');
const giveRolesRequest = require('../../utils/giveRolesRequest');
const {
	deferReplyWithRetry,
	deleteReplyWithRetry,
	editMessageWithRetry,
	editReplyWithRetry,
	runDiscordRequest,
	sendMessageWithRetry,
	showModalWithRetry,
} = require('../../utils/discordRequest');
const inviteCommand = require('../../commands/wn/ka/invite');
const config = require('../../../config.json');

const logger = require('../../utils/logger');

async function replyTemp(interaction, content) {
	await editReplyWithRetry(interaction, { content, ephemeral: true });

	setTimeout(async () => {
		try {
			await deleteReplyWithRetry(interaction);
		} catch (error) {
			logger.info(`Не удалось удалить ответ: ${error}`);
		}
	}, 30000);
}

function buildGiveRolesModal() {
	const modal = new ModalBuilder()
		.setCustomId('gr-submit-modal')
		.setTitle('Заявка на выдачу ролей');

	const nicknameInput = new TextInputBuilder()
		.setCustomId('gr-nickname')
		.setLabel('Имя Фамилия')
		.setStyle(TextInputStyle.Short)
		.setPlaceholder('Michael Lindberg')
		.setRequired(true)
		.setMaxLength(64);

	const staticInput = new TextInputBuilder()
		.setCustomId('gr-static')
		.setLabel('Статик')
		.setStyle(TextInputStyle.Short)
		.setPlaceholder('7658')
		.setRequired(true)
		.setMaxLength(10);

	modal.addComponents(
		new ActionRowBuilder().addComponents(nicknameInput),
		new ActionRowBuilder().addComponents(staticInput),
	);

	return modal;
}

async function safeDm(member, text) {
	try {
		await sendMessageWithRetry(member, { content: text }, {
			nonceSeed: `dm:${member?.id || 'unknown'}:${text}`,
		});
	} catch (error) {
		logger.info(`Не удалось отправить ЛС пользователю ${member?.id || member}: ${error}`);
	}
}


async function lockGiveRolesRequest(query, confirmUserId, action) {
	const result = await giveRoles.updateOne(
		{
			...query,
			status: { $in: ['pending', undefined, null] },
		},
		{
			status: 'processing',
			processingBy: confirmUserId,
			processingAction: action,
			processingStartedAt: Date.now(),
			updatedAt: Date.now(),
		}
	);

	return result.matchedCount > 0;
}

async function finishGiveRolesRequest(query) {
	try {
		await giveRoles.deleteOne({ ...query, status: 'processing' });
	} catch (error) {
		logger.error(`giveRoles: заявка обработана, но не удалось удалить запись из localdb: ${error}`);
	}
}

module.exports = async (client, interaction) => {
	// Кнопка "открыть модал"
	if (interaction.isButton() && interaction.customId === 'gr-open-modal') {
		try {
			if (!interaction.inGuild()) return;

			const modal = buildGiveRolesModal();
			await showModalWithRetry(interaction, modal);
		} catch (error) {
			logger.info(`Не удалось открыть модал выдачи ролей: ${error}`);
		}
		return;
	}

	// отправка модала (создание заявки)
	if (interaction.isModalSubmit() && interaction.customId === 'gr-submit-modal') {
		try {
			await deferReplyWithRetry(interaction, { ephemeral: true });

			const guildId = interaction.guildId;
			const serverCfg = config.servers[guildId];
			if (!serverCfg) {
				await replyTemp(interaction, 'Для этого сервера нет настроек в config.json.');
				return;
			}

			const nickname = interaction.fields.getTextInputValue('gr-nickname')?.trim();
			const staticId = interaction.fields.getTextInputValue('gr-static')?.trim();

			if (!giveRolesRequest.validateNickname(nickname)) {
				await replyTemp(
					interaction,
					'Вы не использовали пробел или использовали знак _ в никнейме.\nУкажите корректный ник, который отображается у вас в игре.\n-# Сообщение удалится через 30 секунд.'
				);
				return;
			}

			if (!giveRolesRequest.validateStatic(staticId)) {
				await replyTemp(
					interaction,
					'Статик указан некорректно. Допустимы только цифры.\n-# Сообщение удалится через 30 секунд.'
				);
				return;
			}

			const userId = interaction.user.id;

			const result = await giveRolesRequest.createGiveRolesRequest(
				client,
				guildId,
				userId,
				nickname,
				staticId
			);

			if (!result.ok) {
				if (result.code === 'blacklist') {
					await replyTemp(
						interaction,
						'Действие невозможно. Вы попали в чёрный список выдачи ролей.\n-# Сообщение удалится через 30 секунд.'
					);
					return;
				}
				if (result.code === 'exists') {
					await replyTemp(
						interaction,
						`<@${userId}>, вы уже отправляли заявку!\nОжидайте, пока сотрудник её рассмотрит.\nВы получите оповещение как только получите роли.\n-# Сообщение удалится через 30 секунд.`
					);
					return;
				}
				if (result.code === 'no_channel') {
					await replyTemp(interaction, 'Не удалось найти канал для заявок. Проверьте настройки сервера.');
					return;
				}

				await replyTemp(interaction, `Не удалось отправить заявку. Код ошибки: ${result.code}`);
				return;
			}

			await replyTemp(
				interaction,
				`Спасибо, <@${userId}>, ваша заявка принята!\nОжидайте, пока сотрудник её рассмотрит.\nВы получите оповещение как только получите роли.\n-# Сообщение удалится через 30 секунд.`
			);
		} catch (error) {
			logger.info(`Произошла ошибка при отправке заявки через модал: ${error}`);
			try {
				if (interaction.deferred || interaction.replied) {
					await editReplyWithRetry(interaction, {
						content: `Произошла ошибка при отправке заявки: ${error}`,
						ephemeral: true,
					});
				}
			} catch (_) {
				// noop
			}
		}
		return;
	}

	// кнопки обработки заявки (одобрить/отклонить/блок)
	if (!interaction.isButton()) return;

	if (!(interaction.customId === 'role-confirm' ||
		interaction.customId === 'role-db' ||
		interaction.customId === 'role-decline' ||
		interaction.customId === 'role-block')) {
		return;
	}

	try {
		await deferReplyWithRetry(interaction, { ephemeral: true });

		const guildId = interaction.guildId;
		const serverCfg = config.servers[guildId];
		if (!serverCfg) {
			await replyTemp(interaction, 'Для этого сервера нет настроек в config.json.');
			return;
		}

		const guild = await client.guilds.fetch(guildId);

		const confirmChannel = await client.channels.fetch(serverCfg.confirmRoleChannelId).catch(() => null);
		const kaChannel = await client.channels.fetch(serverCfg.kaChannelId).catch(() => null);

		const messageId = interaction.message.id;

		const query = {
			guildId,
			messageId,
		};

		const giveRolesList = await giveRoles.findOne(query);
		if (!giveRolesList) {
			// заявка уже обработана/удалена
			try {
				await editMessageWithRetry(interaction.message, { components: [] });
			} catch (_) {
				// noop
			}
			await replyTemp(interaction, 'Заявка уже обработана или не найдена.\n-# Сообщение удалится через 30 секунд.');
			return;
		}

		const requestStatus = giveRolesList.status || 'pending';
		if (requestStatus !== 'pending') {
			await replyTemp(interaction, 'Заявка уже обрабатывается или была обработана другим сотрудником.\n-# Сообщение удалится через 30 секунд.');
			return;
		}

		const nickname = giveRolesList.nickname;
		const staticId = giveRolesList.static;
		const userId = giveRolesList.userId;

		const confirmUserId = interaction.user.id;
		const confirmMember = await guild.members.fetch(confirmUserId).catch(() => null);
		if (!confirmMember) {
			await replyTemp(interaction, 'Не удалось определить ваши роли на сервере.\n-# Сообщение удалится через 30 секунд.');
			return;
		}

		const leaderRoleId = serverCfg.leaderRoleId;
		const depLeaderRoleId = serverCfg.depLeaderRoleId;
		const RDDRoleId = serverCfg.RDDRoleId;
		const partWorkRDDRoleId = serverCfg.partWorkRDDRoleId;

		const hasRole = (roleId) => Boolean(roleId) && confirmMember.roles.cache.has(roleId);

		const isLeader = hasRole(leaderRoleId) || hasRole(depLeaderRoleId);
		const isRdd = hasRole(RDDRoleId) || hasRole(partWorkRDDRoleId);

		const isDev = Array.isArray(config.devs) && config.devs.includes(confirmUserId);

		// пытаемся получить сообщение из канала заявок (если получилось), иначе используем interaction.message
		let message = interaction.message;
		if (confirmChannel && typeof confirmChannel.messages?.fetch === 'function') {
			message = await confirmChannel.messages.fetch(messageId).catch(() => interaction.message);
		}

		const userMention = `<@${userId}>`;
		const confirmMention = `<@${confirmUserId}>`;

		const preNickName = `TD | ${nickname} | ${staticId}`;

		let member = await guild.members.fetch(userId).catch(() => null);

		const weazelNewsRoleId = serverCfg.weazelNewsRoleId;
		const traineeRoleId = serverCfg.traineeRoleId;
		const firstRankRoleId = serverCfg.firstRankRoleId;
		const thirdRankRoleId = serverCfg.thirdRankRoleId;
		const retestingRoleId = serverCfg.retestingRoleId;
		const citizenRoleId = serverCfg.citizenRoleId;

		// права на обработку заявки (кроме блокировки): только лидер/деп и RDD
		const canReview = isLeader || isRdd;
		const canApprove = canReview;
		const canDecline = canReview;
		const canBlock = isLeader || isDev;

		if (interaction.customId === 'role-confirm' || interaction.customId === 'role-db') {
			if (!canApprove) {
				await replyTemp(
					interaction,
					`${confirmMember}, у вас нет доступа к этой кнопке.\n-# Сообщение удалится через 30 секунд.`
				);
				return;
			}

			const locked = await lockGiveRolesRequest(query, confirmUserId, interaction.customId);
			if (!locked) {
				await replyTemp(interaction, 'Заявка уже обрабатывается или была обработана другим сотрудником.\n-# Сообщение удалится через 30 секунд.');
				return;
			}

			const editedEmbed = new EmbedBuilder()
				.setColor(0x008000)
				.setTitle('Заявка на выдачу ролей - ОДОБРЕНА')
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

			await editMessageWithRetry(message, { embeds: [editedEmbed], components: [] });

			let rank;
			let reason;

			if (interaction.customId === 'role-confirm') {
				rank = '1';
				reason = 'Собеседование';
			} else {
				rank = '3';
				reason = 'ДБ';
			}

			// запись в КА теперь через invite.js
			if (kaChannel) {
				const inviterMember = confirmMember;
				if (!inviterMember) {
					logger.error(`giveRoles: не удалось получить пригласившего ${confirmUserId} для записи принятия в КА`);
				} else {
					const ok = await inviteCommand.sendKaInviteRecord(client, {
						guildId,
						kaChannel,
						inviterId: confirmUserId,
						inviterDisplayName: inviterMember.displayName,
						acceptedId: userId,
						acceptedDisplayName: preNickName,
						staticId,
						rank,
						reason,
					});

					if (!ok) {
						logger.error(`giveRoles: не удалось отправить запись принятия в КА (userId=${userId}, inviterId=${confirmUserId})`);
					}
				}
			}

			// даже если пользователя уже нет на сервере - заявка считается обработанной, просто пропускаем выдачу ролей/ЛС
			if (member) {
				const roleIds = [weazelNewsRoleId];

				if (interaction.customId === 'role-confirm') {
					roleIds.push(firstRankRoleId, traineeRoleId);
				}

				if (interaction.customId === 'role-db') {
					roleIds.push(retestingRoleId, thirdRankRoleId, traineeRoleId);
				}

				for (const roleId of roleIds) {
					const role = guild.roles.cache.get(roleId);
					if (role) {
						await runDiscordRequest(() => member.roles.add(role));
					} else {
						logger.error(`Не удалось найти роль ${roleId} на сервере ${guildId}.`);
					}
				}

				if (citizenRoleId && member.roles.cache.has(citizenRoleId)) {
					await runDiscordRequest(() => member.roles.remove(citizenRoleId));
				}

				let newNickName = preNickName;

				if (preNickName.length > 32) {
					for (let i = 0; i < nickname.length; i++) {
						if (nickname[i] === ' ') {
							newNickName = `TD | ${nickname.slice(0, i + 2)}. | ${staticId}`;
							break;
						}
					}
				}

				try {
					await runDiscordRequest(() => member.setNickname(`${newNickName}`));
				} catch (error) {
					logger.error(`Не удалось изменить ник пользователю ${userId}: ${error}`);
				}

				await safeDm(member, `${userMention}, ${confirmMention} одобрил вашу заявку!\nДобро пожаловать в Weazel News!`);
			}

			await finishGiveRolesRequest(query);
			await replyTemp(interaction, `Заявка ${userMention} одобрена.\n-# Сообщение удалится через 30 секунд.`);
			return;
		}

		if (interaction.customId === 'role-decline') {
			if (!canDecline) {
				await replyTemp(
					interaction,
					`${confirmMember}, у вас нет доступа к этой кнопке.\n-# Сообщение удалится через 30 секунд.`
				);
				return;
			}

			const locked = await lockGiveRolesRequest(query, confirmUserId, interaction.customId);
			if (!locked) {
				await replyTemp(interaction, 'Заявка уже обрабатывается или была обработана другим сотрудником.\n-# Сообщение удалится через 30 секунд.');
				return;
			}

			const editedEmbed = new EmbedBuilder()
				.setColor(0xFF2C2C)
				.setTitle('Заявка на выдачу ролей - ОТКЛОНЕНА')
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

			await editMessageWithRetry(message, { embeds: [editedEmbed], components: [] });

			if (member) {
				await safeDm(
					member,
					`${userMention}, к сожалению, ${confirmMention} отклонил вашу заявку.\nСвяжитесь с сотрудником, чтобы выяснить причину.`
				);
			}

			await finishGiveRolesRequest(query);
			await replyTemp(interaction, `Заявка ${userMention} отклонена.\n-# Сообщение удалится через 30 секунд.`);
			return;
		}

		if (interaction.customId === 'role-block') {
			if (!canBlock) {
				await replyTemp(
					interaction,
					`${confirmMember}, вы не являетесь лидером фракции для того, чтобы заблокировать пользователя!\n-# Сообщение удалится через 30 секунд.`
				);
				return;
			}

			const locked = await lockGiveRolesRequest(query, confirmUserId, interaction.customId);
			if (!locked) {
				await replyTemp(interaction, 'Заявка уже обрабатывается или была обработана другим сотрудником.\n-# Сообщение удалится через 30 секунд.');
				return;
			}

			const blQuery = { guildId, userId };
			await blackListGiveRoles.insertOneIfAbsent(blQuery, { guildId, userId, createdAt: Date.now() });

			const editedEmbed = new EmbedBuilder()
				.setColor(0xFF2C2C)
				.setTitle('Заявка на выдачу ролей - ПОЛЬЗОВАТЕЛЬ ЗАБЛОКИРОВАН')
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

			await editMessageWithRetry(message, { embeds: [editedEmbed], components: [] });

			if (member) {
				await safeDm(member, `${userMention}, вы были заблокированы за злоупотребление функционалом бота!`);
			}

			await finishGiveRolesRequest(query);
			await replyTemp(interaction, `Пользователь ${userMention} успешно заблокирован!\n-# Сообщение удалится через 30 секунд.`);
			return;
		}
	} catch (error) {
		logger.info(`Произошла ошибка при нажатии на кнопку, связанную с выдачей ролей: ${error}`);
		try {
			if (interaction.deferred || interaction.replied) {
				await editReplyWithRetry(interaction, {
					content: `Произошла ошибка при обработке заявки: ${error}`,
					ephemeral: true,
				});
			}
		} catch (_) {
			// noop
		}
	}
};
