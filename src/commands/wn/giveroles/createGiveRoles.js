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
const {
	ApplicationCommandOptionType,
	PermissionFlagsBits,
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
} = require('discord.js');

const logger = require('../../../utils/logger');

module.exports = {
	name: 'creategr',
	description: 'Добавляет сообщение с выдачей ролей для Trainee Department в выбранном канале.',
	options: [
		{
			name: 'channel',
			description: 'Выберите канал, в который будет отправлено сообщение.',
			required: true,
			type: ApplicationCommandOptionType.Channel,
		},
	],
	permissionsRequired: [PermissionFlagsBits.Administrator],
	botPermissions: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],

	callback: async (client, interaction) => {
		try {
			await interaction.deferReply({ ephemeral: true });

			const guildId = interaction.guildId;
			const serverCfg = config.servers[guildId];
			if (!serverCfg) {
				await interaction.editReply({
					content: 'Для этого сервера нет настроек в config.json.',
					ephemeral: true,
				});
				return;
			}

			const leaderRoleId = serverCfg.leaderRoleId;
			const channel = interaction.options.getChannel('channel');
			if (!channel) {
				await interaction.editReply({
					content: 'Не удалось получить канал.',
					ephemeral: true,
				});
				return;
			}

			const citizenChannel = await client.channels.fetch(serverCfg.citizenChannelId).catch(() => null);

			const row = new ActionRowBuilder().addComponents(
				new ButtonBuilder()
					.setCustomId('gr-open-modal')
					.setLabel('Подать заявку на роли стажировки')
					.setStyle(ButtonStyle.Primary)
			);

			const citizenChannelMention = citizenChannel ? `${citizenChannel}` : 'нужном канале';
			const text =
				`Чтобы получить роли стажировки, нажмите кнопку ниже и заполните форму.\n` +
				`Поля заявки:\n` +
				`- **nickname** — Имя Фамилия персонажа (пример: Michael Lindberg)\n` +
				`- **static** — ваш статик (пример: 7658)\n` +
				`- **invite** — тег/ID сотрудника, который вас принимал\n\n` +
				`Заявки, составленные не по форме, могут быть отклонены.\n\n` +
				`Если вам нужны особенные роли (МК, лидер/зам. лидера и т.п.), обратитесь напрямую в личные сообщения лидеру WN с ролью <@&${leaderRoleId}>.\n` +
				`Если вы новый куратор фракции, пинганите Главного Куратора гос. фракций в ${citizenChannelMention}.\n` +
				`-# WN Helper by Michael Lindberg. Discord: milkgames`;

			await channel.send({
				content: text,
				components: [row],
			});

			await interaction.editReply({
				content: `Сообщение создано успешно в канале ${channel}!`,
				ephemeral: true,
			});
		} catch (error) {
			logger.info(`Произошла ошибка при создании сообщения с выдачей ролей: ${error}`);
			try {
				await interaction.editReply({
					content: `Произошла ошибка при создании сообщения с выдачей ролей: ${error}`,
					ephemeral: true,
				});
			} catch (_) {
				// noop
			}
		}
	},
};
