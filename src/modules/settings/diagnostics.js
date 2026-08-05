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
const { PermissionFlagsBits } = require('discord.js');

const { getCommandRegistryStatus } = require('../../app/commandRegistry');
const { getApplicationReadinessStatus } = require('../../app/readiness');
const { getSchedulerStatus } = require('../../app/schedulerRegistry');
const { getBackupStatus } = require('../../core/database/backup');
const { getDatabaseStatus } = require('../../core/database/status');
const { getRecoveryPlanStatus } = require('../../core/database/recovery');
const logger = require('../../core/logging/logger');
const { getPublicStatus } = require('../../core/runtime/instance');
const { getLeaseStatus } = require('../../core/runtime/lease');
const { getShutdownStatus } = require('../../core/runtime/shutdown');
const channelCounters = require('../channel-counters');
const examinationModule = require('../examination');
const formsModule = require('../forms');
const staffLists = require('../staff-lists');

const PERMISSION_LABELS = new Map([
    [PermissionFlagsBits.ViewChannel, 'просмотр канала'],
    [PermissionFlagsBits.SendMessages, 'отправка сообщений'],
    [PermissionFlagsBits.EmbedLinks, 'встраивание ссылок'],
    [PermissionFlagsBits.ReadMessageHistory, 'чтение истории'],
    [PermissionFlagsBits.AddReactions, 'добавление реакций'],
    [PermissionFlagsBits.CreatePublicThreads, 'создание публичных веток'],
    [PermissionFlagsBits.SendMessagesInThreads, 'отправка сообщений в ветках'],
    [PermissionFlagsBits.ManageThreads, 'управление ветками'],
    [PermissionFlagsBits.ManageChannels, 'управление каналами'],
    [PermissionFlagsBits.ManageRoles, 'управление ролями'],
    [PermissionFlagsBits.ManageNicknames, 'управление никнеймами'],
]);

const TEXT_CHANNEL_PERMISSIONS = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.ReadMessageHistory,
];

