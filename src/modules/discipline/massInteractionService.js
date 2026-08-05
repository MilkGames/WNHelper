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
    UserSelectMenuBuilder,
} = require('discord.js');
const {
    DISCIPLINE_STAGE_LABELS,
    DISCIPLINE_STAGES,
    getDisciplineSettings,
} = require('./settings/schema');
const { getExams } = require('../examination');
const guildConfigService = require('../../core/config/guildConfigService');
const {
    editReplyWithRetry,
    followUpWithRetry,
    replyWithRetry,
    showModalWithRetry,
} = require('../../core/discord/request');
const logger = require('../../core/logging/logger');
const { buildPublicErrorMessage } = require('../../core/ui/errorMessage');
const DisciplineError = require('./error');
const disciplineService = require('./service');
const massService = require('./massService');

const SESSION_TTL_MS = 20 * 60_000;
const sessions = new Map();
const SANCTION_LABELS = {
    conversation: 'Беседа',
    oral: 'Устный выговор',
    written: 'Письменный выговор',
    demotion: 'Понижение на один ранг',
    recertification: 'Переаттестация',
    dismissal: 'Увольнение',
    dismissal_blacklist: 'Увольнение с ЧС',
};

function createId() {
    return typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getMoscowDateKey() {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Moscow',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}

function customId(sessionId, action) {
    return `massDisciplineSession:${sessionId}:${action}`;
}

function parseCustomId(value) {
    const session = String(value || '').match(/^massDisciplineSession:([^:]+):(.+)$/);
    if (session) return { kind: 'session', sessionId: session[1], action: session[2] };
    const batch = String(value || '').match(/^massDiscipline:(confirm|cancel|back|targets|remove):(.+)$/);
    if (batch) return { kind: 'batch', action: batch[1], batchId: batch[2] };
    return null;
}

function getSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return null;
    if (Date.now() - session.updatedAt > SESSION_TTL_MS) {
        sessions.delete(sessionId);
        return null;
    }
    session.updatedAt = Date.now();
    return session;
}

function assertOwner(session, interaction) {
    if (!session || String(session.guildId) !== String(interaction.guildId) || String(session.actorId) !== String(interaction.user.id)) {
        throw new DisciplineError('Сессия массового взыскания истекла или принадлежит другому пользователю.', 'mass_session_expired');
    }
}

function createSession({ guildId, actorId, targets = [] }) {
    const session = {
        id: createId(),
        guildId: String(guildId),
        actorId: String(actorId),
        targets: massService.normalizeTargets(targets, guildId),
        targetValidation: { valid: [], invalid: [] },
        violationDate: getMoscowDateKey(),
        violatedRules: '',
        reason: '',
        evidence: '',
        selection: [],
        recertificationExamIds: [],
        workoffMode: 'common',
        commonMethodId: 'any',
        memberMethodIds: {},
        selectedMethodTargetKey: null,
        previewBatchId: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    sessions.set(session.id, session);
    return session;
}

function serializeTargets(session) {
    return session.targets.map((target) => (
        target.type === 'external'
            ? `${target.displayName} | ${target.staticId}`
            : target.memberId
    )).join('\n');
}

function createTargetsModal(session) {
    const input = new TextInputBuilder()
        .setCustomId('targets')
        .setLabel('Discord ID или Имя Фамилия | статик')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(4000)
        .setPlaceholder('123456789012345678\nTrevor Philips | 4343');
    const current = serializeTargets(session).slice(0, 4000);
    if (current) input.setValue(current);
    return new ModalBuilder()
        .setCustomId(customId(session.id, 'targets_modal'))
        .setTitle('Сотрудники массового взыскания')
        .addComponents(new ActionRowBuilder().addComponents(input));
}

function createDetailsModal(session) {
    return new ModalBuilder()
        .setCustomId(customId(session.id, 'details_modal'))
        .setTitle('Общие данные взыскания')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('violation_date')
                    .setLabel('Дата нарушения (YYYY-MM-DD)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMaxLength(10)
                    .setValue(session.violationDate || getMoscowDateKey())
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('violated_rules')
                    .setLabel('Нарушенные пункты')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true)
                    .setMaxLength(1024)
                    .setValue(String(session.violatedRules || '').slice(0, 1024))
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('reason')
                    .setLabel('Подробная причина')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true)
                    .setMaxLength(1024)
                    .setValue(String(session.reason || '').slice(0, 1024))
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('evidence')
                    .setLabel('Общие доказательства или ссылки')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true)
                    .setMaxLength(1900)
                    .setValue(String(session.evidence || '').slice(0, 1900))
            )
        );
}

