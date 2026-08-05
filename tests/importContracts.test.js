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
const { installRuntimeStubs } = require('./helpers/runtimeStubs');

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function resolveRelativeModule(filePath, request) {
    return require.resolve(path.resolve(path.dirname(filePath), request));
}


function maskStringsAndComments(source) {
    return String(source).replace(
        /\/\*[\s\S]*?\*\/|\/\/.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/gmu,
        (match) => ' '.repeat(match.length)
    );
}

function parseDestructuredNames(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .replace(/\/\/.*$/gmu, '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
            const normalized = entry.replace(/\s*=.*$/u, '').trim();
            const [exportedName, localName = exportedName] = normalized
                .split(':')
                .map((value) => value.trim());
            return { exportedName, localName };
        })
        .filter(({ exportedName, localName }) => (
            /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(exportedName) &&
            /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(localName)
        ));
}

test('статические обращения к относительным импортам соответствуют реальным экспортам', () => {
    const restore = installRuntimeStubs();
    const failures = [];

    try {
        for (const filePath of collectJavaScriptFiles()) {
            const source = fs.readFileSync(filePath, 'utf8');
            const relativeFile = path.relative(PROJECT_ROOT, filePath).replaceAll('\\', '/');
            const objectRequirePattern = /const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*require\(\s*['"](\.[^'"]+)['"]\s*\)(?!\s*\.)/gu;
            const destructuredRequirePattern = /const\s*\{([^}]*)\}\s*=\s*require\(\s*['"](\.[^'"]+)['"]\s*\)(?!\s*\.)/gu;

            for (const match of source.matchAll(objectRequirePattern)) {
                const [, alias, request] = match;
                let imported;
                try {
                    imported = require(resolveRelativeModule(filePath, request));
                } catch (error) {
                    failures.push(`${relativeFile}: не удалось загрузить ${request}: ${error.message}`);
                    continue;
                }

                const usageSource = source.slice(match.index + match[0].length);
                const maskedUsageSource = maskStringsAndComments(usageSource);
                const propertyPattern = new RegExp(
                    `\\b${escapeRegExp(alias)}(?:\\?\\.|\\.)([A-Za-z_$][A-Za-z0-9_$]*)`,
                    'gu'
                );
                const properties = new Map();
                for (const propertyMatch of maskedUsageSource.matchAll(propertyPattern)) {
                    const property = propertyMatch[1];
                    const after = maskedUsageSource.slice(propertyMatch.index + propertyMatch[0].length);
                    const called = /^\s*\(/u.test(after);
                    properties.set(property, Boolean(properties.get(property)) || called);
                }

                for (const [property, called] of properties) {
                    const exists = imported != null && property in Object(imported);
                    if (!exists) {
                        failures.push(
                            `${relativeFile}: используется ${alias}.${property}, ` +
                            `но ${request} не экспортирует ${property}`
                        );
                        continue;
                    }
                    if (called && typeof imported[property] !== 'function') {
                        failures.push(
                            `${relativeFile}: ${alias}.${property} вызывается как функция, ` +
                            `но ${request}.${property} имеет тип ${typeof imported[property]}`
                        );
                    }
                }

                const directCallPattern = new RegExp(`\\b${escapeRegExp(alias)}\\s*\\(`, 'u');
                if (directCallPattern.test(maskedUsageSource) && typeof imported !== 'function') {
                    failures.push(
                        `${relativeFile}: ${alias} вызывается как функция, ` +
                        `но ${request} имеет тип ${typeof imported}`
                    );
                }
            }

            for (const match of source.matchAll(destructuredRequirePattern)) {
                const [, namesSource, request] = match;
                let imported;
                try {
                    imported = require(resolveRelativeModule(filePath, request));
                } catch (error) {
                    failures.push(`${relativeFile}: не удалось загрузить ${request}: ${error.message}`);
                    continue;
                }

                const usageSource = source.slice(match.index + match[0].length);
                const maskedUsageSource = maskStringsAndComments(usageSource);
                for (const { exportedName, localName } of parseDestructuredNames(namesSource)) {
                    const exists = imported != null && exportedName in Object(imported);
                    if (!exists) {
                        failures.push(
                            `${relativeFile}: импортируется ${request}.${exportedName}, но такого экспорта нет`
                        );
                        continue;
                    }
                    const callPattern = new RegExp(`\\b${escapeRegExp(localName)}\\s*\\(`, 'u');
                    if (callPattern.test(maskedUsageSource) && typeof imported[exportedName] !== 'function') {
                        failures.push(
                            `${relativeFile}: ${localName} вызывается как функция, ` +
                            `но ${request}.${exportedName} имеет тип ${typeof imported[exportedName]}`
                        );
                    }
                }
            }
        }
    } finally {
        restore();
    }

    assert.deepEqual(failures, []);
});
