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
const {
    DISCIPLINE_STAGE_LABELS,
    DISCIPLINE_STAGES,
    getDisciplineSettings,
} = require('./settings/schema');
const { getRanks } = require('../staff-audit');
const { getExams } = require('../examination');
const guildConfigService = require('../../core/config/guildConfigService');
const { getMemberRankMatches } = require('../staff-audit');
const {
    deferReplyWithRetry,
    editReplyWithRetry,
    followUpWithRetry,
    replyWithRetry,
    showModalWithRetry,
} = require('../../core/discord/request');
const logger = require('../../core/logging/logger');
const { buildPublicErrorMessage } = require('../../core/ui/errorMessage');
const DisciplineError = require('./error');
const disciplineService = require('./service');
const targetService = require('./targetService');

const SESSION_TTL_MS = 15 * 60_000;
const issueSessions = new Map();
const actionSessions = new Map();
const externalLinkSessions = new Map();
const MOSCOW_TIME_ZONE = 'Europe/Moscow';

const SANCTION_LABELS = {
    conversation: 'Беседа',
    oral: 'Устный выговор',
    written: 'Письменный выговор',
    demotion: 'Понижение',
    recertification: 'Переаттестация',
    dismissal: 'Увольнение',
    dismissal_blacklist: 'Увольнение с ЧС',
};

function createId() {
    return typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getMoscowDateKey(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: MOSCOW_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}

function issueCustomId(sessionId, action) {
    return `disciplineIssue:${sessionId}:${action}`;
}

function actionCustomId(sessionId, action) {
    return `disciplineAction:${sessionId}:${action}`;
}

function parseCustomId(value) {
    const issue = String(value || '').match(/^disciplineIssue:([^:]+):(.+)$/);
    if (issue) return { kind: 'issue', sessionId: issue[1], action: issue[2] };
    const action = String(value || '').match(/^disciplineAction:([^:]+):(.+)$/);
    if (action) return { kind: 'action', sessionId: action[1], action: action[2] };
    const sanction = String(value || '').match(/^discipline:(remove|method|extend):([^:]+):([^:]+)$/);
    if (sanction) return {
        kind: 'sanction',
        action: sanction[1],
        caseId: sanction[2],
        sanctionId: sanction[3],
    };
    const removal = String(value || '').match(/^disciplineRemoval:(approve|reject):([^:]+)$/);
    if (removal) return { kind: 'removal', action: removal[1], requestId: removal[2] };
    const removalReject = String(value || '').match(/^disciplineRemovalReject:([^:]+)$/);
    if (removalReject) return { kind: 'removalReject', requestId: removalReject[1] };
    const externalLink = String(value || '').match(/^disciplineExternal:link:([^:]+)$/);
    if (externalLink) return { kind: 'externalLink', caseId: externalLink[1] };
    const externalModal = String(value || '').match(/^disciplineExternalLink:([^:]+)$/);
    if (externalModal) return { kind: 'externalLinkModal', caseId: externalModal[1] };
    const externalConfirm = String(value || '').match(/^disciplineExternalConfirm:([^:]+):(confirm|cancel)$/);
    if (externalConfirm) return { kind: 'externalLinkConfirm', sessionId: externalConfirm[1], action: externalConfirm[2] };
    return null;
}

function getSession(store, id) {
    const session = store.get(id);
    if (!session) return null;
    if (Date.now() - session.updatedAt > SESSION_TTL_MS) {
        store.delete(id);
        return null;
    }
    session.updatedAt = Date.now();
    return session;
}

function getIssueSession(id) {
    return getSession(issueSessions, id);
}

function getActionSession(id) {
    return getSession(actionSessions, id);
}

function getExternalLinkSession(id) {
    return getSession(externalLinkSessions, id);
}

function getSessionTarget(session) {
    if (session.targetType === 'external') {
        return {
            type: 'external',
            targetKey: session.targetKey,
            externalTargetId: session.externalTargetId,
            memberId: null,
            displayName: session.externalDisplayName,
            staticId: session.externalStaticId,
        };
    }
    return {
        type: 'member',
        targetKey: session.targetKey || `member:${session.memberId}`,
        memberId: session.memberId,
        displayName: session.memberDisplayName || session.memberId,
    };
}

function formatSessionTarget(session) {
    return targetService.formatTarget(getSessionTarget(session));
}

function assertSessionOwner(session, interaction) {
    if (!session || session.guildId !== interaction.guildId || session.actorId !== interaction.user.id) {
        throw new DisciplineError('Сессия взыскания истекла или принадлежит другому пользователю.', 'session_expired');
    }
}

function buildDetailsModal(session) {
    return new ModalBuilder()
        .setCustomId(issueCustomId(session.id, 'details'))
        .setTitle('Оформление взыскания')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('violation_date')
                    .setLabel('Дата нарушения (YYYY-MM-DD)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMaxLength(10)
                    .setValue(getMoscowDateKey())
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('violated_rules')
                    .setLabel('Нарушенные пункты')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true)
                    .setMaxLength(1024)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('reason')
                    .setLabel('Подробная причина')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true)
                    .setMaxLength(1024)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('evidence')
                    .setLabel('Доказательства или ссылки')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true)
                    .setMaxLength(1900)
            )
        );
}

