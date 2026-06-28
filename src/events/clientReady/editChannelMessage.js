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
const { EmbedBuilder } = require('discord.js');
const config = require('../../../config.json');

const {
    editMessageWithRetry,
    runDiscordRequest,
    sendMessageWithRetry,
} = require('../../utils/discordRequest');
const { ensureGuildMembersCached } = require('../../utils/membersCache');
const logger = require('../../utils/logger');

const UPDATE_INTERVAL_MS = 60 * 60 * 1000; // 1 час
const LEADER_TERM_DAYS = 30; // 30 дней
const DAY_MS = 24 * 60 * 60 * 1000;
const UTC_PLUS_3_OFFSET_MS = 3 * 60 * 60 * 1000;
const FOOTER = {
    text: 'WN Helper by Michael Lindberg. Discord: milkgames',
    iconURL: 'https://i.imgur.com/zdxWb0s.jpeg',
};

const DEPARTMENTS = [
    {
        key: 'rdd',
        shortName: 'RDD',
        fullName: 'Recruitment & Disciplinary Department',
        color: 0x2ECC71,
        staffChannelKey: 'RDDStaffChannelId',
        role: 'RDDRoleId',
        partWorkRole: 'partWorkRDDRoleId',
        depHeadRole: 'depHeadRDDRoleId',
        headRole: 'headRDDRoleId',
        depHeadLimit: 3,
    },
    {
        key: 'amd',
        shortName: 'AMD',
        fullName: 'Advertising Management Department',
        color: 0xE67E22,
        staffChannelKey: 'AMDStaffChannelId',
        role: 'AMDRoleId',
        partWorkRole: 'partWorkAMDRoleId',
        depHeadRole: 'depHeadAMDRoleId',
        headRole: 'headAMDRoleId',
        depHeadLimit: 2,
    },
    {
        key: 'ed',
        shortName: 'ED',
        fullName: 'Event Department',
        color: 0xFFC0CB,
        staffChannelKey: 'EDStaffChannelId',
        role: 'EDRoleId',
        partWorkRole: 'partWorkEDRoleId',
        depHeadRole: 'depHeadEDRoleId',
        headRole: 'headEDRoleId',
        depHeadLimit: 3,
    },
    {
        key: 'jd',
        shortName: 'JD',
        fullName: 'Journalism Department',
        color: 0x3498DB,
        staffChannelKey: 'JDStaffChannelId',
        role: 'JDRoleId',
        partWorkRole: 'partWorkJDRoleId',
        depHeadRole: 'depHeadJDRoleId',
        headRole: 'headJDRoleId',
        depHeadLimit: 3,
    },
];

function getConfiguredRoleId(serverConfig, key) {
    const roleId = serverConfig[key];
    return typeof roleId === 'string' && roleId.length > 0 ? roleId : null;
}

function memberHasRole(member, roleId) {
    return Boolean(roleId) && member.roles.cache.has(roleId);
}

function memberHasLeadershipRole(member, serverConfig) {
    return memberHasRole(member, getConfiguredRoleId(serverConfig, 'leaderRoleId')) ||
        memberHasRole(member, getConfiguredRoleId(serverConfig, 'depLeaderRoleId'));
}

function sortMembers(members) {
    return Array.from(members?.values ? members.values() : members || [])
        .sort((firstMember, secondMember) => {
            const roleDiff = (secondMember.roles?.highest?.position || 0) - (firstMember.roles?.highest?.position || 0);
            if (roleDiff !== 0) return roleDiff;

            return String(firstMember.displayName || firstMember.user?.username || '')
                .localeCompare(String(secondMember.displayName || secondMember.user?.username || ''), 'ru');
        });
}

function truncateFieldValue(value) {
    if (value.length <= 1024) return value;
    return `${value.slice(0, 1000)}\n... (список обрезан)`;
}