function buildTargetPicker(session, maxTargets = 25) {
    const current = session.targets.length
        ? session.targets.map((target) => target.type === 'external'
            ? `${target.displayName} | ${target.staticId}`
            : `<@${target.memberId}>`).join('\n')
        : 'Не выбраны.';
    return {
        content: [
            '**Сотрудники массового дисциплинарного дела**',
            `Выберите до ${maxTargets} сотрудников Discord либо введите смешанный список.`,
            '',
            current.slice(0, 1500),
            '',
            '-# Выбор через меню заменяет текущий список. Текстовый ввод позволяет добавить сотрудников вне сервера.',
        ].join('\n'),
        embeds: [],
        components: [
            new ActionRowBuilder().addComponents(
                new UserSelectMenuBuilder()
                    .setCustomId(customId(session.id, 'targets_select'))
                    .setPlaceholder('Заменить список сотрудниками Discord')
                    .setMinValues(1)
                    .setMaxValues(maxTargets)
            ),
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(customId(session.id, 'targets_ids'))
                    .setLabel('Ввести или изменить список')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId(customId(session.id, 'targets_done'))
                    .setLabel('Готово')
                    .setStyle(ButtonStyle.Success)
                    .setDisabled(session.targets.length < 2),
                new ButtonBuilder()
                    .setCustomId(customId(session.id, 'cancel'))
                    .setLabel('Отменить')
                    .setStyle(ButtonStyle.Danger)
            ),
        ],
        allowedMentions: { parse: [] },
        temporary: false,
    };
}

function addSanction(session, type) {
    if (['dismissal', 'dismissal_blacklist'].includes(type)) {
        session.selection = [{ type, count: 1 }];
        session.recertificationExamIds = [];
        return;
    }
    if (session.selection.some((entry) => ['dismissal', 'dismissal_blacklist'].includes(entry.type))) {
        session.selection = [];
    }
    const existing = session.selection.find((entry) => entry.type === type);
    if (DISCIPLINE_STAGES.includes(type)) {
        if (existing) existing.count = Math.min(10, existing.count + 1);
        else session.selection.push({ type, count: 1 });
        return;
    }
    if (!existing) session.selection.push({ type, count: 1 });
}

function getSelectionText(session) {
    if (!session.selection.length) return 'Не выбраны.';
    return session.selection.map((entry) => {
        const label = SANCTION_LABELS[entry.type] || 'Неизвестное взыскание';
        return DISCIPLINE_STAGES.includes(entry.type) && entry.count > 1 ? `${label} × ${entry.count}` : label;
    }).join('\n');
}

function hasWorkoffSelection(session, settings) {
    return session.selection.some((entry) => (
        DISCIPLINE_STAGES.includes(entry.type) && settings.stages[entry.type].workoffEnabled
    ));
}

async function getMethodOptionsForTarget(guild, config, target, selection) {
    const member = target.type === 'member'
        ? await guild.members.fetch(target.memberId).catch(() => null)
        : null;
    const settings = getDisciplineSettings(config);
    const stages = selection
        .filter((entry) => DISCIPLINE_STAGES.includes(entry.type) && settings.stages[entry.type].workoffEnabled)
        .map((entry) => entry.type);
    if (!stages.length) return [{ label: 'Любой', value: 'any' }];
    let available = null;
    for (const stage of stages) {
        const methods = disciplineService.getAvailableMethods(member, config, stage);
        const map = new Map(methods.map((method) => [method.id, method]));
        if (available === null) available = map;
        else available = new Map([...available].filter(([id]) => map.has(id)));
    }
    return [...(available || new Map()).values()].slice(0, 25).map((method) => ({
        label: String(method.name || method.id).slice(0, 100),
        value: String(method.id),
    }));
}

async function getCommonMethodOptions(guild, config, session) {
    let common = null;
    for (const target of session.targets) {
        const options = await getMethodOptionsForTarget(guild, config, target, session.selection);
        const map = new Map(options.map((option) => [option.value, option]));
        if (common === null) common = map;
        else common = new Map([...common].filter(([id]) => map.has(id)));
    }
    const options = [...(common || new Map()).values()];
    return options.length ? options.slice(0, 25) : [{ label: 'Любой', value: 'any' }];
}

