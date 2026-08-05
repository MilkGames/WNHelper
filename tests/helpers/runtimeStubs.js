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
const { EventEmitter } = require('events');
const Module = require('module');

class Collection extends Map {
    find(predicate) {
        for (const value of this.values()) if (predicate(value)) return value;
        return undefined;
    }

    filter(predicate) {
        return new Collection([...this].filter(([, value]) => predicate(value)));
    }

    map(callback) {
        return [...this.values()].map(callback);
    }

    some(predicate) {
        for (const value of this.values()) if (predicate(value)) return true;
        return false;
    }

    first() {
        return this.values().next().value;
    }

    last() {
        return [...this.values()].at(-1);
    }

    sort(compare) {
        return new Collection([...this].sort((left, right) => compare(left[1], right[1])));
    }
}

class Builder {
    constructor(data = {}) {
        this.data = { ...data };
    }

    static from(value) {
        return new this(value?.data || value || {});
    }

    toJSON() {
        return { ...this.data };
    }
}

for (const method of [
    'addComponents',
    'addFields',
    'addOptions',
    'setAuthor',
    'setChannelTypes',
    'setColor',
    'setComponents',
    'setCustomId',
    'setDefault',
    'setDefaultChannels',
    'setDefaultRoles',
    'setDefaultUsers',
    'setDescription',
    'setDisabled',
    'setEmoji',
    'setFields',
    'setFooter',
    'setLabel',
    'setMaxLength',
    'setMaxValues',
    'setMinLength',
    'setMinValues',
    'setName',
    'setOptions',
    'setPlaceholder',
    'setRequired',
    'setStyle',
    'setThumbnail',
    'setTimestamp',
    'setTitle',
    'setType',
    'setURL',
    'setValue',
]) {
    Builder.prototype[method] = function builderMethod(...argumentsList) {
        this.data[method] = argumentsList;
        return this;
    };
}

class PermissionsBitField {
    static Flags = new Proxy({}, { get: (_target, key) => key });

    has() {
        return true;
    }
}

class Client extends EventEmitter {
    constructor() {
        super();
        this.guilds = { cache: new Collection(), fetch: async () => null };
        this.channels = { cache: new Collection(), fetch: async () => null };
        this.user = { id: '100000000000000001', username: 'WN Helper' };
    }

    async login() {
        return 'test-token';
    }

    destroy() {}
}

class REST extends Builder {
    setToken() {
        return this;
    }

    async put() {
        return [];
    }
}

function numericProxy(seed = 1) {
    let next = seed;
    const values = new Map();
    return new Proxy({}, {
        get: (_target, key) => {
            if (!values.has(key)) values.set(key, next++);
            return values.get(key);
        },
    });
}

const discordStub = {
    ActionRowBuilder: Builder,
    AttachmentBuilder: Builder,
    ButtonBuilder: Builder,
    ChannelSelectMenuBuilder: Builder,
    Client,
    Collection,
    ContextMenuCommandBuilder: Builder,
    EmbedBuilder: Builder,
    MentionableSelectMenuBuilder: Builder,
    ModalBuilder: Builder,
    PermissionsBitField,
    REST,
    RoleSelectMenuBuilder: Builder,
    StringSelectMenuBuilder: Builder,
    TextInputBuilder: Builder,
    UserSelectMenuBuilder: Builder,
    ActivityType: numericProxy(50),
    ApplicationCommandOptionType: numericProxy(1),
    ApplicationCommandType: numericProxy(100),
    ButtonStyle: numericProxy(200),
    ChannelType: numericProxy(300),
    Events: {
        MessageReactionAdd: 'messageReactionAdd',
    },
    GatewayIntentBits: numericProxy(400),
    MessageFlags: { Ephemeral: 64 },
    Partials: numericProxy(500),
    PermissionFlagsBits: numericProxy(600),
    TextInputStyle: numericProxy(700),
    Routes: new Proxy({}, { get: () => (...argumentsList) => argumentsList.join(':') }),
};

function createExpressStub() {
    const app = {
        disable() { return app; },
        get() { return app; },
        post() { return app; },
        set() { return app; },
        use() { return app; },
        listen(_port, callback) {
            const server = new EventEmitter();
            server.listening = true;
            server.close = (done) => {
                server.listening = false;
                done?.();
            };
            callback?.();
            return server;
        },
    };
    return app;
}

function installRuntimeStubs() {
    const originalLoad = Module._load;
    Module._load = function loadWithStubs(request, parent, isMain) {
        if (request === 'discord.js') return discordStub;
        if (request === 'dotenv') return { config: () => ({ parsed: {} }) };
        if (request === 'express') {
            const express = () => createExpressStub();
            express.json = () => (_request, _response, next) => next?.();
            return express;
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    return () => {
        Module._load = originalLoad;
    };
}

module.exports = {
    discordStub,
    installRuntimeStubs,
};
