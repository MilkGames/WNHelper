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
const actions = new Map();

function registerAction(name, handler, { replace = false } = {}) {
    const key = String(name || '').trim();
    if (!key) throw new Error('Не указано имя межмодульного действия');
    if (typeof handler !== 'function') throw new Error(`Действие "${key}" не содержит обработчик`);
    if (!replace && actions.has(key)) throw new Error(`Действие "${key}" зарегистрировано повторно`);
    actions.set(key, handler);
    return () => {
        if (actions.get(key) === handler) actions.delete(key);
    };
}

function hasAction(name) {
    return actions.has(String(name || '').trim());
}

async function invokeAction(name, ...argumentsList) {
    const key = String(name || '').trim();
    const handler = actions.get(key);
    if (!handler) throw new Error(`Межмодульное действие "${key}" не зарегистрировано`);
    return handler(...argumentsList);
}

function clearActions() {
    actions.clear();
}

function getActionNames() {
    return [...actions.keys()].sort((left, right) => left.localeCompare(right));
}

module.exports = {
    clearActions,
    getActionNames,
    hasAction,
    invokeAction,
    registerAction,
};
