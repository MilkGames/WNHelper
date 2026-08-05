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
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    ModalBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require('discord.js');
const guildConfigService = require('../../core/config/guildConfigService');
const {
    editReplyWithRetry,
    replyWithRetry,
    runDiscordRequest,
    showModalWithRetry,
} = require('../../core/discord/request');
const { getDefaultFooter } = require('../../core/ui/defaultFooter');
const logger = require('../../core/logging/logger');
const { buildPublicErrorMessage } = require('../../core/ui/errorMessage');
const examinationService = require('./service');
const ExaminationError = require('./error');

const FLOW_TTL_MS = 15 * 60 * 1000;
const flows = new Map();

function createFlowId() {
    return crypto.randomBytes(7).toString('hex');
}

function flowCustomId(flow, action) {
    return `examflow:${flow.id}:${action}`;
}

function requestCustomIdParts(customId) {
    const match = String(customId || '').match(
        /^examreq:(accept|complete|pass|fail|cancel_procedure|reject|cancel):(.+)$/
    );
    return match ? { action: match[1], requestId: match[2] } : null;
}

function flowCustomIdParts(customId) {
    const match = String(customId || '').match(/^examflow:([a-f0-9]+):([a-z_]+)$/);
    return match ? { flowId: match[1], action: match[2] } : null;
}

function getFlow(flowId, interaction) {
    const flow = flows.get(flowId);
    if (!flow || flow.expiresAt <= Date.now()) {
        if (flow) flows.delete(flowId);
        throw new ExaminationError('Эта сессия оформления завершилась или истекла.', 'flow_expired');
    }
    if (String(flow.guildId) !== String(interaction.guildId) || String(flow.userId) !== String(interaction.user.id)) {
        throw new ExaminationError('Эта сессия принадлежит другому пользователю.', 'flow_owner_mismatch');
    }
    flow.expiresAt = Date.now() + FLOW_TTL_MS;
    return flow;
}

function createFlow(interaction, type) {
    const flow = {
        id: createFlowId(),
        guildId: String(interaction.guildId),
        userId: String(interaction.user.id),
        type,
        lectureTypeId: null,
        examId: null,
        comment: null,
        expiresAt: Date.now() + FLOW_TTL_MS,
    };
    flows.set(flow.id, flow);
    return flow;
}

function cancelRow(flow) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(flowCustomId(flow, 'cancel'))
            .setLabel('Отменить')
            .setStyle(ButtonStyle.Danger)
    );
}

function renderLectureType(flow, config, guild) {
    const lectureTypes = examinationService.getAvailableLectureTypes(config, guild);
    if (!lectureTypes.length) {
        throw new ExaminationError('Типы лекций пока не настроены или не имеют ролей обработки.', 'lecture_types_missing');
    }
    const select = new StringSelectMenuBuilder()
        .setCustomId(flowCustomId(flow, 'lecture_type'))
        .setPlaceholder('Выберите лекцию')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(lectureTypes.slice(0, 25).map((entry) => ({
            label: entry.name.slice(0, 100),
            description: entry.departmentShortName
                ? `Отдел: ${entry.departmentShortName}`.slice(0, 100)
                : 'Без привязки к отделу',
            value: entry.id,
        })));
    return {
        content: [
            '## Запрос лекции',
            'Выберите тип лекции. Отдел и роли обработки уже закреплены за ним в настройках.',
            '',
            '-# Сессия активна 15 минут.',
        ].join('\n'),
        components: [new ActionRowBuilder().addComponents(select), cancelRow(flow)],
        allowedMentions: { parse: [] },
    };
}

function renderRetestExam(flow, guildId, memberId, config) {
    const exams = examinationService.getEligibleRetestExams(guildId, memberId, config);
    if (!exams.length) {
        throw new ExaminationError(
            'Сейчас нет экзаменов, для которых можно запросить пересдачу.',
            'no_eligible_retests'
        );
    }
    const select = new StringSelectMenuBuilder()
        .setCustomId(flowCustomId(flow, 'exam'))
        .setPlaceholder('Выберите экзамен')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(exams.slice(0, 25).map((exam) => ({
            label: exam.name.slice(0, 100),
            description: `Обычных попыток: ${exam.maxAttempts}`.slice(0, 100),
            value: exam.id,
        })));
    return {
        content: [
            '## Запрос пересдачи',
            'Выберите экзамен. Пересдача проводится экзаменатором отдельно в голосовом канале и не добавляет обычных попыток.',
            '',
            '-# Сессия активна 15 минут.',
        ].join('\n'),
        components: [new ActionRowBuilder().addComponents(select), cancelRow(flow)],
        allowedMentions: { parse: [] },
    };
}

