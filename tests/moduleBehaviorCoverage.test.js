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
const path = require('node:path');
const nodeTest = require('node:test');
const test = require('./helpers/createTest')(__filename);
const { installRuntimeStubs } = require('./helpers/runtimeStubs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const restoreRuntimeStubs = installRuntimeStubs();
nodeTest.after(restoreRuntimeStubs);

function loadWithMocks(relativeTarget, mocks) {
    const targetPath = require.resolve(path.join(PROJECT_ROOT, relativeTarget));
    const savedEntries = new Map();

    for (const [relativeMockPath, exportsValue] of Object.entries(mocks)) {
        const mockPath = require.resolve(path.join(PROJECT_ROOT, relativeMockPath));
        savedEntries.set(mockPath, require.cache[mockPath]);
        require.cache[mockPath] = {
            id: mockPath,
            filename: mockPath,
            loaded: true,
            exports: exportsValue,
        };
    }

    const previousTarget = require.cache[targetPath];
    delete require.cache[targetPath];
    const loaded = require(targetPath);

    return {
        loaded,
        restore() {
            delete require.cache[targetPath];
            if (previousTarget) require.cache[targetPath] = previousTarget;
            for (const [mockPath, entry] of savedEntries) {
                if (entry) require.cache[mockPath] = entry;
                else delete require.cache[mockPath];
            }
        },
    };
}

test('выдача ролей собирает и разбирает только допустимые customId', () => {
    const {
        buildGiveRolesRequestCustomId,
        parseGiveRolesRequestCustomId,
    } = require('../src/modules/give-roles/customId');

    const customId = buildGiveRolesRequestCustomId('role-confirm', 'request:42');
    assert.equal(customId, 'role-confirm:request:42');
    assert.deepEqual(parseGiveRolesRequestCustomId(customId), {
        action: 'role-confirm',
        requestId: 'request:42',
    });
    assert.equal(parseGiveRolesRequestCustomId('unknown:42'), null);
    assert.throws(() => buildGiveRolesRequestCustomId('unknown', '42'), /Неизвестное действие/u);
});

test('формы не ставят один webhook в очередь повторно и сохраняют receipt после доставки', async () => {
    const db = { formWebhookQueue: [], webhookReceipts: [] };
    const mocked = loadWithMocks('src/modules/forms/receipts.js', {
        'src/modules/forms/database.js': {
            mutateDatabase: async (mutator) => mutator(db),
        },
    });

    try {
        const first = await mocked.loaded.enqueueWebhookJob({
            collectionName: 'formWebhookQueue',
            source: 'form',
            job: { jobId: 'job-1', jobKey: 'form:event-1', status: 'queued' },
        });
        const duplicateInQueue = await mocked.loaded.enqueueWebhookJob({
            collectionName: 'formWebhookQueue',
            source: 'form',
            job: { jobId: 'job-2', jobKey: 'form:event-1', status: 'queued' },
        });
        await mocked.loaded.completeWebhookJob({
            collectionName: 'formWebhookQueue',
            source: 'form',
            jobId: 'job-1',
            jobKey: 'form:event-1',
        });
        const duplicateAfterDelivery = await mocked.loaded.enqueueWebhookJob({
            collectionName: 'formWebhookQueue',
            source: 'form',
            job: { jobId: 'job-3', jobKey: 'form:event-1', status: 'queued' },
        });

        assert.equal(first.inserted, true);
        assert.equal(duplicateInQueue.dedupeSource, 'queue');
        assert.equal(duplicateAfterDelivery.dedupeSource, 'receipt');
        assert.equal(db.formWebhookQueue.length, 0);
        assert.equal(db.webhookReceipts.length, 1);
    } finally {
        mocked.restore();
    }
});

test('просроченные receipts форм удаляются, а действующие сохраняются', async () => {
    const now = Date.now();
    const db = {
        webhookReceipts: [
            { key: 'expired', expiresAt: now - 1 },
            { key: 'active', expiresAt: now + 60_000 },
        ],
    };
    const mocked = loadWithMocks('src/modules/forms/receipts.js', {
        'src/modules/forms/database.js': {
            mutateDatabase: async (mutator) => mutator(db),
        },
    });

    try {
        assert.equal(await mocked.loaded.cleanupWebhookReceipts({ now }), 1);
        assert.deepEqual(db.webhookReceipts.map((item) => item.key), ['active']);
    } finally {
        mocked.restore();
    }
});

test('неудачная попытка экзамена учитывается один раз на сообщение и очищается после сдачи', async () => {
    const db = { examAttempts: [] };
    const mocked = loadWithMocks('src/modules/examination/attempts.js', {
        'src/modules/examination/database.js': {
            readDatabase: () => db,
            mutateDatabase: async (mutator) => mutator(db),
        },
    });

    try {
        const input = {
            guildId: 'guild-1',
            memberId: 'member-1',
            examId: 'exam-1',
            messageId: 'message-1',
            maxAttempts: 2,
        };
        const first = await mocked.loaded.recordFailedAttempt(input);
        const duplicate = await mocked.loaded.recordFailedAttempt(input);
        const display = mocked.loaded.getAttemptDisplay('guild-1', 'member-1', {
            id: 'exam-1',
            maxAttempts: 2,
        });
        const cleared = await mocked.loaded.clearAfterPass({
            guildId: 'guild-1',
            memberId: 'member-1',
            examId: 'exam-1',
        });

        assert.deepEqual(first, { attemptsUsed: 1, deduped: false });
        assert.deepEqual(duplicate, { attemptsUsed: 1, deduped: true });
        assert.equal(display.text, '2 из 2');
        assert.equal(cleared.deletedCount, 1);
        assert.equal(db.examAttempts.length, 0);
    } finally {
        mocked.restore();
    }
});

test('экзамен с нулевым лимитом попыток остаётся безлимитным и не пишет состояние', async () => {
    const db = { examAttempts: [] };
    const mocked = loadWithMocks('src/modules/examination/attempts.js', {
        'src/modules/examination/database.js': {
            readDatabase: () => db,
            mutateDatabase: async (mutator) => mutator(db),
        },
    });

    try {
        const result = await mocked.loaded.recordFailedAttempt({
            guildId: 'guild-1',
            memberId: 'member-1',
            examId: 'exam-1',
            messageId: 'message-1',
            maxAttempts: 0,
        });
        const display = mocked.loaded.getAttemptDisplay('guild-1', 'member-1', {
            id: 'exam-1',
            maxAttempts: 0,
        });

        assert.deepEqual(result, { attemptsUsed: 0, deduped: false, unlimited: true });
        assert.equal(display.unlimited, true);
        assert.equal(display.text, null);
        assert.equal(db.examAttempts.length, 0);
    } finally {
        mocked.restore();
    }
});

test('массовый кадровый ввод разбирает action, технические упоминания и текстовые имена', () => {
    const { parseMassAuditText } = require('../src/modules/staff-audit/massAuditParser');
    const result = parseMassAuditText([
        '# комментарий',
        '/invite member:<@123456789012345678> static:42 rank:3 department:amd',
        'rank member:Michael Lindberg static:43 action:3-4 reason:"Отличная работа" keep_department:true',
        'uval member:@milkgames static:44 reason:"По собственному желанию"',
    ].join('\n'));

    assert.equal(result.length, 3);
    assert.equal(result[0].reason, 'Собеседование');
    assert.equal(result[0].memberId, '123456789012345678');
    assert.equal(result[0].memberInput, '123456789012345678');
    assert.equal(result[1].memberId, null);
    assert.equal(result[1].memberInput, 'Michael Lindberg');
    assert.equal(result[1].actionInput, '3-4');
    assert.equal(result[1].reason, 'Отличная работа');
    assert.equal(result[1].staticId, '43');
    assert.equal(result[1].keepDepartment, true);
    assert.equal(result[2].action, 'uval');
    assert.equal(result[2].memberInput, '@milkgames');
    assert.equal(result[2].staticId, '44');
});

test('массовый кадровый ввод отклоняет дубли и неизвестные параметры', () => {
    const { parseMassAuditText } = require('../src/modules/staff-audit/massAuditParser');
    assert.throws(
        () => parseMassAuditText('uval member:123456789012345678 member:123456789012345679 reason:test'),
        (error) => error?.code === 'mass_audit_duplicate_argument'
    );
    assert.throws(
        () => parseMassAuditText('invite member:123456789012345678 unknown:value'),
        (error) => error?.code === 'mass_audit_unknown_argument'
    );
    assert.throws(
        () => parseMassAuditText('rank member:123456789012345678 from:2 rank:3 reason:test'),
        (error) => error?.code === 'mass_audit_unknown_argument'
    );
    assert.throws(
        () => parseMassAuditText('invite member:Michael Lindberg rank:1'),
        (error) => error?.code === 'mass_audit_static_required'
    );
});

test('ограничение отпуска сопоставляет команды с группами и показывает ссылку заявки', () => {
    const block = {
        blocked: true,
        request: { requestMessageLink: 'https://discord.com/channels/1/2/3' },
    };
    const mocked = loadWithMocks('src/modules/vacations/accessGuard.js', {
        'src/modules/vacations/service.js': {
            isAccessBlocked: () => block,
        },
    });

    try {
        assert.equal(mocked.loaded.getCommandGroup('MassAudit'), 'staffAudit');
        assert.equal(mocked.loaded.getCommandGroup('discipline'), 'discipline');
        assert.equal(mocked.loaded.getCommandGroup('ping'), null);
        assert.equal(mocked.loaded.getBlock('1', '2', 'staffAudit'), block);
        assert.match(mocked.loaded.buildMessage(block), /https:\/\/discord\.com\/channels\/1\/2\/3/u);
    } finally {
        mocked.restore();
    }
});

test('увольнение формирует стабильные customId и безопасно ограничивает длинный текст', () => {
    const { buildCustomId, truncate } = require('../src/modules/offboarding/presentation');
    assert.equal(buildCustomId('approve', 'batch-42'), 'uvalApproval:approve:batch-42');
    assert.equal(truncate('коротко', 20), 'коротко');
    assert.equal(truncate('1234567890', 6), '12345…');
});

test('scheduler счётчиков объединяет повторные отложенные обновления одного сервера', () => {
    const service = require('../src/modules/channel-counters/service');
    service.stopChannelCounterScheduler();
    service.scheduleGuildChannelCounterUpdate({}, 'guild-1', { delayMs: 60_000 });
    service.scheduleGuildChannelCounterUpdate({}, 'guild-1', { delayMs: 60_000 });

    assert.deepEqual(service.getChannelCounterStatus(), {
        schedulerActive: false,
        scheduledGuilds: 1,
        queuedGuilds: 0,
    });
    service.stopChannelCounterScheduler();
    assert.equal(service.getChannelCounterStatus().scheduledGuilds, 0);
});

test('health-команда считает задержку interaction и websocket', async () => {
    const command = require('../src/modules/health/command');
    const calls = [];
    const interaction = {
        createdTimestamp: 1_000,
        deferReply: async (payload) => calls.push(['defer', payload]),
        fetchReply: async () => ({ createdTimestamp: 1_075 }),
        editReply: async (payload) => {
            calls.push(['edit', payload]);
            return payload;
        },
    };

    await command.callback({ ws: { ping: 42 } }, interaction);
    assert.equal(calls[0][0], 'defer');
    assert.match(calls[1][1].content, /Client 75 ms \| Websocket: 42 ms/u);
});

test('analytics-команда корректно отказывает при запуске вне сервера', async () => {
    const command = require('../src/modules/analytics/command');
    const calls = [];
    const interaction = {
        guild: null,
        user: { id: '123456789012345678' },
        deferReply: async (payload) => calls.push(['defer', payload]),
        editReply: async (payload) => {
            calls.push(['edit', payload]);
            return payload;
        },
    };

    await command.callback({}, interaction);
    assert.equal(calls[0][0], 'defer');
    assert.match(calls[1][1].content, /только на сервере/u);
});
