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
const rankCommand = require('../../commands/wn/ka/rank');
const uvalCommand = require('../../commands/wn/ka/uval');
const logger = require('../../utils/logger');

function extractDiscordId(value) {
	if (!value) return null;
	const str = String(value);
	const m = str.match(/(\d{17,20})/);
	return m ? m[1] : null;
}

function getEmbedFields(embed) {
	// discord.js может отдавать embed.data или "нормальный" EmbedBuilder-like
    // все вопросы к discord.js и его тупым обновлениям, не ко мне
	const data = embed?.data ?? embed ?? {};
	return Array.isArray(data.fields) ? data.fields : [];
}

function extractMemberIdFromMessage(targetMessage) {
	const embed = targetMessage?.embeds?.[0];
	if (!embed) return null;

	const fields = getEmbedFields(embed);

	// последний field
	if (fields.length) {
		const idFromLast = extractDiscordId(fields[fields.length - 1]?.value);
		if (idFromLast) return idFromLast;
	}

	// не нашли? попробуем найти любой field, где похоже на discord id
	for (const f of fields) {
		const id = extractDiscordId(f?.value);
		if (id) return id;
	}

    // fallback'аем
	const data = embed.data ?? embed ?? {};
	return extractDiscordId(data.description) || extractDiscordId(data.title) || null;
}

function extractTargetRankFromMessage(targetMessage) {
	const embed = targetMessage?.embeds?.[0];
	if (!embed) return null;

	const fields = getEmbedFields(embed);

    // второй field
    if (fields[1]?.value != null) {
		const m = String(fields[1].value).match(/(\d{1,2})/);
		if (m) {
			const n = parseInt(m[1], 10);
			if (Number.isFinite(n)) return n;
		}
	}

    // не нашли? попробуем найти любой field, где похоже на ранг
	for (const f of fields) {
		const name = (f?.name ?? '').toLowerCase();
		if (!name.includes('ранг')) continue;

		const m = String(f?.value ?? '').match(/(\d{1,2})/);
		if (m) {
			const n = parseInt(m[1], 10);
			if (Number.isFinite(n)) return n;
		}
	}

	// берём по кайфу максимальную цифру что найдём
	let best = null;
	for (const f of fields) {
		const matches = String(f?.value ?? '').match(/\d+/g);
		if (!matches) continue;

		for (const s of matches) {
			const n = parseInt(s, 10);
			if (!Number.isFinite(n)) continue;
			if (n >= 1 && n <= 8) best = best == null ? n : Math.max(best, n);
		}
	}
	return best;
}

function buildMessageLink(targetMessage) {
	const guildId = targetMessage.guildId;
	const channelId = targetMessage.channelId;
	const messageId = targetMessage.id;
	return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

function buildMockInteraction(baseInteraction, payload) {
	const state = {
		deferred: false,
		replied: false,
	};

	const optionsMap = {
		member: payload.member ?? null,
		action: payload.action ?? null,
		reason: payload.reason ?? null,
		static: payload.static ?? null,
	};

	return {
		guildId: payload.guildId ?? baseInteraction.guildId,
		user: baseInteraction.user,
		channel: baseInteraction.channel,
		channelId: baseInteraction.channelId,

		deferred: state.deferred,
		replied: state.replied,

		options: {
			getString: (name /*, required */) => {
				// required-аргумент игнорим: команды сами валидируют
				if (!(name in optionsMap)) return null;
				return optionsMap[name];
			},
			get: (name) => {
				if (!(name in optionsMap)) return null;
				const v = optionsMap[name];
				return v == null ? null : { value: v };
			},
		},

		deferReply: async (opts) => {
			await baseInteraction.deferReply(opts);
			state.deferred = true;
		},
		editReply: async (opts) => {
			await baseInteraction.editReply(opts);
			state.replied = true;
		},
		reply: async (opts) => {
			await baseInteraction.reply(opts);
			state.replied = true;
		},
		deleteReply: async () => {
			await baseInteraction.deleteReply();
		},
	};
}

module.exports = async (client, interaction) => {
	try {
		if (!interaction.isMessageContextMenuCommand()) return;

		const targetMessage = interaction.targetMessage;
		if (!targetMessage) return;

		const commandName = interaction.commandName;

		// Базовая валидация embed
		if (!targetMessage.embeds?.length) {
			await interaction.reply({
				content: 'В сообщении нет embed-данных. Контекстная команда работает только на нужных отчётах/заявлениях.',
				ephemeral: true,
			});
			return;
		}

		const memberId = extractMemberIdFromMessage(targetMessage);
		if (!memberId) {
			await interaction.reply({
				content: 'Не смог найти Discord ID сотрудника в embed. Проверь структуру сообщения (поля/формат).',
				ephemeral: true,
			});
			return;
		}

		// bugfix #1: отдаём как mention, чтобы rank/uval пошли по ветке "пинг" и могли парсить static из ника
		const memberMention = `<@${memberId}>`;

		if (commandName === 'Повысить по отчёту') {
			const targetRank = extractTargetRankFromMessage(targetMessage);
			if (!targetRank || targetRank < 1 || targetRank > 8) {
				await interaction.reply({
					content: 'Не смог определить целевой ранг (ожидаю число 1–8 в embed). Проверь поле ранга в сообщении.',
					ephemeral: true,
				});
				return;
			}

			if (targetRank <= 1) {
                // Такого быть не может, но кто его знает!!!
				await interaction.reply({
					content: 'Целевой ранг должен быть >= 2, иначе не получится сформировать "Повышен X-Y".',
					ephemeral: true,
				});
				return;
			}

			const action = `Повышен ${targetRank - 1}-${targetRank}`;
			const reason = buildMessageLink(targetMessage);

			const mockInteraction = buildMockInteraction(interaction, {
				guildId: targetMessage.guildId,
				member: memberMention,
				action,
				reason,
				static: null, // пусть rank.js пытается взять из ника; если не сможет — сам попросит, его проблемы, лол
			});

			await rankCommand.callback(client, mockInteraction);

			try {
				await targetMessage.react('✅');
			} catch (e) {
				logger.error(`Не удалось поставить реакцию ✅: ${e}`);
			}

			return;
		}

		if (commandName === 'Уволить по заявлению') {
			const reason = buildMessageLink(targetMessage);

			const mockInteraction = buildMockInteraction(interaction, {
				guildId: targetMessage.guildId,
				member: memberMention,
				reason,
				static: null, // пусть uval.js пытается взять из ника; если не сможет — сам попросит, его проблемы, лол
			});

			await uvalCommand.callback(client, mockInteraction);

			try {
				await targetMessage.react('✅');
			} catch (e) {
				logger.error(`Не удалось поставить реакцию ✅: ${e}`);
			}

			return;
		}
	} catch (error) {
		logger.error(`Произошла ошибка при взаимодействии с контекстным меню: ${error}`);

		try {
			if (!interaction.replied && !interaction.deferred) {
				await interaction.reply({
					content: `Ошибка контекстной команды: ${error}`,
					ephemeral: true,
				});
			} else {
				await interaction.editReply({
					content: `Ошибка контекстной команды: ${error}`,
					ephemeral: true,
				});
			}
		} catch (_) {
			// noop
		}
	}
};