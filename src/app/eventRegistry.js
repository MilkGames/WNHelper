/*
 * WN Helper Discord Bot
 * Copyright (C) 2024-2026 MilkGames
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
const logger = require('../core/logging/logger');
const guildConfigService = require('../core/config/guildConfigService');
const { getModuleEvents } = require('./moduleRegistry');
const { routeInteraction } = require('./interactionRouter');
const readiness = require('./readiness');
const appEvents = require('./events');

function isRecoveryEventAllowed(event) {
    return event.recoverySafe === true;
}

function groupEvents({ recoveryMode = false } = {}) {
    const grouped = new Map();
    const allEvents = [...appEvents, ...getModuleEvents()];
    const events = recoveryMode ? allEvents.filter(isRecoveryEventAllowed) : allEvents;
    for (const event of events) {
        if (!event?.event || typeof event.execute !== 'function') {
            throw new Error(`Некорректный обработчик события ${event?.id || 'без имени'}`);
        }
        if (!grouped.has(event.event)) grouped.set(event.event, []);
        grouped.get(event.event).push(event);
    }
    for (const handlers of grouped.values()) {
        handlers.sort((left, right) => (
            Number(left.order ?? 100) - Number(right.order ?? 100) ||
            String(left.id || '').localeCompare(String(right.id || ''))
        ));
    }
    return grouped;
}


function getGuildIdFromArguments(argumentsList) {
    for (const value of argumentsList) {
        const guildId = value?.guildId || value?.guild?.id || value?.message?.guildId || value?.message?.guild?.id;
        if (guildId) return String(guildId);
    }
    return null;
}

function shouldSkipDisabledGuild(eventName, argumentsList, { recoveryMode = false } = {}) {
    if (recoveryMode || eventName === 'clientReady') return false;
    const guildId = getGuildIdFromArguments(argumentsList);
    if (!guildId) return false;
    return guildConfigService.isEnabled(guildId) === false;
}

function registerEvents(client, options = {}) {
    const grouped = groupEvents(options);
    readiness.configureClientReadyHandlers(grouped.get('clientReady') || []);
    for (const [eventName, handlers] of grouped.entries()) {
        logger.info('Подключаются обработчики события', { event: eventName, handlers: handlers.length });
        client.on(eventName, async (...argumentsList) => {
            if (shouldSkipDisabledGuild(eventName, argumentsList, options)) return;
            if (eventName === 'interactionCreate') {
                await routeInteraction(client, argumentsList[0], handlers);
                return;
            }
            for (const handler of handlers) {
                if (eventName === 'clientReady') readiness.markReadyHandlerStarted(handler);
                try {
                    await handler.execute(client, ...argumentsList);
                    if (eventName === 'clientReady') readiness.markReadyHandlerSucceeded(handler);
                } catch (error) {
                    if (eventName === 'clientReady') readiness.markReadyHandlerFailed(handler, error);
                    logger.error('Обработчик события завершился с ошибкой', {
                        event: eventName,
                        handler: handler.id,
                        module: handler.module || null,
                    }, error);
                }
            }
        });
    }
    return grouped;
}

module.exports = {
    groupEvents,
    isRecoveryEventAllowed,
    getGuildIdFromArguments,
    shouldSkipDisabledGuild,
    registerEvents,
};
