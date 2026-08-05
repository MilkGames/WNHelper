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
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function collectFiles(directory, predicate = () => true) {
    const result = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) result.push(...collectFiles(entryPath, predicate));
        else if (entry.isFile() && predicate(entryPath)) result.push(entryPath);
    }
    return result.sort((left, right) => left.localeCompare(right));
}

function collectJavaScriptFiles() {
    return collectFiles(path.join(PROJECT_ROOT, 'src'), (filePath) => filePath.endsWith('.js'));
}

module.exports = {
    PROJECT_ROOT,
    collectFiles,
    collectJavaScriptFiles,
};