function getMembers(members, max = 0) {
    const list = sortMembers(members);
    const lines = list.map((member) => `> <@${member.user.id}>`);

    if (max > 0 && list.length > max) {
        lines.unshift(`> ⚠ Превышение лимита: ${list.length}/${max}.`);
    }

    if (max > 0) {
        for (let i = list.length; i < max; i += 1) {
            lines.push('> Место вакантно.');
        }
    }

    if (max === 0 && lines.length === 0) {
        lines.push('> Отсутствует(-ют).');
    }

    return truncateFieldValue(lines.join('\n') || '> Отсутствует(-ют).');
}

function createBaseEmbed(color, title) {
    return new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setTimestamp()
        .setFooter(FOOTER);
}

function getDepartmentRoles(serverConfig, department) {
    return {
        staff: getConfiguredRoleId(serverConfig, department.role),
        partWork: getConfiguredRoleId(serverConfig, department.partWorkRole),
        depHead: getConfiguredRoleId(serverConfig, department.depHeadRole),
        head: getConfiguredRoleId(serverConfig, department.headRole),
    };
}

function getDepartmentStaffGroups(members, serverConfig, department) {
    const roles = getDepartmentRoles(serverConfig, department);
    const traineeRoleId = getConfiguredRoleId(serverConfig, 'traineeRoleId');

    return {
        curators: members.filter((member) =>
            memberHasRole(member, roles.head) && memberHasLeadershipRole(member, serverConfig)),
        heads: members.filter((member) =>
            memberHasRole(member, roles.head) && !memberHasLeadershipRole(member, serverConfig)),
        depHeads: members.filter((member) => memberHasRole(member, roles.depHead)),
        staff: members.filter((member) =>
            memberHasRole(member, roles.staff) &&
            !memberHasRole(member, roles.head) &&
            !memberHasRole(member, roles.depHead) &&
            !memberHasRole(member, traineeRoleId)),
        partWork: members.filter((member) => memberHasRole(member, roles.partWork)),
    };
}

function buildDepartmentEmbed(members, serverConfig, department) {
    const groups = getDepartmentStaffGroups(members, serverConfig, department);
    const embed = createBaseEmbed(
        department.color,
        `Состав отдела ${department.fullName}`,
    );

    embed.addFields({ name: 'Куратор отдела:', value: getMembers(groups.curators, 0) });
    embed.addFields(
        { name: '**\nСтарший состав:\n**', value: ' ' },
        { name: 'Глава отдела:', value: getMembers(groups.heads, 1) },
        { name: 'Заместители главы отдела:', value: getMembers(groups.depHeads, department.depHeadLimit) },
    );
    embed.addFields(
        { name: '**\nОсновной состав:\n**', value: ' ' },
        { name: ' ', value: getMembers(groups.staff, 0) },
    );
    embed.addFields(
        { name: '**\nСотрудники при подработке:\n**', value: ' ' },
        { name: ' ', value: getMembers(groups.partWork, 0) },
        { name: ' ', value: '-# Информация обновляется каждый час.' },
    );

    return embed;
}

function parseIsoDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;

    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));

    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
    ) {
        return null;
    }

    return date;
}

function formatDate(date) {
    const day = String(date.getUTCDate()).padStart(2, '0');
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const year = date.getUTCFullYear();

    return `${day}.${month}.${year}`;
}

