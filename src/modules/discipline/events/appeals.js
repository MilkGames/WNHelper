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
    MessageFlags,
    ModalBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require('discord.js');
const guildConfigService = require('../../../core/config/guildConfigService');
const {
    deferReplyWithRetry,
    editReplyWithRetry,
    followUpWithRetry,
    replyWithRetry,
    runDiscordRequest,
    showModalWithRetry,
} = require('../../../core/discord/request');
const logger = require('../../../core/logging/logger');
const { buildPublicErrorMessage } = require('../../../core/ui/errorMessage');
const { SessionStore } = require('../../../core/sessions/sessionStore');
const appealService = require('../appealService');
const DisciplineError = require('../error');
const disciplineService = require('../service');

const SESSION_TTL_MS = 15 * 60_000;
const applicantSessions = new SessionStore({
    ttlMs: SESSION_TTL_MS,
    getLastActivity: (session) => session?.updatedAt,
});
const reviewerSessions = new SessionStore({
    ttlMs: SESSION_TTL_MS,
    getLastActivity: (session) => session?.updatedAt,
});

function createId() {
    return crypto.randomBytes(8).toString('hex');
}

function getSession(store, sessionId, interaction, ownerField) {
    const session = store.get(sessionId);
    if (!session) {
        throw new DisciplineError('Сессия истекла. Откройте обжалование заново.', 'appeal_session_expired');
    }
    if (
        String(session.guildId) !== String(interaction.guildId) ||
        String(session[ownerField]) !== String(interaction.user.id)
    ) {
        throw new DisciplineError('Эта сессия принадлежит другому пользователю.', 'appeal_session_denied');
    }
    session.updatedAt = Date.now();
    return session;
}

function getApplicantSession(sessionId, interaction) {
    return getSession(applicantSessions, sessionId, interaction, 'applicantId');
}

function getReviewerSession(sessionId, interaction) {
    return getSession(reviewerSessions, sessionId, interaction, 'actorId');
}

function parseCustomId(customId) {
    const value = String(customId || '');
    let match = value.match(/^disciplineAppeal:start:([^:]+):([^:]+)$/u);
    if (match) return { action: 'start', caseId: match[1], sanctionId: match[2] };
    match = value.match(/^disciplineAppeal:type:([^:]+):([^:]+)$/u);
    if (match) return { action: 'type', caseId: match[1], sanctionId: match[2] };
    match = value.match(/^disciplineAppeal:(part|method|workoffSubmit|reviewMethod|reviewMethodSubmit):([a-f0-9]+)$/u);
    if (match) return { action: match[1], sessionId: match[2] };
    match = value.match(/^disciplineAppealModal:(basis|workoff):(.+)$/u);
    if (match) return { action: 'createModal', type: match[1], id: match[2] };
    match = value.match(/^disciplineAppeal:(approve|reject|escalate|reroute|withdraw):(.+)$/u);
    if (match) return { action: match[1], appealId: match[2] };
    match = value.match(/^disciplineAppealDecision:(approve|approveWorkoff|reject):(.+)$/u);
    if (match) return { action: 'decisionModal', decision: match[1], id: match[2] };
    return null;
}

function buildTypePanel(caseId, sanctionId, hasWorkoff) {
    const options = [
        {
            label: 'Обжаловать основание взыскания',
            value: 'basis',
            description: 'Запросить аннулирование взыскания.',
        },
    ];
    if (hasWorkoff) {
        options.push({
            label: 'Изменить способ отработки',
            value: 'workoff_method',
            description: 'Запросить другой допустимый способ.',
        });
    }
    return {
        content: [
            '## Обжалование взыскания',
            'Выберите тип обращения.',
            '',
            '-# Интерфейс действителен 15 минут.',
        ].join('\n'),
        components: [new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`disciplineAppeal:type:${caseId}:${sanctionId}`)
                .setPlaceholder('Тип обращения')
                .addOptions(options)
        )],
        allowedMentions: { parse: [] },
        temporary: false,
    };
}

function buildAppealModal(customId, title) {
    return new ModalBuilder()
        .setCustomId(customId)
        .setTitle(title)
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('reason')
                    .setLabel('Причина обращения')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true)
                    .setMinLength(5)
                    .setMaxLength(2000)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('evidence_note')
                    .setLabel('Пояснение или ссылки к доказательствам')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(false)
                    .setMaxLength(2000)
                    .setPlaceholder('Файлы можно будет отправить в созданную ветку.')
            )
        );
}

