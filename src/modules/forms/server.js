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
const crypto = require('crypto');
const express = require('express');

const { getWebhookServerConfig } = require('../../core/config/applicationConfig');
const logger = require('../../core/logging/logger');

const state = {
    app: null,
    server: null,
    client: null,
    handlers: [],
    started: false,
};

function getClientIp(req) {
    return req.ip || req.socket?.remoteAddress || 'unknown';
}

function makeRateLimiter({ limit = 120, windowMs = 60_000 } = {}) {
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
            res.setHeader('Retry-After', Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000)));
            return res.status(429).send('Слишком много запросов');
        }

        bucket.count += 1;
        return next();
    };
}

function getWebhookRateLimitConfig() {
    const { rateLimit, rateWindowMs } = getWebhookServerConfig();
    return { limit: rateLimit, windowMs: rateWindowMs };
}

function getRequestWebhookKey(req) {
    const headerKey = req.get('x-webhook-key');
    if (typeof headerKey === 'string' && headerKey) return headerKey;
    return typeof req.query?.key === 'string' ? req.query.key : '';
}

function secretsEqual(left, right) {
    const a = Buffer.from(String(left || ''));
    const b = Buffer.from(String(right || ''));
    if (a.length !== b.length || a.length === 0) return false;
    return crypto.timingSafeEqual(a, b);
}

function ensureWebhookApp() {
    if (state.app) return state.app;

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 1);
    app.use('/webhook', makeRateLimiter(getWebhookRateLimitConfig()));
    app.use(express.json({ limit: '256kb' }));

    app.get('/webhook', (_req, res) => {
        const testKey = process.env.TEST_KEY;
        if (!testKey) return res.status(503).send('Сервис не настроен');
        return res.status(200).send(testKey);
    });

    app.post('/webhook', async (req, res) => {
        const ip = getClientIp(req);

        try {
            const webhookKey = process.env.WEBHOOK_KEY;
            if (!webhookKey) {
                logger.error('Вебхук-сервер: WEBHOOK_KEY не задан в окружении');
                return res.status(503).send('Сервис не настроен');
            }

            if (!secretsEqual(getRequestWebhookKey(req), webhookKey)) {
                return res.status(403).send('Доступ запрещён');
            }

            const payload = req.body || {};
            const handler = state.handlers.find((item) => {
                try {
                    return item.canHandle({ req, payload }) === true;
                } catch (error) {
                    logger.error('Вебхук-сервер: ошибка маршрутизации запроса', {
                        handler: item.name,
                        ip,
                    }, error);
                    return false;
                }
            });

            if (!handler) {
                logger.warn('Вебхук-сервер: не найден подходящий обработчик', { ip });
                return res.status(400).send('Неизвестный формат вебхука');
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
            logger.error('Вебхук-сервер: необработанная ошибка запроса', { ip }, error);
            return res.status(500).send('Внутренняя ошибка сервера');
        }
    });

    app.use((error, req, res, next) => {
        if (!error) return next();

        if (error.type === 'entity.too.large') {
            return res.status(413).send('Слишком большой запрос');
        }
        if (error instanceof SyntaxError && Object.prototype.hasOwnProperty.call(error, 'body')) {
            return res.status(400).send('Некорректный JSON');
        }

        logger.error('Вебхук-сервер: ошибка промежуточного обработчика', {
            ip: getClientIp(req),
        }, error);
        return res.status(500).send('Внутренняя ошибка сервера');
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
    const { port } = getWebhookServerConfig();

    state.server = app.listen(port, () => {
        logger.info(`Вебхук-сервер запущен на порту ${port}. Обработчиков: ${state.handlers.length}`);
    });
    state.server.on('error', (error) => {
        state.started = false;
        logger.error('Вебхук-сервер: ошибка HTTP-сервера', { port }, error);
    });
    state.started = true;
    return state.server;
}

async function stopWebhookServer() {
    if (!state.server) {
        state.started = false;
        return;
    }
    const server = state.server;
    state.server = null;
    state.started = false;
    await new Promise((resolve, reject) => {
        server.close((error) => {
            if (error) reject(error);
            else resolve();
        });
    });
}

function getWebhookServerStatus() {
    return {
        started: state.started,
        handlerCount: state.handlers.length,
        listening: Boolean(state.server?.listening),
    };
}

module.exports = {
    getWebhookServerStatus,
    registerWebhookHandler,
    startWebhookServer,
    stopWebhookServer,
};
