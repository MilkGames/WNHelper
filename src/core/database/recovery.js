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
const crypto = require('crypto');
const fs = require('fs');

const logger = require('../logging/logger');
const { DATABASE_RECOVERY_PLAN_PATH } = require('../runtime/paths');
const { createSafetyBackup, resolveBackupPath, parseJsonFile } = require('./backup');
const {
    clearMaintenance,
    createDefaultDb,
    getDatabaseStatus,
    readDb,
    replaceDatabase,
    setMaintenance,
    waitForIdle,
} = require('./localDatabase');

const IDENTITY_FIELDS = {
    guildConfigs: ['guildId'],
    shiftSchedules: ['guildId', 'typeId', 'dateKey'],
    shiftRotations: ['guildId', 'typeId'],
    giveRoles: ['guildId', 'requestId'],
    blackListGiveRoles: ['guildId', 'userId'],
    examQueue: ['jobId'],
    examAttempts: ['guildId', 'memberId', 'examId'],
    examinationRequests: ['guildId', 'requestId'],
    vacationRequests: ['guildId', 'requestId'],
    formWebhookQueue: ['jobId'],
    webhookReceipts: ['key'],
    uvalOperations: ['guildId', 'uvalId'],
    staffAuditBatches: ['guildId', 'batchId'],
    staffAuditOperations: ['guildId', 'operationId'],
    staffPromotionHistory: ['guildId', 'promotionId'],
    settingsPublications: ['guildId', 'kind'],
    disciplineAppeals: ['guildId', 'appealId'],
    disciplineCases: ['guildId', 'caseId'],
    disciplineRemovalRequests: ['guildId', 'requestId'],
    massDisciplineBatches: ['guildId', 'massdisciplineId'],
    offboardingOperations: ['guildId', 'operationId'],
};

function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function hashValue(value) {
    return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function buildRecordIdentity(collectionName, record, index) {
    const configuredFields = IDENTITY_FIELDS[collectionName] || [];
    const configuredValues = configuredFields.map((field) => record?.[field]);
    if (configuredFields.length && configuredValues.every((value) => value !== null && value !== undefined && value !== '')) {
        return configuredFields.map((field, fieldIndex) => `${field}=${configuredValues[fieldIndex]}`).join('|');
    }

    const candidateField = Object.keys(record || {}).find((key) => /(?:^id$|Id$|_id$)/u.test(key) && record[key] !== null && record[key] !== undefined);
    if (candidateField) return `${candidateField}=${record[candidateField]}`;
    return `index=${index}|hash=${hashValue(record)}`;
}

function indexCollection(collectionName, records) {
    const result = new Map();
    for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        const identity = buildRecordIdentity(collectionName, record, index);
        if (!result.has(identity)) {
            result.set(identity, { identity, record, index });
            continue;
        }
        const duplicateIdentity = `${identity}|duplicate=${index}`;
        result.set(duplicateIdentity, { identity: duplicateIdentity, record, index });
    }
    return result;
}

function compareDatabases(currentDb, backupDb) {
    const collections = Array.from(new Set([
        ...Object.keys(currentDb || {}),
        ...Object.keys(backupDb || {}),
    ])).sort();
    const summary = {
        currentOnly: 0,
        backupOnly: 0,
        identical: 0,
        conflicts: 0,
    };
    const collectionResults = [];
    const conflicts = [];

    for (const collectionName of collections) {
        const currentRecords = Array.isArray(currentDb?.[collectionName]) ? currentDb[collectionName] : [];
        const backupRecords = Array.isArray(backupDb?.[collectionName]) ? backupDb[collectionName] : [];
        const currentIndex = indexCollection(collectionName, currentRecords);
        const backupIndex = indexCollection(collectionName, backupRecords);
        const identities = Array.from(new Set([...currentIndex.keys(), ...backupIndex.keys()])).sort();
        const result = {
            collection: collectionName,
            currentOnly: 0,
            backupOnly: 0,
            identical: 0,
            conflicts: 0,
        };

        for (const identity of identities) {
            const current = currentIndex.get(identity);
            const backup = backupIndex.get(identity);
            if (current && !backup) {
                result.currentOnly += 1;
                summary.currentOnly += 1;
                continue;
            }
            if (!current && backup) {
                result.backupOnly += 1;
                summary.backupOnly += 1;
                continue;
            }
            if (stableStringify(current.record) === stableStringify(backup.record)) {
                result.identical += 1;
                summary.identical += 1;
                continue;
            }

            result.conflicts += 1;
            summary.conflicts += 1;
            conflicts.push({
                number: conflicts.length + 1,
                collection: collectionName,
                identity,
                current: current.record,
                backup: backup.record,
                resolution: null,
            });
        }

        collectionResults.push(result);
    }

    return { summary, collections: collectionResults, conflicts };
}

