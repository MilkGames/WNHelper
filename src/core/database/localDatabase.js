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
const {
    DATABASE_PREVIOUS_BACKUP_PATH,
    DATABASE_PATH,
    DATABASE_TMP_PATH,
    DATA_DIR,
} = require('../runtime/paths');

let mutationQueue = Promise.resolve();
let pendingMutations = 0;
let maintenanceReason = null;
let recoveryState = null;
let lastWriteAt = null;
let lastWriteError = null;

function createDefaultDb() {
    return {
        guildConfigs: [],
        shiftSchedules: [],
        shiftRotations: [],
        giveRoles: [],
        blackListGiveRoles: [],
        examQueue: [],
        examAttempts: [],
        examinationRequests: [],
        vacationRequests: [],
        formWebhookQueue: [],
        webhookReceipts: [],
        uvalOperations: [],
        staffAuditBatches: [],
        staffAuditOperations: [],
        staffPromotionHistory: [],
        settingsPublications: [],
        disciplineAppeals: [],
        disciplineCases: [],
        disciplineRemovalRequests: [],
        massDisciplineBatches: [],
    };
}

const DEFAULT_DB = createDefaultDb();

function normalizeDbShape(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('localdb.json должен содержать JSON-объект верхнего уровня');
    }

    for (const [key, value] of Object.entries(DEFAULT_DB)) {
        if (!Array.isArray(parsed[key])) parsed[key] = Array.isArray(value) ? [] : value;
    }

    return parsed;
}

function parseDatabaseFile(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = raw.trim() ? JSON.parse(raw) : createDefaultDb();
    return normalizeDbShape(parsed);
}

function buildCorruptFilePath() {
    const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
    return path.join(DATA_DIR, `localdb.corrupt-${timestamp}.json`);
}

const recoveryHandlers = new Set();

function notifyRecoveryHandlers(state) {
    for (const handler of recoveryHandlers) {
        Promise.resolve()
            .then(() => handler({ ...state }))
            .catch((error) => logger.error('Обработчик перехода в режим восстановления завершился с ошибкой', error));
    }
}

function activateRecoveryMode(error, { source = 'runtime' } = {}) {
    if (recoveryState?.active) return { ...recoveryState };

    const corruptPath = buildCorruptFilePath();
    try {
        if (fs.existsSync(DATABASE_PATH)) fs.copyFileSync(DATABASE_PATH, corruptPath);
    } catch (copyError) {
        logger.error('Не удалось сохранить копию повреждённой базы данных', copyError);
    }

    recoveryState = {
        active: true,
        detectedAt: Date.now(),
        corruptPath,
        error: error?.message || String(error || 'Неизвестная ошибка базы данных'),
        source,
    };
    lastWriteError = recoveryState.error;
    maintenanceReason = 'Восстановление повреждённой базы данных';
    logger.fatal('База данных повреждена. Изменения остановлены, автоматическая замена файла запрещена.', {
        corruptPath,
        source,
        error: recoveryState.error,
    });
    notifyRecoveryHandlers(recoveryState);
    return { ...recoveryState };
}

function registerRecoveryHandler(handler) {
    if (typeof handler !== 'function') throw new TypeError('Обработчик восстановления должен быть функцией');
    recoveryHandlers.add(handler);
    return () => recoveryHandlers.delete(handler);
}

function initializeDatabase() {
    fs.mkdirSync(DATA_DIR, { recursive: true });

    if (!fs.existsSync(DATABASE_PATH)) {
        fs.writeFileSync(DATABASE_PATH, JSON.stringify(createDefaultDb(), null, 2), 'utf8');
        lastWriteAt = Date.now();
        return { recoveryMode: false, created: true };
    }

    try {
        parseDatabaseFile(DATABASE_PATH);
        recoveryState = null;
        return { recoveryMode: false, created: false };
    } catch (error) {
        const state = activateRecoveryMode(error, { source: 'startup' });
        return { recoveryMode: true, created: false, corruptPath: state.corruptPath, error };
    }
}

function ensureDatabase() {
    if (!fs.existsSync(DATA_DIR) || !fs.existsSync(DATABASE_PATH)) initializeDatabase();
}

function readDb() {
    ensureDatabase();
    if (recoveryState?.active) {
        throw new Error('Чтение базы данных недоступно в режиме восстановления');
    }

    try {
        return parseDatabaseFile(DATABASE_PATH);
    } catch (error) {
        activateRecoveryMode(error, { source: 'runtime_read' });
        throw error;
    }
}

function assertMutationAllowed() {
    if (maintenanceReason) {
        throw new Error(`Изменения базы данных временно заблокированы: ${maintenanceReason}`);
    }
    if (recoveryState?.active) {
        throw new Error('Изменения базы данных недоступны в режиме восстановления');
    }
}

function writeDatabaseFile(db, { bypassMaintenance = false } = {}) {
    ensureDatabase();
    if (!bypassMaintenance) assertMutationAllowed();

    const normalized = normalizeDbShape(db);
    const serialized = JSON.stringify(normalized, null, 2);

    try {
        if (fs.existsSync(DATABASE_PATH)) {
            fs.copyFileSync(DATABASE_PATH, DATABASE_PREVIOUS_BACKUP_PATH);
        }
        fs.writeFileSync(DATABASE_TMP_PATH, serialized, 'utf8');
        parseDatabaseFile(DATABASE_TMP_PATH);
        fs.renameSync(DATABASE_TMP_PATH, DATABASE_PATH);
        parseDatabaseFile(DATABASE_PATH);
        lastWriteAt = Date.now();
        lastWriteError = null;
    } catch (error) {
        lastWriteError = error.message;
        try {
            if (fs.existsSync(DATABASE_TMP_PATH)) fs.unlinkSync(DATABASE_TMP_PATH);
        } catch (_cleanupError) {
            logger.warn('Не удалось удалить временный файл базы данных после ошибки записи');
        }
        throw error;
    }
}

