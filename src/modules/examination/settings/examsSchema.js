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
const EXAM_CHECK_MODES = new Set(['automatic', 'manualScore']);

function clone(value) {
    return value == null ? value : structuredClone(value);
}

function normalizeText(value) {
    return String(value || '').trim();
}

function normalizeNullableUrl(value) {
    const normalized = normalizeText(value);
    return normalized || null;
}

function normalizePositiveInteger(value, fallback = null) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function normalizeAttempts(value, fallback = 2) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 && number <= 100 ? number : fallback;
}

function normalizeExam(exam) {
    const source = exam && typeof exam === 'object' ? exam : {};
    const mode = EXAM_CHECK_MODES.has(source.checkMode)
        ? source.checkMode
        : 'automatic';

    return {
        id: normalizeText(source.id),
        name: normalizeText(source.name),
        testId: normalizeText(source.testId),
        quickCheckUrl: normalizeNullableUrl(source.quickCheckUrl),
        checkMode: mode,
        maxScore: normalizePositiveInteger(source.maxScore),
        passScore: normalizePositiveInteger(source.passScore),
        maxAttempts: normalizeAttempts(source.maxAttempts, 2),
        retestEnabled: source.retestEnabled === true,
    };
}

function getExams(config) {
    return (Array.isArray(config?.exams) ? config.exams : []).map(normalizeExam);
}

function prepareExamsForStorage(exams) {
    return (Array.isArray(exams) ? exams : []).map(normalizeExam);
}

function getExamChanges(beforeExams, afterExams) {
    const before = prepareExamsForStorage(beforeExams);
    const after = prepareExamsForStorage(afterExams);
    const changes = [];
    const beforeById = new Map(before.map((exam, index) => [exam.id, { exam, index }]));
    const afterById = new Map(after.map((exam, index) => [exam.id, { exam, index }]));

    for (const { exam, index } of afterById.values()) {
        const previous = beforeById.get(exam.id);
        if (!previous) {
            changes.push({
                section: 'exams',
                action: 'added',
                exam: clone(exam),
                examId: exam.id,
                examName: exam.name,
                index,
            });
            continue;
        }

        if (previous.index !== index) {
            changes.push({
                section: 'exams',
                action: 'moved',
                examId: exam.id,
                examName: exam.name,
                before: previous.index,
                after: index,
            });
        }

        for (const [key, label, valueType] of [
            ['name', 'название', 'text'],
            ['testId', 'testId', 'text'],
            ['quickCheckUrl', 'ссылка быстрой проверки', 'url'],
            ['checkMode', 'режим проверки', 'checkMode'],
            ['maxScore', 'максимальный балл', 'number'],
            ['passScore', 'проходной балл', 'number'],
            ['maxAttempts', 'максимальное количество сдач', 'attempts'],
            ['retestEnabled', 'пересдачи', 'boolean'],
        ]) {
            if (previous.exam[key] === exam[key]) continue;
            changes.push({
                section: 'exams',
                action: 'updated',
                examId: exam.id,
                examName: exam.name,
                key,
                label,
                valueType,
                before: previous.exam[key],
                after: exam[key],
            });
        }
    }

    for (const { exam, index } of beforeById.values()) {
        if (afterById.has(exam.id)) continue;
        changes.push({
            section: 'exams',
            action: 'removed',
            exam: clone(exam),
            examId: exam.id,
            examName: exam.name,
            index,
        });
    }

    return changes;
}

function findExamById(config, examId) {
    const normalizedId = normalizeText(examId);
    return getExams(config).find((exam) => exam.id === normalizedId) || null;
}

module.exports = {
    EXAM_CHECK_MODES,
    findExamById,
    getExamChanges,
    getExams,
    prepareExamsForStorage,
};