function buildSanctionOptions(settings, exams, { allowDemotion = true } = {}) {
    const options = [];
    if (settings.stages.conversation.enabled) {
        options.push({ label: 'Беседа', value: 'conversation', description: 'Добавить одну беседу' });
    }
    options.push(
        { label: 'Устный выговор', value: 'oral', description: 'Добавить один устный выговор' },
        { label: 'Письменный выговор', value: 'written', description: 'Добавить один письменный выговор' },
        ...(allowDemotion ? [{ label: 'Понижение', value: 'demotion', description: 'Понизить сотрудника' }] : []),
        ...(exams.length ? [{ label: 'Переаттестация', value: 'recertification', description: 'Выбрать конкретные экзамены' }] : []),
        { label: 'Увольнение', value: 'dismissal', description: 'Несовместимо с другими санкциями' },
        { label: 'Увольнение с ЧС', value: 'dismissal_blacklist', description: 'Несовместимо с другими санкциями' },
    );
    return options;
}

function getStageUnits(session, settings) {
    if (session.willDismiss) return [];
    return session.selection.filter((unit) => (
        DISCIPLINE_STAGES.includes(unit.type) && settings.stages[unit.type].workoffEnabled
    ));
}

function getUnitLabel(unit, session) {
    const sameBefore = session.selection
        .filter((entry) => entry.type === unit.type)
        .findIndex((entry) => entry.id === unit.id) + 1;
    return `${SANCTION_LABELS[unit.type]} ${sameBefore}`;
}

function buildSelectionPanel(session, config) {
    const settings = getDisciplineSettings(config);
    const ranks = getRanks(config);
    const hasDemotion = session.selection.some((unit) => unit.type === 'demotion');
    const hasRecertification = session.selection.some((unit) => unit.type === 'recertification');
    const exams = getExams(config);
    const selectionText = session.selection.length
        ? session.selection.map((unit, index) => `${index + 1}. ${SANCTION_LABELS[unit.type]}`).join('\n')
        : 'Санкции ещё не выбраны.';
    const activeCounts = disciplineService.getActiveCounts(session.guildId, session.targetKey || session.memberId);
    const components = [
        new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(issueCustomId(session.id, 'add_sanction'))
                .setPlaceholder('Добавить санкцию')
                .addOptions(buildSanctionOptions(settings, exams))
        ),
    ];

    if (hasDemotion && !session.detectedRankNumber) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(issueCustomId(session.id, 'current_rank'))
                .setPlaceholder('Текущий ранг сотрудника')
                .addOptions(ranks.slice(0, 25).map((rank) => ({
                    label: `${rank.number} - ${rank.name}`.slice(0, 100),
                    value: String(rank.number),
                    default: rank.number === session.currentRankNumber,
                })))
        ));
    }

    if (hasDemotion) {
        const currentRank = session.detectedRankNumber || session.currentRankNumber;
        const candidates = ranks.filter((rank) => !currentRank || rank.number < currentRank).slice(0, 25);
        if (candidates.length) {
            components.push(new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(issueCustomId(session.id, 'demotion_rank'))
                    .setPlaceholder('Ранг после понижения')
                    .addOptions(candidates.map((rank) => ({
                        label: `${rank.number} - ${rank.name}`.slice(0, 100),
                        value: String(rank.number),
                        default: rank.number === session.demotionRankNumber,
                    })))
            ));
        }
    }

    if (hasRecertification && exams.length) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(issueCustomId(session.id, 'recertification_exams'))
                .setPlaceholder('Экзамены переаттестации')
                .setMinValues(1)
                .setMaxValues(Math.min(exams.length, 25))
                .addOptions(exams.slice(0, 25).map((exam) => ({
                    label: exam.name.slice(0, 100),
                    value: exam.id,
                    default: session.recertificationExamIds.includes(exam.id),
                })))
        ));
    }

    components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(issueCustomId(session.id, 'remove_last'))
            .setLabel('Удалить последнюю')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!session.selection.length),
        new ButtonBuilder()
            .setCustomId(issueCustomId(session.id, 'selection_continue'))
            .setLabel('Продолжить')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(
                !session.selection.length ||
                (hasDemotion && !(session.detectedRankNumber || session.currentRankNumber)) ||
                (hasDemotion && !session.demotionRankNumber) ||
                (hasRecertification && !session.recertificationExamIds.length)
            ),
        new ButtonBuilder()
            .setCustomId(issueCustomId(session.id, 'cancel'))
            .setLabel('Отмена')
            .setStyle(ButtonStyle.Danger),
    ));

    return {
        content: [
            `## Взыскание для ${formatSessionTarget(session)}`,
            session.status ? `**${session.status}**` : '',
            '',
            `Сейчас активно: беседы - ${activeCounts.conversation || 0}, устные - ${activeCounts.oral || 0}, письменные - ${activeCounts.written || 0}.`,
            '',
            selectionText,
            hasDemotion
                ? `\nТекущий ранг: ${session.detectedRankNumber || session.currentRankNumber || 'не выбран'}\nРанг после понижения: ${session.demotionRankNumber || 'не выбран'}`
                : '',
            '',
            '-# Интерфейс действителен 15 минут.',
        ].filter(Boolean).join('\n'),
        components,
        allowedMentions: { parse: [] },
        temporary: false,
    };
}

function intersectMethods(units, member, config) {
    if (!units.length) return [];
    const lists = units.map((unit) => disciplineService.getAvailableMethods(member, config, unit.type));
    const ids = new Set(lists[0].map((method) => method.id));
    for (const list of lists.slice(1)) {
        const current = new Set(list.map((method) => method.id));
        for (const id of [...ids]) if (!current.has(id)) ids.delete(id);
    }
    return lists[0].filter((method) => ids.has(method.id));
}

