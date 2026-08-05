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
const {
    ActionRowBuilder,
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require('discord.js');
const blackListGiveRoles = require('./database').blackListGiveRoles;
const giveRoles = require('./database').giveRoles;
const giveRolesService = require('./service');
const guildConfigService = require('../../core/config/guildConfigService');
const { publishInviteAudit } = require('./integrations');
const {
    deferReplyWithRetry,
    editMessageWithRetry,
    editReplyWithRetry,
    replyWithRetry,
    sendMessageWithRetry,
    showModalWithRetry,
} = require('../../core/discord/request');
const giveRolesRequest = require('./request');
const logger = require('../../core/logging/logger');
const { getDefaultFooter } = require('../../core/ui/defaultFooter');
const { buildPublicErrorMessage } = require('../../core/ui/errorMessage');
const { parseGiveRolesRequestCustomId } = require('./customId');

const PROCESSING_STALE_MS = 10 * 60 * 1000;
const CREATING_RETRY_ATTEMPTS = 5;
const CREATING_RETRY_DELAY_MS = 200;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findRequestForInteraction(guildId, requestId) {
    const query = { guildId, requestId };
    let request = null;

    for (let attempt = 0; attempt < CREATING_RETRY_ATTEMPTS; attempt += 1) {
        request = await giveRoles.findOne(query);
        if (!request || request.status !== 'creating') break;
        await sleep(CREATING_RETRY_DELAY_MS);
    }

    return { query, request };
}

async function replyTemp(interaction, content) {
    await editReplyWithRetry(interaction, {
        content,
        allowedMentions: { parse: [] },
    });
}

async function replyEphemeral(interaction, content) {
    await replyWithRetry(interaction, {
        content,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
    });
}

function buildGiveRolesModal() {
    const modal = new ModalBuilder()
        .setCustomId('gr-submit-modal')
        .setTitle('Заявка на выдачу ролей');

    const nicknameInput = new TextInputBuilder()
        .setCustomId('gr-nickname')
        .setLabel('Имя Фамилия')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Michael Lindberg')
        .setRequired(true)
        .setMaxLength(64);

    const staticInput = new TextInputBuilder()
        .setCustomId('gr-static')
        .setLabel('Статик')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('7658')
        .setRequired(true)
        .setMaxLength(10);

    modal.addComponents(
        new ActionRowBuilder().addComponents(nicknameInput),
        new ActionRowBuilder().addComponents(staticInput)
    );

    return modal;
}

function buildProcessedEmbed({ title, color, userId, nickname, staticId, createdAt }) {
    return new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(
            `Заявка от <@${userId}>. Discord ID: ${userId}.\n` +
            `Уважаемый сотрудник Weazel News!\n` +
            `Обратите внимание на то как записаны Имя Фамилия и статик персонажа!\n` +
            `Проверьте данные дважды перед тем, как одобрять заявку!\n` +
            `Пользователь оставил следующие данные:`
        )
        .addFields(
            { name: 'Имя Фамилия:', value: nickname },
            { name: 'Статик:', value: staticId }
        )
        .setTimestamp(new Date(Number(createdAt) || Date.now()))
        .setFooter(getDefaultFooter());
}

async function safeDm(member, content, nonceSeed) {
    if (!member) return;

    try {
        await sendMessageWithRetry(member, {
            content,
            allowedMentions: { parse: [] },
        }, {
            nonceSeed: nonceSeed || `giveRolesDm:${member.guild?.id || 'dm'}:${member.id}:${Date.now()}:${Math.random()}`,
        });
    } catch (error) {
        logger.info('Не удалось отправить ЛС по заявке выдачи ролей', {
            guildId: member.guild?.id,
            userId: member.id,
        }, error);
    }
}

async function lockGiveRolesRequest(query, userId, action) {
    const result = await giveRoles.updateOne(
        {
            ...query,
            status: { $in: ['pending', undefined, null] },
        },
        {
            status: 'processing',
            processingBy: userId,
            processingAction: action,
            processingStartedAt: Date.now(),
            updatedAt: Date.now(),
        }
    );

    return result.matchedCount > 0;
}

async function unlockGiveRolesRequest(query, userId, action) {
    const result = await giveRoles.updateOne(
        {
            ...query,
            status: 'processing',
            processingBy: userId,
            processingAction: action,
        },
        {
            status: 'pending',
            processingBy: null,
            processingAction: null,
            processingStartedAt: null,
            updatedAt: Date.now(),
        }
    );

    return result.matchedCount > 0;
}

async function finishGiveRolesRequest(query, userId, action) {
    try {
        await giveRoles.deleteOne({
            ...query,
            status: 'processing',
            processingBy: userId,
            processingAction: action,
        });
    } catch (error) {
        logger.error('Заявка обработана, но запись выдачи ролей не удалена', query, error);
    }
}

async function restoreStaleProcessingRequest(record, query) {
    if (record?.status !== 'processing') return record;

    const startedAt = Number(record.processingStartedAt || record.updatedAt || 0);
    if (!startedAt || Date.now() - startedAt < PROCESSING_STALE_MS) return record;

    const restored = await giveRoles.updateOne(
        {
            ...query,
            status: 'processing',
            processingBy: record.processingBy,
            processingAction: record.processingAction,
        },
        {
            status: 'pending',
            processingBy: null,
            processingAction: null,
            processingStartedAt: null,
            updatedAt: Date.now(),
        }
    );

    if (!restored.matchedCount) return record;
    logger.warn('Восстановлена зависшая заявка выдачи ролей', query);
    return giveRoles.findOne(query);
}

async function getRequestMessage(client, interaction, serverConfig) {
    const channel = await client.channels.fetch(serverConfig.channels?.confirmRoleChannelId).catch(() => null);
    if (channel?.messages?.fetch) {
        return channel.messages.fetch(interaction.message.id).catch(() => interaction.message);
    }
    return interaction.message;
}

async function sendKaRecord(client, {
    serverConfig,
    guildId,
    reviewer,
    targetMember,
    userId,
    acceptedDisplayName,
    staticId,
    assignment,
    requestId,
}) {
    if (!serverConfig.features?.staffAudit) return;

    await publishInviteAudit(client, {
        guildId,
        config: serverConfig,
        actor: reviewer,
        target: {
            member: targetMember,
            memberId: userId,
            displayName: acceptedDisplayName,
            staticId,
        },
        rankNumber: assignment.rank.number,
        reason: assignment.reason,
        nonceSeed: `giveRolesKa:${guildId}:${requestId || userId}`,
    });
}

async function handleOpenModal(interaction) {
    if (!interaction.inGuild()) return;

    const serverConfig = guildConfigService.get(interaction.guildId);
    const errors = giveRolesService.getRequestSubmissionErrors(interaction.guild, serverConfig);
    if (errors.length) {
        logger.warn('Выдача ролей: модальное окно не открыто из-за настроек', {
            guildId: interaction.guildId,
            userId: interaction.user.id,
            errors,
        });
        await replyEphemeral(
            interaction,
            'Система выдачи ролей сейчас не настроена. Сообщите об этом руководству Weazel News.'
        );
        return;
    }

    await showModalWithRetry(interaction, buildGiveRolesModal());
}

async function handleModalSubmit(client, interaction) {
    await deferReplyWithRetry(interaction, {
        flags: MessageFlags.Ephemeral,
    });

    const nickname = interaction.fields.getTextInputValue('gr-nickname')?.trim();
    const staticId = interaction.fields.getTextInputValue('gr-static')?.trim();

    if (!giveRolesRequest.validateNickname(nickname)) {
        logger.warn('Выдача ролей: пользователь указал некорректные имя и фамилию', {
            guildId: interaction.guildId,
            userId: interaction.user.id,
            nickname,
        });
        await replyTemp(
            interaction,
            'Укажите имя и фамилию двумя словами на латинице, каждое с заглавной буквы.\n' +
            'Допустимы только английские буквы, дефис и апостроф. Пример: `Michael Lindberg`.\n' +
            '-# Сообщение удалится через 30 секунд.'
        );
        return;
    }

    if (!giveRolesRequest.validateStatic(staticId)) {
        await replyTemp(
            interaction,
            'Статик указан некорректно. Допустимы только цифры.\n' +
            '-# Сообщение удалится через 30 секунд.'
        );
        return;
    }

    const userId = interaction.user.id;
    const result = await giveRolesRequest.createGiveRolesRequest(
        client,
        interaction.guildId,
        userId,
        nickname,
        staticId
    );

    if (!result.ok) {
        if (result.code === 'blacklist') {
            await replyTemp(
                interaction,
                'Действие невозможно. Вы попали в чёрный список выдачи ролей.\n' +
                '-# Сообщение удалится через 30 секунд.'
            );
            return;
        }
        if (result.code === 'exists') {
            await replyTemp(
                interaction,
                `<@${userId}>, вы уже отправляли заявку!\n` +
                `Ожидайте, пока сотрудник её рассмотрит.\n` +
                `Вы получите оповещение как только получите роли.\n` +
                `-# Сообщение удалится через 30 секунд.`
            );
            return;
        }
        if (result.code === 'config_error' || result.code === 'no_config') {
            await replyTemp(
                interaction,
                'Система выдачи ролей сейчас не настроена. Сообщите об этом руководству Weazel News.\n' +
                '-# Сообщение удалится через 30 секунд.'
            );
            return;
        }
        if (result.code === 'no_channel') {
            logger.warn('Выдача ролей: канал подтверждения заявок недоступен', {
                guildId: interaction.guildId,
                userId,
            });
            await replyTemp(
                interaction,
                'Не удалось найти канал для заявок. Сообщите об этом руководству Weazel News.\n' +
                '-# Сообщение удалится через 30 секунд.'
            );
            return;
        }

        logger.warn('Выдача ролей: заявка не отправлена', {
            guildId: interaction.guildId,
            userId,
            code: result.code,
        });
        await replyTemp(
            interaction,
            'Не удалось отправить заявку. Подробности записаны в лог.\n' +
            '-# Сообщение удалится через 30 секунд.'
        );
        return;
    }

    await replyTemp(
        interaction,
        `Спасибо, <@${userId}>, ваша заявка принята!\n` +
        `Ожидайте, пока сотрудник её рассмотрит.\n` +
        `Вы получите оповещение как только получите роли.\n` +
        `-# Сообщение удалится через 30 секунд.`
    );
}

async function handleRequestButton(client, interaction) {
    await deferReplyWithRetry(interaction, {
        flags: MessageFlags.Ephemeral,
    });

    const parsedButton = parseGiveRolesRequestCustomId(interaction.customId);
    if (!parsedButton) {
        logger.warn('Выдача ролей: получена кнопка с некорректным идентификатором', {
            guildId: interaction.guildId,
            userId: interaction.user.id,
            customId: interaction.customId,
        });
        await replyTemp(interaction, 'Кнопка заявки устарела или повреждена.');
        return;
    }

    const { action, requestId } = parsedButton;
    const guildId = interaction.guildId;
    const serverConfig = guildConfigService.get(guildId);
    if (!serverConfig) {
        logger.warn('Выдача ролей: конфигурация сервера отсутствует', { guildId, action });
        await replyTemp(interaction, 'Для этого сервера нет настроек.');
        return;
    }

    const guild = await client.guilds.fetch(guildId);
    const reviewer = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (!reviewer) {
        logger.warn('Выдача ролей: не удалось получить обработчика заявки', {
            guildId,
            userId: interaction.user.id,
            action,
        });
        await replyTemp(interaction, 'Не удалось определить ваши роли на сервере.');
        return;
    }

    const accessErrors = giveRolesService.getAccessErrors(guild, serverConfig, action);
    if (accessErrors.length) {
        logger.warn('Выдача ролей: доступ к кнопке не настроен', {
            guildId,
            userId: reviewer.id,
            action,
            errors: accessErrors,
        });
        await replyTemp(interaction, 'Доступ к этой кнопке не настроен. Подробности записаны в лог.');
        return;
    }

    if (!giveRolesService.canUseAction(reviewer, serverConfig, action)) {
        await replyTemp(
            interaction,
            `${reviewer}, у вас нет доступа к этой кнопке.\n` +
            `-# Сообщение удалится через 30 секунд.`
        );
        return;
    }

    const resolvedRequest = await findRequestForInteraction(guildId, requestId);
    const query = resolvedRequest.query;
    let request = await restoreStaleProcessingRequest(resolvedRequest.request, query);
    if (!request) {
        logger.warn('Выдача ролей: заявка по идентификатору не найдена при нажатии кнопки', {
            guildId,
            requestId,
            messageId: interaction.message.id,
            reviewerId: reviewer.id,
            action,
        });
        await replyTemp(
            interaction,
            'Заявка пока не найдена. Подождите несколько секунд и нажмите кнопку ещё раз.\n' +
            '-# Сообщение удалится через 30 секунд.'
        );
        return;
    }

    if (request.messageId && request.messageId !== interaction.message.id) {
        logger.warn('Выдача ролей: идентификатор кнопки не соответствует сообщению заявки', {
            guildId,
            requestId,
            storedMessageId: request.messageId,
            interactionMessageId: interaction.message.id,
            reviewerId: reviewer.id,
        });
        await replyTemp(interaction, 'Эта кнопка не относится к текущему сообщению заявки.');
        return;
    }

    if (request.status === 'creating') {
        await replyTemp(
            interaction,
            'Заявка ещё сохраняется. Подождите несколько секунд и нажмите кнопку ещё раз.\n' +
            '-# Сообщение удалится через 30 секунд.'
        );
        return;
    }

    if ((request.status || 'pending') !== 'pending') {
        await replyTemp(
            interaction,
            'Заявка уже обрабатывается или была обработана другим сотрудником.\n' +
            '-# Сообщение удалится через 30 секунд.'
        );
        return;
    }

    const targetMember = await guild.members.fetch(request.userId).catch(() => null);
    let assignment = null;

    if (giveRolesService.APPROVE_ACTIONS.has(action)) {
        if (action === 'role-db' && !giveRolesService.isDbApprovalPeriodActive(serverConfig)) {
            await replyTemp(
                interaction,
                'Период ДБ сейчас не действует. Используйте обычное одобрение заявки.'
            );
            return;
        }

        const resolved = giveRolesService.getAssignmentErrors(guild, serverConfig, action);
        assignment = resolved.assignment;
        const memberErrors = giveRolesService.getMemberAssignmentErrors(targetMember, assignment);
        const errors = [...resolved.errors, ...memberErrors];

        if (errors.length) {
            logger.warn('Выдача ролей: заявка не может быть одобрена из-за настроек или иерархии ролей', {
                guildId,
                userId: request.userId,
                reviewerId: reviewer.id,
                action,
                errors,
            });
            await replyTemp(
                interaction,
                'Заявку нельзя одобрить из-за настроек ролей. Подробности записаны в лог.'
            );
            return;
        }
    }

    const locked = await lockGiveRolesRequest(query, reviewer.id, action);
    if (!locked) {
        await replyTemp(
            interaction,
            'Заявка уже обрабатывается или была обработана другим сотрудником.\n' +
            '-# Сообщение удалится через 30 секунд.'
        );
        return;
    }

    const userMention = `<@${request.userId}>`;
    const reviewerMention = `<@${reviewer.id}>`;
    const message = await getRequestMessage(client, interaction, serverConfig);

    try {
        if (giveRolesService.APPROVE_ACTIONS.has(action)) {
            const acceptedDisplayName = targetMember
                ? await giveRolesService.applyAssignment(
                    targetMember,
                    assignment,
                    request.nickname,
                    request.static
                )
                : giveRolesService.buildMemberNickname(
                    assignment.department,
                    request.nickname,
                    request.static
                );

            await sendKaRecord(client, {
                serverConfig,
                guildId,
                reviewer,
                targetMember,
                userId: request.userId,
                acceptedDisplayName,
                staticId: request.static,
                assignment,
                requestId: request.requestId,
            });

            await safeDm(
                targetMember,
                `${userMention}, ${reviewerMention} одобрил вашу заявку!\nДобро пожаловать в Weazel News!`,
                `giveRolesDm:${guildId}:${request.requestId}:${action}`
            );

            await editMessageWithRetry(message, {
                embeds: [buildProcessedEmbed({
                    title: 'Заявка на выдачу ролей - ОДОБРЕНА',
                    color: 0x008000,
                    userId: request.userId,
                    nickname: request.nickname,
                    staticId: request.static,
                    createdAt: request.createdAt,
                })],
                components: [],
                allowedMentions: { parse: [] },
            });

            await finishGiveRolesRequest(query, reviewer.id, action);
            await replyTemp(
                interaction,
                `Заявка ${userMention} одобрена.\n-# Сообщение удалится через 30 секунд.`
            );
            return;
        }

        if (action === 'role-decline') {
            await safeDm(
                targetMember,
                `${userMention}, к сожалению, ${reviewerMention} отклонил вашу заявку.\n` +
                `Свяжитесь с сотрудником, чтобы выяснить причину.`,
                `giveRolesDm:${guildId}:${request.requestId}:${action}`
            );

            await editMessageWithRetry(message, {
                embeds: [buildProcessedEmbed({
                    title: 'Заявка на выдачу ролей - ОТКЛОНЕНА',
                    color: 0xFF2C2C,
                    userId: request.userId,
                    nickname: request.nickname,
                    staticId: request.static,
                    createdAt: request.createdAt,
                })],
                components: [],
                allowedMentions: { parse: [] },
            });

            await finishGiveRolesRequest(query, reviewer.id, action);
            await replyTemp(
                interaction,
                `Заявка ${userMention} отклонена.\n-# Сообщение удалится через 30 секунд.`
            );
            return;
        }

        if (action === 'role-block') {
            await blackListGiveRoles.insertOneIfAbsent(
                { guildId, userId: request.userId },
                {
                    guildId,
                    userId: request.userId,
                    createdAt: Date.now(),
                    blockedBy: reviewer.id,
                }
            );

            await safeDm(
                targetMember,
                `${userMention}, вы были заблокированы за злоупотребление функционалом бота!`,
                `giveRolesDm:${guildId}:${request.requestId}:${action}`
            );

            await editMessageWithRetry(message, {
                embeds: [buildProcessedEmbed({
                    title: 'Заявка на выдачу ролей - ПОЛЬЗОВАТЕЛЬ ЗАБЛОКИРОВАН',
                    color: 0xFF2C2C,
                    userId: request.userId,
                    nickname: request.nickname,
                    staticId: request.static,
                    createdAt: request.createdAt,
                })],
                components: [],
                allowedMentions: { parse: [] },
            });

            await finishGiveRolesRequest(query, reviewer.id, action);
            await replyTemp(
                interaction,
                `Пользователь ${userMention} успешно заблокирован!\n` +
                `-# Сообщение удалится через 30 секунд.`
            );
        }
    } catch (error) {
        await unlockGiveRolesRequest(query, reviewer.id, action).catch(() => undefined);
        logger.error('Ошибка обработки заявки выдачи ролей', {
            guildId,
            requestId: request.requestId,
            messageId: request.messageId,
            userId: request.userId,
            reviewerId: reviewer.id,
            action,
        }, error);
        await replyTemp(
            interaction,
            buildPublicErrorMessage(error, 'Произошла ошибка при обработке заявки. Подробности записаны в лог.')
        );
    }
}

module.exports = async (client, interaction) => {
    try {
        if (interaction.isButton() && interaction.customId === 'gr-open-modal') {
            await handleOpenModal(interaction);
            return;
        }

        if (interaction.isModalSubmit() && interaction.customId === 'gr-submit-modal') {
            await handleModalSubmit(client, interaction);
            return;
        }

        if (interaction.isButton() && parseGiveRolesRequestCustomId(interaction.customId)) {
            await handleRequestButton(client, interaction);
        }
    } catch (error) {
        logger.error('Необработанная ошибка взаимодействия выдачи ролей', {
            guildId: interaction.guildId,
            userId: interaction.user?.id,
            customId: interaction.customId,
        }, error);

        try {
            if (interaction.deferred || interaction.replied) {
                await editReplyWithRetry(interaction, {
                    content: buildPublicErrorMessage(error, 'Произошла внутренняя ошибка. Подробности записаны в лог.'),
                    allowedMentions: { parse: [] },
                });
            } else {
                await replyEphemeral(
                    interaction,
                    buildPublicErrorMessage(error, 'Произошла внутренняя ошибка. Подробности записаны в лог.')
                );
            }
        } catch (replyError) {
            logger.error('Не удалось отправить ответ об ошибке выдачи ролей', replyError);
        }
    }
};
