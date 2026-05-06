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
// ИИ слоп!!! сделал для себя, чтобы тестить
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const {
  PermissionFlagsBits,
  ChannelType,
} = require('discord.js');
const {
  deferReplyWithRetry,
  editReplyWithRetry,
  followUpWithRetry,
  sendMessageWithRetry,
} = require('../../utils/discordRequest');

const DATA_DIR = path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'full_message_scan.json');

// Tuning (safe defaults)
const FETCH_LIMIT = 100;          // max 100
const SOFT_DELAY_MS = 250;        // small delay between fetches (discord.js also rate-limits internally)
const PROGRESS_EVERY_CHANNELS = 3; // how often to post progress updates (optional)
const INCLUDE_THREADS = true;     // scan threads too (recommended for "whole server")

const running = new Map(); // guildId -> Promise

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function loadDb() {
  try {
    ensureDirSync(DATA_DIR);
    const raw = await fsp.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { guilds: {} };
    if (!parsed.guilds || typeof parsed.guilds !== 'object') parsed.guilds = {};
    return parsed;
  } catch {
    return { guilds: {} };
  }
}

async function saveDb(db) {
  ensureDirSync(DATA_DIR);
  const tmp = `${DATA_FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
  await fsp.rename(tmp, DATA_FILE);
}

function safeText(s) {
  if (!s) return '—';
  return String(s).replaceAll('@', '＠').trim() || '—';
}

function isScanTargetChannel(ch) {
  // Text channels we can fetch messages from
  return (
    ch &&
    (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)
  );
}

function isThreadChannel(ch) {
  return (
    ch &&
    (ch.type === ChannelType.PublicThread ||
      ch.type === ChannelType.PrivateThread ||
      ch.type === ChannelType.AnnouncementThread)
  );
}

function getGuildBucket(db, guildId) {
  if (!db.guilds[guildId]) {
    db.guilds[guildId] = {
      stats: {},      // userId -> { count, lastGlobal, lastGuild }
      progress: {},   // channelId -> { before: messageId|null, done: boolean }
      meta: {},       // info
    };
  }
  if (!db.guilds[guildId].stats) db.guilds[guildId].stats = {};
  if (!db.guilds[guildId].progress) db.guilds[guildId].progress = {};
  if (!db.guilds[guildId].meta) db.guilds[guildId].meta = {};
  return db.guilds[guildId];
}

function bump(stats, message) {
  const user = message.author;
  if (!user?.id) return;

  const userId = user.id;

  // "Discord Nickname" (global display name if any, else username)
  const globalNick = user.globalName ?? user.username ?? '—';

  // "Nickname on this server" (displayName if member resolved)
  // For users who left, message.member is often null, so we keep last known
  const guildNick =
    message.member?.displayName ??
    message.guild?.members?.cache?.get(userId)?.displayName ??
    globalNick;

  const prev = stats[userId] ?? { count: 0, lastGlobal: globalNick, lastGuild: guildNick };
  prev.count = (prev.count ?? 0) + 1;
  prev.lastGlobal = globalNick;
  prev.lastGuild = guildNick;
  stats[userId] = prev;
}

async function collectAllTargets(guild) {
  const targets = new Map(); // id -> channel

  const all = await guild.channels.fetch().catch(() => null);
  if (!all) return [];

  // Add base channels (text + forum for threads)
  for (const [, ch] of all) {
    if (!ch) continue;

    if (isScanTargetChannel(ch) || isThreadChannel(ch)) {
      targets.set(ch.id, ch);
    }
  }

  if (INCLUDE_THREADS) {
    // For each possible parent channel that can have threads: text, announcement, forum
    for (const [, ch] of all) {
      if (!ch) continue;

      const canHaveThreads =
        ch.type === ChannelType.GuildText ||
        ch.type === ChannelType.GuildAnnouncement ||
        ch.type === ChannelType.GuildForum;

      if (!canHaveThreads) continue;
      if (!ch.threads) continue;

      // Active threads
      try {
        const active = await ch.threads.fetchActive();
        for (const [, th] of active.threads) targets.set(th.id, th);
      } catch {
        // ignore permissions errors
      }

      // Archived PUBLIC threads (paged)
      try {
        let before = undefined;
        // Loop while hasMore
        for (;;) {
          const res = await ch.threads.fetchArchived({ type: 'public', limit: 100, before });
          for (const [, th] of res.threads) targets.set(th.id, th);
          if (!res.hasMore || res.threads.size === 0) break;
          // Move "before" back: oldest archived thread id from this page
          const last = res.threads.last();
          before = last?.id;
          await sleep(250);
        }
      } catch {
        // ignore
      }

      // Archived PRIVATE threads (may require additional perms)
      try {
        let before = undefined;
        for (;;) {
          const res = await ch.threads.fetchArchived({ type: 'private', limit: 100, before });
          for (const [, th] of res.threads) targets.set(th.id, th);
          if (!res.hasMore || res.threads.size === 0) break;
          const last = res.threads.last();
          before = last?.id;
          await sleep(250);
        }
      } catch {
        // ignore
      }
    }
  }

  // Filter only channels where we can fetch messages
  const list = [];
  for (const [, ch] of targets) {
    // Some channels are text-based but might not support messages.fetch in weird cases
    if (typeof ch?.messages?.fetch === 'function') list.push(ch);
  }

  // Stable order (by position/name if available)
  list.sort((a, b) => {
    const ap = typeof a.position === 'number' ? a.position : 0;
    const bp = typeof b.position === 'number' ? b.position : 0;
    if (ap !== bp) return ap - bp;
    return String(a.name ?? a.id).localeCompare(String(b.name ?? b.id));
  });

  return list;
}

async function scanOneChannel({ guildBucket, channel, db }) {
  const progress = guildBucket.progress[channel.id] ?? { before: null, done: false };
  if (progress.done) return { scanned: 0, done: true };

  let scanned = 0;
  let before = progress.before ?? null;

  for (;;) {
    let batch;
    try {
      const opts = before ? { limit: FETCH_LIMIT, before } : { limit: FETCH_LIMIT };
      batch = await channel.messages.fetch(opts);
    } catch (e) {
      // No perms, unknown channel, etc. Mark done to avoid infinite retry.
      guildBucket.progress[channel.id] = { before: null, done: true, error: String(e?.message ?? e) };
      await saveDb(db);
      return { scanned, done: true, error: true };
    }

    if (!batch || batch.size === 0) {
      guildBucket.progress[channel.id] = { before: null, done: true };
      await saveDb(db);
      return { scanned, done: true };
    }

    // Count
    for (const [, msg] of batch) {
      bump(guildBucket.stats, msg);
      scanned++;
    }

    // Continue backward
    const oldest = batch.last();
    before = oldest?.id;

    // Save checkpoint
    guildBucket.progress[channel.id] = { before, done: false };
    await saveDb(db);

    // Small delay to be polite (discord.js will also handle 429)
    await sleep(SOFT_DELAY_MS);
  }
}

function buildTop10(guildBucket) {
  const entries = Object.entries(guildBucket.stats).map(([userId, v]) => ({
    userId,
    count: Number(v.count ?? 0),
    lastGlobal: v.lastGlobal ?? '—',
    lastGuild: v.lastGuild ?? '—',
  }));

  entries.sort((a, b) => b.count - a.count);
  const top = entries.slice(0, 10);

  if (top.length === 0) {
    return ['Нет данных. Возможно бот не имеет доступа к истории сообщений.'];
  }

  return top.map((x) => {
    const globalNick = safeText(x.lastGlobal);
    const guildNick = safeText(x.lastGuild);
    return `${x.userId} - ${globalNick} - ${guildNick} - ${x.count}`;
  });
}

async function runFullScan({ interaction }) {
  const guild = interaction.guild;
  const guildId = guild.id;

  const db = await loadDb();
  const bucket = getGuildBucket(db, guildId);

  bucket.meta.lastStartedAt = new Date().toISOString();
  bucket.meta.guildName = guild.name;
  await saveDb(db);

  const targets = await collectAllTargets(guild);

  // Send “started” message (ephemeral)
  await editReplyWithRetry(interaction, {
    content:
      `Запустил полный скан истории.\n` +
      `Каналов/тредов к обработке (доступных боту): **${targets.length}**.\n` +
      `⚠️ Это может занять очень долго. Итоговый топ-10 пришлю **в этот канал** отдельным сообщением.\n`,
    ephemeral: true,
    allowedMentions: { parse: [] },
  });

  const outChannel = interaction.channel;

  let doneChannels = 0;
  let totalMessagesCounted = 0;

  for (const ch of targets) {
    const res = await scanOneChannel({ guildBucket: bucket, channel: ch, db });
    doneChannels++;
    totalMessagesCounted += res.scanned ?? 0;

    if (doneChannels % PROGRESS_EVERY_CHANNELS === 0) {
      // progress ping-free
      await sendMessageWithRetry(outChannel, {
        content:
          `Прогресс скана: ${doneChannels}/${targets.length} каналов/тредов, ` +
          `посчитано сообщений: ${totalMessagesCounted}.`,
        allowedMentions: { parse: [] },
      }, {
        nonceSeed: `fullmsgscanProgress:${guildId}:${doneChannels}`,
      }).catch(() => {});
    }
  }

  bucket.meta.lastFinishedAt = new Date().toISOString();
  await saveDb(db);

  const topLines = buildTop10(bucket);

  const header =
    `Топ-10 по количеству сообщений (полный скан) для ${safeText(guild.name)} (${guildId}):\n` +
    `Формат: Discord ID - Discord Nickname - Nickname на сервере - Количество сообщений\n`;

  const body = topLines.join('\n');

  await sendMessageWithRetry(outChannel, {
    content: `${header}\n\`\`\`\n${body}\n\`\`\``,
    allowedMentions: { parse: [] },
  }, {
    nonceSeed: `fullmsgscanResult:${guildId}`,
  });

  // final note to invoker
  await followUpWithRetry(interaction, {
    content: `Скан завершён. Результат отправлен в этот канал. Данные/прогресс сохранены в ${DATA_FILE}`,
    ephemeral: true,
    allowedMentions: { parse: [] },
  }).catch(() => {
    // interaction token might expire; ignore
  });
}

module.exports = {
  name: 'fullmsgscan',
  description: 'Один раз сканирует всю историю сервера и выводит топ-10 по сообщениям (без пингов)',
  permissionsRequired: [PermissionFlagsBits.Administrator],

  callback: async (client, interaction) => {
    await deferReplyWithRetry(interaction, { ephemeral: true });

    if (!interaction.guild) {
      await editReplyWithRetry(interaction, {
        content: 'Команда доступна только на сервере.',
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const guildId = interaction.guild.id;

    if (running.has(guildId)) {
      await editReplyWithRetry(interaction, {
        content: 'Скан уже запущен для этого сервера. Дождитесь завершения.',
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const task = runFullScan({ interaction })
      .catch(async (e) => {
        console.error('[fullmsgscan] error:', e);
        try {
          await followUpWithRetry(interaction, {
            content: `Ошибка во время скана: ${String(e?.message ?? e)}`,
            ephemeral: true,
            allowedMentions: { parse: [] },
          });
        } catch {}
      })
      .finally(() => {
        running.delete(guildId);
      });

    running.set(guildId, task);
  },
};