function buildMethodPanel(session, config, member) {
    const settings = getDisciplineSettings(config);
    const units = getStageUnits(session, settings);
    const selectedUnit = units.find((unit) => unit.id === session.selectedUnitId) || units[0] || null;
    if (selectedUnit && !session.selectedUnitId) session.selectedUnitId = selectedUnit.id;

    const components = [];
    if (units.length >= 2) {
        components.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(issueCustomId(session.id, 'method_mode_same'))
                .setLabel('Один способ всем')
                .setStyle(session.methodMode === 'same' ? ButtonStyle.Success : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(issueCustomId(session.id, 'method_mode_individual'))
                .setLabel('По отдельности')
                .setStyle(session.methodMode === 'individual' ? ButtonStyle.Success : ButtonStyle.Secondary),
        ));
    } else if (units.length === 1 && !session.methodMode) {
        session.methodMode = 'individual';
    }

    if (session.methodMode === 'same') {
        const methods = intersectMethods(units, member, config).slice(0, 25);
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(issueCustomId(session.id, 'method_same'))
                .setPlaceholder('Способ для всех отработок')
                .addOptions(methods.map((method) => ({
                    label: method.name.slice(0, 100),
                    value: method.id,
                    default: units.every((unit) => session.methodAssignments[unit.id] === method.id),
                })))
        ));
    }

    if (session.methodMode === 'individual' && selectedUnit) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(issueCustomId(session.id, 'method_unit'))
                .setPlaceholder('Отработка')
                .addOptions(units.slice(0, 25).map((unit) => ({
                    label: getUnitLabel(unit, session).slice(0, 100),
                    value: unit.id,
                    default: unit.id === selectedUnit.id,
                })))
        ));
        const methods = disciplineService.getAvailableMethods(member, config, selectedUnit.type).slice(0, 25);
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(issueCustomId(session.id, 'method_individual'))
                .setPlaceholder(`Способ: ${getUnitLabel(selectedUnit, session)}`.slice(0, 100))
                .addOptions(methods.map((method) => ({
                    label: method.name.slice(0, 100),
                    value: method.id,
                    default: session.methodAssignments[selectedUnit.id] === method.id,
                })))
        ));
    }

    const complete = Boolean(session.methodMode) && units.every((unit) => session.methodAssignments[unit.id]);
    components.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(issueCustomId(session.id, 'methods_back'))
            .setLabel('Назад')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(issueCustomId(session.id, 'methods_continue'))
            .setLabel('Продолжить')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(!complete),
        new ButtonBuilder()
            .setCustomId(issueCustomId(session.id, 'cancel'))
            .setLabel('Отмена')
            .setStyle(ButtonStyle.Danger),
    ));

    const assignments = units.map((unit) => {
        const methodId = session.methodAssignments[unit.id];
        const method = disciplineService.getAvailableMethods(member, config, unit.type)
            .find((entry) => entry.id === methodId);
        return `${getUnitLabel(unit, session)} - ${method?.name || 'не выбран'}`;
    });

    return {
        content: [
            '## Способы отработки',
            session.status ? `**${session.status}**` : '',
            '',
            assignments.join('\n'),
            '',
            '-# Интерфейс действителен 15 минут.',
        ].filter(Boolean).join('\n'),
        components,
        allowedMentions: { parse: [] },
        temporary: false,
    };
}

function aggregateSelection(session) {
    const stages = new Map();
    const result = [];
    for (const unit of session.selection) {
        if (DISCIPLINE_STAGES.includes(unit.type)) {
            stages.set(unit.type, (stages.get(unit.type) || 0) + 1);
        } else {
            result.push({ type: unit.type, count: 1 });
        }
    }
    for (const stage of DISCIPLINE_STAGES) {
        const count = stages.get(stage) || 0;
        if (count) result.unshift({ type: stage, count });
    }
    return result;
}

function buildServiceMethodAssignments(session) {
    const counters = {};
    const result = {};
    for (const unit of session.selection) {
        if (!DISCIPLINE_STAGES.includes(unit.type)) continue;
        counters[unit.type] = (counters[unit.type] || 0) + 1;
        result[`${unit.type}-${counters[unit.type]}`] = session.methodAssignments[unit.id] || 'any';
    }
    return result;
}

function buildConfirmationPanel(session, config, member) {
    const settings = getDisciplineSettings(config);
    const lines = session.selection.map((unit, index) => {
        let suffix = '';
        if (!session.willDismiss && DISCIPLINE_STAGES.includes(unit.type) && settings.stages[unit.type].workoffEnabled) {
            const method = disciplineService.getAvailableMethods(member, config, unit.type)
                .find((entry) => entry.id === session.methodAssignments[unit.id]);
            suffix = ` - ${method?.name || 'Любой'}`;
        }
        if (unit.type === 'demotion') suffix = ` - ${session.currentRankNumber || session.detectedRankNumber} → ${session.demotionRankNumber}`;
        if (unit.type === 'recertification') {
            const names = session.recertificationExamIds
                .map((examId) => config.exams?.find((exam) => exam.id === examId)?.name || examId);
            suffix = ` - ${names.join(', ')}`;
        }
        return `${index + 1}. ${SANCTION_LABELS[unit.type]}${suffix}`;
    });
    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('Подтверждение взыскания')
        .setDescription([
            `Сотрудник: ${formatSessionTarget(session)}`,
            `Дата нарушения: ${session.details.violationDate}`,
            '',
            lines.join('\n'),
        ].join('\n').slice(0, 4096))
        .addFields(
            { name: 'Нарушенные пункты', value: session.details.violatedRules.slice(0, 1024) },
            { name: 'Причина', value: session.details.reason.slice(0, 1024) },
        )
        .setFooter({ text: 'После подтверждения сообщения будут опубликованы в настроенном канале.' });
    return {
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(issueCustomId(session.id, 'confirm_back'))
                .setLabel('Назад')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(issueCustomId(session.id, 'confirm'))
                .setLabel('Оформить')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(issueCustomId(session.id, 'cancel'))
                .setLabel('Отмена')
                .setStyle(ButtonStyle.Danger),
        )],
        allowedMentions: { parse: [] },
        temporary: false,
    };
}

