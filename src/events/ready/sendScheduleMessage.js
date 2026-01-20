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

const { ButtonBuilder, ActionRowBuilder, ButtonStyle } = require('discord.js');
const cron = require('node-cron');

const config = require('../../../config.json');
const amdShifts = require('../../models/amdShifts');
const amdShiftRotation = require('../../models/amdShiftRotation');
const logger = require('../../utils/logger');

const {
    FREE_SHIFT_VALUE,
    SHIFT_MAP,
    ACCESS_STAGE_MINUTES,
    getMoscowDateKey,
    daysBetween,
    buildShiftLines,
    buildScheduleMessageContent,
    buildAccessPlan,
    formatRoleMentions,
    uniqRoleIds,
} = require('../../utils/amdShiftUtils');

function buildButtons() {
    const buttons = SHIFT_MAP.map((shift) =>
        new ButtonBuilder()
            .setCustomId(shift.id)
            .setStyle(ButtonStyle.Primary)
            .setLabel(String(shift.number))
    );

    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) {
        rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    }
    return rows;
}

function getTomorrowFormattedDate() {
    const todayKey = getMoscowDateKey(new Date());
    const todayUtc = new Date(`${todayKey}T00:00:00Z`);
    const tomorrowUtc = new Date(todayUtc.getTime() + 24 * 60 * 60 * 1000);

    const dd = new Intl.DateTimeFormat('ru-RU', {
        timeZone: 'Europe/Moscow',
        day: '2-digit',
    }).format(tomorrowUtc);
    const mm = new Intl.DateTimeFormat('ru-RU', {
        timeZone: 'Europe/Moscow',
        month: '2-digit',
    }).format(tomorrowUtc);
    const yyyy = new Intl.DateTimeFormat('ru-RU', {
        timeZone: 'Europe/Moscow',
        year: 'numeric',
    }).format(tomorrowUtc);

    return `${dd}.${mm}.${yyyy}`;
}

async function getRotationIndexForToday(guildId) {
    const todayKey = getMoscowDateKey(new Date());
    const state = await amdShiftRotation.findOne({ guildId });

    if (!state) {
        const created = new amdShiftRotation({ guildId, rotationIndex: 0, lastRunDate: todayKey });
        await created.save();
        return 0;
    }

    const lastKey = state.lastRunDate;
    if (!lastKey || lastKey === todayKey) {
        return typeof state.rotationIndex === 'number' ? state.rotationIndex : 0;
    }

    const diff = Math.max(0, daysBetween(lastKey, todayKey));
    const current = typeof state.rotationIndex === 'number' ? state.rotationIndex : 0;
    const next = (current + diff) % 3;
    await amdShiftRotation.updateOne({ guildId }, { rotationIndex: next, lastRunDate: todayKey });
    return next;
}

async function cleanupPreviousSchedule({ guildId, channel }) {
    const existing = await amdShifts.findOne({ guildId });
    if (!existing) return;

    try {
        const message = await channel.messages.fetch(existing.messageId);
        await message.edit({ components: [] }).catch(() => {});
    } catch (error) {
        logger.info(`AMD смены: не удалось очистить старое сообщение для сервера ${guildId}: ${error}`);
    }

    await amdShifts.deleteOne({ guildId });
}

async function scheduleAccessNotifications({
    client,
    guildId,
    channel,
    messageId,
    formattedDate,
    sentAtMs,
    rotationIndex,
    serverConfig,
}) {
    const plan = buildAccessPlan(serverConfig, rotationIndex);

    const stageRoleIds = plan.stages;
    const stageDelays = [ACCESS_STAGE_MINUTES, ACCESS_STAGE_MINUTES * 2];

    for (let i = 0; i < stageDelays.length; i += 1) {
        const stageIdx = i + 1;
        const delayMs = stageDelays[i] * 60 * 1000;

        setTimeout(async () => {
            try {
                const current = await amdShifts.findOne({ guildId, messageId });
                if (!current) return;

                const shiftLines = await buildShiftLines(client, current);
                const content = buildScheduleMessageContent({
                    formattedDate,
                    shiftLines,
                    serverConfig,
                    rotationIndex: current.rotationIndex ?? rotationIndex,
                    sentAtMs: current.sentAt ?? sentAtMs,
                    nowMs: Date.now(),
                });

                const message = await channel.messages.fetch(messageId);
                await message.edit({ content }).catch(() => {});

                const prevRoleIds = uniqRoleIds(stageRoleIds[stageIdx - 1]);
                const nextRoleIds = uniqRoleIds(stageRoleIds[stageIdx]);
                const newlyAdded = nextRoleIds.filter((id) => !prevRoleIds.includes(id));
                if (newlyAdded.length) {
                    await channel.send(
                        `:bell: Смены на ${formattedDate}: открыт доступ к выбору смен для ${formatRoleMentions(newlyAdded)}.`
                    );
                }
            } catch (error) {
                logger.info(`AMD смены: не удалось отправить уведомление этапа для сервера ${guildId}: ${error}`);
            }
        }, delayMs);
    }
}

module.exports = async (client) => {
    for (const guildId of Object.keys(config.servers)) {
        if (guildId !== "1249711898744848415") continue;
        const serverName = client.guilds.cache.get(guildId)?.name || guildId;
        const serverConfig = config.servers[guildId];

        let channel;
        try {
            channel = await client.channels.fetch(serverConfig.amdShiftsChannelId);
        } catch (error) {
            logger.info(`AMD смены: не удалось получить канал для сервера ${serverName}: ${error}`);
            continue;
        }

        logger.info(`Смены для AMD успешно запланированы на сервере ${serverName}.`);

        cron.schedule(
            '0 22 * * *', 
            async () => {
                try {
                    logger.info(`Начинаю отправлять смены AMD для сервера ${serverName}...`);

                    const rotationIndex = await getRotationIndexForToday(guildId);
                    const formattedDate = getTomorrowFormattedDate();

                    await cleanupPreviousSchedule({ guildId, channel });

                    const sentAtMs = Date.now();
                    const emptyRecord = {};
                    for (const shift of SHIFT_MAP) {
                        emptyRecord[shift.field] = FREE_SHIFT_VALUE;
                    }

                    const shiftLines = await buildShiftLines(client, emptyRecord);
                    const content = buildScheduleMessageContent({
                        formattedDate,
                        shiftLines,
                        serverConfig,
                        rotationIndex,
                        sentAtMs,
                        nowMs: sentAtMs,
                    });

                    const sentMessage = await channel.send({
                        content,
                        components: buildButtons(),
                    });

                    const record = new amdShifts({
                        guildId,
                        messageId: sentMessage.id,
                        date: formattedDate,
                        sentAt: sentAtMs,
                        rotationIndex,
                        ...emptyRecord,
                    });
                    await record.save();

                    await scheduleAccessNotifications({
                        client,
                        guildId,
                        channel,
                        messageId: sentMessage.id,
                        formattedDate,
                        sentAtMs,
                        rotationIndex,
                        serverConfig,
                    });

                    logger.info(`Смены для AMD успешно отправлены на сервере ${serverName}.`);
                } catch (error) {
                    logger.info(`AMD смены: не удалось отправить расписание для сервера ${serverName}: ${error}`);
                }
            },
            {
                scheduled: true,
                timezone: 'Europe/Moscow',
            }
        );
    }
};
