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
const {
    ActionRowBuilder,
    ApplicationCommandOptionType,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
} = require('discord.js');
const guildConfigService = require('../../core/config/guildConfigService');
const staffAudit = require('../staff-audit');
const memberOffboardingService = require('../offboarding');
const discipline = require('../discipline');
const examinationService = require('../examination');
const vacationService = require('../vacations');
const shifts = require('../shifts');
const giveRolesModule = require('../give-roles');
const channelCounters = require('../channel-counters');
const staffLists = require('../staff-lists');

const { StaffAuditError } = staffAudit;
const staffAuditBatchService = staffAudit;
const massDisciplineService = discipline;
const { DisciplineError } = discipline;
const { ExaminationError } = examinationService;
const { VacationError } = vacationService;
const { giveRoles, blackListGiveRoles } = giveRolesModule;
const { updateGuildChannelCounters } = channelCounters;
const { syncGuildShiftSchedules } = shifts;
const { updateGuildStaffLists } = staffLists;
const {
    deferReplyWithRetry,
    editMessageWithRetry,
    editReplyWithRetry,
    replyWithRetry,
} = require('../../core/discord/request');
const logger = require('../../core/logging/logger');
const { buildPublicErrorMessage } = require('../../core/ui/errorMessage');
const { getBackupStatus, listBackups } = require('../../core/database/backup');
const { getDatabaseStatus } = require('../../core/database/status');
const {
    createRecoveryPlan,
    getRecoveryPlanStatus,
    resolveRecoveryConflict,
} = require('../../core/database/recovery');
const { getPrivateStatus, getPublicStatus } = require('../../core/runtime/instance');
const { getShutdownStatus } = require('../../core/runtime/shutdown');
const { createShutdownConfirmation } = require('../../core/runtime/shutdownConfirmation');
const { createDatabaseRecoveryConfirmation } = require('./databaseRecoveryConfirmation');
const { buildPendingStatus, buildWebhookStatus } = require('./status');
const {
    OWNER_ONLY_SUBCOMMANDS,
    canUseManualTool,
    isOwnerUser,
} = require('./access');

const REFRESH_TARGETS = new Map([
    ['staff_lists', 'сообщения составов'],
    ['counters', 'счётчики каналов'],
    ['shifts', 'расписания смен'],
    ['all', 'все обслуживаемые данные'],
]);

function formatDuration(milliseconds) {
    const seconds = Math.max(0, Math.floor(Number(milliseconds) / 1000));
    const days = Math.floor(seconds / 86_400);
    const hours = Math.floor((seconds % 86_400) / 3_600);
    const minutes = Math.floor((seconds % 3_600) / 60);
    return [
        days ? `${days} дн.` : null,
        hours ? `${hours} ч.` : null,
        `${minutes} мин.`,
    ].filter(Boolean).join(' ');
}

