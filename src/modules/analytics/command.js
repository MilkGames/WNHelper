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
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const {
    ChannelType,
    MessageFlags,
} = require('discord.js');
const {
    deferReplyWithRetry,
    editMessageWithRetry,
    editReplyWithRetry,
    followUpWithRetry,
    sendMessageWithRetry,
} = require('../../core/discord/request');
const logger = require('../../core/logging/logger');
const { buildPublicErrorMessage } = require('../../core/ui/errorMessage');
const { FULL_MESSAGE_SCAN_PATH } = require('../../core/runtime/paths');

const DATA_FILE = FULL_MESSAGE_SCAN_PATH;
const DATA_DIR = path.dirname(DATA_FILE);

const FETCH_LIMIT = 100;
const SOFT_DELAY_MS = 250;
const PROGRESS_EVERY_CHANNELS = 3;
const INCLUDE_THREADS = true;

const running = new Map();

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDirSync(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function createEmptyDb() {
    return { guilds: {} };
}

async function loadDb() {
    ensureDirSync(DATA_DIR);

    let raw;
    try {
        raw = await fsp.readFile(DATA_FILE, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return createEmptyDb();
        }

        throw new Error(`Не удалось прочитать ${DATA_FILE}.`, { cause: error });
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new Error(`Файл ${DATA_FILE} содержит повреждённый JSON.`, { cause: error });
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Файл ${DATA_FILE} должен содержать JSON-объект.`);
    }

    if (parsed.guilds === undefined) {
        parsed.guilds = {};
    } else if (!parsed.guilds || typeof parsed.guilds !== 'object' || Array.isArray(parsed.guilds)) {
        throw new Error(`Поле guilds в ${DATA_FILE} должно быть JSON-объектом.`);
    }

    return parsed;
}

async function saveDb(db) {
    ensureDirSync(DATA_DIR);

    const tmp = `${DATA_FILE}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
    await fsp.rename(tmp, DATA_FILE);
}

function safeText(value) {
    if (!value) return '-';
    return String(value).replaceAll('@', '＠').trim() || '-';
}

function isScanTargetChannel(channel) {
    return (
        channel &&
        (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement)
    );
}

function isThreadChannel(channel) {
    return (
        channel &&
        (
            channel.type === ChannelType.PublicThread ||
            channel.type === ChannelType.PrivateThread ||
            channel.type === ChannelType.AnnouncementThread
        )
    );
}

function createGuildBucket() {
    return {
        stats: {},
        progress: {},
        meta: {},
    };
}

function getGuildBucket(db, guildId) {
    if (!db.guilds[guildId]) {
        db.guilds[guildId] = createGuildBucket();
    }

    const bucket = db.guilds[guildId];
    if (!bucket.stats || typeof bucket.stats !== 'object') bucket.stats = {};
    if (!bucket.progress || typeof bucket.progress !== 'object') bucket.progress = {};
    if (!bucket.meta || typeof bucket.meta !== 'object') bucket.meta = {};

    return bucket;
}

function prepareGuildBucketForRun(db, guildId) {
    let bucket = getGuildBucket(db, guildId);

    const lastStartedAt = Date.parse(bucket.meta.lastStartedAt || '');
    const lastFinishedAt = Date.parse(bucket.meta.lastFinishedAt || '');
    const previousRunFinished = (
        Number.isFinite(lastFinishedAt) &&
        (!Number.isFinite(lastStartedAt) || lastFinishedAt >= lastStartedAt)
    );

    if (previousRunFinished) {
        bucket = createGuildBucket();
        db.guilds[guildId] = bucket;
    }

    bucket.meta.lastStartedAt = new Date().toISOString();
    delete bucket.meta.lastFinishedAt;

    return bucket;
}

function bump(stats, message) {
    const user = message.author;
    if (!user?.id) return;

    const userId = user.id;
    const globalNick = user.globalName ?? user.username ?? '-';
    const guildNick = (
        message.member?.displayName ??
        message.guild?.members?.cache?.get(userId)?.displayName ??
        globalNick
    );

    const previous = stats[userId] ?? {
        count: 0,
        lastGlobal: globalNick,
        lastGuild: guildNick,
    };

    previous.count = (previous.count ?? 0) + 1;
    previous.lastGlobal = globalNick;
    previous.lastGuild = guildNick;
    stats[userId] = previous;
}

async function collectAllTargets(guild) {
    const targets = new Map();
    const all = await guild.channels.fetch();

    for (const [, channel] of all) {
        if (!channel) continue;

        if (isScanTargetChannel(channel) || isThreadChannel(channel)) {
            targets.set(channel.id, channel);
        }
    }

    if (INCLUDE_THREADS) {
        for (const [, channel] of all) {
            if (!channel) continue;

            const canHaveThreads = (
                channel.type === ChannelType.GuildText ||
                channel.type === ChannelType.GuildAnnouncement ||
                channel.type === ChannelType.GuildForum
            );

            if (!canHaveThreads || !channel.threads) continue;

            try {
                const active = await channel.threads.fetchActive();
                for (const [, thread] of active.threads) {
                    targets.set(thread.id, thread);
                }
            } catch (error) {
                logger.debug('Не удалось получить активные треды при полном скане сообщений.', {
                    guildId: guild.id,
                    channelId: channel.id,
                    error: String(error?.message ?? error),
                });
            }

            try {
                let before;

                for (;;) {
                    const result = await channel.threads.fetchArchived({
                        type: 'public',
                        limit: 100,
                        before,
                    });

                    for (const [, thread] of result.threads) {
                        targets.set(thread.id, thread);
                    }

                    if (!result.hasMore || result.threads.size === 0) break;

                    before = result.threads.last()?.id;
                    await sleep(SOFT_DELAY_MS);
                }
            } catch (error) {
                logger.debug('Не удалось получить архивные публичные треды при полном скане сообщений.', {
                    guildId: guild.id,
                    channelId: channel.id,
                    error: String(error?.message ?? error),
                });
            }

            try {
                let before;

                for (;;) {
                    const result = await channel.threads.fetchArchived({
                        type: 'private',
                        limit: 100,
                        before,
                    });

                    for (const [, thread] of result.threads) {
                        targets.set(thread.id, thread);
                    }

                    if (!result.hasMore || result.threads.size === 0) break;

                    before = result.threads.last()?.id;
                    await sleep(SOFT_DELAY_MS);
                }
            } catch (error) {
                logger.debug('Не удалось получить архивные приватные треды при полном скане сообщений.', {
                    guildId: guild.id,
                    channelId: channel.id,
                    error: String(error?.message ?? error),
                });
            }
        }
    }

    const list = [];
    for (const [, channel] of targets) {
        if (typeof channel?.messages?.fetch === 'function') {
            list.push(channel);
        }
    }

    list.sort((left, right) => {
        const leftPosition = typeof left.position === 'number' ? left.position : 0;
        const rightPosition = typeof right.position === 'number' ? right.position : 0;

        if (leftPosition !== rightPosition) {
            return leftPosition - rightPosition;
        }

        return String(left.name ?? left.id).localeCompare(String(right.name ?? right.id));
    });

    return list;
}

async function scanOneChannel({ guildBucket, channel, db }) {
    const progress = guildBucket.progress[channel.id] ?? {
        before: null,
        done: false,
    };

    if (progress.done) {
        return { scanned: 0, done: true };
    }

    let scanned = 0;
    let before = progress.before ?? null;

    for (;;) {
        let batch;

        try {
            const options = before
                ? { limit: FETCH_LIMIT, before }
                : { limit: FETCH_LIMIT };

            batch = await channel.messages.fetch(options);
        } catch (error) {
            guildBucket.progress[channel.id] = {
                before: null,
                done: true,
                error: String(error?.message ?? error),
            };
            await saveDb(db);

            logger.warn('Не удалось просканировать канал или тред.', {
                guildId: channel.guildId,
                channelId: channel.id,
                channelName: channel.name ?? null,
                error: String(error?.message ?? error),
            });

            return { scanned, done: true, error: true };
        }

        if (!batch || batch.size === 0) {
            guildBucket.progress[channel.id] = {
                before: null,
                done: true,
            };
            await saveDb(db);
            return { scanned, done: true };
        }

        for (const [, message] of batch) {
            bump(guildBucket.stats, message);
            scanned += 1;
        }

        before = batch.last()?.id;
        guildBucket.progress[channel.id] = {
            before,
            done: false,
        };
        await saveDb(db);
        await sleep(SOFT_DELAY_MS);
    }
}

function buildTop10(guildBucket) {
    const entries = Object.entries(guildBucket.stats).map(([userId, value]) => ({
        userId,
        count: Number(value.count ?? 0),
        lastGlobal: value.lastGlobal ?? '-',
        lastGuild: value.lastGuild ?? '-',
    }));

    entries.sort((left, right) => right.count - left.count);
    const top = entries.slice(0, 10);

    if (top.length === 0) {
        return ['Нет данных. Возможно, бот не имеет доступа к истории сообщений.'];
    }

    return top.map((entry) => (
        `${entry.userId} - ${safeText(entry.lastGlobal)} - ` +
        `${safeText(entry.lastGuild)} - ${entry.count}`
    ));
}

function buildProgressContent(doneChannels, totalChannels, totalMessagesCounted, finished = false) {
    const status = finished ? 'Скан завершён' : 'Прогресс скана';

    return (
        `${status}: ${doneChannels}/${totalChannels} каналов/тредов, ` +
        `посчитано сообщений: ${totalMessagesCounted}.`
    );
}

async function updateProgressMessage({
    progressMessage,
    outChannel,
    guildId,
    doneChannels,
    totalChannels,
    totalMessagesCounted,
    finished = false,
}) {
    const content = buildProgressContent(
        doneChannels,
        totalChannels,
        totalMessagesCounted,
        finished,
    );

    if (progressMessage) {
        try {
            await editMessageWithRetry(progressMessage, {
                content,
                allowedMentions: { parse: [] },
            });
            return progressMessage;
        } catch (error) {
            logger.warn('Не удалось обновить сообщение прогресса полного скана.', {
                guildId,
                messageId: progressMessage.id,
                error: String(error?.message ?? error),
            });
        }
    }

    try {
        return await sendMessageWithRetry(outChannel, {
            content,
            allowedMentions: { parse: [] },
        }, {
            nonceSeed: `fullmsgscanProgress:${guildId}:${Date.now()}`,
        });
    } catch (error) {
        logger.warn('Не удалось отправить сообщение прогресса полного скана.', {
            guildId,
            error: String(error?.message ?? error),
        });
        return null;
    }
}

async function runFullScan({ interaction }) {
    const guild = interaction.guild;
    const guildId = guild.id;
    const db = await loadDb();
    const bucket = prepareGuildBucketForRun(db, guildId);

    bucket.meta.guildName = guild.name;
    await saveDb(db);

    const targets = await collectAllTargets(guild);

    await editReplyWithRetry(interaction, {
        content:
            'Запустил полный скан истории.\n' +
            `Каналов/тредов к обработке (доступных боту): **${targets.length}**.\n` +
            '⚠️ Это может занять очень долго. Итоговый топ-10 пришлю в этот канал отдельным сообщением.',
        allowedMentions: { parse: [] },
    });

    const outChannel = interaction.channel;
    let doneChannels = 0;
    let totalMessagesCounted = 0;
    let progressMessage = null;

    for (const channel of targets) {
        const result = await scanOneChannel({
            guildBucket: bucket,
            channel,
            db,
        });

        doneChannels += 1;
        totalMessagesCounted += result.scanned ?? 0;

        if (doneChannels % PROGRESS_EVERY_CHANNELS === 0) {
            progressMessage = await updateProgressMessage({
                progressMessage,
                outChannel,
                guildId,
                doneChannels,
                totalChannels: targets.length,
                totalMessagesCounted,
            });
        }
    }

    bucket.meta.lastFinishedAt = new Date().toISOString();
    bucket.meta.totalChannels = targets.length;
    bucket.meta.totalMessagesCounted = totalMessagesCounted;
    await saveDb(db);

    if (targets.length > 0) {
        progressMessage = await updateProgressMessage({
            progressMessage,
            outChannel,
            guildId,
            doneChannels,
            totalChannels: targets.length,
            totalMessagesCounted,
            finished: true,
        });
    }

    const topLines = buildTop10(bucket);
    const header = (
        `Топ-10 по количеству сообщений (полный скан) для ${safeText(guild.name)} (${guildId}):\n` +
        'Формат: Discord ID - Discord Nickname - Nickname на сервере - Количество сообщений\n'
    );

    await sendMessageWithRetry(outChannel, {
        content: `${header}\n\`\`\`\n${topLines.join('\n')}\n\`\`\``,
        allowedMentions: { parse: [] },
    }, {
        nonceSeed: `fullmsgscanResult:${guildId}:${bucket.meta.lastFinishedAt}`,
    });

    try {
        await followUpWithRetry(interaction, {
            content: 'Скан завершён. Результат отправлен в этот канал, данные сохранены локально.',
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        });
    } catch (error) {
        logger.warn('Не удалось отправить итоговый служебный ответ полного скана.', {
            guildId,
            userId: interaction.user.id,
            error: String(error?.message ?? error),
        });
    }
}

module.exports = {
    name: 'fullmsgscan',
    ownerOnly: true,
    description: 'Сканирует всю историю сервера и выводит топ-10 по сообщениям без пингов',
    callback: async (client, interaction) => {
        await deferReplyWithRetry(interaction, {
            flags: MessageFlags.Ephemeral,
        });

        if (!interaction.guild) {
            logger.warn('Команда полного сканирования сообщений вызвана вне сервера.', {
                userId: interaction.user.id,
            });

            await editReplyWithRetry(interaction, {
                content: 'Команда доступна только на сервере.',
                allowedMentions: { parse: [] },
            });
            return;
        }

        const guildId = interaction.guild.id;

        if (running.size > 0) {
            await editReplyWithRetry(interaction, {
                content: 'Другой полный скан уже запущен. Дождитесь его завершения.',
                allowedMentions: { parse: [] },
            });
            return;
        }

        const task = runFullScan({ interaction })
            .catch(async (error) => {
                logger.error('Произошла ошибка во время полного скана сообщений.', {
                    guildId,
                    userId: interaction.user.id,
                }, error);

                try {
                    await followUpWithRetry(interaction, {
                        content: buildPublicErrorMessage(error, 'Во время скана произошла ошибка. Подробности записаны в лог.'),
                        flags: MessageFlags.Ephemeral,
                        allowedMentions: { parse: [] },
                    });
                } catch (responseError) {
                    logger.error('Не удалось отправить сообщение об ошибке полного скана.', {
                        guildId,
                        userId: interaction.user.id,
                    }, responseError);
                }
            })
            .finally(() => {
                running.delete(guildId);
            });

        running.set(guildId, task);
    },
};