function writeDb(db) {
    writeDatabaseFile(db);
}

function runMutation(mutator) {
    try {
        assertMutationAllowed();
    } catch (error) {
        return Promise.reject(error);
    }
    pendingMutations += 1;
    const task = mutationQueue.then(async () => {
        if (recoveryState?.active) {
            throw new Error('Изменения базы данных недоступны в режиме восстановления');
        }
        const db = readDb();
        const result = await mutator(db);
        if (recoveryState?.active) {
            throw new Error('Изменение базы данных отменено после перехода в режим восстановления');
        }
        writeDatabaseFile(db, { bypassMaintenance: true });
        return result;
    });

    mutationQueue = task.then(() => undefined, () => undefined);
    return task.finally(() => {
        pendingMutations = Math.max(0, pendingMutations - 1);
    });
}

async function waitForIdle() {
    await mutationQueue.catch(() => undefined);
}

function setMaintenance(reason) {
    maintenanceReason = String(reason || 'Техническое обслуживание');
}

function clearMaintenance() {
    if (recoveryState?.active) return false;
    maintenanceReason = null;
    return true;
}

function replaceDatabase(db, { leaveMaintenance = false } = {}) {
    const previousReason = maintenanceReason;
    maintenanceReason = maintenanceReason || 'Замена базы данных';
    writeDatabaseFile(db, { bypassMaintenance: true });
    recoveryState = null;
    maintenanceReason = leaveMaintenance ? (previousReason || 'Техническое обслуживание') : null;
}

function getDatabaseStatus() {
    let size = null;
    try {
        size = fs.existsSync(DATABASE_PATH) ? fs.statSync(DATABASE_PATH).size : null;
    } catch (_error) {
        size = null;
    }

    return {
        path: DATABASE_PATH,
        size,
        lastWriteAt,
        lastWriteError,
        pendingMutations,
        maintenance: Boolean(maintenanceReason),
        maintenanceReason,
        recoveryMode: Boolean(recoveryState?.active),
        recoveryState: recoveryState ? { ...recoveryState } : null,
    };
}

function matchesQueryValue(documentValue, queryValue) {
    if (
        queryValue &&
        typeof queryValue === 'object' &&
        !Array.isArray(queryValue) &&
        Object.prototype.hasOwnProperty.call(queryValue, '$in')
    ) {
        const allowed = Array.isArray(queryValue.$in) ? queryValue.$in : [];
        return allowed.some((item) => item === documentValue);
    }

    return documentValue === queryValue;
}

function matchesQuery(document, query) {
    return Object.entries(query).every(([key, value]) => matchesQueryValue(document[key], value));
}

function createModel(collectionName) {
    return class LocalModel {
        constructor(document = {}) {
            Object.assign(this, document);
        }

        static async findOne(query = {}) {
            const db = readDb();
            const collection = db[collectionName] || [];
            const record = collection.find((item) => matchesQuery(item, query));
            return record ? new LocalModel(record) : null;
        }

        static async find(query = {}) {
            const db = readDb();
            const collection = db[collectionName] || [];
            const records = Object.keys(query).length
                ? collection.filter((item) => matchesQuery(item, query))
                : collection;
            return records.map((record) => new LocalModel(record));
        }

        async save() {
            return runMutation((db) => {
                if (!Array.isArray(db[collectionName])) db[collectionName] = [];
                db[collectionName].push({ ...this });
                return this;
            });
        }

        static async insertOneIfAbsent(query = {}, document = {}) {
            return runMutation((db) => {
                if (!Array.isArray(db[collectionName])) db[collectionName] = [];
                const existing = db[collectionName].find((item) => matchesQuery(item, query));
                if (existing) return { inserted: false, document: new LocalModel(existing) };
                const record = { ...document };
                db[collectionName].push(record);
                return { inserted: true, document: new LocalModel(record) };
            });
        }

        static async updateOne(query = {}, update = {}) {
            return runMutation((db) => {
                const collection = db[collectionName] || [];
                const index = collection.findIndex((item) => matchesQuery(item, query));
                if (index === -1) return { matchedCount: 0, modifiedCount: 0 };
                collection[index] = { ...collection[index], ...update };
                db[collectionName] = collection;
                return { matchedCount: 1, modifiedCount: 1 };
            });
        }

        static async replaceOne(query = {}, replacement = {}) {
            return runMutation((db) => {
                const collection = db[collectionName] || [];
                const index = collection.findIndex((item) => matchesQuery(item, query));
                if (index === -1) return { matchedCount: 0, modifiedCount: 0 };
                collection[index] = { ...replacement };
                db[collectionName] = collection;
                return { matchedCount: 1, modifiedCount: 1 };
            });
        }

        static async deleteOne(query = {}) {
            return runMutation((db) => {
                const collection = db[collectionName] || [];
                const index = collection.findIndex((item) => matchesQuery(item, query));
                if (index === -1) return { deletedCount: 0 };
                collection.splice(index, 1);
                db[collectionName] = collection;
                return { deletedCount: 1 };
            });
        }
    };
}

module.exports = {
    activateRecoveryMode,
    clearMaintenance,
    createDefaultDb,
    createModel,
    ensureDatabase,
    getDatabaseStatus,
    initializeDatabase,
    mutateDb: runMutation,
    normalizeDbShape,
    parseDatabaseFile,
    readDb,
    registerRecoveryHandler,
    replaceDatabase,
    setMaintenance,
    waitForIdle,
    writeDb,
};