async function startIssue(client, interaction) {
    const config = guildConfigService.get(interaction.guildId);
    disciplineService.assertFeatureEnabled(config);
    const guild = interaction.guild || await client.guilds.fetch(interaction.guildId);
    let target = targetService.resolveSingleTargetInput({
        guildId: interaction.guildId,
        memberInput: interaction.options.getString('member', true),
        staticId: interaction.options.getString('static'),
    });

    let member = null;
    let matches = [];
    if (target.type === 'member') {
        member = await guild.members.fetch(target.memberId).catch(() => null);
        if (!member) throw new DisciplineError('Сотрудник не найден на сервере.', 'member_not_found');
        disciplineService.assertMemberHasMainRole(member, config);
        if (member.id === interaction.user.id) throw new DisciplineError('Нельзя оформить взыскание самому себе.', 'self_discipline_denied');
        matches = getMemberRankMatches(member, config);
        if (matches.length > 1) throw new DisciplineError('У сотрудника найдено несколько ролей рангов.', 'target_multiple_ranks');
        target = targetService.createMemberTarget(member);
    }

    const session = {
        id: createId(),
        guildId: interaction.guildId,
        actorId: interaction.user.id,
        targetType: target.type,
        targetKey: target.targetKey,
        memberId: target.memberId,
        memberDisplayName: target.displayName,
        externalTargetId: target.externalTargetId,
        externalDisplayName: target.type === 'external' ? target.displayName : null,
        externalStaticId: target.type === 'external' ? target.staticId : null,
        detectedRankNumber: matches[0]?.number || null,
        currentRankNumber: matches[0]?.number || null,
        demotionRankNumber: null,
        details: null,
        selection: [],
        methodMode: null,
        methodAssignments: {},
        selectedUnitId: null,
        recertificationExamIds: [],
        willDismiss: false,
        status: null,
        updatedAt: Date.now(),
    };
    issueSessions.set(session.id, session);
    await showModalWithRetry(interaction, buildDetailsModal(session), { attempts: 1 });
}

function addSanction(session, type) {
    const dismissalSelected = session.selection.some((unit) => ['dismissal', 'dismissal_blacklist'].includes(unit.type));
    if (['dismissal', 'dismissal_blacklist'].includes(type)) {
        if (session.selection.length) throw new DisciplineError('Увольнение нельзя объединять с другими санкциями.', 'dismissal_exclusive');
    } else if (dismissalSelected) {
        throw new DisciplineError('Увольнение нельзя объединять с другими санкциями.', 'dismissal_exclusive');
    }
    if (type === 'demotion' && session.selection.some((unit) => unit.type === 'demotion')) {
        throw new DisciplineError('В одном деле можно выбрать только одно понижение.', 'duplicate_demotion');
    }
    if (type === 'recertification' && session.selection.some((unit) => unit.type === 'recertification')) {
        throw new DisciplineError('В одном деле можно выбрать только одну переаттестацию.', 'duplicate_recertification');
    }
    if (session.selection.length >= 10) throw new DisciplineError('В одном деле можно выбрать не больше 10 санкций.', 'sanction_limit');
    session.selection.push({ id: createId(), type });
    session.willDismiss = false;
}

async function executeIssue(client, interaction, session) {
    const config = guildConfigService.get(session.guildId);
    const guild = interaction.guild || await client.guilds.fetch(session.guildId);
    const issuer = await guild.members.fetch(session.actorId);
    let member = null;
    let externalTarget = null;
    if (session.targetType === 'external') {
        externalTarget = getSessionTarget(session);
    } else {
        member = await guild.members.fetch(session.memberId).catch(() => null);
        if (!member) throw new DisciplineError('Сотрудник больше не находится на сервере.', 'member_not_found');
        disciplineService.assertMemberHasMainRole(member, config);
        const matches = getMemberRankMatches(member, config);
        if (matches.length > 1) throw new DisciplineError('У сотрудника найдено несколько ролей рангов.', 'target_multiple_ranks');
        if (session.detectedRankNumber && matches[0]?.number !== session.detectedRankNumber) {
            throw new DisciplineError('Ранг сотрудника изменился во время оформления. Начните заново.', 'target_rank_changed');
        }
        if (!session.detectedRankNumber && session.currentRankNumber && matches.length === 1 && matches[0].number !== session.currentRankNumber) {
            throw new DisciplineError(
                `Выбранный текущий ранг ${session.currentRankNumber} не совпадает с ролью ранга ${matches[0].number}.`,
                'target_rank_changed'
            );
        }
    }

    return disciplineService.issueCase(client, {
        guild,
        config,
        issuer,
        member,
        externalTarget,
        violationDate: session.details.violationDate,
        violatedRules: session.details.violatedRules,
        reason: session.details.reason,
        evidence: session.details.evidence,
        selection: aggregateSelection(session),
        methodAssignments: buildServiceMethodAssignments(session),
        currentRankNumber: session.detectedRankNumber || session.currentRankNumber,
        demotionRankNumber: session.demotionRankNumber,
        recertificationExamIds: session.recertificationExamIds,
    });
}

