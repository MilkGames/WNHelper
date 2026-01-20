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
const inviteCommand = require('../../commands/wn/ka/invite');
const config = require('../../../config.json');

const logger = require('../../utils/logger');

function extractDiscordId(text) {
	if (!text) return null;
	const m = String(text).match(/(\d{17,20})/);
	return m ? m[1] : null;
}

async function resolveMemberFromInviteField(guild, raw) {
	const trimmed = String(raw || '').trim();
	if (!trimmed) return { member: null };

	// Ищем сначала по Discord ID
	const id = extractDiscordId(trimmed);
	if (id) {
		const m = await guild.members.fetch(id).catch(() => null);
		return { member: m };
	}

	// Потом по @username / username / username#0000
	let q = trimmed.replace(/^@/, '').trim();
	if (!q) return { member: null };

	// На всякий случай отрежем дискриминатор, если кто-то ввёл старый формат
	if (q.includes('#')) q = q.split('#')[0].trim();
	if (!q) return { member: null };

	const qLower = q.toLowerCase();

	// Если есть кеш, ищем через него
	let cached =
		guild.members.cache.find((m) => m.user?.username?.toLowerCase() === qLower) ||
		guild.members.cache.find((m) => (m.displayName || '').toLowerCase() === qLower);

	if (cached) return { member: cached };

	// Теперь уже ищем через API
	const fetched = await guild.members.fetch({ query: q, limit: 10 }).catch(() => null);
	if (!fetched || fetched.size === 0) return { member: null };

	const exact =
		fetched.find((m) => m.user?.username?.toLowerCase() === qLower) ||
		fetched.find((m) => (m.displayName || '').toLowerCase() === qLower);

	if (exact) return { member: exact };

	if (fetched.size === 1) return { member: fetched.first() };

	return {
		member: null,
		ambiguous: true,
		candidates: fetched.map((m) => `@${m.user.username}`).slice(0, 5),
	};
}

