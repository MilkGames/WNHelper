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
const path = require('path');
const test = require('./helpers/createTest')(__filename);

const { PROJECT_ROOT, collectJavaScriptFiles } = require('./helpers/projectFiles');

const SRC_ROOT = path.join(PROJECT_ROOT, 'src');
const MODULES_ROOT = path.join(SRC_ROOT, 'modules');
const REMOVED_ROOTS = [
    'commands',
    'config',
    'events',
    'features',
    'handlers',
    'models',
    'services',
    'utils',
];

function normalize(filePath) {
    return path.relative(PROJECT_ROOT, filePath).replace(/\\/gu, '/');
}

function moduleNames() {
    return fs.readdirSync(MODULES_ROOT, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
}

function resolveRelativeRequire(filePath, request, fileSet) {
    const base = path.resolve(path.dirname(filePath), request);
    return [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')]
        .map((candidate) => path.resolve(candidate))
        .find((candidate) => fileSet.has(candidate) || fs.existsSync(candidate)) || null;
}

function buildGraph() {
    const files = collectJavaScriptFiles().map((filePath) => path.resolve(filePath));
    const fileSet = new Set(files);
    const graph = new Map(files.map((filePath) => [filePath, []]));
    const pattern = /require\(\s*['"](\.[^'"]+)['"]\s*\)/gu;

    for (const filePath of files) {
        const source = fs.readFileSync(filePath, 'utf8');
        for (const match of source.matchAll(pattern)) {
            const target = resolveRelativeRequire(filePath, match[1], fileSet);
            if (target && fileSet.has(target)) graph.get(filePath).push(target);
        }
    }
    return graph;
}

function findCycles(graph) {
    let nextIndex = 0;
    const indices = new Map();
    const lowLinks = new Map();
    const stack = [];
    const onStack = new Set();
    const components = [];

    function visit(filePath) {
        indices.set(filePath, nextIndex);
        lowLinks.set(filePath, nextIndex);
        nextIndex += 1;
        stack.push(filePath);
        onStack.add(filePath);

        for (const target of graph.get(filePath) || []) {
            if (!indices.has(target)) {
                visit(target);
                lowLinks.set(filePath, Math.min(lowLinks.get(filePath), lowLinks.get(target)));
            } else if (onStack.has(target)) {
                lowLinks.set(filePath, Math.min(lowLinks.get(filePath), indices.get(target)));
            }
        }

        if (lowLinks.get(filePath) !== indices.get(filePath)) return;
        const component = [];
        for (;;) {
            const target = stack.pop();
            onStack.delete(target);
            component.push(target);
            if (target === filePath) break;
        }
        if (component.length > 1) components.push(component);
    }

    for (const filePath of graph.keys()) {
        if (!indices.has(filePath)) visit(filePath);
    }
    return components;
}

test('старая слоистая структура удалена после полного переноса', () => {
    const existing = REMOVED_ROOTS.filter((directory) => fs.existsSync(path.join(SRC_ROOT, directory)));
    assert.deepEqual(existing, []);
});

test('каждый функциональный модуль имеет публичный index.js', () => {
    const missing = moduleNames().filter((name) => !fs.existsSync(path.join(MODULES_ROOT, name, 'index.js')));
    assert.deepEqual(missing, []);
});

test('все относительные require указывают на существующие файлы', () => {
    const pattern = /require\((['"])([^'"]+)\1\)/gu;
    const missing = [];
    const files = collectJavaScriptFiles();
    const fileSet = new Set(files.map((filePath) => path.resolve(filePath)));

    for (const filePath of files) {
        const source = fs.readFileSync(filePath, 'utf8');
        for (const match of source.matchAll(pattern)) {
            const request = match[2];
            if (!request.startsWith('.')) continue;
            if (!resolveRelativeRequire(filePath, request, fileSet)) {
                missing.push(`${normalize(filePath)} -> ${request}`);
            }
        }
    }
    assert.deepEqual(missing, []);
});

test('внешний код импортирует модуль только через его index.js', () => {
    const violations = [];
    const files = collectJavaScriptFiles();
    const fileSet = new Set(files.map((filePath) => path.resolve(filePath)));
    const pattern = /require\((['"])([^'"]+)\1\)/gu;

    for (const filePath of files) {
        const source = fs.readFileSync(filePath, 'utf8');
        const importer = normalize(filePath);
        for (const match of source.matchAll(pattern)) {
            const request = match[2];
            if (!request.startsWith('.')) continue;
            const target = resolveRelativeRequire(filePath, request, fileSet);
            if (!target) continue;
            const targetRelative = normalize(target);
            const targetMatch = /^src\/modules\/([^/]+)\/(.+)$/u.exec(targetRelative);
            if (!targetMatch) continue;
            const moduleName = targetMatch[1];
            if (importer.startsWith(`src/modules/${moduleName}/`)) continue;
            if (targetMatch[2] !== 'index.js') violations.push(`${importer} -> ${targetRelative}`);
        }
    }
    assert.deepEqual(violations, []);
});

test('core не зависит от функциональных модулей', () => {
    const violations = [];
    const pattern = /require\((['"])([^'"]+)\1\)/gu;
    for (const filePath of collectJavaScriptFiles()) {
        const relativePath = normalize(filePath);
        if (!relativePath.startsWith('src/core/')) continue;
        const source = fs.readFileSync(filePath, 'utf8');
        for (const match of source.matchAll(pattern)) {
            if (match[2].includes('modules/')) violations.push(`${relativePath} -> ${match[2]}`);
        }
    }
    assert.deepEqual(violations, []);
});

test('в runtime-графе отсутствуют циклические зависимости', () => {
    const cycles = findCycles(buildGraph()).map((component) => component.map(normalize).sort());
    assert.deepEqual(cycles, []);
});


test('только database.js модулей обращаются к низкоуровневой локальной базе', () => {
    const violations = [];
    for (const filePath of collectJavaScriptFiles()) {
        const relativePath = normalize(filePath);
        if (!relativePath.startsWith('src/modules/')) continue;
        const source = fs.readFileSync(filePath, 'utf8');
        if (!source.includes('core/database/localDatabase')) continue;
        if (!relativePath.endsWith('/database.js')) violations.push(relativePath);
    }
    assert.deepEqual(violations, []);
});

test('сервисы бизнес-логики не создают Discord UI напрямую', () => {
    const violations = [];
    const serviceNames = new Set(['service.js', 'appealService.js', 'massService.js']);
    for (const filePath of collectJavaScriptFiles()) {
        const relativePath = normalize(filePath);
        if (!relativePath.startsWith('src/modules/')) continue;
        if (!serviceNames.has(path.basename(filePath))) continue;
        const source = fs.readFileSync(filePath, 'utf8');
        if (/\b(?:EmbedBuilder|ActionRowBuilder|ButtonBuilder|ModalBuilder|StringSelectMenuBuilder)\b/u.test(source)) {
            violations.push(relativePath);
        }
    }
    assert.deepEqual(violations, []);
});

test('runtime не содержит migrations, schemaVersion и legacy fallback', () => {
    const violations = [];
    const forbidden = [
        { label: 'schemaVersion', pattern: /\bschemaVersion\b/u },
        { label: 'migration', pattern: /\bmigrat(?:e|es|ed|ing|ion|ions)\b/iu },
        { label: 'legacy', pattern: /\blegacy\b/iu },
    ];

    for (const filePath of collectJavaScriptFiles()) {
        const relativePath = normalize(filePath);
        if (!relativePath.startsWith('src/')) continue;
        const source = fs.readFileSync(filePath, 'utf8');
        for (const rule of forbidden) {
            if (rule.pattern.test(source)) violations.push(`${relativePath}: ${rule.label}`);
        }
    }

    assert.deepEqual(violations, []);
});
