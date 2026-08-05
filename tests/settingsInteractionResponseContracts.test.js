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

const INTERACTIONS_PATH = path.join(
    __dirname,
    '..',
    'src',
    'modules',
    'settings',
    'interactions.js'
);

function getAcknowledgedActionTail(source) {
    const marker = /await acknowledgePanelInteraction\(interaction\);\s*\n\s*if \(parsed\.action === 'nav'\)/u;
    const match = marker.exec(source);
    assert.ok(match, 'Не найдено общее подтверждение кнопок панели /settings.');
    return source.slice(match.index);
}

test('после общего deferUpdate панель /settings не вызывает обычный reply', () => {
    const source = fs.readFileSync(INTERACTIONS_PATH, 'utf8');
    const acknowledgedTail = getAcknowledgedActionTail(source);

    assert.doesNotMatch(
        acknowledgedTail,
        /replyWithRetry\(interaction\s*,/u,
        'После deferUpdate нужно использовать followUpWithRetry или редактирование сообщения.'
    );
});

test('экспорт конфигурации отправляется follow-up сообщением после подтверждения кнопки', () => {
    const source = fs.readFileSync(INTERACTIONS_PATH, 'utf8');
    const startMarker = "if (parsed.action === 'diagnostics_export_config') {";
    const endMarker = "if (parsed.action === 'publication_start') {";
    const startIndex = source.indexOf(startMarker);
    const endIndex = source.indexOf(endMarker, startIndex + startMarker.length);

    assert.notEqual(startIndex, -1, 'Не найден обработчик diagnostics_export_config.');
    assert.notEqual(endIndex, -1, 'Не найден следующий обработчик publication_start.');
    const block = source.slice(startIndex, endIndex);
    const followUps = block.match(/followUpWithRetry\(interaction\s*,/gu) || [];

    assert.equal(followUps.length, 2);
    assert.doesNotMatch(block, /replyWithRetry\(interaction\s*,/u);
});