function formatBytes(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return `${bytes} байт`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} КБ`;
    return `${(bytes / (1024 ** 2)).toFixed(1)} МБ`;
}

function normalizeUserId(input) {
    return String(input || '').replace(/[<@!>]/g, '').trim();
}

function buildRecordQuery(record, guildId, userId) {
    const query = { guildId, userId };

    if (record?.requestId) {
        query.requestId = record.requestId;
    } else if (record?.messageId) {
        query.messageId = record.messageId;
    } else if (record?.createdAt) {
        query.createdAt = record.createdAt;
    } else if (record?.status !== undefined) {
        query.status = record.status;
    }

    return query;
}

function buildResetEmbeds(message) {
    const embeds = Array.isArray(message?.embeds)
        ? message.embeds.map((embed) => EmbedBuilder.from(embed))
        : [];

    if (!embeds.length) return embeds;

    const currentTitle = String(message.embeds[0]?.title || 'Заявка на выдачу ролей');
    const baseTitle = currentTitle
        .replace(/\s*-\s*НА РАССМОТРЕНИИ\s*$/iu, '')
        .trim() || 'Заявка на выдачу ролей';

    embeds[0]
        .setTitle(`${baseTitle} - СБРОШЕНА ВРУЧНУЮ`.slice(0, 256))
        .setColor(0x95A5A6);

    return embeds;
}

async function disableGiveRolesMessage(client, serverConfig, record, context) {
    if (!record?.messageId) return 'missing';

    const channelId = serverConfig?.channels?.confirmRoleChannelId;
    if (!channelId) {
        logger.warn('Ручные инструменты: у заявки выдачи ролей нет доступного канала для отключения сообщения', {
            ...context,
            messageId: record.messageId,
        });
        return 'failed';
    }

    let channel;
    try {
        channel = await client.channels.fetch(channelId);
    } catch (error) {
        logger.warn('Ручные инструменты: не удалось получить канал заявки выдачи ролей', {
            ...context,
            channelId,
            messageId: record.messageId,
        }, error);
        return 'failed';
    }

    if (!channel?.messages?.fetch) {
        logger.warn('Ручные инструменты: для заявки выдачи ролей настроен неподходящий канал', {
            ...context,
            channelId,
            messageId: record.messageId,
        });
        return 'failed';
    }

    let message;
    try {
        message = await channel.messages.fetch(record.messageId);
    } catch (error) {
        if (Number(error?.code) === 10_008) return 'missing';

        logger.warn('Ручные инструменты: не удалось получить сообщение заявки выдачи ролей', {
            ...context,
            channelId,
            messageId: record.messageId,
        }, error);
        return 'failed';
    }

    try {
        const embeds = buildResetEmbeds(message);
        await editMessageWithRetry(message, {
            ...(embeds.length ? { embeds } : {}),
            components: [],
            allowedMentions: { parse: [] },
        });
        return 'updated';
    } catch (error) {
        if (Number(error?.code) === 10_008) return 'missing';

        logger.warn('Ручные инструменты: не удалось отключить сообщение заявки выдачи ролей', {
            ...context,
            channelId,
            messageId: record.messageId,
        }, error);
        return 'failed';
    }
}

async function refreshGuildData(client, guildId, target, actorId) {
    const reason = `manualtools:${actorId}`;
    const tasks = [];

    if (target === 'staff_lists' || target === 'all') {
        tasks.push(() => updateGuildStaffLists(client, guildId, { reason }));
    }

    if (target === 'counters' || target === 'all') {
        tasks.push(() => updateGuildChannelCounters(client, guildId, { reason }));
    }

    if (target === 'shifts' || target === 'all') {
        tasks.push(() => syncGuildShiftSchedules(client, guildId, { reason }));
    }

    const results = await Promise.allSettled(tasks.map((task) => task()));
    const errors = results
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason);

    if (errors.length) {
        throw new AggregateError(errors, 'Не все действия ручной синхронизации выполнены');
    }
}

module.exports = {
    name: 'manualtools',
    description: 'Ручные восстановительные и обслуживающие действия.',
    options: [
        {
            name: 'reset_giveroles',
            description: 'Сбросить активную заявку пользователя на выдачу ролей.',
            type: ApplicationCommandOptionType.Subcommand,
            options: [
                {
                    name: 'user_id',
                    description: 'Discord ID пользователя или пинг.',
                    type: ApplicationCommandOptionType.String,
                    required: true,
                },
            ],
        },
        {
            name: 'unblock_giveroles',
            description: 'Разблокировать отправку заявок на выдачу ролей.',
            type: ApplicationCommandOptionType.Subcommand,
            options: [
                {
                    name: 'user_id',
                    description: 'Discord ID пользователя или пинг.',
                    type: ApplicationCommandOptionType.String,
                    required: true,
                },
            ],
        },
        {
            name: 'retry_uval',
            description: 'Продолжить неудавшееся увольнение.',
            type: ApplicationCommandOptionType.Subcommand,
            options: [
                {
                    name: 'uval_id',
                    description: 'ID увольнения из сообщения об ошибке.',
                    type: ApplicationCommandOptionType.String,
                    required: true,
                },
            ],
        },
        {
            name: 'retry_staff_action',
            description: 'Продолжить неудавшееся принятие или изменение ранга.',
            type: ApplicationCommandOptionType.Subcommand,
            options: [
                {
                    name: 'operation_id',
                    description: 'ID операции кадрового аудита из сообщения об ошибке.',
                    type: ApplicationCommandOptionType.String,
                    required: true,
                },
            ],
        },
        {
            name: 'retry_massaudit',
            description: 'Продолжить частично выполненный массовый кадровый аудит.',
            type: ApplicationCommandOptionType.Subcommand,
            options: [
                {
                    name: 'massaudit_id',
                    description: 'ID массового КА из итогового сообщения.',
                    type: ApplicationCommandOptionType.String,
                    required: true,
                },
            ],
        },
        {
            name: 'retry_massdiscipline',
            description: 'Продолжить частично выполненное массовое дисциплинарное дело.',
            type: ApplicationCommandOptionType.Subcommand,
            options: [
                {
                    name: 'massdiscipline_id',
                    description: 'ID массового дисциплинарного дела из итогового сообщения.',
                    type: ApplicationCommandOptionType.String,
                    required: true,
                },
            ],
        },
        {
            name: 'retry_exam_request',
            description: 'Восстановить сообщение заявки экзаменации.',
            type: ApplicationCommandOptionType.Subcommand,
            options: [
                {
                    name: 'request_id',
                    description: 'ID заявки на лекцию или пересдачу.',
                    type: ApplicationCommandOptionType.String,
                    required: true,
                },
            ],
        },
        {
            name: 'retry_vacation',
            description: 'Восстановить или продолжить заявку на отпуск.',
            type: ApplicationCommandOptionType.Subcommand,
            options: [
                {
                    name: 'vacation_id',
                    description: 'ID заявки на отпуск.',
                    type: ApplicationCommandOptionType.String,
                    required: true,
                },
            ],
        },
        {
            name: 'instance_status',
            description: 'Показать состояние текущего процесса без секретного ID.',
            type: ApplicationCommandOptionType.Subcommand,
        },
        {
            name: 'shutdown_instance',
            description: 'Остановить конкретный инстанс бота по ID из логов.',
            type: ApplicationCommandOptionType.Subcommand,
            options: [
                {
                    name: 'instance_id',
                    description: 'Точный ID инстанса из его лог-файла.',
                    type: ApplicationCommandOptionType.String,
                    required: true,
                },
                {
                    name: 'mode',
                    description: 'Режим завершения работы.',
                    type: ApplicationCommandOptionType.String,
                    required: true,
                    choices: [
                        { name: 'Корректное завершение', value: 'graceful' },
                        { name: 'Ускоренное завершение', value: 'force' },
                    ],
                },
            ],
        },
        {
            name: 'database_status',
            description: 'Показать состояние базы данных и резервных копий.',
            type: ApplicationCommandOptionType.Subcommand,
        },
        {
            name: 'webhook_status',
            description: 'Показать состояние webhook-сервера и очередей доставки.',
            type: ApplicationCommandOptionType.Subcommand,
        },
        {
            name: 'pending_status',
            description: 'Показать незавершённые и проблемные операции сервера.',
            type: ApplicationCommandOptionType.Subcommand,
        },
        {
            name: 'database_compare',
            description: 'Сравнить текущую базу данных с резервной копией.',
            type: ApplicationCommandOptionType.Subcommand,
            options: [
                {
                    name: 'backup',
                    description: 'Файл резервной копии из папки backups.',
                    type: ApplicationCommandOptionType.String,
                    required: true,
                    autocomplete: true,
                },
            ],
        },
        {
            name: 'database_resolve',
            description: 'Разрешить один конфликт плана восстановления базы данных.',
            type: ApplicationCommandOptionType.Subcommand,
            options: [
                {
                    name: 'plan_id',
                    description: 'ID плана из результата сравнения.',
                    type: ApplicationCommandOptionType.String,
                    required: true,
                },
                {
                    name: 'conflict',
                    description: 'Номер конфликта.',
                    type: ApplicationCommandOptionType.Integer,
                    required: true,
                    minValue: 1,
                },
                {
                    name: 'resolution',
                    description: 'Какую запись оставить.',
                    type: ApplicationCommandOptionType.String,
                    required: true,
                    choices: [
                        { name: 'Оставить текущую запись', value: 'keep_current' },
                        { name: 'Восстановить запись из резервной копии', value: 'restore_backup' },
                    ],
                },
            ],
        },
        {
            name: 'database_apply',
            description: 'Подтвердить безопасное объединение по плану восстановления.',
            type: ApplicationCommandOptionType.Subcommand,
            options: [
                {
                    name: 'plan_id',
                    description: 'ID плана из результата сравнения.',
                    type: ApplicationCommandOptionType.String,
                    required: true,
                },
            ],
        },
        {
            name: 'refresh',
            description: 'Принудительно синхронизировать данные текущего сервера.',
            type: ApplicationCommandOptionType.Subcommand,
            options: [
                {
                    name: 'target',
                    description: 'Что нужно синхронизировать.',
                    type: ApplicationCommandOptionType.String,
                    required: true,
                    choices: [
                        { name: 'Составы', value: 'staff_lists' },
                        { name: 'Счётчики каналов', value: 'counters' },
                        { name: 'Смены', value: 'shifts' },
                        { name: 'Всё', value: 'all' },
                    ],
                },
            ],
        },
    ],

    autocomplete: async (_client, interaction) => {
        try {
            const subcommand = interaction.options.getSubcommand(false);
            if (subcommand === 'database_compare') {
                if (!isOwnerUser(interaction.user?.id)) {
                    await interaction.respond([]);
                    return;
                }
                const focused = String(interaction.options.getFocused() || '').toLocaleLowerCase('ru');
                const choices = listBackups()
                    .filter((backup) => backup.valid && backup.name.toLocaleLowerCase('ru').includes(focused))
                    .slice(0, 25)
                    .map((backup) => ({
                        name: `${backup.name} - ${formatBytes(backup.size)}`.slice(0, 100),
                        value: backup.name.slice(0, 100),
                    }));
                await interaction.respond(choices);
                return;
            }
            await interaction.respond([]);
        } catch (error) {
            logger.error('Не удалось сформировать автодополнение служебной команды', {
                guildId: interaction.guildId,
                userId: interaction.user?.id,
            }, error);
            await interaction.respond([]).catch(() => undefined);
        }
    },

    callback: async (client, interaction) => {
        const guildId = interaction.guildId;
        const actorId = interaction.user.id;
        const subcommand = interaction.options.getSubcommand(true);
        const accessMember = interaction.member || { id: actorId, roles: [] };

        if (!canUseManualTool(accessMember, guildId, subcommand)) {
            logger.warn('Отклонена попытка запуска /manualtools без настроенного доступа', {
                guildId,
                actorId,
                subcommand,
            });
            await replyWithRetry(interaction, {
                content: 'У вас нет доступа к этой подкоманде /manualtools.',
                flags: MessageFlags.Ephemeral,
                allowedMentions: { parse: [] },
            });
            return;
        }

        if (subcommand === 'shutdown_instance') {
            if (!isOwnerUser(actorId)) {
                logger.warn('Отклонена попытка остановки инстанса без прав владельца', {
                    guildId,
                    actorId,
                });
                await replyWithRetry(interaction, {
                    content: 'Недостаточно прав для выполнения этого действия.',
                    flags: MessageFlags.Ephemeral,
                    allowedMentions: { parse: [] },
                });
                return;
            }

            const requestedId = interaction.options.getString('instance_id', true).trim();
            if (requestedId !== getPrivateStatus().instanceId) {
                logger.warn('Запрос на остановку предназначен другому инстансу', {
                    guildId,
                    actorId,
                });
                return;
            }
        }

        await deferReplyWithRetry(interaction, { flags: MessageFlags.Ephemeral });

        try {
            if (OWNER_ONLY_SUBCOMMANDS.has(subcommand) && !isOwnerUser(actorId)) {
                logger.warn('Отклонена попытка запуска служебного действия владельца', {
                    guildId,
                    actorId,
                    subcommand,
                });
                await editReplyWithRetry(interaction, {
                    content: 'Недостаточно прав для выполнения этого действия.',
                    allowedMentions: { parse: [] },
                });
                return;
            }

            if (subcommand === 'instance_status') {
                const runtime = getPublicStatus();
                const shutdown = getShutdownStatus();
                const database = getDatabaseStatus();
                const backup = getBackupStatus();
                await editReplyWithRetry(interaction, {
                    content: [
                        'Состояние текущего процесса:',
                        `- Время запуска: <t:${Math.floor(runtime.startedAt / 1000)}:F>`,
                        `- Время работы: ${formatDuration(runtime.uptimeMs)}`,
                        `- PID: ${runtime.pid}`,
                        `- Завершение работы: ${shutdown.shuttingDown ? 'выполняется' : 'не запрошено'}`,
                        `- Операций базы в очереди: ${database.pendingMutations}`,
                        `- Последняя запись базы: ${database.lastWriteAt ? `<t:${Math.floor(database.lastWriteAt / 1000)}:R>` : 'в этом запуске ещё не было'}`,
                        `- Последняя резервная копия: ${backup.lastBackupName || 'не создана'}`,
                    ].join('\n'),
                    allowedMentions: { parse: [] },
                });
                return;
            }

            if (subcommand === 'shutdown_instance') {
                const mode = interaction.options.getString('mode', true);
                const confirmation = createShutdownConfirmation({
                    actorId,
                    guildId,
                    mode,
                });
                logger.warn('Владелец запросил подтверждение остановки текущего инстанса', {
                    guildId,
                    actorId,
                    mode,
                });
                await editReplyWithRetry(interaction, {
                    content: [
                        'Подтвердите остановку текущего инстанса.',
                        mode === 'force'
                            ? 'Будет выполнена короткая попытка корректного завершения, затем процесс остановится принудительно.'
                            : 'Бот завершит текущие операции и корректно остановит процесс.',
                        'Подтверждение действует 2 минуты.',
                    ].join('\n'),
                    components: [new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId(`wn-shutdown:confirm:${confirmation.token}`)
                            .setLabel('Выключить инстанс')
                            .setStyle(ButtonStyle.Danger),
                        new ButtonBuilder()
                            .setCustomId(`wn-shutdown:cancel:${confirmation.token}`)
                            .setLabel('Отмена')
                            .setStyle(ButtonStyle.Secondary)
                    )],
                    allowedMentions: { parse: [] },
                });
                return;
            }

            if (subcommand === 'database_status') {
                const database = getDatabaseStatus();
                const backup = getBackupStatus();
                const plan = getRecoveryPlanStatus();
                await editReplyWithRetry(interaction, {
                    content: [
                        'Состояние базы данных:',
                        `- Размер: ${formatBytes(database.size)}`,
                        `- Режим восстановления: ${database.recoveryMode ? 'включён' : 'выключен'}`,
                        `- Техническая блокировка: ${database.maintenance ? 'включена' : 'выключена'}`,
                        `- Операций в очереди: ${database.pendingMutations}`,
                        `- Резервных копий: ${backup.count}, валидных: ${backup.validCount}`,
                        `- Последняя резервная копия: ${backup.lastBackupName || 'не создана'}`,
                        `- Активный план: ${plan ? plan.planId : 'отсутствует'}`,
                        ...(plan ? [`- Неразрешённых конфликтов: ${plan.unresolvedConflicts}`] : []),
                    ].join('\n'),
                    allowedMentions: { parse: [] },
                });
                return;
            }

            if (subcommand === 'webhook_status') {
                const status = buildWebhookStatus(guildId);
                await editReplyWithRetry(interaction, {
                    content: status.lines.join('\n').slice(0, 1_950),
                    allowedMentions: { parse: [] },
                });
                return;
            }

            if (subcommand === 'pending_status') {
                const status = buildPendingStatus(guildId, getRecoveryPlanStatus());
                await editReplyWithRetry(interaction, {
                    content: status.lines.join('\n').slice(0, 1_950),
                    allowedMentions: { parse: [] },
                });
                return;
            }

            if (subcommand === 'database_compare') {
                const backupName = interaction.options.getString('backup', true).trim();
                const plan = createRecoveryPlan(backupName);
                logger.warn('Создан план восстановления базы данных', {
                    guildId,
                    actorId,
                    planId: plan.planId,
                    backup: backupName,
                });
                const conflictPreview = plan.conflicts.slice(0, 10).map((conflict) => (
                    `- ${conflict.number}. ${conflict.collection}: ${conflict.identity}`
                ));
                await editReplyWithRetry(interaction, {
                    content: [
                        `План восстановления создан. ID: "${plan.planId}"`,
                        `Резервная копия: "${backupName}"`,
                        `- Только в текущей базе: ${plan.summary.currentOnly}`,
                        `- Только в резервной копии: ${plan.summary.backupOnly}`,
                        `- Совпадают: ${plan.summary.identical}`,
                        `- Конфликтуют: ${plan.summary.conflicts}`,
                        ...(conflictPreview.length ? ['', 'Первые конфликты:', ...conflictPreview] : []),
                    ].join('\n').slice(0, 1_950),
                    allowedMentions: { parse: [] },
                });
                return;
            }

            if (subcommand === 'database_resolve') {
                const planId = interaction.options.getString('plan_id', true).trim();
                const conflictNumber = interaction.options.getInteger('conflict', true);
                const resolution = interaction.options.getString('resolution', true);
                const result = resolveRecoveryConflict(planId, conflictNumber, resolution);
                logger.warn('Разрешён конфликт восстановления базы данных', {
                    guildId,
                    actorId,
                    planId,
                    conflictNumber,
                    resolution,
                });
                await editReplyWithRetry(interaction, {
                    content: `Конфликт ${result.conflict.number} разрешён. Неразрешённых конфликтов осталось: ${result.plan.conflicts.filter((item) => !item.resolution).length}.`,
                    allowedMentions: { parse: [] },
                });
                return;
            }

            if (subcommand === 'database_apply') {
                const planId = interaction.options.getString('plan_id', true).trim();
                const plan = getRecoveryPlanStatus();
                if (!plan || plan.planId !== planId) {
                    await editReplyWithRetry(interaction, {
                        content: 'План восстановления с указанным ID не найден.',
                        allowedMentions: { parse: [] },
                    });
                    return;
                }
                if (plan.unresolvedConflicts > 0) {
                    await editReplyWithRetry(interaction, {
                        content: `Сначала разрешите все конфликты плана. Осталось: ${plan.unresolvedConflicts}.`,
                        allowedMentions: { parse: [] },
                    });
                    return;
                }

                const confirmation = createDatabaseRecoveryConfirmation({
                    actorId,
                    guildId,
                    planId,
                });
                logger.warn('Владелец запросил применение плана восстановления базы данных', {
                    guildId,
                    actorId,
                    planId,
                });
                await editReplyWithRetry(interaction, {
                    content: [
                        `Подтвердите применение плана "${planId}".`,
                        'Будет создана защитная копия текущей базы, после чего записи безопасно объединятся с выбранной резервной копией.',
                        'Поля конфликтующих записей автоматически смешиваться не будут.',
                        'Подтверждение действует 2 минуты.',
                    ].join('\n'),
                    components: [new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId(`wn-db-recovery:confirm:${confirmation.token}`)
                            .setLabel('Применить план')
                            .setStyle(ButtonStyle.Danger),
                        new ButtonBuilder()
                            .setCustomId(`wn-db-recovery:cancel:${confirmation.token}`)
                            .setLabel('Отмена')
                            .setStyle(ButtonStyle.Secondary)
                    )],
                    allowedMentions: { parse: [] },
                });
                return;
            }

            if (subcommand === 'reset_giveroles') {
                const userId = normalizeUserId(interaction.options.getString('user_id', true));
                if (!/^\d{17,20}$/.test(userId)) {
                    await editReplyWithRetry(interaction, {
                        content: 'Укажите корректный Discord ID пользователя или пинг.',
                        allowedMentions: { parse: [] },
                    });
                    return;
                }

                const existing = await giveRoles.findOne({ guildId, userId });
                if (!existing) {
                    await editReplyWithRetry(interaction, {
                        content: `Активная заявка пользователя <@${userId}> на этом сервере не найдена.`,
                        allowedMentions: { parse: [] },
                    });
                    return;
                }

                const serverConfig = guildConfigService.get(guildId);
                const context = {
                    guildId,
                    actorId,
                    userId,
                    requestId: existing.requestId || null,
                };
                const messageStatus = await disableGiveRolesMessage(
                    client,
                    serverConfig,
                    existing,
                    context
                );
                const result = await giveRoles.deleteOne(buildRecordQuery(existing, guildId, userId));

                if (!result.deletedCount) {
                    await editReplyWithRetry(interaction, {
                        content: 'Заявка уже была изменена или обработана во время сброса. Новая запись не удалялась.',
                        allowedMentions: { parse: [] },
                    });
                    return;
                }

                logger.info('Ручные инструменты: заявка выдачи ролей сброшена вручную', {
                    ...context,
                    messageId: existing.messageId || null,
                    messageStatus,
                });

                const warning = messageStatus === 'failed'
                    ? '\nСтарое сообщение не удалось обновить автоматически - проверьте его вручную.'
                    : '';

                await editReplyWithRetry(interaction, {
                    content: `Активная заявка пользователя <@${userId}> сброшена. Пользователь может отправить новую заявку.${warning}`,
                    allowedMentions: { parse: [] },
                });
                return;
            }

            if (subcommand === 'unblock_giveroles') {
                const userId = normalizeUserId(interaction.options.getString('user_id', true));
                if (!/^\d{17,20}$/.test(userId)) {
                    await editReplyWithRetry(interaction, {
                        content: 'Укажите корректный Discord ID пользователя или пинг.',
                        allowedMentions: { parse: [] },
                    });
                    return;
                }

                const query = { guildId, userId };
                const existing = await blackListGiveRoles.findOne(query);
                if (!existing) {
                    await editReplyWithRetry(interaction, {
                        content: `Пользователь <@${userId}> не заблокирован в системе заявок этого сервера.`,
                        allowedMentions: { parse: [] },
                    });
                    return;
                }

                const result = await blackListGiveRoles.deleteOne(query);
                if (!result.deletedCount) {
                    await editReplyWithRetry(interaction, {
                        content: 'Запись блокировки уже была удалена.',
                        allowedMentions: { parse: [] },
                    });
                    return;
                }

                logger.info('Ручные инструменты: пользователь разблокирован в выдаче ролей', {
                    guildId,
                    actorId,
                    userId,
                    blockedBy: existing.blockedBy || null,
                    blockedAt: existing.createdAt || null,
                });

                await editReplyWithRetry(interaction, {
                    content: `Пользователь <@${userId}> разблокирован и снова может отправлять заявки.`,
                    allowedMentions: { parse: [] },
                });
                return;
            }

            if (subcommand === 'retry_uval') {
                const uvalId = interaction.options.getString('uval_id', true).trim();
                const guild = interaction.guild || await client.guilds.fetch(guildId);
                const requester = await guild.members.fetch(actorId);
                const result = await memberOffboardingService.retryFailedOperation(client, {
                    uvalId,
                    requester,
                });

                logger.info('Ручные инструменты: увольнение продолжено вручную', {
                    guildId,
                    actorId,
                    uvalId,
                    status: result.status,
                });
                await editReplyWithRetry(interaction, {
                    content: `Увольнение ${uvalId} продолжено и завершено.`,
                    allowedMentions: { parse: [] },
                });
                return;
            }

            if (subcommand === 'retry_staff_action') {
                const operationId = interaction.options.getString('operation_id', true).trim();
                const result = await staffAudit.executeOperation(client, operationId);
                logger.info('Ручные инструменты: операция кадрового аудита продолжена вручную', {
                    guildId,
                    actorId,
                    operationId,
                    status: result.status,
                });
                await editReplyWithRetry(interaction, {
                    content: `Операция кадрового аудита ${operationId} продолжена и завершена.`,
                    allowedMentions: { parse: [] },
                });
                return;
            }

            if (subcommand === 'retry_massaudit') {
                const massauditId = interaction.options.getString('massaudit_id', true).trim();
                const guild = interaction.guild || await client.guilds.fetch(guildId);
                const actor = await guild.members.fetch(actorId);
                const result = await staffAuditBatchService.retryBatch(client, {
                    massauditId,
                    actor,
                });

                logger.info('Ручные инструменты: массовый кадровый аудит продолжен вручную', {
                    guildId,
                    actorId,
                    massauditId,
                    status: result.status,
                });
                await editReplyWithRetry(interaction, {
                    content: staffAuditBatchService.buildResult(result),
                    allowedMentions: { parse: [] },
                });
                return;
            }

            if (subcommand === 'retry_massdiscipline') {
                const massdisciplineId = interaction.options.getString('massdiscipline_id', true).trim();
                const guild = interaction.guild || await client.guilds.fetch(guildId);
                const requester = await guild.members.fetch(actorId);
                const result = await massDisciplineService.retryBatch(client, {
                    batchId: massdisciplineId,
                    requester,
                });

                logger.info('Ручные инструменты: массовое дисциплинарное дело продолжено вручную', {
                    guildId,
                    actorId,
                    massdisciplineId,
                    status: result.status,
                });
                await editReplyWithRetry(interaction, massDisciplineService.buildResultPayload(result));
                return;
            }

            if (subcommand === 'retry_exam_request') {
                const requestId = interaction.options.getString('request_id', true).trim();
                const result = await examinationService.retryRequest(client, {
                    guildId,
                    requestId,
                });
                const request = examinationService.getRequestById(requestId) || result.request;

                logger.info('Ручные инструменты: заявка экзаменации восстановлена вручную', {
                    guildId,
                    actorId,
                    requestId,
                    status: result.status,
                });
                await editReplyWithRetry(interaction, {
                    content: result.status === 'republished'
                        ? `Сообщение заявки ${requestId} опубликовано заново: ${request?.requestMessageLink || 'ссылка недоступна'}`
                        : `Сообщение заявки ${requestId} обновлено: ${request?.requestMessageLink || 'ссылка недоступна'}`,
                    allowedMentions: { parse: [] },
                });
                return;
            }

            if (subcommand === 'retry_vacation') {
                const vacationId = interaction.options.getString('vacation_id', true).trim();
                const guild = interaction.guild || await client.guilds.fetch(guildId);
                const requester = await guild.members.fetch(actorId);
                const result = await vacationService.retryRequest(client, {
                    guildId,
                    requestId: vacationId,
                    requester,
                });
                const request = result.request || vacationService.getRequestById(vacationId);

                logger.info('Ручные инструменты: заявка на отпуск восстановлена вручную', {
                    guildId,
                    actorId,
                    vacationId,
                    status: result.status,
                    requestStatus: request?.status || null,
                });
                await editReplyWithRetry(interaction, {
                    content: result.status === 'republished'
                        ? `Сообщение заявки ${vacationId} опубликовано заново: ${request?.requestMessageLink || 'ссылка недоступна'}`
                        : `Заявка ${vacationId} продолжена и обновлена: ${request?.requestMessageLink || 'ссылка недоступна'}`,
                    allowedMentions: { parse: [] },
                });
                return;
            }

            if (subcommand === 'refresh') {
                const target = interaction.options.getString('target', true);
                if (!REFRESH_TARGETS.has(target)) {
                    await editReplyWithRetry(interaction, {
                        content: 'Выбрано неизвестное действие синхронизации.',
                        allowedMentions: { parse: [] },
                    });
                    return;
                }

                const serverConfig = guildConfigService.getAny(guildId);
                if (!serverConfig) {
                    await editReplyWithRetry(interaction, {
                        content: 'Для этого сервера нет записи настроек.',
                        allowedMentions: { parse: [] },
                    });
                    return;
                }

                await refreshGuildData(client, guildId, target, actorId);

                logger.info('Ручные инструменты: выполнена ручная синхронизация', {
                    guildId,
                    actorId,
                    target,
                });

                await editReplyWithRetry(interaction, {
                    content: `Синхронизация завершена: ${REFRESH_TARGETS.get(target)}.`,
                    allowedMentions: { parse: [] },
                });
                return;
            }

            await editReplyWithRetry(interaction, {
                content: 'Неизвестная подкоманда.',
                allowedMentions: { parse: [] },
            });
        } catch (error) {
            logger[
                error instanceof StaffAuditError ||
                error instanceof DisciplineError ||
                error instanceof ExaminationError ||
                error instanceof VacationError
                    ? 'warn'
                    : 'error'
            ]('Ошибка выполнения /manualtools', {
                guildId,
                actorId,
                subcommand,
            }, error);
            await editReplyWithRetry(interaction, {
                content: buildPublicErrorMessage(error, 'Произошла внутренняя ошибка при выполнении команды. Подробности записаны в лог.'),
                allowedMentions: { parse: [] },
            }).catch(() => undefined);
        }
    },
};
