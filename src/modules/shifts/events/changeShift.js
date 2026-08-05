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
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */
const { MessageFlags } = require('discord.js');
const shiftSchedules = require('../database').shiftSchedules;
const guildConfigService = require('../../../core/config/guildConfigService');
const {
    canMemberManageShift,
    canMemberTakeShift,
    getRecordShiftType,
    getScheduleActiveUntil,
    updateScheduleAfterInteraction,
    writeShiftAudit,
} = require('../service');
const {
    deferReplyWithRetry,
    editReplyWithRetry,
    replyWithRetry,
} = require('../../../core/discord/request');
const logger = require('../../../core/logging/logger');
const { buildPublicErrorMessage } = require('../../../core/ui/errorMessage');

function parseShiftCustomId(customId) {
    const match = /^shift:([^:]+):(\d+)$/.exec(String(customId || ''));
    if (!match) return null;
    return { typeId: match[1], page: Number(match[2]) };
}

async function safeReply(interaction, content) {
    const payload = {
        content,
        allowedMentions: { parse: [] },
    };
    if (interaction.deferred || interaction.replied) {
        return editReplyWithRetry(interaction, payload).catch(() => undefined);
    }
    return replyWithRetry(interaction, {
        ...payload,
        flags: MessageFlags.Ephemeral,
    }).catch(() => undefined);
}

function formatManagerRoles(shiftType) {
    if (!shiftType.managerRoleIds.length) return 'администратора расписания';
    return shiftType.managerRoleIds.map((roleId) => `<@&${roleId}>`).join(' ');
}

function formatAccessDenied(access) {
    if (access.unrestricted) return 'Сейчас невозможно занять эту смену.';
    if (access.stageIndex < 0) {
        const eta = access.nextStage
            ? Math.max(0, access.nextStage.delayMinutes - access.elapsedMinutes)
            : null;
        return eta === null
            ? 'Выбор смен пока закрыт.'
            : `Выбор смен пока закрыт. Первый доступ откроется примерно через ${eta} мин.`;
    }

    const shownRoleIds = access.currentRoleIds.slice(0, 10);
    const roles = shownRoleIds.length
        ? shownRoleIds.map((roleId) => `<@&${roleId}>`).join(' ') +
            (access.currentRoleIds.length > shownRoleIds.length
                ? ` и ещё ${access.currentRoleIds.length - shownRoleIds.length} ролей`
                : '')
        : 'настроенных групп';
    const eta = access.nextStage
        ? ` Следующее расширение примерно через ${Math.max(0, access.nextStage.delayMinutes - access.elapsedMinutes)} мин.`
        : '';
    return `Сейчас доступ к выбору смен открыт только для: ${roles}.${eta}`;
}

function countMemberSlots(record, memberId) {
    return record.slots.filter((slot) => slot.memberId === memberId).length;
}

async function applySlotMutation({
    guildId,
    typeId,
    messageId,
    slotId,
    member,
}) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const record = await shiftSchedules.findOne({ guildId, typeId, messageId });
        if (!record) return { error: 'Расписание не найдено. Обновите сообщение и попробуйте снова.' };
        if (record.status !== 'active') return { error: 'Это расписание уже закрыто.' };

        const shiftType = getRecordShiftType(record);
        const activeUntil = Number.isFinite(Number(record.activeUntil))
            ? Number(record.activeUntil)
            : getScheduleActiveUntil(shiftType, record.dateKey);
        if (Date.now() >= activeUntil) return { error: 'Это расписание уже завершено.' };

        const slotIndex = record.slots.findIndex((slot) => slot.id === slotId);
        if (slotIndex < 0) return { error: 'Выбранная смена не найдена в расписании.' };

        const slot = record.slots[slotIndex];
        const actorId = member.id;
        const isManager = canMemberManageShift(member, shiftType);
        const nextRecord = structuredClone({ ...record });
        const nextSlot = nextRecord.slots[slotIndex];
        let action;
        const previousMemberId = slot.memberId;

        if (!slot.memberId) {
            const accessResult = canMemberTakeShift(member, shiftType, record);
            if (!accessResult.allowed) {
                return { error: formatAccessDenied(accessResult.access) };
            }

            if (
                shiftType.maxSlotsPerMember > 0 &&
                countMemberSlots(record, actorId) >= shiftType.maxSlotsPerMember
            ) {
                return {
                    error: `Вы уже заняли максимальное количество смен: ${shiftType.maxSlotsPerMember}.`,
                };
            }

            nextSlot.memberId = actorId;
            action = 'take';
        } else if (slot.memberId === actorId || isManager) {
            nextSlot.memberId = null;
            action = 'release';
        } else {
            return {
                error: `Эта смена уже занята <@${slot.memberId}>. Освободить её может сотрудник или ${formatManagerRoles(shiftType)}.`,
            };
        }

        nextRecord.activeUntil = activeUntil;
        nextRecord.typeSnapshot = structuredClone(shiftType);
        nextRecord.revision = Number(record.revision || 0) + 1;
        const result = await shiftSchedules.replaceOne(
            {
                guildId,
                typeId,
                messageId,
                revision: Number(record.revision || 0),
            },
            nextRecord
        );

        if (result.matchedCount === 0) continue;
        return {
            record: nextRecord,
            shiftType,
            slot: nextSlot,
            action,
            previousMemberId,
        };
    }

    return { error: 'Расписание изменилось одновременно с вашим выбором. Попробуйте ещё раз.' };
}