async function refreshTargetValidation(guild, config, actor, session) {
    session.targetValidation = session.selection.length
        ? await massService.validateTargetsDraft({
            guild,
            config,
            actor,
            targets: session.targets,
            data: session,
        })
        : await massService.validateTargetsEarly({
            guild,
            config,
            actor,
            targets: session.targets,
        });
    session.targetValidation.globalError ||= null;
    if (Array.isArray(session.targetValidation.targets)) {
        session.targets = session.targetValidation.targets;
        const targetKeys = new Set(session.targets.map((target) => target.targetKey));
        session.memberMethodIds = Object.fromEntries(
            Object.entries(session.memberMethodIds || {}).filter(([targetKey]) => targetKeys.has(targetKey))
        );
        if (!targetKeys.has(session.selectedMethodTargetKey)) {
            session.selectedMethodTargetKey = session.targets[0]?.targetKey || null;
        }
    }
    return session.targetValidation;
}

async function buildPanel(client, session) {
    const guild = await client.guilds.fetch(session.guildId);
    const actor = await guild.members.fetch(session.actorId);
    const config = guildConfigService.get(session.guildId);
    const settings = getDisciplineSettings(config);
    const exams = getExams(config);
    const validation = await refreshTargetValidation(guild, config, actor, session);
    const detailsReady = Boolean(session.violatedRules && session.reason && session.evidence);
    const targetLines = session.targets.map((target) => {
        const invalid = validation.invalid.find((entry) => entry.targetKey === target.targetKey);
        const label = target.type === 'external'
            ? `${target.displayName} | ${target.staticId} - вне сервера`
            : `<@${target.memberId}> | ||${target.memberId}||`;
        return invalid ? `❌ ${label} - ${invalid.error}` : `✅ ${label}`;
    }).join('\n');
    const embed = new EmbedBuilder()
        .setColor(validation.invalid.length || validation.globalError ? 0xE74C3C : 0xE67E22)
        .setTitle('Массовое дисциплинарное дело')
        .addFields(
            { name: `Сотрудники (${session.targets.length})`, value: targetLines.slice(0, 1024) || 'Не выбраны.' },
            { name: 'Общие данные', value: detailsReady ? `✅ ${session.violationDate}\n${session.violatedRules}`.slice(0, 1024) : '❌ Не заполнены' },
            { name: 'Санкции', value: getSelectionText(session) },
        );
    const rows = [];
    const sanctionOptions = [];
    if (settings.stages.conversation.enabled) sanctionOptions.push({ label: 'Добавить беседу', value: 'conversation' });
    sanctionOptions.push(
        { label: 'Добавить устный выговор', value: 'oral' },
        { label: 'Добавить письменный выговор', value: 'written' },
        { label: 'Добавить понижение', value: 'demotion' },
        ...(exams.length ? [{ label: 'Добавить переаттестацию', value: 'recertification' }] : []),
        { label: 'Выбрать увольнение', value: 'dismissal' },
        { label: 'Выбрать увольнение с ЧС', value: 'dismissal_blacklist' }
    );
    rows.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(customId(session.id, 'add_sanction'))
            .setPlaceholder('Добавить санкцию')
            .addOptions(sanctionOptions.slice(0, 25))
    ));

    if (session.selection.some((entry) => entry.type === 'recertification') && exams.length) {
        rows.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(customId(session.id, 'exams'))
                .setPlaceholder('Экзамены переаттестации')
                .setMinValues(1)
                .setMaxValues(Math.min(25, exams.length))
                .addOptions(exams.slice(0, 25).map((exam) => ({
                    label: exam.name.slice(0, 100),
                    value: exam.id,
                    default: session.recertificationExamIds.includes(exam.id),
                })))
        ));
    }

    if (hasWorkoffSelection(session, settings)) {
        if (session.workoffMode === 'common') {
            const options = await getCommonMethodOptions(guild, config, session);
            if (!options.some((option) => option.value === session.commonMethodId)) session.commonMethodId = options[0].value;
            rows.push(new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(customId(session.id, 'common_method'))
                    .setPlaceholder('Один способ всем сотрудникам')
                    .addOptions(options.map((option) => ({ ...option, default: option.value === session.commonMethodId })))
            ));
        } else {
            const selected = session.targets.find((target) => target.targetKey === session.selectedMethodTargetKey) || session.targets[0];
            session.selectedMethodTargetKey = selected?.targetKey || null;
            rows.push(new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(customId(session.id, 'individual_member'))
                    .setPlaceholder('Сотрудник для настройки способа')
                    .addOptions(session.targets.slice(0, 25).map((target) => ({
                        label: (target.type === 'external'
                            ? `${target.displayName} | ${target.staticId}`
                            : guild.members.cache.get(target.memberId)?.displayName || target.memberId).slice(0, 100),
                        value: target.targetKey,
                        default: target.targetKey === session.selectedMethodTargetKey,
                    })))
            ));
            if (selected) {
                const options = await getMethodOptionsForTarget(guild, config, selected, session.selection);
                const current = session.memberMethodIds[selected.targetKey] || 'any';
                rows.push(new ActionRowBuilder().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId(customId(session.id, 'individual_method'))
                        .setPlaceholder('Способ выбранному сотруднику')
                        .addOptions(options.map((option) => ({ ...option, default: option.value === current })))
                ));
            }
        }
    }

    const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(customId(session.id, 'details'))
            .setLabel(detailsReady ? 'Изменить данные' : 'Заполнить данные')
            .setStyle(detailsReady ? ButtonStyle.Secondary : ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId(customId(session.id, session.workoffMode === 'common' ? 'mode_individual' : 'mode_common'))
            .setLabel(session.workoffMode === 'common' ? 'По сотрудникам' : 'Один всем')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!hasWorkoffSelection(session, settings)),
        new ButtonBuilder()
            .setCustomId(customId(session.id, 'edit_targets'))
            .setLabel('Изменить сотрудников')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(customId(session.id, 'clear'))
            .setLabel('Очистить санкции')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(customId(session.id, 'preview'))
            .setLabel('Предпросмотр')
            .setStyle(ButtonStyle.Success)
            .setDisabled(
                !detailsReady ||
                !session.selection.length ||
                session.targets.length < 2 ||
                validation.invalid.length > 0 ||
                Boolean(validation.globalError)
            )
    );

    const componentRows = [...rows, actionRow];
    if (componentRows.length > 5) {
        throw new DisciplineError('Интерфейс массового взыскания превысил лимит компонентов Discord.', 'mass_ui_component_limit');
    }
    return {
        content: [
            validation.globalError ? `**Ошибка параметров:** ${validation.globalError}` : '',
            validation.invalid.length ? '**Исправьте отмеченных сотрудников до предпросмотра.**' : '',
            '-# Интерфейс действует 20 минут. Массовое взыскание потребует подтверждения второго сотрудника, кроме настроенных ролей обхода.',
        ].filter(Boolean).join('\n'),
        embeds: [embed],
        components: componentRows,
        allowedMentions: { parse: [] },
        temporary: false,
    };
}

