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
class SessionStore {
    constructor({ ttlMs, getLastActivity = (session) => session?.lastActivityAt } = {}) {
        this.ttlMs = Math.max(1, Number(ttlMs) || 1);
        this.getLastActivity = getLastActivity;
        this.sessions = new Map();
        this.indexes = new Map();
    }

    isExpired(session, now = Date.now()) {
        return !session || now - Number(this.getLastActivity(session) || 0) >= this.ttlMs;
    }

    set(id, session, indexValues = {}) {
        const normalizedId = String(id);
        this.delete(normalizedId);
        this.sessions.set(normalizedId, session);
        for (const [indexName, value] of Object.entries(indexValues)) {
            if (value === null || value === undefined) continue;
            if (!this.indexes.has(indexName)) this.indexes.set(indexName, new Map());
            this.indexes.get(indexName).set(String(value), normalizedId);
        }
        return session;
    }

    get(id) {
        const normalizedId = String(id || '');
        const session = this.sessions.get(normalizedId) || null;
        if (this.isExpired(session)) {
            this.delete(normalizedId);
            return null;
        }
        return session;
    }

    getByIndex(indexName, value) {
        const id = this.indexes.get(indexName)?.get(String(value || ''));
        return id ? this.get(id) : null;
    }

    delete(id) {
        const normalizedId = String(id || '');
        const session = this.sessions.get(normalizedId) || null;
        if (!session) return null;
        this.sessions.delete(normalizedId);
        for (const index of this.indexes.values()) {
            for (const [key, indexedId] of index.entries()) {
                if (indexedId === normalizedId) index.delete(key);
            }
        }
        return session;
    }

    size() {
        this.cleanup();
        return this.sessions.size;
    }

    cleanup() {
        const now = Date.now();
        for (const [id, session] of this.sessions.entries()) {
            if (this.isExpired(session, now)) this.delete(id);
        }
    }
}

module.exports = {
    SessionStore,
};
