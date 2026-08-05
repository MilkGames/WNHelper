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
const path = require('path');

const logger = require('../logging/logger');
const { INSTANCE_LEASE_PATH } = require('./paths');
const { instanceId, startedAt } = require('./instance');

const HEARTBEAT_INTERVAL_MS = 15_000;
const STALE_AFTER_MS = 60_000;
let heartbeatTimer = null;
let acquired = false;
let lastHeartbeatAt = null;

function readLease() {
    try {
        if (!fs.existsSync(INSTANCE_LEASE_PATH)) return null;
        return JSON.parse(fs.readFileSync(INSTANCE_LEASE_PATH, 'utf8'));
    } catch (error) {
        logger.warn('Не удалось прочитать файл блокировки инстанса', error);
        return null;
    }
}

function buildLease(now = Date.now()) {
    return {
        instanceId,
        pid: process.pid,
        startedAt: startedAt.getTime(),
        heartbeatAt: now,
    };
}

function writeLease() {
    const now = Date.now();
    const lease = buildLease(now);
    fs.mkdirSync(path.dirname(INSTANCE_LEASE_PATH), { recursive: true });
    const temporaryPath = `${INSTANCE_LEASE_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(lease, null, 2), 'utf8');
    fs.renameSync(temporaryPath, INSTANCE_LEASE_PATH);
    lastHeartbeatAt = now;
}

function createLeaseExclusive() {
    const now = Date.now();
    const lease = buildLease(now);
    fs.mkdirSync(path.dirname(INSTANCE_LEASE_PATH), { recursive: true });
    const descriptor = fs.openSync(INSTANCE_LEASE_PATH, 'wx');
    try {
        fs.writeFileSync(descriptor, JSON.stringify(lease, null, 2), 'utf8');
    } finally {
        fs.closeSync(descriptor);
    }
    lastHeartbeatAt = now;
}

function moveStaleLease() {
    const stalePath = `${INSTANCE_LEASE_PATH}.stale-${Date.now()}-${process.pid}`;
    fs.renameSync(INSTANCE_LEASE_PATH, stalePath);
    return stalePath;
}

function acquireInstanceLease() {
    let acquiredPath = false;
    for (let attempt = 0; attempt < 3 && !acquiredPath; attempt += 1) {
        try {
            createLeaseExclusive();
            acquiredPath = true;
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
            const existing = readLease();
            const existingIsFresh = existing?.instanceId &&
                Date.now() - Number(existing.heartbeatAt || 0) < STALE_AFTER_MS;
            if (existingIsFresh && existing.instanceId !== instanceId) {
                throw new Error('Обнаружен другой активный инстанс WN Helper. Запуск остановлен для защиты общей базы данных.');
            }
            try {
                const stalePath = moveStaleLease();
                logger.warn('Обнаружена устаревшая блокировка инстанса', { stalePath });
            } catch (moveError) {
                if (moveError?.code !== 'ENOENT') throw moveError;
            }
        }
    }
    if (!acquiredPath) {
        throw new Error('Не удалось получить блокировку единственного инстанса после нескольких попыток');
    }

    acquired = true;
    heartbeatTimer = setInterval(() => {
        try {
            const current = readLease();
            if (current?.instanceId && current.instanceId !== instanceId) {
                logger.fatal('Файл блокировки инстанса был перехвачен другим процессом. Текущий процесс будет остановлен.');
                if (heartbeatTimer) {
                    clearInterval(heartbeatTimer);
                    heartbeatTimer = null;
                }
                const { requestShutdown } = require('./shutdown');
                requestShutdown('Блокировка инстанса перехвачена другим процессом', { exitCode: 1 })
                    .catch(() => process.exit(1));
                return;
            }
            writeLease();
        } catch (error) {
            logger.error('Не удалось обновить блокировку инстанса', error);
        }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();
}

function releaseInstanceLease() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    if (!acquired) return;

    try {
        const current = readLease();
        if (current?.instanceId === instanceId && fs.existsSync(INSTANCE_LEASE_PATH)) {
            fs.unlinkSync(INSTANCE_LEASE_PATH);
        }
    } catch (error) {
        logger.warn('Не удалось удалить файл блокировки инстанса', error);
    }
    acquired = false;
}

function getLeaseStatus() {
    const current = readLease();
    return {
        acquired,
        heartbeatFresh: Boolean(current?.heartbeatAt && Date.now() - Number(current.heartbeatAt) < STALE_AFTER_MS),
        lastHeartbeatAt,
    };
}

module.exports = {
    HEARTBEAT_INTERVAL_MS,
    STALE_AFTER_MS,
    acquireInstanceLease,
    getLeaseStatus,
    releaseInstanceLease,
};