async function start(client, interaction, targets = []) {
    const guild = interaction.guild || await client.guilds.fetch(interaction.guildId);
    const actor = await guild.members.fetch(interaction.user.id);
    const config = guildConfigService.get(interaction.guildId);
    await massService.preflight({ client, guild, config, actor });
    const session = createSession({
        guildId: interaction.guildId,
        actorId: interaction.user.id,
        targets,
    });
    if (!session.targets.length) {
        const maxTargets = getDisciplineSettings(config).massMaxTargets;
        await replyWithRetry(interaction, {
            ...buildTargetPicker(session, maxTargets),
            flags: MessageFlags.Ephemeral,
        });
        return session;
    }
    const payload = await buildPanel(client, session);
    if (interaction.deferred || interaction.replied) await editReplyWithRetry(interaction, payload);
    else await replyWithRetry(interaction, { ...payload, flags: MessageFlags.Ephemeral });
    return session;
}

async function editPanel(client, interaction, session) {
    if (interaction.isButton?.() || interaction.isStringSelectMenu?.() || interaction.isUserSelectMenu?.()) {
        await interaction.deferUpdate();
    }
    const payload = await buildPanel(client, session);
    await editReplyWithRetry(interaction, payload);
}

async function handleSession(client, interaction, parsed) {
    const session = getSession(parsed.sessionId);
    assertOwner(session, interaction);
    const action = parsed.action;

    if (interaction.isButton() && action === 'targets_ids') {
        await showModalWithRetry(interaction, createTargetsModal(session));
        return true;
    }
    if (interaction.isModalSubmit() && action === 'targets_modal') {
        session.targets = massService.parseTargetText(interaction.fields.getTextInputValue('targets'), interaction.guildId);
        session.selectedMethodTargetKey = null;
        session.memberMethodIds = {};
        await interaction.deferUpdate();
        await editReplyWithRetry(interaction, await buildPanel(client, session));
        return true;
    }
    if (interaction.isUserSelectMenu() && action === 'targets_select') {
        session.targets = massService.normalizeTargets(interaction.values, interaction.guildId);
        session.selectedMethodTargetKey = null;
        session.memberMethodIds = {};
        await interaction.update(buildTargetPicker(session, getDisciplineSettings(guildConfigService.get(interaction.guildId)).massMaxTargets));
        return true;
    }
    if (interaction.isButton() && action === 'targets_done') {
        await interaction.deferUpdate();
        await editReplyWithRetry(interaction, await buildPanel(client, session));
        return true;
    }
    if (interaction.isButton() && action === 'edit_targets') {
        const maxTargets = getDisciplineSettings(guildConfigService.get(interaction.guildId)).massMaxTargets;
        await interaction.update(buildTargetPicker(session, maxTargets));
        return true;
    }
    if (interaction.isButton() && action === 'details') {
        await showModalWithRetry(interaction, createDetailsModal(session));
        return true;
    }
    if (interaction.isModalSubmit() && action === 'details_modal') {
        session.violationDate = interaction.fields.getTextInputValue('violation_date').trim();
        session.violatedRules = interaction.fields.getTextInputValue('violated_rules').trim();
        session.reason = interaction.fields.getTextInputValue('reason').trim();
        session.evidence = interaction.fields.getTextInputValue('evidence').trim();
        await interaction.deferUpdate();
        await editReplyWithRetry(interaction, await buildPanel(client, session));
        return true;
    }
    if (interaction.isStringSelectMenu() && action === 'add_sanction') {
        addSanction(session, interaction.values[0]);
        await editPanel(client, interaction, session);
        return true;
    }
    if (interaction.isStringSelectMenu() && action === 'exams') {
        session.recertificationExamIds = [...interaction.values];
        await editPanel(client, interaction, session);
        return true;
    }
    if (interaction.isStringSelectMenu() && action === 'common_method') {
        session.commonMethodId = interaction.values[0];
        await editPanel(client, interaction, session);
        return true;
    }
    if (interaction.isStringSelectMenu() && action === 'individual_member') {
        session.selectedMethodTargetKey = interaction.values[0];
        await editPanel(client, interaction, session);
        return true;
    }
    if (interaction.isStringSelectMenu() && action === 'individual_method') {
        if (!session.selectedMethodTargetKey) throw new DisciplineError('Сначала выберите сотрудника.', 'mass_method_member_missing');
        session.memberMethodIds[session.selectedMethodTargetKey] = interaction.values[0];
        await editPanel(client, interaction, session);
        return true;
    }
    if (interaction.isButton() && action === 'mode_individual') {
        session.workoffMode = 'individual';
        session.selectedMethodTargetKey ||= session.targets[0]?.targetKey || null;
        await editPanel(client, interaction, session);
        return true;
    }
    if (interaction.isButton() && action === 'mode_common') {
        session.workoffMode = 'common';
        await editPanel(client, interaction, session);
        return true;
    }
    if (interaction.isButton() && action === 'clear') {
        session.selection = [];
        session.recertificationExamIds = [];
        await editPanel(client, interaction, session);
        return true;
    }
    if (interaction.isButton() && action === 'cancel') {
        sessions.delete(session.id);
        await interaction.update({
            content: 'Оформление массового взыскания отменено.',
            embeds: [],
            components: [],
            allowedMentions: { parse: [] },
        });
        return true;
    }
    if (interaction.isButton() && action === 'preview') {
        await interaction.deferUpdate();
        const guild = interaction.guild || await client.guilds.fetch(interaction.guildId);
        const actor = await guild.members.fetch(interaction.user.id);
        const config = guildConfigService.get(interaction.guildId);
        if (session.previewBatchId) {
            await massService.cancelBatch(session.previewBatchId, actor.id).catch(() => undefined);
            session.previewBatchId = null;
        }
        const batch = await massService.createBatch({
            guild,
            config,
            actor,
            targets: session.targets,
            data: session,
            sessionId: session.id,
        });
        session.previewBatchId = batch.massdisciplineId;
        await editReplyWithRetry(interaction, massService.buildPreviewPayload(batch));
        return true;
    }
    return false;
}

