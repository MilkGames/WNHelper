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
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const DATABASE_PATH = path.join(DATA_DIR, 'localdb.json');
const DATABASE_TMP_PATH = path.join(DATA_DIR, 'localdb.json.tmp');
const DATABASE_PREVIOUS_BACKUP_PATH = path.join(DATA_DIR, 'localdb.backup.json');
const DATABASE_RECOVERY_PLAN_PATH = path.join(DATA_DIR, 'database-recovery-plan.json');
const INSTANCE_LEASE_PATH = path.join(DATA_DIR, 'runtime-instance.lock');
const FULL_MESSAGE_SCAN_PATH = path.join(DATA_DIR, 'full_message_scan.json');

module.exports = {
    BACKUPS_DIR,
    DATABASE_PREVIOUS_BACKUP_PATH,
    DATABASE_PATH,
    DATABASE_RECOVERY_PLAN_PATH,
    DATABASE_TMP_PATH,
    DATA_DIR,
    FULL_MESSAGE_SCAN_PATH,
    INSTANCE_LEASE_PATH,
    LOGS_DIR,
    PROJECT_ROOT,
};
