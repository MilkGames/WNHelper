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
const test = require('./helpers/createTest')(__filename);
const applicationConfig = require('../config.json');
const { installRuntimeStubs } = require('./helpers/runtimeStubs');

test('лог использует английский уровень и не повторяет Instance ID в строке', () => {
    const loggerPath = require.resolve('../src/core/logging/logger');
    const instancePath = require.resolve('../src/core/runtime/instance');
    const previousLogging = structuredClone(applicationConfig.logging);
    applicationConfig.logging = { level: 'info', toFile: false };
    delete require.cache[loggerPath];
    const logger = require(loggerPath);
    const { instanceId } = require(instancePath);
    const originalWrite = process.stdout.write;
    let output = '';
    process.stdout.write = (chunk) => {
        output += String(chunk);
        return true;
    };
    try {
        logger.createLogger({ module: 'test' }).info('Проверка');
    } finally {
        process.stdout.write = originalWrite;
        applicationConfig.logging = previousLogging;
        delete require.cache[loggerPath];
    }

    assert.match(output, / INFO /u);
    assert.doesNotMatch(output, /ИНФОРМАЦИЯ|ПРЕДУПРЕЖДЕНИЕ/u);
    assert.equal(output.includes(instanceId), false);
    assert.equal(path.basename(logger.logFilePath).startsWith(instanceId), true);
});

test('параметры slash-команды сериализуются вместе с группой и подкомандой', () => {
    const restore = installRuntimeStubs();
    try {
        const { extractCommandParameters } = require('../src/app/commandHandler');
        const parameters = extractCommandParameters({
            options: {
                data: [{
                    name: 'database',
                    type: 2,
                    options: [{
                        name: 'compare',
                        type: 1,
                        options: [
                            { name: 'backup', type: 3, value: 'localdb-01.json' },
                            { name: 'force', type: 5, value: true },
                        ],
                    }],
                }],
            },
        });
        assert.deepEqual(parameters, {
            group: 'database',
            subcommand: 'compare',
            backup: 'localdb-01.json',
            force: true,
        });
    } finally {
        restore();
    }
});

test('глобальные несекретные параметры читаются только из config.json', () => {
    const configService = require('../src/core/config/applicationConfig');
    assert.equal(configService.getOwnerUserIds().has(String(applicationConfig.devs[0])), true);
    assert.deepEqual(configService.getLoggingConfig(), applicationConfig.logging);
    assert.deepEqual(configService.getWebhookServerConfig(), applicationConfig.webhookServer);
    assert.deepEqual(
        [...configService.getRulesPublicationGuildIds()],
        applicationConfig.rulesPublicationGuildIds
    );
});
