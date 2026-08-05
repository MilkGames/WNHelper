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
const { mutateDatabase: mutateDb } = require('./database');

const RECEIPT_RETENTION_MS = 24 * 60 * 60_000;

function ensureCollection(db, name) {
    if (!Array.isArray(db[name])) db[name] = [];
    return db[name];
}

function removeExpiredReceipts(receipts, now) {
    let writeIndex = 0;
    for (const receipt of receipts) {
        if ((Number(receipt?.expiresAt) || 0) <= now) continue;
        receipts[writeIndex] = receipt;
        writeIndex += 1;
    }
    receipts.length = writeIndex;
}

async function enqueueWebhookJob({ collectionName, source, job }) {
    if (!collectionName) throw new Error('enqueueWebhookJob: collectionName не указан');
    if (!source) throw new Error('enqueueWebhookJob: source не указан');
    if (!job?.jobKey) throw new Error('enqueueWebhookJob: job.jobKey не указан');

    return mutateDb((db) => {
        const now = Date.now();
        const receipts = ensureCollection(db, 'webhookReceipts');
        const queue = ensureCollection(db, collectionName);
        removeExpiredReceipts(receipts, now);

        const receipt = receipts.find((item) => item.key === job.jobKey);
        if (receipt) {
            return {
                inserted: false,
                dedupeSource: 'receipt',
                document: {
                    jobId: null,
                    jobKey: job.jobKey,
                    status: 'delivered',
                    deliveredAt: receipt.deliveredAt,
                },
            };
        }

        const existing = queue.find((item) => item.jobKey === job.jobKey);
        if (existing) {
            return {
                inserted: false,
                dedupeSource: 'queue',
                document: { ...existing },
            };
        }

        queue.push({ ...job });
        return {
            inserted: true,
            dedupeSource: null,
            document: { ...job },
        };
    });
}

async function completeWebhookJob({ collectionName, source, jobId, jobKey }) {
    if (!collectionName) throw new Error('completeWebhookJob: collectionName не указан');
    if (!source) throw new Error('completeWebhookJob: source не указан');
    if (!jobId) throw new Error('completeWebhookJob: jobId не указан');
    if (!jobKey) throw new Error('completeWebhookJob: jobKey не указан');

    return mutateDb((db) => {
        const now = Date.now();
        const receipts = ensureCollection(db, 'webhookReceipts');
        const queue = ensureCollection(db, collectionName);
        removeExpiredReceipts(receipts, now);

        const existingReceiptIndex = receipts.findIndex((item) => item.key === jobKey);
        const receipt = {
            key: jobKey,
            source,
            deliveredAt: now,
            expiresAt: now + RECEIPT_RETENTION_MS,
        };
        if (existingReceiptIndex === -1) receipts.push(receipt);
        else receipts[existingReceiptIndex] = receipt;

        const jobIndex = queue.findIndex((item) => item.jobId === jobId);
        if (jobIndex !== -1) queue.splice(jobIndex, 1);

        return {
            deletedCount: jobIndex === -1 ? 0 : 1,
            receipt: { ...receipt },
        };
    });
}

async function cleanupWebhookReceipts({ now = Date.now() } = {}) {
    return mutateDb((db) => {
        const receipts = ensureCollection(db, 'webhookReceipts');
        const before = receipts.length;
        removeExpiredReceipts(receipts, now);
        return before - receipts.length;
    });
}

module.exports = {
    RECEIPT_RETENTION_MS,
    cleanupWebhookReceipts,
    completeWebhookJob,
    enqueueWebhookJob,
};