function buildWorkoffPanel(session) {
    const selectedPart = session.parts.find((part) => part.id === session.partId) || null;
    const methods = selectedPart ? session.methodsByPart[selectedPart.id] || [] : [];
    const components = [];
    if (session.parts.length > 1) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`disciplineAppeal:part:${session.id}`)
                .setPlaceholder('Часть отработки')
                .addOptions(session.parts.map((part, index) => ({
                    label: `${index + 1}. ${part.methodName}`.slice(0, 100),
                    value: part.id,
                    default: part.id === session.partId,
                })))
        ));
    }
    if (selectedPart) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`disciplineAppeal:method:${session.id}`)
                .setPlaceholder('Желаемый способ отработки')
                .addOptions(methods.slice(0, 25).map((method) => ({
                    label: method.name.slice(0, 100),
                    value: method.id,
                    default: method.id === session.methodId,
                })))
        ));
    }
    components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`disciplineAppeal:workoffSubmit:${session.id}`)
            .setLabel('Продолжить')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(!session.partId || !session.methodId)
    ));
    return {
        content: [
            '## Изменение способа отработки',
            selectedPart ? `Текущий способ: ${selectedPart.methodName}` : 'Выберите часть отработки.',
            session.methodId
                ? `Желаемый способ: ${methods.find((method) => method.id === session.methodId)?.name || 'Неизвестный способ'}`
                : 'Желаемый способ не выбран.',
            '',
            '-# Срок отработки при таком обращении не приостанавливается.',
        ].join('\n'),
        components,
        allowedMentions: { parse: [] },
        temporary: false,
    };
}

function buildReviewMethodPanel(session) {
    return {
        content: [
            '## Итоговый способ отработки',
            `Текущий способ: ${session.currentMethodName}`,
            `Запрошенный способ: ${session.requestedMethodName || 'не указан'}`,
            session.methodId
                ? `Выбранный итоговый способ: ${session.methods.find((method) => method.id === session.methodId)?.name || 'Неизвестный способ'}`
                : 'Итоговый способ не выбран.',
            '',
            '-# Рассматривающий может выбрать любой доступный способ, а не только запрошенный сотрудником.',
        ].join('\n'),
        components: [
            new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`disciplineAppeal:reviewMethod:${session.id}`)
                    .setPlaceholder('Итоговый способ отработки')
                    .addOptions(session.methods.slice(0, 25).map((method) => ({
                        label: method.name.slice(0, 100),
                        value: method.id,
                        default: method.id === session.methodId,
                    })))
            ),
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`disciplineAppeal:reviewMethodSubmit:${session.id}`)
                    .setLabel('Продолжить')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(!session.methodId)
            ),
        ],
        allowedMentions: { parse: [] },
        temporary: false,
    };
}

function buildDecisionModal(decision, id) {
    const approve = decision === 'approve' || decision === 'approveWorkoff';
    return new ModalBuilder()
        .setCustomId(`disciplineAppealDecision:${decision}:${id}`)
        .setTitle(approve ? 'Удовлетворить обращение' : 'Отклонить обращение')
        .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('reason')
                .setLabel(approve ? 'Причина решения' : 'Причина отказа')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMinLength(3)
                .setMaxLength(1000)
        ));
}

async function fetchContext(client, interaction, caseId, sanctionId) {
    const config = guildConfigService.get(interaction.guildId);
    appealService.assertAppealsEnabled(config);
    const guild = interaction.guild || await client.guilds.fetch(interaction.guildId);
    const applicant = await guild.members.fetch(interaction.user.id);
    const caseRecord = await disciplineService.fetchCase(caseId);
    if (!caseRecord || String(caseRecord.guildId) !== String(guild.id)) {
        throw new DisciplineError('Дисциплинарное дело не найдено.', 'appeal_case_not_found');
    }
    if (String(caseRecord.memberId || '') !== String(applicant.id)) {
        throw new DisciplineError('Обжаловать взыскание может только сотрудник, которому оно выдано.', 'appeal_applicant_denied');
    }
    const sanction = disciplineService.findSanction(caseRecord, sanctionId);
    if (!sanction || sanction.status !== 'active') {
        throw new DisciplineError('Активное взыскание не найдено.', 'appeal_sanction_not_active');
    }
    return { config, guild, applicant, caseRecord, sanction };
}

async function handleStart(client, interaction, parsed) {
    const { sanction } = await fetchContext(client, interaction, parsed.caseId, parsed.sanctionId);
    await replyWithRetry(interaction, {
        ...buildTypePanel(parsed.caseId, parsed.sanctionId, disciplineService.getPendingParts(sanction).length > 0),
        flags: MessageFlags.Ephemeral,
    });
}

