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

const logger = require('./logger');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'localdb.json');
const TMP_PATH = path.join(DATA_DIR, 'localdb.json.tmp');
const BACKUP_PATH = path.join(DATA_DIR, 'localdb.backup.json');

let mutationQueue = Promise.resolve();

function createDefaultDb() {
    return {
        amdShifts: [],
        amdShiftRotation: [],
        giveRoles: [],
        blackListGiveRoles: [],
        examQueue: [],
        formWebhookQueue: [],
    };
}

const DEFAULT_DB = createDefaultDb();

function ensureDatabase() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    if (!fs.existsSync(DB_PATH)) {
        fs.writeFileSync(DB_PATH, JSON.stringify(createDefaultDb(), null, 2));
    }
}

function normalizeDbShape(parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('localdb.json должен содержать JSON-объект верхнего уровня');
    }

    for (const [key, value] of Object.entries(DEFAULT_DB)) {
        if (!Array.isArray(parsed[key])) {
            parsed[key] = Array.isArray(value) ? [] : value;
        }
    }

    return parsed;
}

function readDb() {
    ensureDatabase();

    try {
        const raw = fs.readFileSync(DB_PATH, 'utf8');
        const parsed = raw.trim() ? JSON.parse(raw) : createDefaultDb();
        return normalizeDbShape(parsed);
    } catch (error) {
        logger.error(
            'Локальная база данных localdb.json повреждена или не читается. Файл НЕ пересоздаётся автоматически, чтобы не потерять данные.',
            error
        );
        throw error;
    }
}

function writeDb(db) {
    ensureDatabase();
    const normalized = normalizeDbShape(db);
    const serialized = JSON.stringify(normalized, null, 2);

    if (fs.existsSync(DB_PATH)) {
        try {
            fs.copyFileSync(DB_PATH, BACKUP_PATH);
        } catch (error) {
            logger.warn(`Не удалось обновить backup локальной базы данных: ${error}`);
        }
    }

    fs.writeFileSync(TMP_PATH, serialized);
    fs.renameSync(TMP_PATH, DB_PATH);
}

function runMutation(mutator) {
    const task = mutationQueue.then(() => {
        const db = readDb();
        return Promise.resolve(mutator(db)).then((result) => {
            writeDb(db);
            return result;
        });
    });

    mutationQueue = task.then(() => undefined, () => undefined);
    return task;
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
        constructor(doc = {}) {
            Object.assign(this, doc);
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
                if (!Array.isArray(db[collectionName])) {
                    db[collectionName] = [];
                }

                db[collectionName].push({ ...this });
                return this;
            });
        }

        static async insertOneIfAbsent(query = {}, doc = {}) {
            return runMutation((db) => {
                if (!Array.isArray(db[collectionName])) {
                    db[collectionName] = [];
                }

                const existing = db[collectionName].find((item) => matchesQuery(item, query));
                if (existing) {
                    return { inserted: false, document: new LocalModel(existing) };
                }

                const record = { ...doc };
                db[collectionName].push(record);
                return { inserted: true, document: new LocalModel(record) };
            });
        }

        static async updateOne(query = {}, update = {}) {
            return runMutation((db) => {
                const collection = db[collectionName] || [];
                const index = collection.findIndex((item) => matchesQuery(item, query));
                if (index === -1) {
                    return { matchedCount: 0, modifiedCount: 0 };
                }

                collection[index] = { ...collection[index], ...update };
                db[collectionName] = collection;
                return { matchedCount: 1, modifiedCount: 1 };
            });
        }

        static async deleteOne(query = {}) {
            return runMutation((db) => {
                const collection = db[collectionName] || [];
                const index = collection.findIndex((item) => matchesQuery(item, query));
                if (index === -1) {
                    return { deletedCount: 0 };
                }

                collection.splice(index, 1);
                db[collectionName] = collection;
                return { deletedCount: 1 };
            });
        }
    };
}

module.exports = {
    createModel,
    ensureDatabase,
    readDb,
    writeDb,
};