async function handleBatch(client, interaction, parsed) {
    const guild = interaction.guild || await client.guilds.fetch(interaction.guildId);
    const actor = await guild.members.fetch(interaction.user.id);
    await interaction.deferUpdate();
    if (['back', 'targets', 'remove'].includes(parsed.action)) {
        const batch = await massService.getBatch(parsed.batchId);
        if (!batch || String(batch.actorId) !== String(actor.id)) {
            throw new DisciplineError('Предпросмотр не найден или принадлежит другому пользователю.', 'mass_batch_owner');
        }
        const session = getSession(batch.sessionId);
        assertOwner(session, interaction);
        if (parsed.action === 'remove') {
            const removed = new Set(Array.isArray(interaction.values) ? interaction.values.map(String) : []);
            session.targets = session.targets.filter((target) => !removed.has(target.targetKey));
            session.selectedMethodTargetKey = session.targets.some((target) => target.targetKey === session.selectedMethodTargetKey)
                ? session.selectedMethodTargetKey
                : session.targets[0]?.targetKey || null;
            session.memberMethodIds = Object.fromEntries(
                Object.entries(session.memberMethodIds || {}).filter(([targetKey]) => !removed.has(targetKey))
            );
        }
        await massService.cancelBatch(parsed.batchId, actor.id);
        session.previewBatchId = null;
        if (parsed.action === 'targets') {
            const config = guildConfigService.get(interaction.guildId);
            await editReplyWithRetry(interaction, buildTargetPicker(session, getDisciplineSettings(config).massMaxTargets));
        } else {
            await editReplyWithRetry(interaction, await buildPanel(client, session));
        }
        return true;
    }
    if (parsed.action === 'cancel') {
        const batch = await massService.cancelBatch(parsed.batchId, actor.id);
        if (batch.sessionId) sessions.delete(batch.sessionId);
        await editReplyWithRetry(interaction, {
            content: `Массовое дисциплинарное дело ${batch.massdisciplineId} отменено.`,
            embeds: [],
            components: [],
            allowedMentions: { parse: [] },
        });
        return true;
    }
    const result = await massService.submitBatch(client, { batchId: parsed.batchId, actor });
    const sourceBatch = await massService.getBatch(parsed.batchId);
    if (sourceBatch?.sessionId) sessions.delete(sourceBatch.sessionId);
    if (result.status === 'awaiting_approval') {
        await editReplyWithRetry(interaction, {
            content: [
                `Массовое дисциплинарное дело отправлено на подтверждение.`,
                `ID: ${result.massdisciplineId}`,
                `Срок подтверждения: <t:${Math.floor(result.expiresAt / 1000)}:R>`,
            ].join('\n'),
            embeds: [],
            components: [],
            allowedMentions: { parse: [] },
        });
    } else {
        await editReplyWithRetry(interaction, {
            ...massService.buildResultPayload(result),
            components: [],
        });
    }
    return true;
}

async function handle(client, interaction) {
    if (!interaction.customId) return false;
    const parsed = parseCustomId(interaction.customId);
    if (!parsed) return false;
    try {
        if (parsed.kind === 'session') return await handleSession(client, interaction, parsed);
        return await handleBatch(client, interaction, parsed);
    } catch (error) {
        logger[error instanceof DisciplineError ? 'warn' : 'error']('Ошибка интерфейса массового взыскания', {
            guildId: interaction.guildId,
            userId: interaction.user?.id,
            customId: interaction.customId,
        }, error);
        const content = buildPublicErrorMessage(error, 'Не удалось обработать массовое взыскание.');
        if (interaction.deferred || interaction.replied) {
            await followUpWithRetry(interaction, {
                content,
                flags: MessageFlags.Ephemeral,
                allowedMentions: { parse: [] },
            }).catch(() => undefined);
        } else {
            await replyWithRetry(interaction, {
                content,
                flags: MessageFlags.Ephemeral,
                allowedMentions: { parse: [] },
            }).catch(() => undefined);
        }
        return true;
    }
}

module.exports = {
    createSession,
    handle,
    start,
};
