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
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
    ModalBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require('discord.js');
const { getVacationSettings } = require('../settings/schema');
const vacationService = require('../service');
const { formatDate, getStatusLabel } = require('../presentation');
const guildConfigService = require('../../../core/config/guildConfigService');
const {
    editReplyWithRetry,
    replyWithRetry,
    runDiscordRequest,
} = require('../../../core/discord/request');
const logger = require('../../../core/logging/logger');
const { buildPublicErrorMessage } = require('../../../core/ui/errorMessage');

function parseCustomId(customId) {
    const parts = String(customId || '').split(':');
    if (parts[0] !== 'vacation') return null;
    return { action: parts[1] || null, value: parts.slice(2).join(':') || null };
}

async function safeReply(interaction, content, components = []) {
    const payload = {
        content,
        components,
        allowedMentions: { parse: [] },
    };
    if (interaction.deferred || interaction.replied) {
        return editReplyWithRetry(interaction, payload).catch(() => undefined);
    }
    return replyWithRetry(interaction, { ...payload, flags: MessageFlags.Ephemeral }).catch(() => undefined);
}

function buildTypeSelect(config, requestId = 'new') {
    const types = getVacationSettings(config).types.filter((type) => type.enabled).slice(0, 25);
    const menu = new StringSelectMenuBuilder()
        .setCustomId(`vacation:type:${requestId}`)
        .setPlaceholder('Выберите тип отпуска')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(types.map((type) => ({
            label: type.name.slice(0, 100),
            value: type.id,
            description: [
                type.maxDurationDays > 0 ? `до ${type.maxDurationDays} дн.` : 'без максимума',
                type.monthlyLimitDays > 0 ? `${type.monthlyLimitDays} дн./месяц` : 'без месячного лимита',
            ].join('; ').slice(0, 100),
        })));
    return [new ActionRowBuilder().addComponents(menu)];
}

function buildRequestModal(requestId, typeId, request = null) {
    const modal = new ModalBuilder()
        .setCustomId(`vacation:form:${requestId}:${typeId}`.slice(0, 100))
        .setTitle(request ? 'Изменение заявки' : 'Заявка на отпуск');
    const start = new TextInputBuilder()
        .setCustomId('startDate')
        .setLabel('Дата начала (YYYY-MM-DD)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(10);
    const end = new TextInputBuilder()
        .setCustomId('endDate')
        .setLabel('Дата окончания (YYYY-MM-DD)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(10);
    const reason = new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('Причина')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(1000);
    if (request?.startDate) start.setValue(request.startDate);
    if (request?.endDate) end.setValue(request.endDate);
    if (request?.reason) reason.setValue(request.reason.slice(0, 1000));
    modal.addComponents(
        new ActionRowBuilder().addComponents(start),
        new ActionRowBuilder().addComponents(end),
        new ActionRowBuilder().addComponents(reason),
    );
    return modal;
}

function buildRejectModal(requestId) {
    return new ModalBuilder()
        .setCustomId(`vacation:reject_form:${requestId}`)
        .setTitle('Отклонение заявки')
        .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('reason')
                .setLabel('Причина отклонения')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMaxLength(1000)
        ));
}

function buildExceptionApprovalModal(requestId) {
    return new ModalBuilder()
        .setCustomId(`vacation:approve_exception_form:${requestId}`)
        .setTitle('Одобрение исключения')
        .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('reason')
                .setLabel('Причина превышения лимита')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMaxLength(1000)
        ));
}

function buildExistingControls(request) {
    const row = new ActionRowBuilder();
    if (['pending', 'scheduled'].includes(request.status)) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`vacation:self_edit:${request.requestId}`)
                .setLabel('Изменить заявку')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`vacation:withdraw:${request.requestId}`)
                .setLabel('Отозвать заявку')
                .setStyle(ButtonStyle.Secondary),
        );
    }
    if (['active', 'awaiting_return'].includes(request.status)) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`vacation:return:${request.requestId}`)
                .setLabel('Завершить отпуск')
                .setStyle(ButtonStyle.Success)
        );
    }
    return row.components.length ? [row] : [];
}

