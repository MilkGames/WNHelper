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

const config = require('../../../config.json');
const amdShifts = require('../../models/amdShifts');
const logger = require('../../utils/logger');

const {
	FREE_SHIFT_VALUE,
	SHIFT_MAP,
	buildShiftLines,
	buildScheduleMessageContent,
	buildAccessPlan,
	buildAccessSection,
	formatRoleMentions,
	getMemberCategory,
} = require('../../utils/amdShiftUtils');

async function safeReply(interaction, payload) {
	if (interaction.replied || interaction.deferred) {
		return interaction.editReply(payload).catch(() => {});
	}
	return interaction.reply(payload).catch(() => {});
}

function countUserShifts(shiftsRecord, userId) {
	if (!shiftsRecord || !userId) return 0;
	let count = 0;
	for (const shift of SHIFT_MAP) {
		if (shiftsRecord[shift.field] === userId) count += 1;
	}
	return count;
}

async function replyAndAutoDelete(interaction, content) {
	await safeReply(interaction, { content, ephemeral: true });
	setTimeout(async () => {
		try {
			if (interaction.deferred || interaction.replied) {
				await interaction.deleteReply();
			}
		} catch (error) {
			logger.error(`AMD смены: не удалось удалить ответ интеракции: ${error}`);
		}
	}, 30000);
}

async function threadEdit(message, shiftNumber, formattedDate, currentMember, userId, userMentionText, deleted) {
	const threadName = `Смены ${formattedDate}`;
	const existingThread = message.channel.threads.cache.find((thread) => thread.name === threadName);

	let thread = existingThread;
	if (!thread) {
		thread = await message.startThread({
			name: threadName,
			autoArchiveDuration: 60,
		});
	}

	if (deleted) {
		if (currentMember === userId) {
			await thread.send(`${userMentionText} снял себя со смены номер ${shiftNumber}.`);
		} else {
			const currentMention = /^\d{17,20}$/.test(String(currentMember)) ? `<@${currentMember}>` : currentMember;
			await thread.send(`${userMentionText} снял ${currentMention} со смены номер ${shiftNumber}.`);
		}
		return;
	}

	await thread.send(`${userMentionText} занял смену номер ${shiftNumber}.`);
}

function buildOutcomeText({ shiftNumber, currentMember, userId, userMentionText, headRoleId, deleted, badRequest }) {
	if (badRequest) {
		const mentionText = /^\d{17,20}$/.test(String(currentMember)) ? `<@${currentMember}>` : currentMember;
		return `${userMentionText}, смена номер ${shiftNumber} уже занята ${mentionText}. Попроси его или <@&${headRoleId}> освободить её.`;
	}

	if (deleted) {
		if (currentMember === userId) {
			return `${userMentionText}, ты снялся со смены номер ${shiftNumber}.`;
		}
		const mentionText = /^\d{17,20}$/.test(String(currentMember)) ? `<@${currentMember}>` : currentMember;
		return `${userMentionText}, ты снял ${mentionText} со смены номер ${shiftNumber}.`;
	}

	return `${userMentionText}, ты занял смену номер ${shiftNumber}.`;
}

