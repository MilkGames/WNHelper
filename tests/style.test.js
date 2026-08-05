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
const fs = require('fs');
const test = require('./helpers/createTest')(__filename);

const { PROJECT_ROOT, collectJavaScriptFiles, collectFiles } = require('./helpers/projectFiles');

const HEADER_PATTERN = /^\/\*\n \* WN Helper Discord Bot\n \* Copyright \(C\) (?:2026|\d{4}-2026) MilkGames\n \*\n \* This program is free software: you can redistribute it and\/or modify\n \* it under the terms of the GNU General Public License as published by\n \* the Free Software Foundation, either version 3 of the License, or\n \* \(at your option\) any later version\.\n \*\n \* This program is distributed in the hope that it will be useful,\n \* but WITHOUT ANY WARRANTY; without even the implied warranty of\n \* MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE\.  See the\n \* GNU General Public License for more details\.\n \*\n \* You should have received a copy of the GNU General Public License\n \* along with this program\. If not, see <https:\/\/www\.gnu\.org\/licenses\/>\.\n \*\/\n[^\n]/u;

test('каждый js файл начинается с copyright', () => {
    const violations = [];
    const files = [
        ...collectJavaScriptFiles(),
        ...collectFiles(`${PROJECT_ROOT}/tests`, (filePath) => filePath.endsWith('.js')),
    ];
    for (const filePath of files) {
        const buffer = fs.readFileSync(filePath);
        const source = buffer.toString('utf8');
        if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
            violations.push(`${filePath}: BOM`);
            continue;
        }
        if (!HEADER_PATTERN.test(source)) violations.push(filePath);
    }
    assert.deepEqual(violations, []);
});

test('в исходниках нет случайного длинного тире и типографских кавычек от docx файлов', () => {
    const violations = [];
    const files = [
        ...collectJavaScriptFiles(),
        ...collectFiles(`${PROJECT_ROOT}/tests`, (filePath) => filePath.endsWith('.js')),
    ];
    for (const filePath of files) {
        const source = fs.readFileSync(filePath, 'utf8');
        if (/[\u2014\u2013\u00ab\u00bb\u201c\u201d]/u.test(source)) violations.push(filePath);
    }
    assert.deepEqual(violations, []);
});