module.exports = async (client, interaction) => {
    const parsed = parseCustomId(interaction.customId);
    if (!parsed) return;
    if (!interaction.inGuild() || !interaction.guild) return;

    try {
        const config = guildConfigService.get(interaction.guildId);
        if (!config?.features?.vacations) {
            await safeReply(interaction, 'Функция отпусков сейчас отключена.');
            return;
        }
        const member = interaction.member?.roles?.cache
            ? interaction.member
            : await interaction.guild.members.fetch(interaction.user.id);

        if (parsed.action === 'apply' && interaction.isButton()) {
            const existing = vacationService.getActiveRequest(interaction.guildId, interaction.user.id);
            if (existing) {
                await safeReply(
                    interaction,
                    [
                        `У вас уже есть заявка **${existing.typeName}**.`,
                        `Период: ${formatDate(existing.startDate)}-${formatDate(existing.endDate)}.`,
                        `Статус: ${getStatusLabel(existing.status)}.`,
                        existing.requestMessageLink || null,
                    ].filter(Boolean).join('\n'),
                    buildExistingControls(existing)
                );
                return;
            }
            const types = getVacationSettings(config).types.filter((type) => type.enabled);
            if (!types.length) {
                await safeReply(interaction, 'На сервере нет доступных типов отпуска.');
                return;
            }
            await safeReply(interaction, 'Выберите тип отпуска.', buildTypeSelect(config));
            return;
        }

        if (parsed.action === 'self_edit' && interaction.isButton()) {
            const request = vacationService.getRequestById(parsed.value);
            if (!request || String(request.memberId) !== String(interaction.user.id)) {
                await safeReply(interaction, 'Заявка не найдена или принадлежит другому сотруднику.');
                return;
            }
            if (!['pending', 'scheduled'].includes(request.status)) {
                await safeReply(interaction, 'Эту заявку уже нельзя изменить.');
                return;
            }
            await safeReply(interaction, 'Выберите тип отпуска для обновлённой заявки.', buildTypeSelect(config, request.requestId));
            return;
        }

        if (parsed.action === 'type' && interaction.isStringSelectMenu()) {
            const requestId = parsed.value || 'new';
            const typeId = String(interaction.values?.[0] || '');
            const request = requestId === 'new' ? null : vacationService.getRequestById(requestId);
            if (request && String(request.memberId) !== String(interaction.user.id)) {
                await safeReply(interaction, 'Нельзя изменить чужую заявку.');
                return;
            }
            await runDiscordRequest(() => interaction.showModal(buildRequestModal(requestId, typeId, request)), { attempts: 1 });
            return;
        }

        if (parsed.action === 'form' && interaction.isModalSubmit()) {
            const [requestId = 'new', typeId = ''] = String(parsed.value || '').split(':');
            await replyWithRetry(interaction, {
                content: 'Проверяю и сохраняю заявку…',
                flags: MessageFlags.Ephemeral,
            });
            const request = await vacationService.createOrUpdateRequest(client, {
                guild: interaction.guild,
                member,
                typeId,
                startDate: interaction.fields.getTextInputValue('startDate').trim(),
                endDate: interaction.fields.getTextInputValue('endDate').trim(),
                reason: interaction.fields.getTextInputValue('reason'),
                existingRequestId: requestId === 'new' ? null : requestId,
            });
            await editReplyWithRetry(interaction, {
                content: [
                    requestId === 'new' ? 'Заявка создана.' : 'Заявка обновлена и повторно отправлена на рассмотрение.',
                    request.requestMessageLink,
                ].filter(Boolean).join('\n'),
                components: [],
                allowedMentions: { parse: [] },
            });
            return;
        }

        if (parsed.action === 'approve' && interaction.isButton()) {
            const current = vacationService.getRequestById(parsed.value);
            if (current?.exceedReasons?.length) {
                await runDiscordRequest(() => interaction.showModal(buildExceptionApprovalModal(parsed.value)), { attempts: 1 });
                return;
            }
            await runDiscordRequest(() => interaction.deferReply({ flags: MessageFlags.Ephemeral }), { attempts: 1 });
            const request = await vacationService.approveRequest(client, parsed.value, member);
            await editReplyWithRetry(interaction, {
                content: request.status === 'active'
                    ? 'Отпуск одобрен и уже начат.'
                    : 'Отпуск одобрен.',
                allowedMentions: { parse: [] },
            });
            return;
        }

        if (parsed.action === 'approve_exception_form' && interaction.isModalSubmit()) {
            await replyWithRetry(interaction, {
                content: 'Проверяю и одобряю исключение…',
                flags: MessageFlags.Ephemeral,
            });
            const request = await vacationService.approveRequest(client, parsed.value, member, {
                exceptionReason: interaction.fields.getTextInputValue('reason'),
            });
            await editReplyWithRetry(interaction, {
                content: request.status === 'active'
                    ? 'Превышение одобрено, отпуск уже начат.'
                    : 'Превышение лимитов одобрено.',
                allowedMentions: { parse: [] },
            });
            return;
        }

        if (parsed.action === 'reject' && interaction.isButton()) {
            await runDiscordRequest(() => interaction.showModal(buildRejectModal(parsed.value)), { attempts: 1 });
            return;
        }

        if (parsed.action === 'reject_form' && interaction.isModalSubmit()) {
            await replyWithRetry(interaction, { content: 'Отклоняю заявку…', flags: MessageFlags.Ephemeral });
            await vacationService.rejectRequest(
                client,
                parsed.value,
                member,
                interaction.fields.getTextInputValue('reason')
            );
            await editReplyWithRetry(interaction, { content: 'Заявка отклонена.', allowedMentions: { parse: [] } });
            return;
        }

        if (parsed.action === 'withdraw' && interaction.isButton()) {
            await runDiscordRequest(() => interaction.deferReply({ flags: MessageFlags.Ephemeral }), { attempts: 1 });
            await vacationService.withdrawRequest(client, parsed.value, member);
            await editReplyWithRetry(interaction, { content: 'Заявка отозвана.', allowedMentions: { parse: [] } });
            return;
        }

        if (parsed.action === 'return' && interaction.isButton()) {
            await runDiscordRequest(() => interaction.deferReply({ flags: MessageFlags.Ephemeral }), { attempts: 1 });
            await vacationService.confirmReturn(client, parsed.value, member);
            await editReplyWithRetry(interaction, { content: 'Отпуск завершён.', allowedMentions: { parse: [] } });
        }
    } catch (error) {
        const userMessage = buildPublicErrorMessage(error, 'Не удалось выполнить действие с отпуском. Ошибка записана в лог.');
        if (!(error instanceof vacationService.VacationError)) {
            logger.error('Ошибка обработки отпуска', {
                guildId: interaction.guildId,
                userId: interaction.user?.id,
                customId: interaction.customId,
            }, error);
        } else {
            logger.warn('Ожидаемая ошибка обработки отпуска', {
                guildId: interaction.guildId,
                userId: interaction.user?.id,
                code: error.code,
            });
        }
        await safeReply(interaction, userMessage);
    }
};
