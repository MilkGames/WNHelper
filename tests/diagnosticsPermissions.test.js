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
const assert = require('node:assert/strict');
const nodeTest = require('node:test');
const test = require('./helpers/createTest')(__filename);
const { installRuntimeStubs, discordStub } = require('./helpers/runtimeStubs');

const restoreRuntimeStubs = installRuntimeStubs();
nodeTest.after(restoreRuntimeStubs);

const {
    getRequiredChannelPermissions,
    summarizeDiscordResources,
} = require('../src/modules/settings/diagnostics');

const { PermissionFlagsBits } = discordStub;
const IDS = {
    text: '100000000000000001',
    thread: '100000000000000002',
    voice: '100000000000000003',
    counter: '100000000000000004',
    rank: '100000000000000005',
    sanction: '100000000000000006',
};

function permissions(allowed) {
    const set = new Set(allowed);
    return { has: (permission) => set.has(permission) };
}

function channel(id, allowed, extra = {}) {
    return {
        id,
        name: `channel-${id.slice(-2)}`,
        permissionsFor: () => permissions(allowed),
        isTextBased: () => true,
        isVoiceBased: () => false,
        ...extra,
    };
}

test('диагностика проверяет ветки, типы каналов, общие права и иерархию ролей', () => {
    const botMember = {
        permissions: permissions([PermissionFlagsBits.ManageRoles]),
        roles: { highest: { comparePositionTo: () => -1 } },
    };
    const guild = {
        members: { me: botMember },
        channels: {
            cache: new Map([
                [IDS.text, channel(IDS.text, [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.EmbedLinks,
                ])],
                [IDS.thread, channel(IDS.thread, [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.EmbedLinks,
                    PermissionFlagsBits.ReadMessageHistory,
                ])],
                [IDS.voice, channel(IDS.voice, [PermissionFlagsBits.ViewChannel])],
                [IDS.counter, channel(IDS.counter, [PermissionFlagsBits.ViewChannel])],
            ]),
        },
        roles: {
            cache: new Map([
                [IDS.rank, { id: IDS.rank, name: 'Rank', editable: false, managed: false }],
                [IDS.sanction, { id: IDS.sanction, name: 'Sanction', editable: true, managed: false }],
            ]),
        },
    };
    const config = {
        features: { staffAudit: true, giveRoles: true, vacations: true, discipline: true },
        channels: { examChannelId: IDS.text },
        disciplineSettings: {
            channelId: IDS.thread,
            stages: { oral: { roleByCount: { 1: IDS.sanction } } },
        },
        examinationSettings: { lectureVoiceChannelId: IDS.voice },
        channelCounterSettings: { employeesChannelId: IDS.counter },
        ranks: [{ roleId: IDS.rank }],
    };

    const result = summarizeDiscordResources(guild, config);
    assert.ok(result.permissionProblems.some((item) => item.path === 'channels.examChannelId'));
    assert.ok(result.permissionProblems.some((item) => (
        item.path === 'disciplineSettings.channelId' &&
        item.missing.includes(PermissionFlagsBits.ManageThreads)
    )));
    assert.ok(result.permissionProblems.some((item) => item.path === 'channelCounterSettings.employeesChannelId'));
    assert.ok(result.channelTypeProblems.some((item) => item.path === 'examinationSettings.lectureVoiceChannelId'));
    assert.ok(result.guildPermissionProblems.some((item) => item.permission === PermissionFlagsBits.ManageNicknames));
    assert.ok(result.guildPermissionProblems.some((item) => item.permission === PermissionFlagsBits.ManageChannels));
    assert.ok(result.roleHierarchyProblems.some((item) => item.id === IDS.rank));
    assert.equal(result.missingChannels.length, 0);
    assert.equal(result.missingRoles.length, 0);
});

test('канал дисциплины требует полный набор прав для жизненного цикла ветки', () => {
    const required = getRequiredChannelPermissions('disciplineSettings.channelId');
    assert.ok(required.includes(PermissionFlagsBits.CreatePublicThreads));
    assert.ok(required.includes(PermissionFlagsBits.SendMessagesInThreads));
    assert.ok(required.includes(PermissionFlagsBits.ManageThreads));
    assert.ok(required.includes(PermissionFlagsBits.ReadMessageHistory));
});
