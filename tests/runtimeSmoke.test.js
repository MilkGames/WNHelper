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

const { installRuntimeStubs } = require('./helpers/runtimeStubs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = path.join(PROJECT_ROOT, 'src');

function collectJavaScriptFiles(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) return collectJavaScriptFiles(entryPath);
        return entry.isFile() && entry.name.endsWith('.js') ? [entryPath] : [];
    });
}

test('все runtime-модули загружаются с изолированными Discord-зависимостями', () => {
    const restore = installRuntimeStubs();
    const failures = [];
    try {
        for (const filePath of collectJavaScriptFiles(SRC_ROOT)) {
            if (filePath === path.join(SRC_ROOT, 'index.js')) continue;
            try {
                require(filePath);
            } catch (error) {
                failures.push({
                    file: path.relative(PROJECT_ROOT, filePath),
                    error: error.stack || error.message,
                });
            }
        }
    } finally {
        restore();
    }
    assert.deepEqual(failures, []);
});

test('публичные фасады модулей не скрывают одинаковые ключи при последовательных spread', () => {
    const restore = installRuntimeStubs();
    try {
        const modulesRoot = path.join(SRC_ROOT, 'modules');
        const collisions = [];
        for (const moduleName of fs.readdirSync(modulesRoot)) {
            const indexPath = path.join(modulesRoot, moduleName, 'index.js');
            if (!fs.existsSync(indexPath)) continue;
            const source = fs.readFileSync(indexPath, 'utf8');
            const requires = new Map();
            for (const match of source.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*require\(['"]([^'"]+)['"]\);/gu)) {
                requires.set(match[1], match[2]);
            }
            const owners = new Map();
            for (const match of source.matchAll(/\.\.\.([A-Za-z_$][\w$]*)/gu)) {
                const variableName = match[1];
                const request = requires.get(variableName);
                if (!request) continue;
                const exported = require(path.resolve(path.dirname(indexPath), request));
                for (const key of Object.keys(exported || {})) {
                    const previous = owners.get(key);
                    if (previous && previous !== variableName) {
                        collisions.push(`${moduleName}.${key}: ${previous}, ${variableName}`);
                    } else {
                        owners.set(key, variableName);
                    }
                }
            }
        }
        assert.deepEqual(collisions, []);
    } finally {
        restore();
    }
});

test('реестры загружают команды и перенесённые модули один раз', () => {
    const restore = installRuntimeStubs();
    try {
        const commands = require('../src/app/commandRegistry');
        const modules = require('../src/app/moduleRegistry');
        const firstCommands = commands.loadCommands();
        const secondCommands = commands.loadCommands();
        const firstModules = modules.loadModules();
        const secondModules = modules.loadModules();

        assert.equal(firstCommands, secondCommands);
        assert.equal(firstModules, secondModules);
        assert.ok(firstCommands.length > 0);
        assert.deepEqual(
            firstModules.map((descriptor) => descriptor.name),
            ['channel-counters', 'staff-lists', 'forms', 'give-roles', 'shifts', 'examination', 'vacations', 'staff-audit', 'offboarding', 'discipline', 'settings', 'manual-tools', 'analytics', 'health']
        );
    } finally {
        restore();
    }
});


test('реестр событий сохраняет порядок старых обработчиков после переноса', () => {
    const restore = installRuntimeStubs();
    try {
        const { groupEvents } = require('../src/app/eventRegistry');
        const grouped = groupEvents();
        assert.deepEqual(
            grouped.get('clientReady').map((event) => event.id),
            [
                '00registerGuildConfigs.js',
                'app.registerCommands',
                'changeChannelName.js',
                'app.status',
                'disciplineScheduler.js',
                'editChannelMessage.js',
                'examinationScheduler.js',
                'getExams.js',
                'getForms.js',
                'massDisciplineScheduler.js',
                'sendScheduleMessage.js',
                'vacationScheduler.js',
                'zzStartWebhookServer.js',
                'app.readyLog',
            ]
        );
        const interactionIds = grouped.get('interactionCreate').map((event) => event.id);
        assert.ok(interactionIds.indexOf('giveRoles.js') < interactionIds.indexOf('app.commandHandler'));
        assert.ok(interactionIds.indexOf('app.commandHandler') < interactionIds.indexOf('manual-tools.shutdownConfirmation'));
        assert.ok(interactionIds.includes('manual-tools.shutdownConfirmation'));
        const memberAddIds = grouped.get('guildMemberAdd').map((event) => event.id);
        assert.deepEqual(memberAddIds, [
            'updateStaffOverview.js:01-staff-lists',
            'updateStaffOverview.js:02-channel-counters',
        ]);
    } finally {
        restore();
    }
});

test('режим восстановления подключает только безопасные обработчики', () => {
    const restore = installRuntimeStubs();
    try {
        const { groupEvents } = require('../src/app/eventRegistry');
        const grouped = groupEvents({ recoveryMode: true });
        assert.deepEqual(
            grouped.get('clientReady').map((event) => event.id),
            ['app.registerCommands', 'app.status', 'app.readyLog']
        );
        assert.deepEqual(
            grouped.get('interactionCreate').map((event) => event.id),
            ['app.recoveryAccess', 'app.commandHandler', 'manual-tools.shutdownConfirmation', 'manual-tools.databaseRecoveryConfirmation']
        );
        assert.equal(grouped.size, 2);
    } finally {
        restore();
    }
});


test('реестр команд сохраняет полный публичный набор после переноса', () => {
    const restore = installRuntimeStubs();
    try {
        const commands = require('../src/app/commandRegistry').loadCommands();
        const names = commands.map((command) => command?.data?.name || command?.name).filter(Boolean).sort();
        assert.deepEqual(names, [
            'discipline',
            'fullmsgscan',
            'invite',
            'manualtools',
            'massaudit',
            'massdiscipline',
            'ping',
            'rank',
            'sendexam',
            'settings',
            'uval',
        ]);
    } finally {
        restore();
    }
});

test('все статически вызываемые межмодульные действия зарегистрированы', () => {
    const restore = installRuntimeStubs();
    try {
        const { loadModules } = require('../src/app/moduleRegistry');
        const { getActionNames } = require('../src/core/integrations/actionRegistry');
        loadModules();
        const registered = new Set(getActionNames());
        const invoked = new Set();
        const pattern = /invokeAction\(\s*['"]([^'"]+)['"]/gu;
        for (const filePath of collectJavaScriptFiles(SRC_ROOT)) {
            const source = fs.readFileSync(filePath, 'utf8');
            for (const match of source.matchAll(pattern)) invoked.add(match[1]);
        }
        assert.deepEqual(
            [...invoked].filter((name) => !registered.has(name)).sort(),
            []
        );
    } finally {
        restore();
    }
});