function readPlan() {
    if (!fs.existsSync(DATABASE_RECOVERY_PLAN_PATH)) return null;
    const raw = fs.readFileSync(DATABASE_RECOVERY_PLAN_PATH, 'utf8');
    return JSON.parse(raw);
}

function writePlan(plan) {
    const temporaryPath = `${DATABASE_RECOVERY_PLAN_PATH}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(plan, null, 2), 'utf8');
    JSON.parse(fs.readFileSync(temporaryPath, 'utf8'));
    fs.renameSync(temporaryPath, DATABASE_RECOVERY_PLAN_PATH);
}

function getCurrentDatabaseForRecovery() {
    const status = getDatabaseStatus();
    if (status.recoveryMode) {
        if (!status.recoveryState?.corruptPath || !fs.existsSync(status.recoveryState.corruptPath)) {
            throw new Error('Не найдена сохранённая копия повреждённой базы данных');
        }
        try {
            return parseJsonFile(status.recoveryState.corruptPath);
        } catch (_error) {
            return createDefaultDb();
        }
    }
    return readDb();
}

function createRecoveryPlan(backupName) {
    const backupPath = resolveBackupPath(backupName);
    const currentDb = getCurrentDatabaseForRecovery();
    const backupDb = parseJsonFile(backupPath);
    const comparison = compareDatabases(currentDb, backupDb);
    const plan = {
        planId: crypto.randomBytes(8).toString('hex'),
        createdAt: Date.now(),
        backupName,
        currentHash: hashValue(currentDb),
        backupHash: hashValue(backupDb),
        summary: comparison.summary,
        collections: comparison.collections,
        conflicts: comparison.conflicts,
    };
    writePlan(plan);
    return plan;
}

function resolveRecoveryConflict(planId, conflictNumber, resolution) {
    const plan = readPlan();
    if (!plan || plan.planId !== String(planId || '')) throw new Error('План восстановления не найден');
    if (!['keep_current', 'restore_backup'].includes(resolution)) {
        throw new Error('Неизвестный вариант разрешения конфликта');
    }

    const conflict = plan.conflicts.find((item) => item.number === Number(conflictNumber));
    if (!conflict) throw new Error('Конфликт с указанным номером не найден');
    conflict.resolution = resolution;
    conflict.resolvedAt = Date.now();
    writePlan(plan);
    return { plan, conflict };
}

function assertRecoveryPlanSourcesUnchanged(plan, currentDb, backupDb) {
    if (hashValue(currentDb) !== plan.currentHash) {
        throw new Error('Основная база данных изменилась после создания плана. Создайте новый план восстановления.');
    }
    if (hashValue(backupDb) !== plan.backupHash) {
        throw new Error('Резервная копия изменилась после создания плана. Создайте новый план восстановления.');
    }
}

function mergeUsingPlan(currentDb, backupDb, plan) {
    const result = JSON.parse(JSON.stringify(currentDb));
    const conflictMap = new Map(plan.conflicts.map((conflict) => [
        `${conflict.collection}:${conflict.identity}`,
        conflict,
    ]));
    const collections = Array.from(new Set([...Object.keys(currentDb), ...Object.keys(backupDb)])).sort();

    for (const collectionName of collections) {
        const currentRecords = Array.isArray(currentDb[collectionName]) ? currentDb[collectionName] : [];
        const backupRecords = Array.isArray(backupDb[collectionName]) ? backupDb[collectionName] : [];
        const currentIndex = indexCollection(collectionName, currentRecords);
        const backupIndex = indexCollection(collectionName, backupRecords);
        const mergedRecords = currentRecords.map((record) => JSON.parse(JSON.stringify(record)));

        for (const [identity, backupEntry] of backupIndex.entries()) {
            const currentEntry = currentIndex.get(identity);
            if (!currentEntry) {
                mergedRecords.push(JSON.parse(JSON.stringify(backupEntry.record)));
                continue;
            }
            if (stableStringify(currentEntry.record) === stableStringify(backupEntry.record)) continue;

            const conflict = conflictMap.get(`${collectionName}:${identity}`);
            if (!conflict?.resolution) throw new Error(`Конфликт ${collectionName}:${identity} не разрешён`);
            if (conflict.resolution === 'restore_backup') {
                mergedRecords[currentEntry.index] = JSON.parse(JSON.stringify(backupEntry.record));
            }
        }

        result[collectionName] = mergedRecords;
    }

    return result;
}

async function applyRecoveryPlan(planId) {
    const plan = readPlan();
    if (!plan || plan.planId !== String(planId || '')) throw new Error('План восстановления не найден');
    const unresolved = plan.conflicts.filter((conflict) => !conflict.resolution);
    if (unresolved.length) {
        throw new Error(`Не разрешено конфликтов: ${unresolved.length}`);
    }

    const databaseStatus = getDatabaseStatus();
    setMaintenance('Применение плана восстановления базы данных');
    await waitForIdle();

    try {
        if (!databaseStatus.recoveryMode) createSafetyBackup();
        const backupPath = resolveBackupPath(plan.backupName);
        const backupDb = parseJsonFile(backupPath);
        const currentDb = getCurrentDatabaseForRecovery();
        assertRecoveryPlanSourcesUnchanged(plan, currentDb, backupDb);
        const nextDb = mergeUsingPlan(currentDb, backupDb, plan);
        replaceDatabase(nextDb, { leaveMaintenance: true });
        setMaintenance('Требуется перезапуск после восстановления базы данных');
        try {
            fs.unlinkSync(DATABASE_RECOVERY_PLAN_PATH);
        } catch (_error) {
            logger.warn('Не удалось удалить применённый план восстановления базы данных');
        }
        logger.info('План восстановления базы данных применён', {
            planId: plan.planId,
            backup: plan.backupName,
            mode: 'безопасное объединение',
        });
        return {
            planId: plan.planId,
            backupName: plan.backupName,
            mode: 'merge',
        };
    } catch (error) {
        if (!databaseStatus.recoveryMode) clearMaintenance();
        logger.error('Не удалось применить план восстановления базы данных', {
            planId: plan.planId,
            backup: plan.backupName,
        }, error);
        throw error;
    }
}

function getRecoveryPlanStatus() {
    const plan = readPlan();
    if (!plan) return null;
    return {
        planId: plan.planId,
        createdAt: plan.createdAt,
        backupName: plan.backupName,
        summary: plan.summary,
        conflicts: plan.conflicts.length,
        unresolvedConflicts: plan.conflicts.filter((conflict) => !conflict.resolution).length,
    };
}

module.exports = {
    applyRecoveryPlan,
    assertRecoveryPlanSourcesUnchanged,
    compareDatabases,
    createRecoveryPlan,
    getRecoveryPlanStatus,
    readPlan,
    resolveRecoveryConflict,
    stableStringify,
};
