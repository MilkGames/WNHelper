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

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SOURCE_ROOT = path.join(PROJECT_ROOT, 'src');
const INTERACTIONS_PATH = path.join(SOURCE_ROOT, 'modules', 'settings', 'interactions.js');
const PRESENTATION_PATH = path.join(SOURCE_ROOT, 'modules', 'settings', 'presentation.js');

function collectJavaScriptFiles(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) return collectJavaScriptFiles(entryPath);
        return entry.isFile() && entry.name.endsWith('.js') ? [entryPath] : [];
    });
}

function parseValidSections(source) {
    const match = source.match(/const VALID_SECTIONS = new Set\(\[(.*?)\]\);/su);
    assert.ok(match, 'Не найден реестр VALID_SECTIONS.');
    return new Set(Array.from(match[1].matchAll(/['"]([^'"]+)['"]/gu), (entry) => entry[1]));
}

function parsePresentationSections(source) {
    return new Set(Array.from(source.matchAll(/case\s+['"]([^'"]+)['"]\s*:/gu), (entry) => entry[1]));
}

function collectLiteralNavigationTargets() {
    const targets = new Map();
    const pattern = /createButton\(\s*session\s*,\s*['"]nav['"]\s*,\s*['"][^'"]*['"]\s*,\s*[^,]+,\s*['"]([^'"]+)['"]\s*\)/gsu;

    for (const filePath of collectJavaScriptFiles(SOURCE_ROOT)) {
        const source = fs.readFileSync(filePath, 'utf8');
        for (const match of source.matchAll(pattern)) {
            const target = match[1];
            const locations = targets.get(target) || [];
            locations.push(path.relative(PROJECT_ROOT, filePath).replaceAll('\\', '/'));
            targets.set(target, locations);
        }
    }
    return targets;
}

test('все кнопки навигации /settings ведут в зарегистрированные и отображаемые окна', () => {
    const validSections = parseValidSections(fs.readFileSync(INTERACTIONS_PATH, 'utf8'));
    const presentationSections = parsePresentationSections(fs.readFileSync(PRESENTATION_PATH, 'utf8'));
    const navigationTargets = collectLiteralNavigationTargets();
    const failures = [];

    for (const [target, locations] of navigationTargets) {
        if (!validSections.has(target)) {
            failures.push(`Окно ${target} используется в ${locations.join(', ')}, но отсутствует в VALID_SECTIONS.`);
        }
        if (target !== 'main' && !presentationSections.has(target)) {
            failures.push(`Окно ${target} используется в ${locations.join(', ')}, но не отображается presentation.js.`);
        }
    }

    for (const target of presentationSections) {
        if (!validSections.has(target)) {
            failures.push(`Окно ${target} отображается presentation.js, но отсутствует в VALID_SECTIONS.`);
        }
    }

    assert.deepEqual(failures, []);
});