function renderPreview(flow, config, guild) {
    let details;
    if (flow.type === 'lecture') {
        const lecture = examinationService.getAvailableLectureTypes(config, guild)
            .find((entry) => entry.id === flow.lectureTypeId);
        if (!lecture) {
            throw new ExaminationError('Выбранный тип лекции больше не существует в настройках.', 'flow_data_missing');
        }
        details = [
            '## Подтверждение запроса лекции',
            `Лекция: **${lecture.name}**`,
            ...(lecture.departmentName ? [`Отдел: **${lecture.departmentName}**`] : []),
            `Комментарий: ${flow.comment || 'не указан'}`,
        ];
    } else {
        const exam = examinationService.getEligibleRetestExams(flow.guildId, flow.userId, config)
            .find((entry) => entry.id === flow.examId);
        if (!exam) {
            throw new ExaminationError(
                'Пересдача этого экзамена больше не доступна. Обновите оформление.',
                'retest_no_longer_eligible'
            );
        }
        details = [
            '## Подтверждение запроса пересдачи',
            `Экзамен: **${exam.name}**`,
            `Использовано обычных попыток: **${exam.maxAttempts} из ${exam.maxAttempts}**`,
            'Пересдача будет проведена отдельно в голосовом канале.',
            `Комментарий: ${flow.comment || 'не указан'}`,
        ];
    }
    details.push('', '-# Сессия активна 15 минут.');
    return {
        content: details.join('\n'),
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(flowCustomId(flow, 'confirm'))
                .setLabel('Отправить заявку')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(flowCustomId(flow, 'comment'))
                .setLabel(flow.comment ? 'Изменить комментарий' : 'Добавить комментарий')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(flowCustomId(flow, 'back'))
                .setLabel('Назад')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(flowCustomId(flow, 'cancel'))
                .setLabel('Отменить')
                .setStyle(ButtonStyle.Danger),
        )],
        allowedMentions: { parse: [] },
    };
}

function buildCommentModal(flow) {
    const modal = new ModalBuilder()
        .setCustomId(flowCustomId(flow, 'comment_submit'))
        .setTitle(flow.type === 'lecture' ? 'Комментарий к лекции' : 'Комментарий к пересдаче');
    const input = new TextInputBuilder()
        .setCustomId('comment')
        .setLabel('Комментарий (необязательно)')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(1000);
    if (flow.comment) input.setValue(flow.comment);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return modal;
}

function buildRejectionModal(requestId) {
    return new ModalBuilder()
        .setCustomId(`examreq:reject_submit:${requestId}`.slice(0, 100))
        .setTitle('Отклонение заявки')
        .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('reason')
                .setLabel('Причина отклонения')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMinLength(3)
                .setMaxLength(1000)
        ));
}

function buildPanelPayload(mode = 'both') {
    const normalizedMode = ['lecture', 'retest', 'both'].includes(mode) ? mode : 'both';
    const includesLecture = normalizedMode !== 'retest';
    const includesRetest = normalizedMode !== 'lecture';
    const actions = [];
    if (includesLecture) actions.push('запросить проведение лекции');
    if (includesRetest) actions.push('подать заявку на пересдачу экзамена');

    const embed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle('Экзаменация Weazel News')
        .setDescription([
            `Через эту панель можно ${actions.join(' или ')}.`,
            '',
            'После принятия заявки бот пригласит сотрудника в настроенный голосовой канал.',
            'Начало будет подтверждено автоматически, когда сотрудник и экзаменатор подключатся к нему.',
        ].join('\n'))
        .setFooter(getDefaultFooter());

    const buttons = [];
    if (includesLecture) {
        buttons.push(new ButtonBuilder()
            .setCustomId('examination:open:lecture')
            .setLabel('Запросить лекцию')
            .setStyle(ButtonStyle.Primary));
    }
    if (includesRetest) {
        buttons.push(new ButtonBuilder()
            .setCustomId('examination:open:retest')
            .setLabel('Запросить пересдачу')
            .setStyle(ButtonStyle.Secondary));
    }

    return {
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(...buttons)],
        allowedMentions: { parse: [] },
    };
}

