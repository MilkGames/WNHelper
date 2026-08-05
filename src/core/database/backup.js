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
const { BACKUPS_DIR, DATABASE_PATH } = require('../runtime/paths');

const MAX_BACKUPS = 24;
const BACKUP_INTERVAL_MS = 60 * 60 * 1000;
let backupTimer = null;
let lastBackupAt = null;
let lastBackupPath = null;
let lastBackupError = null;

function pad(value) {
    return String(value).padStart(2, '0');
}

function buildBackupName(date = new Date()) {
    return `localdb-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}.json`;
}

function buildSafetyBackupName(date = new Date()) {
    return `localdb-pre-recovery-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}.json`;
}

function parseJsonFile(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Файл базы данных должен содержать JSON-объект верхнего уровня');
    }
    return parsed;
}

function listBackups() {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    return fs.readdirSync(BACKUPS_DIR, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /^localdb-\d{4}-\d{2}-\d{2}_\d{2}\.json$/u.test(entry.name))
        .map((entry) => {
            const filePath = path.join(BACKUPS_DIR, entry.name);
            const stats = fs.statSync(filePath);
            let valid = true;
            let error = null;
            try {
                parseJsonFile(filePath);
            } catch (parseError) {
                valid = false;
                error = parseError.message;
            }
            return {
                name: entry.name,
                path: filePath,
                size: stats.size,
                createdAt: stats.mtimeMs,
                valid,
                error,
            };
        })
        .sort((left, right) => right.createdAt - left.createdAt);
}

function pruneBackups() {
    const backups = listBackups();
    for (const backup of backups.slice(MAX_BACKUPS)) {
        try {
            fs.unlinkSync(backup.path);
            logger.info('Удалена устаревшая резервная копия базы данных', { backup: backup.name });
        } catch (error) {
            logger.warn('Не удалось удалить устаревшую резервную копию базы данных', {
                backup: backup.name,
            }, error);
        }
    }
}

function createHourlyBackup({ force = false } = {}) {
    if (!fs.existsSync(DATABASE_PATH)) return null;
    const parsed = parseJsonFile(DATABASE_PATH);
    const serialized = JSON.stringify(parsed, null, 2);
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });

    const backupName = buildBackupName();
    const backupPath = path.join(BACKUPS_DIR, backupName);
    if (!force && fs.existsSync(backupPath)) {
        lastBackupPath = backupPath;
        lastBackupAt = fs.statSync(backupPath).mtimeMs;
        lastBackupError = null;
        return backupPath;
    }

    const temporaryPath = `${backupPath}.tmp`;
    fs.writeFileSync(temporaryPath, serialized, 'utf8');
    parseJsonFile(temporaryPath);
    fs.renameSync(temporaryPath, backupPath);
    lastBackupPath = backupPath;
    lastBackupAt = Date.now();
    lastBackupError = null;
    pruneBackups();
    logger.info('Создана резервная копия базы данных', { backup: backupName });
    return backupPath;
}


function createSafetyBackup() {
    if (!fs.existsSync(DATABASE_PATH)) return null;
    const parsed = parseJsonFile(DATABASE_PATH);
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    const backupName = buildSafetyBackupName();
    const backupPath = path.join(BACKUPS_DIR, backupName);
    const temporaryPath = `${backupPath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(parsed, null, 2), 'utf8');
    parseJsonFile(temporaryPath);
    fs.renameSync(temporaryPath, backupPath);
    logger.info('Создана защитная копия базы данных перед восстановлением', { backup: backupName });
    return backupPath;
}

function startBackupScheduler() {
    if (backupTimer) return;

    try {
        createHourlyBackup();
    } catch (error) {
        lastBackupError = error.message;
        logger.error('Не удалось создать резервную копию базы данных при запуске', error);
    }

    backupTimer = setInterval(() => {
        try {
            createHourlyBackup();
        } catch (error) {
            lastBackupError = error.message;
            logger.error('Не удалось создать почасовую резервную копию базы данных', error);
        }
    }, BACKUP_INTERVAL_MS);
    backupTimer.unref?.();
}

function stopBackupScheduler() {
    if (!backupTimer) return;
    clearInterval(backupTimer);
    backupTimer = null;
}

function getBackupStatus() {
    const backups = listBackups();
    return {
        count: backups.length,
        lastBackupAt,
        lastBackupName: lastBackupPath ? path.basename(lastBackupPath) : backups[0]?.name || null,
        lastBackupError,
        validCount: backups.filter((backup) => backup.valid).length,
    };
}

function resolveBackupPath(backupName) {
    const normalizedName = path.basename(String(backupName || ''));
    const backup = listBackups().find((item) => item.name === normalizedName);
    if (!backup) throw new Error('Указанная резервная копия не найдена');
    if (!backup.valid) throw new Error(`Резервная копия повреждена: ${backup.error}`);
    return backup.path;
}

module.exports = {
    BACKUP_INTERVAL_MS,
    MAX_BACKUPS,
    buildBackupName,
    buildSafetyBackupName,
    createHourlyBackup,
    createSafetyBackup,
    getBackupStatus,
    listBackups,
    parseJsonFile,
    resolveBackupPath,
    startBackupScheduler,
    stopBackupScheduler,
};
