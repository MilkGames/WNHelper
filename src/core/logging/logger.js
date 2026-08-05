/*
 * WN Helper Discord Bot
 * Copyright (C) 2025-2026 MilkGames
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

const { getLoggingConfig } = require('../config/applicationConfig');
const { LOGS_DIR } = require('../runtime/paths');
const { instanceId } = require('../runtime/instance');

const LEVELS = {
    fatal: 60,
    error: 50,
    warn: 40,
    info: 30,
    debug: 20,
    trace: 10,
};
const LEVEL_LABELS = {
    fatal: 'FATAL',
    error: 'ERROR',
    warn: 'WARN',
    info: 'INFO',
    debug: 'DEBUG',
    trace: 'TRACE',
};
let stream = null;
let streamErrorReported = false;
let closePromise = null;

function buildLogFileName() {
    return `${instanceId}.log`;
}

function resolveLogFilePath() {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const baseName = buildLogFileName();
    let candidate = path.join(LOGS_DIR, baseName);
    let suffix = 1;

    while (fs.existsSync(candidate)) {
        candidate = path.join(LOGS_DIR, baseName.replace(/\.log$/u, `_${suffix}.log`));
        suffix += 1;
    }

    return candidate;
}

const loggingConfig = getLoggingConfig();
const logFilePath = resolveLogFilePath();
const logToFile = loggingConfig.toFile;

function normalizeLevel(level) {
    const normalized = String(level || '').toLowerCase();
    return Object.prototype.hasOwnProperty.call(LEVELS, normalized) ? normalized : 'info';
}

function safeJson(value) {
    const seen = new WeakSet();
    try {
        return JSON.stringify(value, (_key, nestedValue) => {
            if (nestedValue instanceof Error) {
                return {
                    name: nestedValue.name,
                    message: nestedValue.message,
                    stack: nestedValue.stack,
                };
            }
            if (nestedValue && typeof nestedValue === 'object') {
                if (seen.has(nestedValue)) return '[ЦИКЛИЧЕСКАЯ ССЫЛКА]';
                seen.add(nestedValue);
            }
            return nestedValue;
        });
    } catch (_error) {
        return '"[НЕ УДАЛОСЬ СЕРИАЛИЗОВАТЬ]"';
    }
}

function formatArg(argument) {
    if (argument instanceof Error) {
        return `${argument.name}: ${argument.message}\n${argument.stack || ''}`.trim();
    }
    if (typeof argument === 'string') return argument;
    if (argument === null) return 'null';
    if (argument === undefined) return 'undefined';
    return safeJson(argument);
}

function formatLine(level, context, argumentsList) {
    const timestamp = new Date().toISOString();
    const normalizedContext = context && Object.keys(context).length
        ? ` ${safeJson(context)}`
        : '';
    const message = argumentsList.map(formatArg).join(' ');
    return `${timestamp} ${LEVEL_LABELS[level]}${normalizedContext} ${message}`.trim();
}

function ensureStream() {
    if (!logToFile || stream) return;
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    stream = fs.createWriteStream(logFilePath, { flags: 'a', encoding: 'utf8' });
    stream.on('error', (error) => {
        if (streamErrorReported) return;
        streamErrorReported = true;
        process.stderr.write(`Не удалось записать лог-файл: ${error.message}\n`);
    });
}

function writeToStream(line) {
    if (!logToFile) return;
    ensureStream();
    stream.write(`${line}\n`);
}

function createLogger(context = {}) {
    const minimumLevel = LEVELS[normalizeLevel(loggingConfig.level)];

    function write(level, argumentsList) {
        if (LEVELS[level] < minimumLevel) return;
        const line = formatLine(level, context, argumentsList);
        const output = LEVELS[level] >= LEVELS.error ? process.stderr : process.stdout;
        output.write(`${line}\n`);
        writeToStream(line);
    }

    return {
        child(extraContext) {
            return createLogger({ ...context, ...(extraContext || {}) });
        },
        debug: (...argumentsList) => write('debug', argumentsList),
        error: (...argumentsList) => write('error', argumentsList),
        fatal: (...argumentsList) => write('fatal', argumentsList),
        info: (...argumentsList) => write('info', argumentsList),
        trace: (...argumentsList) => write('trace', argumentsList),
        warn: (...argumentsList) => write('warn', argumentsList),
    };
}

async function closeLogger() {
    if (closePromise) return closePromise;
    if (!stream) return undefined;

    closePromise = new Promise((resolve) => {
        stream.end(resolve);
    });
    return closePromise;
}

function getLoggerStatus() {
    let fileCount = 0;
    let totalSize = 0;
    let oldestFileAt = null;

    try {
        const entries = fs.readdirSync(LOGS_DIR, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.log')) continue;
            const stats = fs.statSync(path.join(LOGS_DIR, entry.name));
            fileCount += 1;
            totalSize += stats.size;
            if (oldestFileAt === null || stats.mtimeMs < oldestFileAt) oldestFileAt = stats.mtimeMs;
        }
    } catch (_error) {
        return {
            fileCount: 0,
            totalSize: 0,
            oldestFileAt: null,
            logFilePath,
        };
    }

    return {
        fileCount,
        totalSize,
        oldestFileAt,
        logFilePath,
    };
}

const logger = createLogger();

module.exports = logger;
module.exports.closeLogger = closeLogger;
module.exports.createLogger = createLogger;
module.exports.getLoggerStatus = getLoggerStatus;
module.exports.logFilePath = logFilePath;