async function getMemberAndConfig(client, interaction) {
    const config = guildConfigService.get(interaction.guildId);
    if (!config) throw new ExaminationError('Для этого сервера нет настроек.', 'config_missing');
    const guild = interaction.guild || await client.guilds.fetch(interaction.guildId);
    const member = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member) throw new ExaminationError('Не удалось получить участника сервера.', 'member_missing');
    return { config, guild, member };
}

async function handlePanelOpen(client, interaction, type) {
    const { config, guild, member } = await getMemberAndConfig(client, interaction);
    const panelErrors = examinationService.validatePanelPublication(guild, config, type);
    if (panelErrors.length) {
        throw new ExaminationError(panelErrors.join('\n'), 'panel_not_ready');
    }
    const wnRoleId = config.commonRoles?.weazelNewsRoleId;
    if (!wnRoleId || !member.roles.cache.has(wnRoleId)) {
        throw new ExaminationError(
            'Запрашивать лекции и пересдачи могут только действующие сотрудники Weazel News.',
            'wn_role_missing'
        );
    }
    const flow = createFlow(interaction, type);
    const payload = type === 'lecture'
        ? renderLectureType(flow, config, guild)
        : renderRetestExam(flow, interaction.guildId, interaction.user.id, config);
    await replyWithRetry(interaction, { ...payload, flags: MessageFlags.Ephemeral });
}

async function handleFlow(client, interaction, parsed) {
    const flow = getFlow(parsed.flowId, interaction);
    const { config, guild, member } = await getMemberAndConfig(client, interaction);

    if (parsed.action === 'cancel') {
        flows.delete(flow.id);
        await runDiscordRequest(() => interaction.update({
            content: 'Оформление отменено.',
            components: [],
            allowedMentions: { parse: [] },
        }), { attempts: 2 });
        return;
    }

    if (parsed.action === 'lecture_type' && interaction.isStringSelectMenu()) {
        flow.lectureTypeId = interaction.values[0];
        await runDiscordRequest(() => interaction.update(renderPreview(flow, config, guild)), { attempts: 2 });
        return;
    }

    if (parsed.action === 'exam' && interaction.isStringSelectMenu()) {
        flow.examId = interaction.values[0];
        await runDiscordRequest(() => interaction.update(renderPreview(flow, config, guild)), { attempts: 2 });
        return;
    }

    if (parsed.action === 'back') {
        if (flow.type === 'lecture') {
            flow.lectureTypeId = null;
            await runDiscordRequest(() => interaction.update(renderLectureType(flow, config, guild)), { attempts: 2 });
        } else {
            flow.examId = null;
            await runDiscordRequest(() => interaction.update(renderRetestExam(flow, flow.guildId, flow.userId, config)), { attempts: 2 });
        }
        return;
    }

    if (parsed.action === 'comment') {
        await showModalWithRetry(interaction, buildCommentModal(flow));
        return;
    }

    if (parsed.action === 'comment_submit' && interaction.isModalSubmit()) {
        flow.comment = interaction.fields.getTextInputValue('comment').trim() || null;
        await runDiscordRequest(() => interaction.update(renderPreview(flow, config, guild)), { attempts: 2 });
        return;
    }

    if (parsed.action === 'confirm') {
        await runDiscordRequest(() => interaction.deferUpdate(), { attempts: 2 });
        const request = flow.type === 'lecture'
            ? await examinationService.createLectureRequest(client, {
                guild,
                member,
                lectureTypeId: flow.lectureTypeId,
                comment: flow.comment,
            })
            : await examinationService.createRetestRequest(client, {
                guild,
                member,
                examId: flow.examId,
                comment: flow.comment,
            });
        flows.delete(flow.id);
        await editReplyWithRetry(interaction, {
            content: `Заявка отправлена. ${request.requestMessageLink || `ID: ${request.requestId}`}`,
            components: [],
            allowedMentions: { parse: [] },
        });
        return;
    }

    throw new ExaminationError('Неизвестное действие оформления.', 'unknown_flow_action');
}

