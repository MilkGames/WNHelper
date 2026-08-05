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
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('./helpers/createTest')(__filename);
const { writeTestConfig } = require('./helpers/testConfig');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function createIsolatedCore() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-helper-db-'));
    const target = path.join(root, 'src', 'core');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.join(PROJECT_ROOT, 'src', 'core'), target, { recursive: true });
    writeTestConfig(root);
    const database = require(path.join(target, 'database', 'localDatabase.js'));
    const backup = require(path.join(target, 'database', 'backup.js'));
    const recovery = require(path.join(target, 'database', 'recovery.js'));
    const paths = require(path.join(target, 'runtime', 'paths.js'));
    return { root, database, backup, recovery, paths };
}

function silentFatal(callback) {
    const original = process.stderr.write;
    process.stderr.write = () => true;
    try {
        return callback();
    } finally {
        process.stderr.write = original;
    }
}

test('повреждение базы во время работы включает режим восстановления и блокирует изменения', async (context) => {
    const isolated = createIsolatedCore();
    context.after(() => fs.rmSync(isolated.root, { recursive: true, force: true }));
    const { database, paths } = isolated;

    database.initializeDatabase();
    let recoveryEvent = null;
    database.registerRecoveryHandler((state) => {
        recoveryEvent = state;
    });
    fs.writeFileSync(paths.DATABASE_PATH, '{ повреждено', 'utf8');

    silentFatal(() => assert.throws(() => database.readDb(), /Unexpected token|JSON/u));
    await new Promise((resolve) => setImmediate(resolve));

    const status = database.getDatabaseStatus();
    assert.equal(status.recoveryMode, true);
    assert.equal(status.maintenance, true);
    assert.equal(status.recoveryState.source, 'runtime_read');
    assert.ok(fs.existsSync(status.recoveryState.corruptPath));
    assert.equal(recoveryEvent?.source, 'runtime_read');
    await assert.rejects(database.mutateDb(() => undefined), /временно заблокированы|режиме восстановления/u);
});

test('почасовые резервные копии ограничиваются 24 файлами, защитные копии сохраняются отдельно', (context) => {
    const isolated = createIsolatedCore();
    context.after(() => fs.rmSync(isolated.root, { recursive: true, force: true }));
    const { database, backup, paths } = isolated;

    database.initializeDatabase();
    fs.mkdirSync(paths.BACKUPS_DIR, { recursive: true });
    const base = Date.UTC(2026, 6, 1, 0, 0, 0);
    for (let index = 0; index < 25; index += 1) {
        const date = new Date(base + index * 60 * 60 * 1000);
        const name = backup.buildBackupName(date);
        const filePath = path.join(paths.BACKUPS_DIR, name);
        fs.writeFileSync(filePath, JSON.stringify(database.createDefaultDb()), 'utf8');
        fs.utimesSync(filePath, date, date);
    }
    const safetyPath = path.join(paths.BACKUPS_DIR, backup.buildSafetyBackupName(new Date(base)));
    fs.writeFileSync(safetyPath, JSON.stringify(database.createDefaultDb()), 'utf8');

    backup.createHourlyBackup({ force: true });
    assert.equal(backup.listBackups().length, 24);
    assert.equal(fs.existsSync(safetyPath), true);
});

test('после применения плана восстановления база требует перезапуска и не принимает новые изменения', async (context) => {
    const isolated = createIsolatedCore();
    context.after(() => fs.rmSync(isolated.root, { recursive: true, force: true }));
    const { database, backup, recovery, paths } = isolated;

    database.initializeDatabase();
    await database.mutateDb((db) => {
        db.vacationRequests.push({ guildId: '1', requestId: 'current', status: 'active' });
    });

    fs.mkdirSync(paths.BACKUPS_DIR, { recursive: true });
    const backupName = backup.buildBackupName(new Date(2026, 7, 3, 10, 0, 0));
    const backupDb = database.createDefaultDb();
    backupDb.vacationRequests.push({ guildId: '1', requestId: 'backup', status: 'pending' });
    fs.writeFileSync(path.join(paths.BACKUPS_DIR, backupName), JSON.stringify(backupDb, null, 2), 'utf8');

    const plan = recovery.createRecoveryPlan(backupName);
    assert.equal(plan.summary.backupOnly, 1);
    await recovery.applyRecoveryPlan(plan.planId);

    const status = database.getDatabaseStatus();
    assert.equal(status.recoveryMode, false);
    assert.equal(status.maintenance, true);
    assert.match(status.maintenanceReason, /перезапуск/u);
    const merged = database.readDb();
    assert.deepEqual(
        merged.vacationRequests.map((entry) => entry.requestId).sort(),
        ['backup', 'current']
    );
    await assert.rejects(database.mutateDb(() => undefined), /Требуется перезапуск/u);
});

test('техническая блокировка пропускает уже принятую очередь и отклоняет новые изменения', async (context) => {
    const isolated = createIsolatedCore();
    context.after(() => fs.rmSync(isolated.root, { recursive: true, force: true }));
    const { database } = isolated;

    database.initializeDatabase();
    let releaseFirst;
    let signalStarted;
    const started = new Promise((resolve) => {
        signalStarted = resolve;
    });
    const gate = new Promise((resolve) => {
        releaseFirst = resolve;
    });

    const first = database.mutateDb(async (db) => {
        signalStarted();
        await gate;
        db.vacationRequests.push({ guildId: '1', requestId: 'first' });
    });
    const second = database.mutateDb((db) => {
        db.vacationRequests.push({ guildId: '1', requestId: 'second' });
    });

    await started;
    database.setMaintenance('Проверка технической блокировки');
    await assert.rejects(
        database.mutateDb((db) => db.vacationRequests.push({ guildId: '1', requestId: 'late' })),
        /Проверка технической блокировки/u
    );

    releaseFirst();
    await Promise.all([first, second]);
    const storedIds = database.readDb().vacationRequests.map((entry) => entry.requestId);
    assert.deepEqual(storedIds, ['first', 'second']);
    assert.equal(database.clearMaintenance(), true);
});