module.exports = async (client, interaction) => {
	if (!interaction.isButton()) return;

	const shiftConfig = SHIFT_MAP.find(({ id }) => id === interaction.customId);
	if (!shiftConfig) return;

	try {
		await interaction.deferReply({ ephemeral: true }).catch(() => {});

		const guildId = interaction.guildId;
		const serverConfig = config.servers[guildId];
		if (!serverConfig) return;

		const guild = interaction.guild || (await client.guilds.fetch(guildId));
		const message = interaction.message;
		const messageId = message.id;

		const userId = interaction.user.id;
		const userMentionText = `<@${userId}>`;
		const member = interaction.member || (await guild.members.fetch(userId));

		const query = { guildId, messageId };
		const shiftsRecord = await amdShifts.findOne(query);
		if (!shiftsRecord) {
			await replyAndAutoDelete(
				interaction,
				'Критическая ошибка в сменах! Расписание смены не найдено. Обновите сообщение и попробуйте снова.'
			);
			return;
		}

		const formattedDate = shiftsRecord.date;
		const headRoleId = serverConfig.headAMDRoleId;

		const nowMs = Date.now();
		const sentAtMs = shiftsRecord.sentAt || message.createdTimestamp || nowMs;
		const rotationIndex = typeof shiftsRecord.rotationIndex === 'number' ? shiftsRecord.rotationIndex : 0;

		const plan = buildAccessPlan(serverConfig, rotationIndex);
		const access = buildAccessSection({ plan, sentAtMs, nowMs });

		let currentMember = shiftsRecord[shiftConfig.field] || FREE_SHIFT_VALUE;
		let deleted = false;
		let badRequest = false;

		// Если смена свободна — пробуем занять
		if (currentMember === FREE_SHIFT_VALUE) {
			const category = getMemberCategory(member, serverConfig);
			const allowed = Boolean(category) && (access.currentCategories || []).includes(category);
			if (!allowed) {
				const nextInfo = access.nextEtaMinutes !== null
					? ` Следующее расширение через ~${access.nextEtaMinutes} мин.`
					: '';

				await replyAndAutoDelete(
					interaction,
					`Сейчас доступ к выбору смен открыт только для: ${formatRoleMentions(access.currentRoleIds)}.${nextInfo}`
				);
				return;
			}

			const alreadyTaken = countUserShifts(shiftsRecord, userId);
			if (alreadyTaken >= 2) {
				await replyAndAutoDelete(
					interaction,
					'Ты уже занял максимальное количество смен на сегодня (2). Сначала освободи одну из смен, чтобы занять новую.'
				);
				return;
			}

			// Занимать можно только если смена всё ещё свободна
			const takeQuery = { ...query, [shiftConfig.field]: FREE_SHIFT_VALUE };
			const takeRes = await amdShifts.updateOne(takeQuery, { [shiftConfig.field]: userId });

			if (!takeRes || takeRes.matchedCount === 0) {
				// Кто-то занял раньше нас — никого не перезаписали
				const fresh = await amdShifts.findOne(query);
				if (fresh) currentMember = fresh[shiftConfig.field] || currentMember;

				badRequest = true;
				const text = buildOutcomeText({
					shiftNumber: shiftConfig.number,
					currentMember,
					userId,
					userMentionText,
					headRoleId,
					deleted,
					badRequest,
				});
				await replyAndAutoDelete(interaction, text);
				return;
			}

			// Обновляем локальную копию, чтобы не делать второй findOne
			shiftsRecord[shiftConfig.field] = userId;
		} else {
			// Если смена занята — можно снять себя, либо старший AMD может снять любого
			const canForceDelete = Boolean(headRoleId) && member.roles.cache.has(headRoleId);

			if (currentMember === userId || canForceDelete) {
				// Освобождать можно только если значение не поменялось
				const expected = canForceDelete ? currentMember : userId;
				const delQuery = { ...query, [shiftConfig.field]: expected };
				const delRes = await amdShifts.updateOne(delQuery, { [shiftConfig.field]: FREE_SHIFT_VALUE });

				if (!delRes || delRes.matchedCount === 0) {
					const fresh = await amdShifts.findOne(query);
					if (fresh) currentMember = fresh[shiftConfig.field] || currentMember;

					badRequest = true;
					const text = buildOutcomeText({
						shiftNumber: shiftConfig.number,
						currentMember,
						userId,
						userMentionText,
						headRoleId,
						deleted,
						badRequest,
					});
					await replyAndAutoDelete(interaction, text);
					return;
				}

				shiftsRecord[shiftConfig.field] = FREE_SHIFT_VALUE;
				deleted = true;
			} else {
				badRequest = true;
				const text = buildOutcomeText({
					shiftNumber: shiftConfig.number,
					currentMember,
					userId,
					userMentionText,
					headRoleId,
					deleted,
					badRequest,
				});
				await replyAndAutoDelete(interaction, text);
				return;
			}
		}

		// Пересобираем расписание из обновлённой локальной копии (без повторного findOne)
		const shiftLines = await buildShiftLines(client, shiftsRecord);
		const content = buildScheduleMessageContent({
			formattedDate,
			shiftLines,
			serverConfig,
			rotationIndex,
			sentAtMs,
			nowMs,
		});

		await message.edit({ content });

		await threadEdit(
			message,
			shiftConfig.number,
			formattedDate,
			currentMember,
			userId,
			userMentionText,
			deleted
		);

		const text = buildOutcomeText({
			shiftNumber: shiftConfig.number,
			currentMember,
			userId,
			userMentionText,
			headRoleId,
			deleted,
			badRequest,
		});

		await replyAndAutoDelete(interaction, text);
	} catch (error) {
		logger.info(`AMD смены: ошибка в обработчике changeShift: ${error}`);
		await safeReply(interaction, { content: `Ошибка при обработке смены: ${error}`, ephemeral: true }).catch(() => {});
	}
};