async function handleRequestAction(client, interaction, parsed) {
    const { guild } = await getMemberAndConfig(client, interaction);
    const actor = await guild.members.fetch(interaction.user.id);
    if (parsed.action === 'reject') {
        await showModalWithRetry(interaction, buildRejectionModal(parsed.requestId));
        return;
    }

    await replyWithRetry(interaction, {
        content: 'Обрабатываю заявку…',
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
    });
    const request = await examinationService.transitionRequest(client, {
        requestId: parsed.requestId,
        actor,
        action: parsed.action,
    });
    const resultText = {
        accept: request.status === 'in_progress'
            ? 'Заявка принята, оба участника уже находятся в голосовом канале. Процедура начата.'
            : 'Заявка принята. Сотруднику отправлено приглашение в голосовой канал.',
        complete: 'Лекция завершена, итог опубликован.',
        pass: 'Пересдача отмечена как сданная, итог опубликован.',
        fail: 'Пересдача отмечена как не сданная, итог опубликован.',
        cancel_procedure: request.type === 'lecture'
            ? 'Лекция отменена.'
            : 'Пересдача отменена.',
        cancel: 'Заявка отозвана.',
    }[parsed.action] || 'Заявка обработана.';
    await editReplyWithRetry(interaction, {
        content: `${resultText}\nID: ${request.requestId}`,
        allowedMentions: { parse: [] },
    });
}

async function handleRejectSubmit(client, interaction, requestId) {
    const { guild } = await getMemberAndConfig(client, interaction);
    const actor = await guild.members.fetch(interaction.user.id);
    await replyWithRetry(interaction, {
        content: 'Обрабатываю заявку…',
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
    });
    const request = await examinationService.transitionRequest(client, {
        requestId,
        actor,
        action: 'reject',
        reason: interaction.fields.getTextInputValue('reason'),
    });
    await editReplyWithRetry(interaction, {
        content: `Заявка отклонена. ID: ${request.requestId}`,
        allowedMentions: { parse: [] },
    });
}

async function handle(client, interaction) {
    const customId = String(interaction.customId || '');
    try {
        if (interaction.isButton() && customId === 'examination:open:lecture') {
            await handlePanelOpen(client, interaction, 'lecture');
            return true;
        }
        if (interaction.isButton() && customId === 'examination:open:retest') {
            await handlePanelOpen(client, interaction, 'retest');
            return true;
        }

        const rejectSubmit = customId.match(/^examreq:reject_submit:(.+)$/);
        if (interaction.isModalSubmit() && rejectSubmit) {
            await handleRejectSubmit(client, interaction, rejectSubmit[1]);
            return true;
        }

        const requestAction = requestCustomIdParts(customId);
        if (requestAction && interaction.isButton()) {
            await handleRequestAction(client, interaction, requestAction);
            return true;
        }

        const flowAction = flowCustomIdParts(customId);
        if (flowAction && (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit())) {
            await handleFlow(client, interaction, flowAction);
            return true;
        }
        return false;
    } catch (error) {
        const level = error instanceof ExaminationError ? 'warn' : 'error';
        logger[level]('Ошибка взаимодействия экзаменации', {
            guildId: interaction.guildId,
            userId: interaction.user?.id,
            customId,
            code: error?.code || null,
        }, error);
        const payload = {
            content: buildPublicErrorMessage(error, 'Произошла внутренняя ошибка экзаменации. Подробности записаны в лог.'),
            allowedMentions: { parse: [] },
        };
        if (interaction.deferred || interaction.replied) {
            await editReplyWithRetry(interaction, payload).catch(() => undefined);
        } else {
            await replyWithRetry(interaction, { ...payload, flags: MessageFlags.Ephemeral }).catch(() => undefined);
        }
        return true;
    }
}

module.exports = {
    buildPanelPayload,
    handle,
};