async function handleType(client, interaction, parsed) {
    const type = interaction.values[0];
    const context = await fetchContext(client, interaction, parsed.caseId, parsed.sanctionId);
    if (type === 'basis') {
        await showModalWithRetry(
            interaction,
            buildAppealModal(`disciplineAppealModal:basis:${parsed.caseId}|${parsed.sanctionId}`, 'Обжалование взыскания'),
            { attempts: 1 }
        );
        return;
    }
    if (type !== 'workoff_method') throw new DisciplineError('Неизвестный тип обращения.', 'appeal_type_invalid');
    const parts = disciplineService.getPendingParts(context.sanction);
    if (!parts.length) throw new DisciplineError('У взыскания нет активной отработки.', 'appeal_no_workoff');
    const methodsByPart = Object.fromEntries(parts.map((part) => [
        part.id,
        disciplineService.getAvailableMethods(context.applicant, context.config, part.stage)
            .filter((method) => method.id !== part.methodId),
    ]));
    const firstPart = parts.find((part) => methodsByPart[part.id].length) || null;
    if (!firstPart) throw new DisciplineError('Для отработки нет другого доступного способа.', 'appeal_no_alternative_method');
    const session = {
        id: createId(),
        guildId: String(interaction.guildId),
        applicantId: String(interaction.user.id),
        caseId: parsed.caseId,
        sanctionId: parsed.sanctionId,
        parts,
        methodsByPart,
        partId: firstPart.id,
        methodId: null,
        updatedAt: Date.now(),
    };
    applicantSessions.set(session.id, session);
    await runDiscordRequest(() => interaction.update(buildWorkoffPanel(session)), { attempts: 1 });
}

async function handleWorkoffSelect(interaction, parsed) {
    const session = getApplicantSession(parsed.sessionId, interaction);
    if (parsed.action === 'part') {
        session.partId = interaction.values[0];
        session.methodId = null;
    } else {
        session.methodId = interaction.values[0];
    }
    await runDiscordRequest(() => interaction.update(buildWorkoffPanel(session)), { attempts: 1 });
}

async function handleWorkoffSubmit(interaction, parsed) {
    const session = getApplicantSession(parsed.sessionId, interaction);
    if (!session.partId || !session.methodId) {
        throw new DisciplineError('Выберите желаемый способ отработки.', 'appeal_method_required');
    }
    await showModalWithRetry(
        interaction,
        buildAppealModal(`disciplineAppealModal:workoff:${session.id}`, 'Изменение способа'),
        { attempts: 1 }
    );
}

async function handleCreateModal(client, interaction, parsed) {
    await deferReplyWithRetry(interaction, { flags: MessageFlags.Ephemeral });
    let caseId;
    let sanctionId;
    let partId = null;
    let methodId = null;
    let session = null;
    if (parsed.type === 'basis') {
        [caseId, sanctionId] = parsed.id.split('|');
    } else {
        session = getApplicantSession(parsed.id, interaction);
        ({ caseId, sanctionId, partId, methodId } = session);
    }
    const { guild, applicant } = await fetchContext(client, interaction, caseId, sanctionId);
    const appeal = await appealService.createAppeal(client, {
        guild,
        applicant,
        caseId,
        sanctionId,
        type: parsed.type === 'basis' ? 'basis' : 'workoff_method',
        reason: interaction.fields.getTextInputValue('reason'),
        evidenceNote: interaction.fields.getTextInputValue('evidence_note'),
        partId,
        requestedMethodId: methodId,
    });
    if (session) applicantSessions.delete(session.id);
    await editReplyWithRetry(interaction, {
        content: `Обращение создано. ID: ${appeal.appealId}`,
        components: [],
        allowedMentions: { parse: [] },
    });
}

async function handleDecisionButton(client, interaction, parsed) {
    if (parsed.action === 'reject') {
        await showModalWithRetry(interaction, buildDecisionModal('reject', parsed.appealId), { attempts: 1 });
        return;
    }
    const guild = interaction.guild || await client.guilds.fetch(interaction.guildId);
    const appeal = await appealService.fetchAppeal(parsed.appealId);
    if (!appeal || String(appeal.guildId) !== String(guild.id)) {
        throw new DisciplineError('Обращение не найдено.', 'appeal_not_found');
    }
    if (appeal.type === 'basis') {
        await showModalWithRetry(interaction, buildDecisionModal('approve', parsed.appealId), { attempts: 1 });
        return;
    }
    const options = await appealService.getWorkoffReviewOptions(guild, appeal.appealId, interaction.user.id);
    const selectedMethod = options.methods.find((method) => method.id === appeal.requestedMethodId) || options.methods[0];
    const session = {
        id: createId(),
        guildId: String(guild.id),
        actorId: String(interaction.user.id),
        appealId: appeal.appealId,
        currentMethodName: options.currentMethodName,
        requestedMethodName: appeal.requestedMethodName,
        methods: options.methods,
        methodId: selectedMethod?.id || null,
        updatedAt: Date.now(),
    };
    reviewerSessions.set(session.id, session);
    await replyWithRetry(interaction, {
        ...buildReviewMethodPanel(session),
        flags: MessageFlags.Ephemeral,
    });
}