function formatDuration(milliseconds) {
    const totalSeconds = Math.max(0, Math.floor(Number(milliseconds) / 1000));
    const days = Math.floor(totalSeconds / 86_400);
    const hours = Math.floor((totalSeconds % 86_400) / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;
    return [
        days ? `${days} дн.` : null,
        hours ? `${hours} ч.` : null,
        minutes ? `${minutes} мин.` : null,
        `${seconds} сек.`,
    ].filter(Boolean).join(' ');
}

function collectConfiguredIds(value, path = '', result = { channels: [], roles: [] }) {
    if (!value || typeof value !== 'object') return result;
    if (Array.isArray(value)) {
        value.forEach((item, index) => collectConfiguredIds(item, `${path}[${index}]`, result));
        return result;
    }

    for (const [key, nestedValue] of Object.entries(value)) {
        const nextPath = path ? `${path}.${key}` : key;
        if (typeof nestedValue === 'string' && /^\d{17,20}$/u.test(nestedValue)) {
            if (/channelId$/iu.test(key)) result.channels.push({ path: nextPath, id: nestedValue });
            if (/roleId$/iu.test(key)) result.roles.push({ path: nextPath, id: nestedValue });
            continue;
        }
        if (Array.isArray(nestedValue) && /roleIds$/iu.test(key)) {
            for (const roleId of nestedValue) {
                if (/^\d{17,20}$/u.test(String(roleId || ''))) {
                    result.roles.push({ path: nextPath, id: String(roleId) });
                }
            }
            continue;
        }
        if (nestedValue && typeof nestedValue === 'object' && /roleByCount$/iu.test(key)) {
            for (const [count, roleId] of Object.entries(nestedValue)) {
                if (/^\d{17,20}$/u.test(String(roleId || ''))) {
                    result.roles.push({ path: `${nextPath}.${count}`, id: String(roleId) });
                }
            }
            continue;
        }
        collectConfiguredIds(nestedValue, nextPath, result);
    }
    return result;
}

function permissionLabel(permission) {
    return PERMISSION_LABELS.get(permission) || String(permission);
}

function isVoiceChannelPath(path) {
    return /VoiceChannelId$/u.test(path);
}

function isCounterChannelPath(path) {
    return /^channelCounterSettings\./u.test(path);
}

function isThreadChannelPath(path) {
    return /^shiftTypes\[\d+\]\.channelId$/u.test(path) ||
        /^disciplineSettings\.(channelId|removalChannelId)$/u.test(path) ||
        /^disciplineSettings\.appeals\.channelId$/u.test(path);
}

function getRequiredChannelPermissions(path) {
    if (isVoiceChannelPath(path)) return [PermissionFlagsBits.ViewChannel];
    if (isCounterChannelPath(path)) {
        return [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels];
    }

    const permissions = [...TEXT_CHANNEL_PERMISSIONS];
    if (/^staffAuditSettings\.channelId$/u.test(path)) {
        permissions.push(PermissionFlagsBits.AddReactions);
    }
    if (isThreadChannelPath(path)) {
        permissions.push(
            PermissionFlagsBits.CreatePublicThreads,
            PermissionFlagsBits.SendMessagesInThreads,
            PermissionFlagsBits.ManageThreads
        );
    }
    return [...new Set(permissions)];
}

function isManagedRolePath(path) {
    return /^ranks\[\d+\]\.roleId$/u.test(path) ||
        /^departments\[\d+\]\.roles\./u.test(path) ||
        /^commonRoles\.weazelNewsRoleId$/u.test(path) ||
        /^giveRolesSettings\.dbAdditionalRoleIds$/u.test(path) ||
        /^vacationSettings\.types\[\d+\]\.(vacationRoleId|removeRoleIdsOnStart|conditionalRemoveRoleIdsOnStart)$/u.test(path) ||
        /^disciplineSettings\.recertificationRoleId$/u.test(path) ||
        /^disciplineSettings\.stages\.[^.]+\.roleByCount/u.test(path);
}

function getRequiredGuildPermissions(config) {
    const features = config?.features || {};
    const requirements = [];
    const roleFeaturesEnabled = ['staffAudit', 'giveRoles', 'vacations', 'discipline']
        .some((key) => features[key] !== false);
    if (roleFeaturesEnabled) {
        requirements.push({
            permission: PermissionFlagsBits.ManageRoles,
            reason: 'кадровые действия, отпуска, выдача ролей и взыскания',
        });
    }
    if (features.staffAudit !== false || features.giveRoles !== false) {
        requirements.push({
            permission: PermissionFlagsBits.ManageNicknames,
            reason: 'принятие, изменение ранга и увольнение сотрудников',
        });
    }
    if (config?.channelCounterSettings?.employeesChannelId || config?.channelCounterSettings?.membersChannelId) {
        requirements.push({
            permission: PermissionFlagsBits.ManageChannels,
            reason: 'обновление названий каналов-счётчиков',
        });
    }
    return requirements;
}

function channelTypeMatches(channel, path) {
    if (isVoiceChannelPath(path)) {
        if (typeof channel?.isVoiceBased === 'function') return channel.isVoiceBased();
        return true;
    }
    if (isCounterChannelPath(path)) return true;
    if (typeof channel?.isTextBased === 'function') return channel.isTextBased();
    return true;
}

function roleIsEditableByBot(role, botMember) {
    if (!role) return false;
    if (role.managed) return false;
    if (typeof role.editable === 'boolean') return role.editable;
    const highest = botMember?.roles?.highest;
    if (highest?.comparePositionTo) return highest.comparePositionTo(role) > 0;
    return true;
}

function summarizeDiscordResources(guild, config) {
    const references = collectConfiguredIds(config);
    const missingChannels = [];
    const missingRoles = [];
    const permissionProblems = [];
    const channelTypeProblems = [];
    const roleHierarchyProblems = [];
    const guildPermissionProblems = [];
    const uniqueChannels = new Map(references.channels.map((item) => [`${item.path}:${item.id}`, item]));
    const uniqueRoles = new Map(references.roles.map((item) => [`${item.path}:${item.id}`, item]));
    const botMember = guild.members?.me || null;

    for (const item of uniqueChannels.values()) {
        const channel = guild.channels.cache.get(item.id);
        if (!channel) {
            missingChannels.push(item);
            continue;
        }
        if (!channelTypeMatches(channel, item.path)) {
            channelTypeProblems.push(item);
            continue;
        }
        const permissions = channel.permissionsFor?.(botMember);
        if (!permissions?.has) continue;
        const missing = getRequiredChannelPermissions(item.path)
            .filter((permission) => !permissions.has(permission));
        if (missing.length) {
            permissionProblems.push({
                ...item,
                channelName: channel.name || null,
                missing,
                missingLabels: missing.map(permissionLabel),
            });
        }
    }

    for (const item of uniqueRoles.values()) {
        const role = guild.roles.cache.get(item.id);
        if (!role) {
            missingRoles.push(item);
            continue;
        }
        if (isManagedRolePath(item.path) && !roleIsEditableByBot(role, botMember)) {
            roleHierarchyProblems.push({
                ...item,
                roleName: role.name || null,
                managed: Boolean(role.managed),
            });
        }
    }

    const guildPermissions = botMember?.permissions;
    for (const requirement of getRequiredGuildPermissions(config)) {
        if (guildPermissions?.has && !guildPermissions.has(requirement.permission)) {
            guildPermissionProblems.push({
                ...requirement,
                label: permissionLabel(requirement.permission),
            });
        }
    }

    return {
        configuredChannels: uniqueChannels.size,
        configuredRoles: uniqueRoles.size,
        missingChannels,
        missingRoles,
        permissionProblems,
        channelTypeProblems,
        roleHierarchyProblems,
        guildPermissionProblems,
        botMemberMissing: !botMember,
    };
}

function buildDiagnostics(guild, config) {
    const instance = getPublicStatus();
    const database = getDatabaseStatus();
    const backups = getBackupStatus();
    const recoveryPlan = getRecoveryPlanStatus();
    const resources = summarizeDiscordResources(guild, config);
    const formsWorker = formsModule.getFormWorkerStatus();
    const examWorker = examinationModule.getWebhookWorkerStatus();
    const webhook = formsModule.getWebhookServerStatus();
    const counters = channelCounters.getChannelCounterStatus();
    const lists = staffLists.getStaffListStatus();
    const loggerStatus = logger.getLoggerStatus();
    const lease = getLeaseStatus();
    const shutdown = getShutdownStatus();
    const commands = getCommandRegistryStatus();
    const schedulers = getSchedulerStatus();
    const readiness = getApplicationReadinessStatus(guild.client);

    const problems = [];
    if (resources.botMemberMissing) problems.push('Бот не найден среди участников сервера.');
    for (const item of resources.missingChannels.slice(0, 5)) {
        problems.push(`Канал не найден: ${item.path} (${item.id})`);
    }
    for (const item of resources.missingRoles.slice(0, 5)) {
        problems.push(`Роль не найдена: ${item.path} (${item.id})`);
    }
    for (const item of resources.channelTypeProblems.slice(0, 5)) {
        problems.push(`Неверный тип канала: ${item.path} (${item.id})`);
    }
    for (const item of resources.permissionProblems.slice(0, 8)) {
        problems.push(`Не хватает прав в ${item.path}: ${item.missingLabels.join(', ')}.`);
    }
    for (const item of resources.guildPermissionProblems.slice(0, 5)) {
        problems.push(`Не хватает общего права "${item.label}" для: ${item.reason}.`);
    }
    for (const item of resources.roleHierarchyProblems.slice(0, 8)) {
        problems.push(`Бот не может управлять ролью ${item.path} (${item.roleName || item.id}).`);
    }
    if (database.recoveryMode) problems.push('База данных работает в режиме восстановления.');
    if (database.maintenance) problems.push(`Изменения базы данных заблокированы: ${database.maintenanceReason}`);
    if (database.lastWriteError) problems.push(`Последняя ошибка базы данных: ${database.lastWriteError}`);
    if (backups.lastBackupError) problems.push(`Последняя ошибка резервного копирования: ${backups.lastBackupError}`);
    if (recoveryPlan?.unresolvedConflicts) problems.push(`Неразрешённых конфликтов восстановления: ${recoveryPlan.unresolvedConflicts}`);
    for (const problem of readiness.problems.slice(0, 8)) {
        if (!problems.includes(problem)) problems.push(problem);
    }

    return {
        sections: [
            {
                title: 'Конфигурация Discord',
                lines: [
                    `Настроенных каналов: ${resources.configuredChannels}`,
                    `Настроенных ролей: ${resources.configuredRoles}`,
                    `Удалённых каналов: ${resources.missingChannels.length}`,
                    `Удалённых ролей: ${resources.missingRoles.length}`,
                    `Каналов неверного типа: ${resources.channelTypeProblems.length}`,
                ],
            },
            {
                title: 'Полномочия Discord',
                lines: [
                    `Каналов с недостаточными правами: ${resources.permissionProblems.length}`,
                    `Недостающих общих прав: ${resources.guildPermissionProblems.length}`,
                    `Недоступных для управления ролей: ${resources.roleHierarchyProblems.length}`,
                    `Manage Roles: ${guild.members?.me?.permissions?.has?.(PermissionFlagsBits.ManageRoles) ? 'есть' : 'нет'}`,
                    `Manage Nicknames: ${guild.members?.me?.permissions?.has?.(PermissionFlagsBits.ManageNicknames) ? 'есть' : 'нет'}`,
                    `Manage Channels: ${guild.members?.me?.permissions?.has?.(PermissionFlagsBits.ManageChannels) ? 'есть' : 'нет'}`,
                ],
            },
            {
                title: 'База данных',
                lines: [
                    `Режим восстановления: ${database.recoveryMode ? 'включён' : 'выключен'}`,
                    `Техническая блокировка: ${database.maintenance ? 'включена' : 'выключена'}`,
                    `Операций в очереди: ${database.pendingMutations}`,
                    `Последняя запись: ${database.lastWriteAt ? `<t:${Math.floor(database.lastWriteAt / 1000)}:R>` : 'в этом запуске ещё не было'}`,
                    `Резервных копий: ${backups.count}/${backups.validCount} валидных`,
                    `Последняя копия: ${backups.lastBackupName || 'не создана'}`,
                ],
            },
            {
                title: 'Состояние процесса',
                lines: [
                    `Полная готовность: ${readiness.ready ? 'подтверждена' : 'есть проблемы'}`,
                    `Время работы: ${formatDuration(instance.uptimeMs)}`,
                    `PID: ${instance.pid}`,
                    `Команд в реестре: ${commands.count}`,
                    `Обработчиков запуска: ${readiness.handlers.succeeded}/${readiness.handlers.total}, ошибок: ${readiness.handlers.failed}`,
                    `Блокировка одного инстанса: ${lease.acquired && lease.heartbeatFresh ? 'активна' : 'неактивна'}`,
                    `Завершение работы: ${shutdown.shuttingDown ? 'выполняется' : 'не запрошено'}`,
                    `Лог-файлов: ${loggerStatus.fileCount}, общий размер: ${loggerStatus.totalSize} байт`,
                ],
            },
            {
                title: 'Фоновые процессы',
                lines: [
                    `Вебхук-сервер: ${webhook.started && webhook.listening ? 'работает' : 'остановлен'}`,
                    `Обработчиков вебхука: ${webhook.handlerCount}`,
                    `Очередь форм: ${formsWorker.workerStarted ? (formsWorker.workerBusy ? 'обрабатывается' : 'ожидает') : 'остановлена'}`,
                    `Очередь экзаменов: ${examWorker.workerStarted ? (examWorker.workerBusy ? 'обрабатывается' : 'ожидает') : 'остановлена'}`,
                    `Общих планировщиков: ${schedulers.count}`,
                    `Планировщик составов: ${lists.schedulerActive ? 'работает' : 'остановлен'}`,
                    `Планировщик счётчиков: ${counters.schedulerActive ? 'работает' : 'остановлен'}`,
                    `WEBHOOK_KEY: ${process.env.WEBHOOK_KEY ? 'задан' : 'не задан'}`,
                    `TEST_KEY: ${process.env.TEST_KEY ? 'задан' : 'не задан'}`,
                ],
            },
        ],
        problems,
    };
}

module.exports = {
    buildDiagnostics,
    collectConfiguredIds,
    formatDuration,
    getRequiredChannelPermissions,
    getRequiredGuildPermissions,
    isManagedRolePath,
    summarizeDiscordResources,
};