module.exports = async (client, interaction) => {
    if (!interaction.isStringSelectMenu()) return;
    const parsed = parseShiftCustomId(interaction.customId);
    if (!parsed) return;

    try {
        await deferReplyWithRetry(interaction, { flags: MessageFlags.Ephemeral });

        const guildId = String(interaction.guildId || '');
        const config = guildConfigService.get(guildId);
        if (!config?.features?.shifts) {
            await safeReply(interaction, 'Функция смен сейчас выключена.');
            return;
        }

        const record = await shiftSchedules.findOne({
            guildId,
            typeId: parsed.typeId,
            messageId: interaction.message.id,
        });
        if (!record) {
            await safeReply(interaction, 'Расписание не найдено. Обновите сообщение и попробуйте снова.');
            return;
        }
        if (String(record.channelId) !== String(interaction.channelId)) {
            await safeReply(interaction, 'Это сообщение находится не в канале своего расписания.');
            return;
        }

        const guild = interaction.guild || await client.guilds.fetch(guildId);
        const member = interaction.member?.roles?.cache
            ? interaction.member
            : await guild.members.fetch(interaction.user.id);
        const slotId = String(interaction.values?.[0] || '');

        const outcome = await applySlotMutation({
            guildId,
            typeId: parsed.typeId,
            messageId: interaction.message.id,
            slotId,
            member,
        });
        if (outcome.error) {
            await safeReply(interaction, outcome.error);
            return;
        }

        await updateScheduleAfterInteraction(
            client,
            outcome.shiftType,
            outcome.record,
            interaction.message
        ).catch((error) => {
            logger.error('Не удалось обновить сообщение после изменения смены', {
                guildId,
                shiftTypeId: parsed.typeId,
                dateKey: outcome.record.dateKey,
                userId: interaction.user.id,
            }, error);
        });

        await writeShiftAudit(interaction.message, outcome.record, outcome.shiftType, {
            actorId: interaction.user.id,
            slot: outcome.slot,
            previousMemberId: outcome.previousMemberId,
            action: outcome.action,
        }).catch((error) => {
            logger.error('Не удалось записать действие в журнал смен', {
                guildId,
                shiftTypeId: parsed.typeId,
                dateKey: outcome.record.dateKey,
                userId: interaction.user.id,
            }, error);
        });

        if (outcome.action === 'take') {
            await safeReply(
                interaction,
                `Вы заняли смену №${outcome.slot.number} (${outcome.slot.startTime}-${outcome.slot.endTime}).`
            );
            return;
        }

        if (outcome.previousMemberId === interaction.user.id) {
            await safeReply(
                interaction,
                `Вы освободили смену №${outcome.slot.number} (${outcome.slot.startTime}-${outcome.slot.endTime}).`
            );
            return;
        }

        await safeReply(
            interaction,
            `Вы освободили смену №${outcome.slot.number}, которую занимал <@${outcome.previousMemberId}>.`
        );
    } catch (error) {
        logger.error('Ошибка обработки списка смен', {
            guildId: interaction.guildId,
            userId: interaction.user.id,
            customId: interaction.customId,
        }, error);
        await safeReply(
            interaction,
            buildPublicErrorMessage(error, 'Произошла внутренняя ошибка при обработке смены.')
        ).catch(() => undefined);
    }
};
