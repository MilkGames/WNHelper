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
const { installRuntimeStubs } = require('./helpers/runtimeStubs');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function createIsolatedDiscipline() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wn-helper-discipline-threads-'));
    fs.cpSync(path.join(PROJECT_ROOT, 'src'), path.join(root, 'src'), { recursive: true });
    writeTestConfig(root);
    const database = require(path.join(root, 'src', 'core', 'database', 'localDatabase.js'));
    database.initializeDatabase();
    const disciplineDatabase = require(path.join(root, 'src', 'modules', 'discipline', 'database.js'));
    const service = require(path.join(root, 'src', 'modules', 'discipline', 'service.js'));
    const appealService = require(path.join(root, 'src', 'modules', 'discipline', 'appealService.js'));
    const massService = require(path.join(root, 'src', 'modules', 'discipline', 'massService.js'));
    return { root, disciplineDatabase, service, appealService, massService };
}

function createThread(id, closed) {
    return {
        id,
        archived: false,
        locked: false,
        isThread: () => true,
        async setLocked(value) {
            this.locked = value;
            closed.push(`${id}:locked`);
            return this;
        },
        async setArchived(value) {
            this.archived = value;
            closed.push(`${id}:archived`);
            return this;
        },
    };
}

test('завершённые процессы закрывают собственные ветки, а активные остаются открытыми', async (context) => {
    const restore = installRuntimeStubs();
    const isolated = createIsolatedDiscipline();
    context.after(() => {
        restore();
        fs.rmSync(isolated.root, { recursive: true, force: true });
    });

    await new isolated.disciplineDatabase.disciplineCases({
        caseId: 'case-finished',
        status: 'completed',
        evidenceThreadId: 'case-thread',
        sanctions: [],
    }).save();
    await new isolated.disciplineDatabase.disciplineCases({
        caseId: 'case-active',
        status: 'active',
        evidenceThreadId: 'active-thread',
        sanctions: [],
    }).save();
    await new isolated.disciplineDatabase.disciplineCases({
        caseId: 'case-mass',
        status: 'completed',
        evidenceThreadId: 'shared-thread',
        batchId: 'mass-1',
        sanctions: [],
    }).save();
    await new isolated.disciplineDatabase.disciplineRemovalRequests({
        requestId: 'removal-1',
        status: 'approved',
        threadId: 'removal-thread',
    }).save();
    await new isolated.disciplineDatabase.disciplineAppeals({
        appealId: 'appeal-1',
        status: 'satisfied',
        threadId: 'appeal-thread',
    }).save();
    await new isolated.disciplineDatabase.massDisciplineBatches({
        massdisciplineId: 'mass-1',
        status: 'completed',
        sharedThreadId: 'shared-thread',
    }).save();

    const closed = [];
    const threads = new Map([
        'case-thread',
        'active-thread',
        'removal-thread',
        'appeal-thread',
        'shared-thread',
    ].map((id) => [id, createThread(id, closed)]));
    const client = {
        channels: {
            async fetch(id) {
                return threads.get(String(id)) || null;
            },
        },
    };

    await isolated.service.closeInactiveDisciplineThreads(client);
    await isolated.appealService.closeInactiveAppealThreads(client);
    await isolated.massService.closeInactiveMassThreads(client);

    for (const id of ['case-thread', 'removal-thread', 'appeal-thread', 'shared-thread']) {
        assert.equal(threads.get(id).locked, true, id);
        assert.equal(threads.get(id).archived, true, id);
    }
    assert.equal(threads.get('active-thread').locked, false);
    assert.equal(threads.get('active-thread').archived, false);
    assert.equal(closed.filter((entry) => entry.startsWith('shared-thread:')).length, 2);
});

test('обжалования и подтверждения увольнения используют единый стандартный footer', () => {
    const restore = installRuntimeStubs();
    try {
        const { getDefaultFooter } = require('../src/core/ui/defaultFooter');
        const { buildAppealEmbed } = require('../src/modules/discipline/appealPresentation');
        const { buildApprovalEmbed } = require('../src/modules/offboarding/presentation');
        const expected = getDefaultFooter();
        const appealEmbed = buildAppealEmbed({
            appealId: 'appeal-1',
            applicantId: '1',
            applicantDisplayName: 'Сотрудник',
            type: 'basis',
            sanctionLabel: 'Письменный выговор',
            sanctionMessageLink: 'https://discord.com/channels/1/2/3',
            reason: 'Причина',
            threadId: null,
            currentStageKey: null,
            status: 'creating',
            createdAt: 1_700_000_000_000,
        });
        const offboardingEmbed = buildApprovalEmbed([{
            actorId: '1',
            targetMemberId: '2',
            targetDisplayName: 'Сотрудник',
            source: 'slash_uval',
            reason: 'Причина',
            createdAt: 1_700_000_000_000,
        }]);

        assert.deepEqual(appealEmbed.data.setFooter[0], expected);
        assert.deepEqual(offboardingEmbed.data.setFooter[0], expected);
    } finally {
        restore();
    }
});

test('адрес и текст стандартного footer определены только в общем UI-модуле', () => {
    const footerPath = path.join(PROJECT_ROOT, 'src', 'core', 'ui', 'defaultFooter.js');
    const files = [];
    function walk(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const fullPath = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(fullPath);
            else if (entry.name.endsWith('.js')) files.push(fullPath);
        }
    }
    walk(path.join(PROJECT_ROOT, 'src'));

    const duplicates = files.filter((filePath) => (
        filePath !== footerPath && fs.readFileSync(filePath, 'utf8').includes('https://i.imgur.com/zdxWb0s.jpeg')
    ));
    assert.deepEqual(duplicates, []);
});

test('ошибка блокировки ветки не мешает её архивировать', async () => {
    const restore = installRuntimeStubs();
    try {
        const { closeThreadWithRetry } = require('../src/core/discord/request');
        const thread = {
            archived: false,
            locked: false,
            async setLocked() {
                throw new Error('Нет права блокировать ветку');
            },
            async setArchived(value) {
                this.archived = value;
                return this;
            },
        };

        const result = await closeThreadWithRetry(thread, { attempts: 1 });
        assert.equal(result.locked, false);
        assert.equal(result.archived, true);
        assert.match(result.lockError.message, /Нет права блокировать/);
    } finally {
        restore();
    }
});