async function replyTemp(interaction, content) {
	await interaction.editReply({ content, ephemeral: true });

	setTimeout(async () => {
		try {
			await interaction.deleteReply();
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

	const inviteInput = new TextInputBuilder()
		.setCustomId('gr-invite')
		.setLabel('Кто принимал (тег или ID)')
		.setStyle(TextInputStyle.Short)
		.setPlaceholder('@username или 123456789012345678')
		.setRequired(true)
		.setMaxLength(128);

	modal.addComponents(
		new ActionRowBuilder().addComponents(nicknameInput),
		new ActionRowBuilder().addComponents(staticInput),
		new ActionRowBuilder().addComponents(inviteInput),
	);

	return modal;
}

async function safeDm(member, text) {
	try {
		await member.send(text);
	} catch (error) {
		logger.info(`Не удалось отправить ЛС пользователю ${member?.id || member}: ${error}`);
	}
}

module.exports = async (client, interaction) => {
	// Кнопка "открыть модал"
	if (interaction.isButton() && interaction.customId === 'gr-open-modal') {
		try {
			if (!interaction.inGuild()) return;

			const modal = buildGiveRolesModal();
			await interaction.showModal(modal);
		} catch (error) {
			logger.info(`Не удалось открыть модал выдачи ролей: ${error}`);
		}
		return;
	}

	// Отправка модала (создание заявки)
	if (interaction.isModalSubmit() && interaction.customId === 'gr-submit-modal') {
		try {
			await interaction.deferReply({ ephemeral: true });

			const guildId = interaction.guildId;
			const serverCfg = config.servers[guildId];
			if (!serverCfg) {
				await replyTemp(interaction, 'Для этого сервера нет настроек в config.json.');
				return;
			}

			const nickname = interaction.fields.getTextInputValue('gr-nickname')?.trim();
			const staticId = interaction.fields.getTextInputValue('gr-static')?.trim();
			const inviteRaw = interaction.fields.getTextInputValue('gr-invite')?.trim();

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

            const guild = await client.guilds.fetch(guildId);

            const resolved = await resolveMemberFromInviteField(guild, inviteRaw);
            if (!resolved.member) {
                if (resolved.ambiguous) {
                    await replyTemp(
                        interaction,
                        `Нашёл несколько пользователей по вашему вводу: ${resolved.candidates.join(', ')}.\n` +
                        `Укажите тег (упоминание вида <@123...>), Discord ID или @username.\n` +
                        `-# Сообщение удалится через 30 секунд.`
                    );
                    return;
                }

                await replyTemp(
                    interaction,
                    'Не удалось определить сотрудника, который вас принимал.\n' +
                    'Укажите тег (упоминание вида <@123...>), Discord ID или @username.\n' +
                    '-# Сообщение удалится через 30 секунд.'
                );
                return;
            }
			
            const inviteMember = resolved.member;
            const inviteUserId = inviteMember.id;

			const userId = interaction.user.id;

			const result = await giveRolesRequest.createGiveRolesRequest(
				client,
				guildId,
				userId,
				nickname,
				staticId,
				inviteUserId
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
					const inviteMention = result.inviteUserId ? `<@${result.inviteUserId}>` : `${inviteMember}`;
					await replyTemp(
						interaction,
						`<@${userId}>, вы уже отправляли заявку!\nОжидайте, пока сотрудник ${inviteMention} её рассмотрит.\nВы получите оповещение как только получите роли.\n-# Сообщение удалится через 30 секунд.`
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
				`Спасибо, <@${userId}>, ваша заявка принята!\nОжидайте, пока сотрудник <@${inviteUserId}> её рассмотрит.\nВы получите оповещение как только получите роли.\n-# Сообщение удалится через 30 секунд.`
			);
		} catch (error) {
			logger.info(`Произошла ошибка при отправке заявки через модал: ${error}`);
			try {
				if (interaction.deferred || interaction.replied) {
					await interaction.editReply({
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

	// Кнопки обработки заявки (одобрить/отклонить/блок)
	if (!interaction.isButton()) return;

	if (!(interaction.customId === 'role-confirm' ||
		interaction.customId === 'role-db' ||
		interaction.customId === 'role-decline' ||
		interaction.customId === 'role-block')) {
		return;
	}

	try {
		await interaction.deferReply({ ephemeral: true });

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
			// Заявка уже обработана/удалена
			try {
				await interaction.message.edit({ components: [] });
			} catch (_) {
				// noop
			}
			await replyTemp(interaction, 'Заявка уже обработана или не найдена.\n-# Сообщение удалится через 30 секунд.');
			return;
		}

		const nickname = giveRolesList.nickname;
		const staticId = giveRolesList.static;
		const inviteUserId = giveRolesList.invite_nick;
		const userId = giveRolesList.userId;

		const confirmUserId = interaction.user.id;
		const confirmMember = await guild.members.fetch(confirmUserId).catch(() => null);
		if (!confirmMember) {
			await replyTemp(interaction, 'Не удалось определить ваши роли на сервере.\n-# Сообщение удалится через 30 секунд.');
			return;
		}

		const leaderRoleId = serverCfg.leaderRoleId;
		const depLeaderRoleId = serverCfg.depLeaderRoleId;

		const isLeader =
			(leaderRoleId && confirmMember.roles.cache.has(leaderRoleId)) ||
			(depLeaderRoleId && confirmMember.roles.cache.has(depLeaderRoleId));

		const isDev = Array.isArray(config.devs) && config.devs.includes(confirmUserId);
		const isInviter = confirmUserId === inviteUserId;

		// Пытаемся получить сообщение из канала заявок (если получилось), иначе используем interaction.message
		let message = interaction.message;
		if (confirmChannel && typeof confirmChannel.messages?.fetch === 'function') {
			message = await confirmChannel.messages.fetch(messageId).catch(() => interaction.message);
		}

		const userMention = `<@${userId}>`;
		const inviteMention = `<@${inviteUserId}>`;

		const preNickName = `TD | ${nickname} | ${staticId}`;

		let member = await guild.members.fetch(userId).catch(() => null);

		const weazelNewsRoleId = serverCfg.weazelNewsRoleId;
		const traineeRoleId = serverCfg.traineeRoleId;
		const firstRankRoleId = serverCfg.firstRankRoleId;
		const thirdRankRoleId = serverCfg.thirdRankRoleId;
		const retestingRoleId = serverCfg.retestingRoleId;
		const citizenRoleId = serverCfg.citizenRoleId;

		const canApprove = isInviter || isLeader || isDev;
		const canDecline = isInviter || isLeader || isDev;
		const canBlock = isLeader || isDev;

		if (interaction.customId === 'role-confirm' || interaction.customId === 'role-db') {
			if (!canApprove) {
				await replyTemp(
					interaction,
					`${confirmMember}, вы не являетесь ${inviteMention} для того, чтобы принять заявку!\n-# Сообщение удалится через 30 секунд.`
				);
				return;
			}

			await giveRoles.deleteOne(query);

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

			await message.edit({ embeds: [editedEmbed], components: [] });

			let rank;
			let reason;

			if (interaction.customId === 'role-confirm') {
				rank = '1';
				reason = 'Собеседование';
			} else {
				rank = '3';
				reason = 'ДБ';
			}

			// Запись в КА теперь через invite.js
			if (kaChannel) {
				const inviterMember = await guild.members.fetch(inviteUserId).catch(() => null);
				if (!inviterMember) {
					logger.error(`giveRoles: не удалось получить пригласившего ${inviteUserId} для записи принятия в КА`);
				} else {
					const ok = await inviteCommand.sendKaInviteRecord(client, {
						guildId,
						kaChannel,
						inviterId: inviteUserId,
						inviterDisplayName: inviterMember.displayName,
						acceptedId: userId,
						acceptedDisplayName: preNickName,
						staticId,
						rank,
						reason,
					});

					if (!ok) {
						logger.error(`giveRoles: не удалось отправить запись принятия в КА (userId=${userId}, inviterId=${inviteUserId})`);
					}
				}
			}

			// Даже если пользователя уже нет на сервере — заявка считается обработанной, просто пропускаем выдачу ролей/ЛС.
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
						await member.roles.add(role);
					} else {
						logger.error(`Не удалось найти роль ${roleId} на сервере ${guildId}.`);
					}
				}

				if (citizenRoleId && member.roles.cache.has(citizenRoleId)) {
					await member.roles.remove(citizenRoleId);
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
					await member.setNickname(`${newNickName}`);
				} catch (error) {
					logger.error(`Не удалось изменить ник пользователю ${userId}: ${error}`);
				}

				await safeDm(member, `${userMention}, ${inviteMention} одобрил вашу заявку!\nДобро пожаловать в Weazel News!`);
			}

			await replyTemp(interaction, `Заявка ${userMention} одобрена.\n-# Сообщение удалится через 30 секунд.`);
			return;
		}

		if (interaction.customId === 'role-decline') {
			if (!canDecline) {
				await replyTemp(
					interaction,
					`${confirmMember}, вы не являетесь лидером фракции или ${inviteMention} для того, чтобы отклонить заявку!\n-# Сообщение удалится через 30 секунд.`
				);
				return;
			}

			await giveRoles.deleteOne(query);

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

			await message.edit({ embeds: [editedEmbed], components: [] });

			if (member) {
				await safeDm(
					member,
					`${userMention}, к сожалению, ${inviteMention} отклонил вашу заявку.\nСвяжитесь с сотрудником, чтобы выяснить причину.`
				);
			}

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

			const blQuery = { guildId, userId };
			const existed = await blackListGiveRoles.findOne(blQuery);
			if (!existed) {
				const newBlackListGiveRoles = new blackListGiveRoles({ guildId, userId });
				await newBlackListGiveRoles.save();
			}

			await giveRoles.deleteOne(query);

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

			await message.edit({ embeds: [editedEmbed], components: [] });

			if (member) {
				await safeDm(member, `${userMention}, вы были заблокированы за злоупотребление функционалом бота!`);
			}

			await replyTemp(interaction, `Пользователь ${userMention} успешно заблокирован!\n-# Сообщение удалится через 30 секунд.`);
			return;
		}
	} catch (error) {
		logger.info(`Произошла ошибка при нажатии на кнопку, связанную с выдачей ролей: ${error}`);
		try {
			if (interaction.deferred || interaction.replied) {
				await interaction.editReply({
					content: `Произошла ошибка при обработке заявки: ${error}`,
					ephemeral: true,
				});
			}
		} catch (_) {
			// noop
		}
	}
};
