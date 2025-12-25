/*
 * WN Helper Discord Bot
 * Copyright (C) 2025 MilkGames
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

const LEVELS = {
	fatal: 60,
	error: 50,
	warn: 40,
	info: 30,
	debug: 20,
	trace: 10,
};

function normalizeLevel(level) {
	const l = String(level || '').toLowerCase();
	return LEVELS[l] ? l : 'info';
}

function ensureDirSync(dirPath) {
	try {
		fs.mkdirSync(dirPath, { recursive: true });
	} catch (_) {
		// ignore
	}
}

function safeJson(value) {
	try {
		return JSON.stringify(value);
	} catch (_) {
		return '"[unserializable]"';
	}
}

function formatArg(arg) {
	if (arg instanceof Error) {
		return `${arg.name}: ${arg.message}\n${arg.stack || ''}`.trim();
	}
	if (typeof arg === 'string') return arg;
	if (arg === null) return 'null';
	if (arg === undefined) return 'undefined';
	return safeJson(arg);
}

function formatLine(level, context, args) {
	const ts = new Date().toISOString();
	const ctx = context && Object.keys(context).length ? ` ${safeJson(context)}` : '';
	const msg = args.map(formatArg).join(' ');
	return `${ts} ${level.toUpperCase()}${ctx} ${msg}`.trim();
}

function createLogger(context = {}) {
	const envLevel = normalizeLevel(process.env.LOG_LEVEL);
	const min = LEVELS[envLevel];

	const logDir = path.join(__dirname, '..', '..', 'data', 'logs');
	const logFile = process.env.LOG_FILE || path.join(logDir, 'bot.log');
	const logToFile = String(process.env.LOG_TO_FILE ?? 'true').toLowerCase() !== 'false';

	if (logToFile) ensureDirSync(path.dirname(logFile));

	function write(level, args) {
		if (LEVELS[level] < min) return;

		const line = formatLine(level, context, args);

		// stdout/stderr
		if (LEVELS[level] >= LEVELS.error) {
			process.stderr.write(line + '\n');
		} else {
			process.stdout.write(line + '\n');
		}

		// file
		if (logToFile) {
			fs.appendFile(logFile, line + '\n', () => {});
		}
	}

	const api = {
		child(extraContext) {
			return createLogger({ ...context, ...(extraContext || {}) });
		},
		trace: (...args) => write('trace', args),
		debug: (...args) => write('debug', args),
		info: (...args) => write('info', args),
		warn: (...args) => write('warn', args),
		error: (...args) => write('error', args),
		fatal: (...args) => write('fatal', args),
	};

	return api;
}

module.exports = createLogger();
module.exports.createLogger = createLogger;