async function handleIssueInteraction(client, interaction, parsed) {
    const session = getIssueSession(parsed.sessionId);
    assertSessionOwner(session, interaction);
    const config = guildConfigService.get(session.guildId);
    disciplineService.assertFeatureEnabled(config);
    const guild = interaction.guild || await client.guilds.fetch(session.guildId);
    const member = session.targetType === 'member'
        ? await guild.members.fetch(session.memberId).catch(() => null)
        : null;
    if (session.targetType === 'member' && !member) {
        throw new DisciplineError('Сотрудник больше не находится на сервере.', 'member_not_found');
    }

    if (interaction.isModalSubmit() && parsed.action === 'details') {
        session.details = {
            violationDate: interaction.fields.getTextInputValue('violation_date').trim(),
            violatedRules: interaction.fields.getTextInputValue('violated_rules').trim(),
            reason: interaction.fields.getTextInputValue('reason').trim(),
            evidence: interaction.fields.getTextInputValue('evidence').trim(),
        };
        await deferReplyWithRetry(interaction, { flags: MessageFlags.Ephemeral });
        await editReplyWithRetry(interaction, buildSelectionPanel(session, config));
        return;
    }

    if (interaction.isStringSelectMenu()) {
        if (parsed.action === 'add_sanction') {
            addSanction(session, interaction.values[0]);
            session.status = null;
        } else if (parsed.action === 'current_rank') {
            session.currentRankNumber = Number(interaction.values[0]);
            if (session.demotionRankNumber >= session.currentRankNumber) session.demotionRankNumber = null;
        } else if (parsed.action === 'demotion_rank') {
            session.demotionRankNumber = Number(interaction.values[0]);
        } else if (parsed.action === 'recertification_exams') {
            session.recertificationExamIds = [...new Set(interaction.values)];
        } else if (parsed.action === 'method_same') {
            const methodId = interaction.values[0];
            for (const unit of getStageUnits(session, getDisciplineSettings(config))) {
                session.methodAssignments[unit.id] = methodId;
            }
        } else if (parsed.action === 'method_unit') {
            session.selectedUnitId = interaction.values[0];
        } else if (parsed.action === 'method_individual') {
            session.methodAssignments[session.selectedUnitId] = interaction.values[0];
        }
        await interaction.deferUpdate();
        const payload = parsed.action.startsWith('method_')
            ? buildMethodPanel(session, config, member)
            : buildSelectionPanel(session, config);
        await editReplyWithRetry(interaction, payload);
        return;
    }

    if (!interaction.isButton()) return;

    if (parsed.action === 'cancel') {
        issueSessions.delete(session.id);
        await interaction.deferUpdate();
        await editReplyWithRetry(interaction, { content: 'Оформление взыскания отменено.', components: [] });
        return;
    }

    if (parsed.action === 'remove_last') {
        session.selection.pop();
        if (!session.selection.some((unit) => unit.type === 'demotion')) session.demotionRankNumber = null;
        if (!session.selection.some((unit) => unit.type === 'recertification')) session.recertificationExamIds = [];
        session.willDismiss = false;
        await interaction.deferUpdate();
        await editReplyWithRetry(interaction, buildSelectionPanel(session, config));
        return;
    }

    if (parsed.action === 'selection_continue') {
        const settings = getDisciplineSettings(config);
        const outcome = disciplineService.previewSelectionOutcome(
            session.guildId,
            session.targetKey,
            aggregateSelection(session),
            settings
        );
        session.willDismiss = outcome.willDismiss;
        if (outcome.willDismiss && session.memberId) disciplineService.assertNoDismissalConflict(session.guildId, session.memberId);
        const units = getStageUnits(session, settings);
        if (units.length) {
            session.methodMode = units.length === 1 ? 'individual' : null;
            session.methodAssignments = {};
            session.selectedUnitId = units[0].id;
            await interaction.deferUpdate();
            await editReplyWithRetry(interaction, buildMethodPanel(session, config, member));
        } else {
            await interaction.deferUpdate();
            await editReplyWithRetry(interaction, buildConfirmationPanel(session, config, member));
        }
        return;
    }

    if (parsed.action === 'method_mode_same' || parsed.action === 'method_mode_individual') {
        session.methodMode = parsed.action.endsWith('same') ? 'same' : 'individual';
        session.methodAssignments = {};
        await interaction.deferUpdate();
        await editReplyWithRetry(interaction, buildMethodPanel(session, config, member));
        return;
    }

    if (parsed.action === 'methods_back') {
        await interaction.deferUpdate();
        await editReplyWithRetry(interaction, buildSelectionPanel(session, config));
        return;
    }

    if (parsed.action === 'methods_continue') {
        await interaction.deferUpdate();
        await editReplyWithRetry(interaction, buildConfirmationPanel(session, config, member));
        return;
    }

    if (parsed.action === 'confirm_back') {
        const units = getStageUnits(session, getDisciplineSettings(config));
        await interaction.deferUpdate();
        await editReplyWithRetry(interaction, units.length
            ? buildMethodPanel(session, config, member)
            : buildSelectionPanel(session, config));
        return;
    }

    if (parsed.action === 'confirm') {
        if (session.willDismiss && session.memberId) disciplineService.assertNoDismissalConflict(session.guildId, session.memberId);
        await interaction.deferUpdate();
        await editReplyWithRetry(interaction, {
            content: 'Оформляю взыскание…',
            components: [],
            temporary: false,
        });
        const result = await executeIssue(client, interaction, session);
        issueSessions.delete(session.id);
        const counts = result.counts || {};
        const threshold = result.thresholdDismissal?.operation?.uvalId
            ? `\nID увольнения: ${result.thresholdDismissal.operation.uvalId}`
            : '';
        await editReplyWithRetry(interaction, {
            content: [
                'Взыскание оформлено.',
                `ID дела: ${result.caseRecord.caseId}`,
                `Активно: беседы - ${counts.conversation || 0}, устные - ${counts.oral || 0}, письменные - ${counts.written || 0}.${threshold}`,
            ].join('\n'),
            components: [],
            allowedMentions: { parse: [] },
        });
    }
}