async function handleReviewMethodSelect(interaction, parsed) {
    const session = getReviewerSession(parsed.sessionId, interaction);
    session.methodId = interaction.values[0];
    await runDiscordRequest(() => interaction.update(buildReviewMethodPanel(session)), { attempts: 1 });
}

async function handleReviewMethodSubmit(interaction, parsed) {
    const session = getReviewerSession(parsed.sessionId, interaction);
    if (!session.methodId) {
        throw new DisciplineError('Выберите итоговый способ отработки.', 'appeal_approved_method_required');
    }
    await showModalWithRetry(
        interaction,
        buildDecisionModal('approveWorkoff', session.id),
        { attempts: 1 }
    );
}

async function handleDecisionModal(client, interaction, parsed) {
    await deferReplyWithRetry(interaction, { flags: MessageFlags.Ephemeral });
    const guild = interaction.guild || await client.guilds.fetch(interaction.guildId);
    const actor = await guild.members.fetch(interaction.user.id);
    const reason = interaction.fields.getTextInputValue('reason');
    let appeal;
    if (parsed.decision === 'approveWorkoff') {
        const session = getReviewerSession(parsed.id, interaction);
        appeal = await appealService.approveAppeal(client, {
            guild,
            actor,
            appealId: session.appealId,
            decisionReason: reason,
            approvedMethodId: session.methodId,
        });
        reviewerSessions.delete(session.id);
    } else if (parsed.decision === 'approve') {
        appeal = await appealService.approveAppeal(client, {
            guild,
            actor,
            appealId: parsed.id,
            decisionReason: reason,
        });
    } else {
        appeal = await appealService.rejectAppeal(client, {
            guild,
            actor,
            appealId: parsed.id,
            decisionReason: reason,
        });
    }
    await editReplyWithRetry(interaction, {
        content: parsed.decision === 'approve' || parsed.decision === 'approveWorkoff'
            ? 'Обращение удовлетворено.'
            : appeal.status === 'rejected_final'
                ? 'Обращение отклонено окончательно.'
                : 'Обращение отклонено на текущем этапе. Заявитель может передать его выше.',
        components: [],
        allowedMentions: { parse: [] },
    });
}

async function handleApplicantAction(client, interaction, parsed) {
    await runDiscordRequest(() => interaction.deferUpdate(), { attempts: 1 });
    const guild = interaction.guild || await client.guilds.fetch(interaction.guildId);
    const applicant = await guild.members.fetch(interaction.user.id);
    if (parsed.action === 'withdraw') {
        await appealService.withdrawAppeal(client, { guild, applicant, appealId: parsed.appealId });
        await followUpWithRetry(interaction, {
            content: 'Обращение отозвано.',
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        });
        return;
    }
    await appealService.escalateAppeal(client, { guild, applicant, appealId: parsed.appealId });
    await followUpWithRetry(interaction, {
        content: 'Обращение передано на следующий доступный этап.',
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
    });
}

module.exports = async (client, interaction) => {
    if (!interaction.customId || !String(interaction.customId).startsWith('disciplineAppeal')) return;
    const parsed = parseCustomId(interaction.customId);
    if (!parsed) return;
    interaction.__wnStopPropagation = true;
    try {
        if (parsed.action === 'start') await handleStart(client, interaction, parsed);
        else if (parsed.action === 'type') await handleType(client, interaction, parsed);
        else if (parsed.action === 'part' || parsed.action === 'method') await handleWorkoffSelect(interaction, parsed);
        else if (parsed.action === 'workoffSubmit') await handleWorkoffSubmit(interaction, parsed);
        else if (parsed.action === 'createModal') await handleCreateModal(client, interaction, parsed);
        else if (parsed.action === 'approve' || parsed.action === 'reject') await handleDecisionButton(client, interaction, parsed);
        else if (parsed.action === 'reviewMethod') await handleReviewMethodSelect(interaction, parsed);
        else if (parsed.action === 'reviewMethodSubmit') await handleReviewMethodSubmit(interaction, parsed);
        else if (parsed.action === 'decisionModal') await handleDecisionModal(client, interaction, parsed);
        else if (['escalate', 'reroute', 'withdraw'].includes(parsed.action)) {
            await handleApplicantAction(client, interaction, parsed);
        }
    } catch (error) {
        logger[error instanceof DisciplineError ? 'warn' : 'error']('Ошибка обработки обжалования взыскания', {
            guildId: interaction.guildId,
            userId: interaction.user?.id,
            customId: interaction.customId,
        }, error);
        const payload = {
            content: buildPublicErrorMessage(error, 'Не удалось обработать обращение.'),
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        };
        if (interaction.deferred || interaction.replied) {
            await followUpWithRetry(interaction, payload).catch(() => undefined);
        } else {
            await replyWithRetry(interaction, payload).catch(() => undefined);
        }
    }
};