function getTodayUtc3Date() {
    const now = new Date(Date.now() + UTC_PLUS_3_OFFSET_MS);
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function formatDay(day) {
    const absDay = Math.abs(day);
    const lastTwoDigits = absDay % 100;
    const lastDigit = absDay % 10;

    if (lastTwoDigits >= 11 && lastTwoDigits <= 14) {
        return ' дней';
    }

    if (lastDigit === 1) {
        return ' день';
    }

    if (lastDigit >= 2 && lastDigit <= 4) {
        return ' дня';
    }

    return ' дней';
}

function getLeaderTermInfo(appointmentDateString) {
    const appointmentDate = parseIsoDate(appointmentDateString);
    if (!appointmentDate) {
        return {
            appointmentDate: 'Не указана.',
            term: `Срок не указан.`,
            termEndDate: `Невозможно рассчитать.`
        };
    }

    const today = getTodayUtc3Date();
    if (appointmentDate.getTime() > today.getTime()) {
        return {
            appointmentDate: formatDate(appointmentDate),
            term: `Срок ещё не начался.`,
            termEndDate: `Невозможно рассчитать.`
        };
    }

    const daysPassed = Math.floor((today.getTime() - appointmentDate.getTime()) / DAY_MS);
    const termNumber = Math.floor(daysPassed / LEADER_TERM_DAYS) + 1;
    const termEndDate = new Date(appointmentDate.getTime() + (termNumber * LEADER_TERM_DAYS - 1) * DAY_MS);

    return {
        appointmentDate: formatDate(appointmentDate),
        term: `${termNumber}-й срок, ${daysPassed + formatDay(daysPassed)} на должности.`,
        termEndDate: formatDate(termEndDate)
    };
}

function getCuratedDepartment(member, serverConfig) {
    const department = DEPARTMENTS.find(({ headRole }) =>
        memberHasRole(member, getConfiguredRoleId(serverConfig, headRole)),
    );

    return department?.shortName ?? null;
}

function formatGeneralDirector(leaders, serverConfig) {
    const termInfo = getLeaderTermInfo(serverConfig.leaderAppointmentDate);
    const list = sortMembers(leaders);
    const lines = [];

    if (list.length > 1) {
        lines.push(`> ⚠ Превышение лимита: ${list.length}/1.`);
    }

    if (list.length === 0) {
        lines.push('> Место вакантно.');
    } else {
        const leader = list[0];
        const department = getCuratedDepartment(leader, serverConfig);
        const curatorText = department ? ` - куратор отдела ${department}` : '';

        lines.push(`> <@${leader.user.id}>${curatorText}`);
    }

    lines.push(`> Дата назначения: ${termInfo.appointmentDate}`);
    lines.push(`> ${termInfo.term}`);
    lines.push(`> Дата окончания текущего срока: ${termInfo.termEndDate}`);

    return truncateFieldValue(lines.join('\n'));
}

function formatDeputyDirectors(depLeaders, serverConfig) {
    const list = sortMembers(depLeaders);
    const lines = list.map((member) => {
        const department = getCuratedDepartment(member, serverConfig);
        const curatorText = department ? ` - куратор отдела ${department}` : '';

        return `> <@${member.user.id}>${curatorText}`;
    });

    if (list.length > 3) {
        lines.unshift(`> ⚠ Превышение лимита: ${list.length}/3.`);
    }

    for (let i = list.length; i < 3; i += 1) {
        lines.push('> Место вакантно.');
    }

    return truncateFieldValue(lines.join('\n') || '> Отсутствует(-ют).');
}

function buildHighStaffEmbed(members, serverConfig) {
    const leaderRoleId = getConfiguredRoleId(serverConfig, 'leaderRoleId');
    const depLeaderRoleId = getConfiguredRoleId(serverConfig, 'depLeaderRoleId');
    const leaders = members.filter((member) => memberHasRole(member, leaderRoleId));
    const depLeaders = members.filter((member) =>
        memberHasRole(member, depLeaderRoleId) && !memberHasRole(member, leaderRoleId));

    const embed = createBaseEmbed(0xF1C40F, 'Руководящий и старший составы Weazel News');

    embed.addFields(
        { name: 'Генеральный директор:', value: formatGeneralDirector(leaders, serverConfig) },
        { name: 'Заместители директора:', value: formatDeputyDirectors(depLeaders, serverConfig) },
    );

    for (const department of DEPARTMENTS) {
        const groups = getDepartmentStaffGroups(members, serverConfig, department);

        embed.addFields(
            { name: `**\n${department.shortName} - ${department.fullName}\n**`, value: ' ' },
            { name: 'Глава отдела:', value: getMembers(groups.heads, 1) },
            { name: 'Заместители главы отдела:', value: getMembers(groups.depHeads, department.depHeadLimit) },
        );
    }

    embed.addFields({ name: ' ', value: '-# Информация обновляется каждый час.' });

    return embed;
}

async function getLastBotMessage(channel) {
    return runDiscordRequest(async () => {
        const messages = await channel.messages.fetch({ limit: 100 });
        return messages.find((message) => message.author?.id === channel.client.user.id) || null;
    });
}

async function upsertChannelMessage(channel, embed, nonceSeed) {
    const existingMessage = await getLastBotMessage(channel);

    if (existingMessage) {
        await editMessageWithRetry(existingMessage, { embeds: [embed] });
        return;
    }

    await sendMessageWithRetry(channel, { embeds: [embed] }, { nonceSeed });
}

async function fetchTextChannel(client, channelId, serverId, channelKey) {
    if (!channelId) return null;

    try {
        const channel = await runDiscordRequest(() => client.channels.fetch(channelId));

        if (!channel?.isTextBased?.() || !channel.messages) {
            logger.info(`Канал ${channelKey} сервера ${serverId} не является текстовым каналом.`);
            return null;
        }

        return channel;
    } catch (error) {
        logger.info(`Не удалось получить канал ${channelKey} сервера ${serverId}: ${error}`);
        return null;
    }
}

async function updateServerMessages(client, serverId, serverConfig, channels) {
    const guild = client.guilds.cache.get(serverId);

    if (!guild) {
        logger.info(`Сервер ${serverId} не найден в кэше клиента.`);
        return;
    }

    const members = await ensureGuildMembersCached(guild);
    const updates = [];

    for (const department of DEPARTMENTS) {
        const channel = channels.departments[department.key];
        if (!channel) continue;

        updates.push(upsertChannelMessage(
            channel,
            buildDepartmentEmbed(members, serverConfig, department),
            `dept:${serverId}:${department.key}`,
        ));
    }

    if (channels.highStaff) {
        updates.push(upsertChannelMessage(
            channels.highStaff,
            buildHighStaffEmbed(members, serverConfig),
            `high-staff:${serverId}`,
        ));
    }

    const results = await Promise.allSettled(updates);
    for (const result of results) {
        if (result.status === 'rejected') {
            logger.info(`Произошла ошибка при обновлении сообщения в канале: ${result.reason}`);
        }
    }
}

async function getServerChannels(client, serverId, serverConfig) {
    const departments = {};

    for (const department of DEPARTMENTS) {
        departments[department.key] = await fetchTextChannel(
            client,
            serverConfig[department.staffChannelKey],
            serverId,
            department.staffChannelKey,
        );
    }

    const highStaff = await fetchTextChannel(client, serverConfig.highStaffChannelId, serverId, 'highStaffChannelId');

    return { departments, highStaff };
}

async function updateAllServerMessages(client, scheduleUpdates = true) {
    try {
        for (const [serverId, serverConfig] of Object.entries(config.servers)) {
            const channels = await getServerChannels(client, serverId, serverConfig);
            const hasAnyChannel = channels.highStaff || Object.values(channels.departments).some(Boolean);

            if (!hasAnyChannel) continue;

            await updateServerMessages(client, serverId, serverConfig, channels);

            if (scheduleUpdates) {
                setInterval(() => {
                    updateServerMessages(client, serverId, serverConfig, channels).catch((error) => {
                        logger.info(`Произошла ошибка при обновлении сообщения в канале: ${error}`);
                    });
                }, UPDATE_INTERVAL_MS);
            }
        }
    } catch (error) {
        logger.info(`Произошла ошибка при обновлении сообщения в канале: ${error}`);
    }
} 

module.exports = async (client) => {
    await updateAllServerMessages(client);
};

module.exports.updateAllServerMessages = updateAllServerMessages;