function buildPartSelect(session, sanction) {
    const parts = disciplineService.getPendingParts(sanction);
    return {
        content: 'Выберите часть отработки.',
        components: [new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(actionCustomId(session.id, 'part'))
                .setPlaceholder('Часть отработки')
                .addOptions([
                    { label: 'Все активные части', value: '__all__' },
                    ...parts.slice(0, 24).map((part, index) => ({
                        label: `${index + 1}. ${part.methodName}`.slice(0, 100),
                        description: `Срок: ${new Date(part.deadlineAt).toLocaleString('ru-RU', { timeZone: MOSCOW_TIME_ZONE })}`.slice(0, 100),
                        value: part.id,
                    })),
                ])
        )],
        flags: MessageFlags.Ephemeral,
        temporary: false,
    };
}

function buildMethodSelect(session, member, config, sanction) {
    const pendingParts = disciplineService.getPendingParts(sanction);
    const part = pendingParts.find((entry) => entry.id === session.partId);
    const methodLists = session.partId
        ? [disciplineService.getAvailableMethods(member, config, part?.stage || sanction.type)]
        : pendingParts.map((entry) => disciplineService.getAvailableMethods(member, config, entry.stage || sanction.type));
    const methods = methodLists.length
        ? methodLists[0].filter((method) => methodLists.every((list) => list.some((entry) => entry.id === method.id))).slice(0, 25)
        : [];
    return {
        content: 'Выберите новый способ отработки. Срок не изменится.',
        components: [new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(actionCustomId(session.id, 'method'))
                .setPlaceholder('Новый способ')
                .addOptions(methods.map((method) => ({ label: method.name.slice(0, 100), value: method.id })))
        )],
        temporary: false,
    };
}

function buildRemovalModal(session) {
    return new ModalBuilder()
        .setCustomId(actionCustomId(session.id, 'removal_modal'))
        .setTitle('Запрос на снятие')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('reason')
                    .setLabel('Причина снятия')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true)
                    .setMaxLength(1024)
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('proof')
                    .setLabel('Доказательства или ссылка')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true)
                    .setMaxLength(1024)
            )
        );
}


function buildRemovalRejectModal(requestId) {
    return new ModalBuilder()
        .setCustomId(`disciplineRemovalReject:${requestId}`)
        .setTitle('Отклонение запроса на снятие')
        .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('reason')
                .setLabel('Причина отклонения')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMaxLength(1024)
        ));
}

function buildExtendModal(session) {
    return new ModalBuilder()
        .setCustomId(actionCustomId(session.id, 'extend_modal'))
        .setTitle('Продление срока')
        .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('days')
                .setLabel('Количество дополнительных дней')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(3)
                .setPlaceholder('Например: 2')
        ));
}

async function openAction(client, interaction, parsed) {
    const caseRecord = await disciplineService.fetchCase(parsed.caseId);
    if (!caseRecord || String(caseRecord.guildId) !== String(interaction.guildId)) {
        throw new DisciplineError('Дисциплинарное дело не найдено.', 'case_not_found');
    }
    const sanction = disciplineService.findSanction(caseRecord, parsed.sanctionId);
    if (!sanction || sanction.status !== 'active') throw new DisciplineError('Активное взыскание не найдено.', 'sanction_not_active');
    const guild = interaction.guild || await client.guilds.fetch(interaction.guildId);
    const member = caseRecord.memberId
        ? await guild.members.fetch(caseRecord.memberId).catch(() => null)
        : null;
    if (caseRecord.memberId && !member) throw new DisciplineError('Сотрудник не найден на сервере.', 'member_not_found');
    const actor = await guild.members.fetch(interaction.user.id);
    const config = guildConfigService.get(interaction.guildId);
    if (parsed.action === 'remove') disciplineService.assertCanRequestRemoval(actor, caseRecord, config);
    else disciplineService.assertCanManageSanction(actor, caseRecord, config);
    const parts = disciplineService.getPendingParts(sanction);
    if (parsed.action !== 'remove' && !parts.length) throw new DisciplineError('У взыскания нет активной отработки.', 'no_pending_workoff');

    const session = {
        id: createId(),
        guildId: interaction.guildId,
        actorId: interaction.user.id,
        caseId: parsed.caseId,
        sanctionId: parsed.sanctionId,
        action: parsed.action,
        partId: parts.length === 1 ? parts[0].id : null,
        updatedAt: Date.now(),
    };
    actionSessions.set(session.id, session);

    if (parts.length > 1) {
        await replyWithRetry(interaction, buildPartSelect(session, sanction));
        return;
    }
    if (parsed.action === 'remove') {
        await showModalWithRetry(interaction, buildRemovalModal(session), { attempts: 1 });
        return;
    }
    if (parsed.action === 'extend') {
        await showModalWithRetry(interaction, buildExtendModal(session), { attempts: 1 });
        return;
    }
    await replyWithRetry(interaction, {
        ...buildMethodSelect(session, member, config, sanction),
        flags: MessageFlags.Ephemeral,
    });
}

