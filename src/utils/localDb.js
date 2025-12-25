const fs = require('fs');
const path = require('path');

const logger = require('./logger');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'localdb.json');
const DEFAULT_DB = {
    amdShifts: [],
    giveRoles: [],
    blackListGiveRoles: [],
};

function ensureDatabase() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    if (!fs.existsSync(DB_PATH)) {
        fs.writeFileSync(DB_PATH, JSON.stringify(DEFAULT_DB, null, 2));
    }
}

function readDb() {
    ensureDatabase();
    try {
        const raw = fs.readFileSync(DB_PATH, 'utf8');
        return raw ? JSON.parse(raw) : { ...DEFAULT_DB };
    } catch (error) {
        logger.error('Не удалось прочитать локальную базу данных, пересоздаю с настройками по умолчанию.', error);
        fs.writeFileSync(DB_PATH, JSON.stringify(DEFAULT_DB, null, 2));
        return { ...DEFAULT_DB };
    }
}

function writeDb(db) {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function matchesQuery(document, query) {
    return Object.entries(query).every(([key, value]) => document[key] === value);
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

        async save() {
            const db = readDb();
            if (!Array.isArray(db[collectionName])) {
                db[collectionName] = [];
            }
            db[collectionName].push({ ...this });
            writeDb(db);
            return this;
        }

        static async updateOne(query = {}, update = {}) {
            const db = readDb();
            const collection = db[collectionName] || [];
            const index = collection.findIndex((item) => matchesQuery(item, query));
            if (index === -1) {
                return { matchedCount: 0, modifiedCount: 0 };
            }
            collection[index] = { ...collection[index], ...update };
            db[collectionName] = collection;
            writeDb(db);
            return { matchedCount: 1, modifiedCount: 1 };
        }

        static async deleteOne(query = {}) {
            const db = readDb();
            const collection = db[collectionName] || [];
            const index = collection.findIndex((item) => matchesQuery(item, query));
            if (index === -1) {
                return { deletedCount: 0 };
            }
            collection.splice(index, 1);
            db[collectionName] = collection;
            writeDb(db);
            return { deletedCount: 1 };
        }
    };
}

module.exports = {
    createModel,
    ensureDatabase,
};
