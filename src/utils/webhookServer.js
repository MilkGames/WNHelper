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
const express = require('express');

const logger = require('./logger');

const state = {
    app: null,
    server: null,
    client: null,
    handlers: [],
    started: false,
};

function getClientIp(req) {
    const xf = req.headers['x-forwarded-for'];
    if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim();
    return req.ip || 'unknown';
}

function makeRateLimiter({ limit = 120, windowMs = 60_000 } = {}) { // лимит 120 в минуту
    const buckets = new Map();
    let lastCleanupAt = 0;

    function cleanupExpiredBuckets(now) {
        if (now - lastCleanupAt < windowMs) return;
        lastCleanupAt = now;

        for (const [ip, bucket] of buckets.entries()) {
            if (!bucket || now >= bucket.resetAt) {
                buckets.delete(ip);
            }
        }
    }

    return (req, res, next) => {
        const ip = getClientIp(req);
        const now = Date.now();
        cleanupExpiredBuckets(now);

        const bucket = buckets.get(ip);

        if (!bucket || now >= bucket.resetAt) {
            buckets.set(ip, { count: 1, resetAt: now + windowMs });
            return next();
        }

        if (bucket.count >= limit) {
            res.setHeader('Retry-After', Math.ceil((bucket.resetAt - now) / 1000));
            return res.status(429).send('Too Many Requests');
        }

        bucket.count += 1;
        return next();
    };
}

function getWebhookRateLimitConfig() {
    const limit = Number(process.env.WEBHOOK_RATE_LIMIT);
    const windowMs = Number(process.env.WEBHOOK_RATE_WINDOW_MS);

    return {
        limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 120,
        windowMs: Number.isFinite(windowMs) && windowMs > 0 ? Math.floor(windowMs) : 60_000,
    };
}

function ensureWebhookApp() {
    if (state.app) return state.app;

    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json({ limit: '256kb' }));
    app.use('/webhook', makeRateLimiter(getWebhookRateLimitConfig()));

    app.get('/webhook', (req, res) => {
        const testKey = process.env.TEST_KEY;
        if (!testKey) return res.status(500).send('TEST_KEY не задан в окружении');
        return res.status(200).send(testKey);
    });

    app.post('/webhook', async (req, res) => {
        try {
            const webhookKey = process.env.WEBHOOK_KEY;
            if (!webhookKey) {
                logger.error('Вебхук-сервер: WEBHOOK_KEY не задан в окружении');
                return res.status(500).send('WEBHOOK_KEY не задан в окружении');
            }

            if (req.query.key !== webhookKey) return res.status(403).send('Forbidden');

            const payload = req.body || {};
            const ip = getClientIp(req);
            const handler = state.handlers.find((item) => {
                try {
                    return item.canHandle({ req, payload }) === true;
                } catch (error) {
                    logger.error(`Вебхук-сервер: ошибка в canHandle у обработчика ${item.name}`, error);
                    return false;
                }
            });

            if (!handler) {
                logger.warn(`Вебхук-сервер: для запроса с ip=${ip} не найден подходящий обработчик`);
                return res.status(200).send('Принято');
            }

            const result = await handler.handle({
                client: state.client,
                req,
                payload,
                ip,
            });

            const statusCode = Number(result?.statusCode) || 200;
            const body = typeof result?.body === 'string' ? result.body : 'Принято';
            return res.status(statusCode).send(body);
        } catch (error) {
            logger.error(`Вебхук-сервер: необработанная ошибка при обработке запроса: ${error}`);
            return res.status(200).send('Принято');
        }
    });

    state.app = app;
    return app;
}

function registerWebhookHandler(handler) {
    if (!handler || typeof handler.name !== 'string') {
        throw new Error('registerWebhookHandler: требуется handler.name');
    }
    if (typeof handler.canHandle !== 'function' || typeof handler.handle !== 'function') {
        throw new Error(`registerWebhookHandler: обработчик ${handler.name} должен определить canHandle и handle`);
    }
    if (state.handlers.some((item) => item.name === handler.name)) return;
    state.handlers.push(handler);
}

function startWebhookServer(client) {
    if (client) state.client = client;
    if (state.started) return state.server;

    const webhookKey = process.env.WEBHOOK_KEY;
    const testKey = process.env.TEST_KEY;
    if (!webhookKey) throw new Error('WEBHOOK_KEY не задан в окружении');
    if (!testKey) throw new Error('TEST_KEY не задан в окружении');

    const app = ensureWebhookApp();
    const port = Number(process.env.PORT) || 80;

    state.server = app.listen(port, () => {
        logger.info(`Вебхук-сервер запущен на порту ${port}. Обработчиков: ${state.handlers.length}`);
    });
    state.started = true;
    return state.server;
}

module.exports = {
    registerWebhookHandler,
    startWebhookServer,
};