async function handleActionInteraction(client, interaction, parsed) {
    const session = getActionSession(parsed.sessionId);
    assertSessionOwner(session, interaction);
    const caseRecord = await disciplineService.fetchCase(session.caseId);
    const sanction = disciplineService.findSanction(caseRecord, session.sanctionId);
    if (!caseRecord || !sanction) throw new DisciplineError('Взыскание не найдено.', 'sanction_not_found');
    const guild = interaction.guild || await client.guilds.fetch(interaction.guildId);
    const actor = await guild.members.fetch(interaction.user.id);
    const member = caseRecord.memberId
        ? await guild.members.fetch(caseRecord.memberId).catch(() => null)
        : null;
    const config = guildConfigService.get(interaction.guildId);

    if (interaction.isStringSelectMenu() && parsed.action === 'part') {
        session.partId = interaction.values[0] === '__all__' ? null : interaction.values[0];
        if (session.action === 'remove') {
            await showModalWithRetry(interaction, buildRemovalModal(session), { attempts: 1 });
        } else if (session.action === 'extend') {
            await showModalWithRetry(interaction, buildExtendModal(session), { attempts: 1 });
        } else {
            await interaction.deferUpdate();
            await editReplyWithRetry(interaction, buildMethodSelect(session, member, config, sanction));
        }
        return;
    }

    if (interaction.isStringSelectMenu() && parsed.action === 'method') {
        await interaction.deferUpdate();
        await disciplineService.changeWorkoffMethod(client, {
            guild,
            actor,
            caseId: session.caseId,
            sanctionId: session.sanctionId,
            partId: session.partId,
            methodId: interaction.values[0],
        });
        actionSessions.delete(session.id);
        await editReplyWithRetry(interaction, { content: 'Способ отработки изменён. Срок сохранён.', components: [] });
        return;
    }

    if (interaction.isModalSubmit() && parsed.action === 'extend_modal') {
        await deferReplyWithRetry(interaction, { flags: MessageFlags.Ephemeral });
        const days = Number(interaction.fields.getTextInputValue('days').trim());
        await disciplineService.extendWorkoffDeadline(client, {
            guild,
            actor,
            caseId: session.caseId,
            sanctionId: session.sanctionId,
            partId: session.partId,
            days,
        });
        actionSessions.delete(session.id);
        await editReplyWithRetry(interaction, { content: `Срок продлён на ${days} дн.`, components: [] });
        return;
    }

    if (interaction.isModalSubmit() && parsed.action === 'removal_modal') {
        await deferReplyWithRetry(interaction, { flags: MessageFlags.Ephemeral });
        const request = await disciplineService.createRemovalRequest(client, {
            guild,
            requester: actor,
            caseId: session.caseId,
            sanctionId: session.sanctionId,
            partId: session.partId,
            reason: interaction.fields.getTextInputValue('reason').trim(),
            proof: interaction.fields.getTextInputValue('proof').trim(),
        });
        actionSessions.delete(session.id);
        await editReplyWithRetry(interaction, {
            content: `Запрос на снятие создан. ID: ${request.requestId}`,
            components: [],
        });
    }
}

async function handleRemovalDecision(client, interaction, parsed) {
    if (parsed.action === 'reject') {
        await showModalWithRetry(interaction, buildRemovalRejectModal(parsed.requestId), { attempts: 1 });
        return;
    }
    await interaction.deferUpdate();
    const guild = interaction.guild || await client.guilds.fetch(interaction.guildId);
    const approver = await guild.members.fetch(interaction.user.id);
    await disciplineService.handleRemovalDecision(client, {
        guild,
        approver,
        requestId: parsed.requestId,
        approve: true,
        message: interaction.message,
    });
    await followUpWithRetry(interaction, {
        content: 'Снятие одобрено.',
        flags: MessageFlags.Ephemeral,
    });
}

async function handleRemovalReject(client, interaction, parsed) {
    await deferReplyWithRetry(interaction, { flags: MessageFlags.Ephemeral });
    const guild = interaction.guild || await client.guilds.fetch(interaction.guildId);
    const approver = await guild.members.fetch(interaction.user.id);
    await disciplineService.handleRemovalDecision(client, {
        guild,
        approver,
        requestId: parsed.requestId,
        approve: false,
        rejectionReason: interaction.fields.getTextInputValue('reason').trim(),
        message: interaction.message,
    });
    await editReplyWithRetry(interaction, {
        content: 'Снятие отклонено.',
        components: [],
    });
}

