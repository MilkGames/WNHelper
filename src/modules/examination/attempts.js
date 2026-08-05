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
const { mutateDatabase: mutateDb, readDatabase: readDb } = require('./database');

function normalizeKey(value) {
    return String(value || '').trim();
}

function findState(db, guildId, memberId, examId) {
    return (db.examAttempts || []).find((entry) => (
        String(entry.guildId) === String(guildId) &&
        String(entry.memberId) === String(memberId) &&
        String(entry.examId) === String(examId)
    )) || null;
}

function getAttemptState(guildId, memberId, examId) {
    const db = readDb();
    const state = findState(db, guildId, memberId, examId);
    return state ? structuredClone(state) : {
        guildId: normalizeKey(guildId),
        memberId: normalizeKey(memberId),
        examId: normalizeKey(examId),
        attemptsUsed: 0,
    };
}

function getAttemptDisplay(guildId, memberId, exam) {
    const maxAttempts = Number.isSafeInteger(exam?.maxAttempts) && exam.maxAttempts >= 0
        ? exam.maxAttempts
        : 2;
    if (maxAttempts === 0) {
        return {
            attemptsUsed: 0,
            currentAttempt: null,
            maxAttempts: 0,
            unlimited: true,
            text: null,
        };
    }

    const state = getAttemptState(guildId, memberId, exam?.id);
    const attemptsUsed = Number.isSafeInteger(state.attemptsUsed) && state.attemptsUsed >= 0
        ? state.attemptsUsed
        : 0;
    const currentAttempt = attemptsUsed + 1;
    return {
        attemptsUsed,
        currentAttempt,
        maxAttempts,
        unlimited: false,
        text: currentAttempt <= maxAttempts
            ? `${currentAttempt} из ${maxAttempts}`
            : `${currentAttempt}; лимит обычных попыток - ${maxAttempts}`,
    };
}

async function recordFailedAttempt({ guildId, memberId, examId, messageId, maxAttempts = null }) {
    if (Number(maxAttempts) === 0) {
        return { attemptsUsed: 0, deduped: false, unlimited: true };
    }
    const normalized = {
        guildId: normalizeKey(guildId),
        memberId: normalizeKey(memberId),
        examId: normalizeKey(examId),
        messageId: normalizeKey(messageId),
    };
    if (!normalized.guildId || !normalized.memberId || !normalized.examId || !normalized.messageId) {
        throw new Error('Для учёта попытки экзамена не хватает идентификаторов.');
    }

    return mutateDb((db) => {
        db.examAttempts ||= [];
        let state = findState(db, normalized.guildId, normalized.memberId, normalized.examId);
        if (!state) {
            state = {
                guildId: normalized.guildId,
                memberId: normalized.memberId,
                examId: normalized.examId,
                attemptsUsed: 0,
                processedMessageIds: [],
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };
            db.examAttempts.push(state);
        }

        state.processedMessageIds = Array.isArray(state.processedMessageIds)
            ? state.processedMessageIds.map(String)
            : [];
        if (state.processedMessageIds.includes(normalized.messageId)) {
            return { attemptsUsed: state.attemptsUsed || 0, deduped: true };
        }

        state.attemptsUsed = (Number.isSafeInteger(state.attemptsUsed) && state.attemptsUsed >= 0
            ? state.attemptsUsed
            : 0) + 1;
        state.processedMessageIds.push(normalized.messageId);
        state.processedMessageIds = state.processedMessageIds.slice(-50);
        state.updatedAt = Date.now();
        return { attemptsUsed: state.attemptsUsed, deduped: false };
    });
}

async function clearAfterPass({ guildId, memberId, examId }) {
    const normalized = {
        guildId: normalizeKey(guildId),
        memberId: normalizeKey(memberId),
        examId: normalizeKey(examId),
    };
    return mutateDb((db) => {
        db.examAttempts ||= [];
        const before = db.examAttempts.length;
        db.examAttempts = db.examAttempts.filter((entry) => !(
            String(entry.guildId) === normalized.guildId &&
            String(entry.memberId) === normalized.memberId &&
            String(entry.examId) === normalized.examId
        ));
        return { deletedCount: before - db.examAttempts.length };
    });
}

async function closeMemberAttempts(guildId, memberId) {
    const normalizedGuildId = normalizeKey(guildId);
    const normalizedMemberId = normalizeKey(memberId);
    return mutateDb((db) => {
        db.examAttempts ||= [];
        const before = db.examAttempts.length;
        db.examAttempts = db.examAttempts.filter((entry) => !(
            String(entry.guildId) === normalizedGuildId &&
            String(entry.memberId) === normalizedMemberId
        ));
        return before - db.examAttempts.length;
    });
}

module.exports = {
    clearAfterPass,
    closeMemberAttempts,
    getAttemptDisplay,
    getAttemptState,
    recordFailedAttempt,
};
