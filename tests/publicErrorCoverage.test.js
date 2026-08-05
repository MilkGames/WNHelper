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
const path = require('node:path');
const test = require('./helpers/createTest')(__filename);
const { collectJavaScriptFiles, PROJECT_ROOT } = require('./helpers/projectFiles');

const GENERIC_FRONT_ERROR_PATTERNS = [
    /Произошла внутренняя ошибка/gu,
    /Ошибка записана в лог/gu,
    /Подробности записаны в лог/gu,
];

test('обработчики с общей технической ошибкой используют безопасный публичный formatter', () => {
    const failures = [];
    for (const filePath of collectJavaScriptFiles().filter((candidate) => (
        candidate.includes(`${path.sep}src${path.sep}modules${path.sep}`) ||
        candidate.endsWith(`${path.sep}src${path.sep}app${path.sep}commandHandler.js`)
    ))) {
        const source = fs.readFileSync(filePath, 'utf8');
        if (!GENERIC_FRONT_ERROR_PATTERNS.some((pattern) => pattern.test(source))) continue;
        if (source.includes('buildPublicErrorMessage(')) continue;
        failures.push(path.relative(PROJECT_ROOT, filePath).replaceAll('\\', '/'));
    }
    assert.deepEqual(failures, []);
});