function buildExternalLinkModal(caseId) {
    return new ModalBuilder()
        .setCustomId(`disciplineExternalLink:${caseId}`)
        .setTitle('Привязка Discord')
        .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('discord_id')
                .setLabel('Discord ID сотрудника')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMinLength(17)
                .setMaxLength(20)
                .setPlaceholder('1153405398771060739')
        ));
}

function buildExternalLinkPreviewPayload(session) {
    const preview = session.preview;
    const memberName = preview.member.displayName || preview.member.user?.username || preview.member.id;
    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('Подтверждение привязки Discord')
        .setDescription([
            `Внешний сотрудник: ${preview.displayName} | ${preview.staticId}`,
            `Discord: <@${preview.member.id}> | ${memberName} | ||${preview.member.id}||`,
            '',
            `Будут привязаны дисциплинарные дела: ${preview.caseCount}`,
            `Активные взыскания: ${preview.activeSanctionCount}`,
            `Активные части отработки: ${preview.pendingWorkoffCount}`,
            `Активные переаттестации: ${preview.activeRecertificationCount}`,
            '',
            preview.alreadyLinked
                ? 'Discord уже привязан. Будет повторена синхронизация ролей и сообщений.'
                : 'Взыскания не будут выданы повторно, а иерархия задним числом не проверяется.',
        ].join('\n').slice(0, 4096));
    return {
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`disciplineExternalConfirm:${session.id}:confirm`)
                .setLabel('Привязать')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`disciplineExternalConfirm:${session.id}:cancel`)
                .setLabel('Отмена')
                .setStyle(ButtonStyle.Secondary),
        )],
        allowedMentions: { parse: [] },
        temporary: false,
    };
}

async function handleExternalLinkStart(interaction, parsed) {
    await showModalWithRetry(interaction, buildExternalLinkModal(parsed.caseId), { attempts: 1 });
}

async function handleExternalLinkModal(client, interaction, parsed) {
    const memberId = interaction.fields.getTextInputValue('discord_id').trim();
    if (!/^\d{17,20}$/.test(memberId)) {
        throw new DisciplineError('Discord ID должен содержать от 17 до 20 цифр.', 'external_link_id_invalid');
    }
    await deferReplyWithRetry(interaction, { flags: MessageFlags.Ephemeral });
    const guild = interaction.guild || await client.guilds.fetch(interaction.guildId);
    const actor = await guild.members.fetch(interaction.user.id);
    const preview = await disciplineService.getExternalLinkPreview({
        guild,
        actor,
        caseId: parsed.caseId,
        memberId,
    });
    const session = {
        id: createId(),
        guildId: String(interaction.guildId),
        actorId: String(interaction.user.id),
        caseId: parsed.caseId,
        memberId,
        preview,
        updatedAt: Date.now(),
    };
    externalLinkSessions.set(session.id, session);
    await editReplyWithRetry(interaction, buildExternalLinkPreviewPayload(session));
}

async function handleExternalLinkConfirm(client, interaction, parsed) {
    const session = getExternalLinkSession(parsed.sessionId);
    assertSessionOwner(session, interaction);
    await interaction.deferUpdate();
    if (parsed.action === 'cancel') {
        externalLinkSessions.delete(session.id);
        await editReplyWithRetry(interaction, { content: 'Привязка Discord отменена.', embeds: [], components: [] });
        return;
    }
    const guild = interaction.guild || await client.guilds.fetch(interaction.guildId);
    const actor = await guild.members.fetch(interaction.user.id);
    const result = await disciplineService.linkExternalTarget(client, {
        guild,
        actor,
        caseId: session.caseId,
        memberId: session.memberId,
    });
    externalLinkSessions.delete(session.id);
    await editReplyWithRetry(interaction, {
        content: [
            result.alreadyLinked ? 'Синхронизация привязки Discord повторена.' : 'Discord привязан.',
            `Обновлено дисциплинарных дел: ${result.affectedCaseIds.length}.`,
            ...(result.warnings || []).map((warning) => `⚠️ ${warning}`),
        ].join('\n'),
        embeds: [],
        components: [],
        allowedMentions: { parse: [] },
    });
}

async function handle(client, interaction) {
    const parsed = parseCustomId(interaction.customId);
    if (!parsed) return false;
    try {
        if (parsed.kind === 'issue') await handleIssueInteraction(client, interaction, parsed);
        else if (parsed.kind === 'sanction') await openAction(client, interaction, parsed);
        else if (parsed.kind === 'action') await handleActionInteraction(client, interaction, parsed);
        else if (parsed.kind === 'removal') await handleRemovalDecision(client, interaction, parsed);
        else if (parsed.kind === 'removalReject') await handleRemovalReject(client, interaction, parsed);
        else if (parsed.kind === 'externalLink') await handleExternalLinkStart(interaction, parsed);
        else if (parsed.kind === 'externalLinkModal') await handleExternalLinkModal(client, interaction, parsed);
        else if (parsed.kind === 'externalLinkConfirm') await handleExternalLinkConfirm(client, interaction, parsed);
        return true;
    } catch (error) {
        logger[error instanceof DisciplineError ? 'warn' : 'error']('Ошибка интерфейса взысканий', {
            guildId: interaction.guildId,
            userId: interaction.user?.id,
            customId: interaction.customId,
        }, error);
        const content = buildPublicErrorMessage(error, 'Не удалось выполнить действие со взысканием.');
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
    handle,
    startIssue,
};
