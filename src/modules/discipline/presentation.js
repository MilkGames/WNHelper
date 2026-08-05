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
    EmbedBuilder,
} = require('discord.js');
const { DISCIPLINE_STAGE_LABELS } = require('./settings/schema');
const { getDefaultFooter } = require('../../core/ui/defaultFooter');
const targetService = require('./targetService');

function createDisciplinePresentation({ findTransferredSanctionLink }) {
    function buildSanctionComponents(caseRecord, sanction, {
        includeExternalLink = false,
        appealsEnabled = false,
    } = {}) {
        const buttons = [];
        if (sanction && sanction.status === 'active') {
            const hasPendingParts = (sanction.workoffParts || []).some((part) => part.status === 'pending');
            buttons.push(
                new ButtonBuilder()
                    .setCustomId(`discipline:remove:${caseRecord.caseId}:${sanction.id}`)
                    .setLabel('Запросить снятие')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`discipline:method:${caseRecord.caseId}:${sanction.id}`)
                    .setLabel('Изменить способ')
                    .setStyle(ButtonStyle.Primary)
                    .setDisabled(!hasPendingParts),
                new ButtonBuilder()
                    .setCustomId(`discipline:extend:${caseRecord.caseId}:${sanction.id}`)
                    .setLabel('Продлить срок')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(!hasPendingParts),
            );
        }
        if (appealsEnabled && caseRecord?.memberId && sanction?.status === 'active') {
            buttons.push(
                new ButtonBuilder()
                    .setCustomId(`disciplineAppeal:start:${caseRecord.caseId}:${sanction.id}`)
                    .setLabel('Обжаловать')
                    .setStyle(ButtonStyle.Secondary)
            );
        }
        if (includeExternalLink && caseRecord?.targetType === 'external' && !caseRecord.memberId) {
            buttons.push(
                new ButtonBuilder()
                    .setCustomId(`disciplineExternal:link:${caseRecord.caseId}`)
                    .setLabel('Привязать Discord')
                    .setStyle(ButtonStyle.Secondary)
            );
        }
        return buttons.length ? [new ActionRowBuilder().addComponents(buttons.slice(0, 5))] : [];
    }

    function buildCaseComponents(caseRecord) {
        if (caseRecord?.targetType !== 'external' || caseRecord.memberId) return [];
        return [new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`disciplineExternal:link:${caseRecord.caseId}`)
                .setLabel('Привязать Discord')
                .setStyle(ButtonStyle.Secondary)
        )];
    }

    function formatWorkoffParts(sanction) {
        const parts = sanction.workoffParts || [];
        if (!parts.length) return 'Отработка не назначена.';
        return parts.map((part, index) => {
            let status;
            if (part.status === 'completed') {
                status = '✅ выполнено';
            } else if (part.status === 'transferred') {
                const link = findTransferredSanctionLink(part.transferredToSanctionId);
                status = link
                    ? `↪️ перенесено во взыскание: ${link}`
                    : `↪️ перенесено во взыскание ${part.transferredToSanctionId || 'неизвестно'}`;
            } else if (part.status === 'closed_by_overdue_replacement') {
                status = '♻️ закрыто заменой взыскания';
            } else if (part.status === 'cancelled_by_appeal') {
                status = '❌ отменено после удовлетворения обжалования';
            } else {
                status = `до <t:${Math.floor(part.deadlineAt / 1000)}:f>`;
            }
            return `${index + 1}. ${part.methodName} - ${status}`;
        }).join('\n').slice(0, 1024);
    }

    function formatMemberIdentity(memberId, displayName) {
        const id = String(memberId || '').trim();
        const name = String(displayName || id || 'неизвестно').trim();
        return id ? `<@${id}> | ${name} | ||${id}||` : name;
    }

    function formatCaseTargetIdentity(caseRecord) {
        return targetService.formatTarget(targetService.targetFromCase(caseRecord));
    }

    function addEmbedMetadata(embed, values) {
        const metadata = values.filter(Boolean).join(' • ');
        if (!metadata) return embed;

        const line = `-# ${metadata}`.slice(0, 1023);
        const fields = Array.isArray(embed.data?.fields)
            ? embed.data.fields.map((field) => ({ ...field }))
            : [];

        if (fields.length) {
            const last = fields[fields.length - 1];
            const current = String(last.value || '');
            const separator = current ? '\n' : '';
            const available = 1024 - separator.length - line.length;
            if (current.length <= available) {
                last.value = `${current}${separator}${line}`;
            } else {
                const ellipsis = available >= 1 ? '…' : '';
                const contentLimit = Math.max(0, available - ellipsis.length);
                last.value = `${current.slice(0, contentLimit)}${ellipsis}${separator}${line}`;
            }
            embed.setFields(fields);
            return embed;
        }

        const description = String(embed.data?.description || '');
        const separator = description ? '\n' : '';
        const available = 4096 - separator.length - line.length;
        if (description.length <= available) {
            embed.setDescription(`${description}${separator}${line}`);
            return embed;
        }
        const ellipsis = available >= 1 ? '…' : '';
        const contentLimit = Math.max(0, available - ellipsis.length);
        embed.setDescription(`${description.slice(0, contentLimit)}${ellipsis}${separator}${line}`);
        return embed;
    }

    function getSanctionLabel(sanction) {
        if (DISCIPLINE_STAGE_LABELS[sanction.type]) return DISCIPLINE_STAGE_LABELS[sanction.type];
        if (sanction.type === 'demotion') {
            return sanction.targetRankNumber
                ? `Понижение до ${sanction.targetRankNumber} ранга`
                : 'Понижение на один ранг';
        }
        if (sanction.type === 'recertification') return 'Переаттестация';
        if (sanction.type === 'dismissal_blacklist') return 'Увольнение с ЧС';
        if (sanction.type === 'dismissal') return 'Увольнение';
        return 'Неизвестное взыскание';
    }

    function formatRecertificationExams(sanction) {
        const exams = Array.isArray(sanction.recertificationExams) ? sanction.recertificationExams : [];
        if (!exams.length) return 'Экзамены не указаны.';
        return exams.map((exam) => {
            const status = exam.status === 'passed'
                ? '✅ сдан'
                : exam.status === 'failed'
                    ? '❌ не сдан'
                    : '⏳ ожидается';
            return `• ${exam.examName || exam.examId} - ${status}`;
        }).join('\n').slice(0, 1024);
    }

    function formatRecertificationAction(action) {
        return ({
            none: 'Без дополнительного действия',
            add_written: 'Выдать письменный выговор',
            dismiss: 'Уволить',
            dismiss_blacklist: 'Уволить с ЧС',
        })[action] || 'Неизвестное действие';
    }

    function buildSanctionEmbed(caseRecord, sanction) {
        const statusLabels = {
            active: 'Активно',
            converted: 'Преобразовано',
            resolved: 'Снято',
            expired: 'Истекло автоматически',
            completed: 'Выполнено',
            failed: 'Ошибка выполнения',
            dismissal_pending: 'Ожидает увольнения',
            rejected: 'Увольнение отклонено',
            replacement_pending: 'Заменяется из-за просрочки',
            replaced_overdue: 'Заменено из-за просрочки',
            closed_by_dismissal: 'Закрыто увольнением',
            annulled: 'Аннулировано по результатам обжалования',
        };
        const issuerId = sanction.issuerId || caseRecord.issuerId;
        const issuerName = sanction.issuerDisplayName || caseRecord.issuerDisplayName;
        const statusLabel = sanction.type === 'demotion' && sanction.executionMode === 'external_record' && sanction.status === 'completed'
            ? 'Оформлено'
            : statusLabels[sanction.status] || 'Неизвестный статус';
        const embed = new EmbedBuilder()
            .setColor(
                sanction.type === 'written' ? 0xE74C3C :
                    sanction.type === 'oral' ? 0xF39C12 :
                        sanction.type === 'recertification' ? 0x9B59B6 : 0x3498DB
            )
            .setTitle(`Взыскание • ${getSanctionLabel(sanction)}`)
            .addFields(
                { name: 'Сотрудник', value: formatCaseTargetIdentity(caseRecord) },
                { name: 'Выдал(-а)', value: formatMemberIdentity(issuerId, issuerName) },
                { name: 'Дата нарушения', value: caseRecord.violationDate, inline: true },
                { name: 'Статус', value: statusLabel, inline: true },
                ...(sanction.appealMessageLink ? [{
                    name: 'Обжалование',
                    value: sanction.appealStatusLabel
                        ? `[${sanction.appealStatusLabel}](${sanction.appealMessageLink})`
                        : sanction.appealMessageLink,
                }] : []),
                { name: 'Нарушенные пункты', value: caseRecord.violatedRules.slice(0, 1024) },
                { name: 'Причина', value: caseRecord.reason.slice(0, 1024) },
            )
            .setFooter(getDefaultFooter())
            .setTimestamp(sanction.createdAt || caseRecord.createdAt);
        if (sanction.type === 'demotion' && sanction.executionMode === 'external_record') {
            embed.addFields({ name: 'Применение', value: 'Без изменения Discord-роли: сотрудник находится вне сервера.' });
        }
        if (['conversation', 'oral', 'written'].includes(sanction.type) && (sanction.workoffParts || []).length) {
            embed.addFields({ name: 'Отработка', value: formatWorkoffParts(sanction) });
        }
        if (sanction.type === 'recertification') {
            embed.addFields(
                { name: 'Экзамены переаттестации', value: formatRecertificationExams(sanction) },
                {
                    name: 'Срок',
                    value: sanction.deadlineAt ? `<t:${Math.floor(sanction.deadlineAt / 1000)}:f>` : 'не указан',
                    inline: true,
                },
                { name: 'При просрочке', value: formatRecertificationAction(sanction.expiryAction), inline: true }
            );
        }
        if (sanction.conversionTargetId) {
            const targetLink = findTransferredSanctionLink(sanction.conversionTargetId);
            embed.addFields({
                name: 'Преобразование',
                value: targetLink
                    ? `Включено во взыскание: ${targetLink}`
                    : `Включено во взыскание ${sanction.conversionTargetId}`,
            });
        }
        return addEmbedMetadata(embed, [
            `Дело: "${caseRecord.caseId}"`,
            `Взыскание: "${sanction.id}"`,
        ]);
    }

    function buildCombinedSanctionEmbed(caseRecord, sanction) {
        return buildSanctionEmbed(caseRecord, sanction)
            .setTitle(`Дисциплинарное дело • ${getSanctionLabel(sanction)}`)
            .setFooter(getDefaultFooter());
    }

    function buildCaseEmbed(caseRecord) {
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('Дисциплинарное дело')
            .addFields(
                { name: 'Сотрудник', value: formatCaseTargetIdentity(caseRecord) },
                { name: 'Инициатор', value: formatMemberIdentity(caseRecord.issuerId, caseRecord.issuerDisplayName) },
                { name: 'Дата нарушения', value: caseRecord.violationDate, inline: true },
                { name: 'Нарушенные пункты', value: caseRecord.violatedRules.slice(0, 1024) },
                { name: 'Причина', value: caseRecord.reason.slice(0, 1024) },
            )
            .setTimestamp(caseRecord.createdAt)
            .setFooter(getDefaultFooter());
        return addEmbedMetadata(embed, [`Дело: "${caseRecord.caseId}"`]);
    }

    function buildRemovalRequestEmbed(request, caseRecord, sanction, identities, {
        workoffMethods = null,
        sanctionMessageLink,
    } = {}) {
        const embed = new EmbedBuilder()
            .setColor(0x2ECC71)
            .setTitle('Запрос на снятие взыскания')
            .addFields(
                { name: 'Сотрудник', value: identities.member },
                { name: 'Запросил(-а)', value: identities.requester },
                { name: 'Выдал(-а) взыскание', value: identities.issuer },
                { name: 'Взыскание', value: getSanctionLabel(sanction), inline: true },
            );
        if (workoffMethods) embed.addFields({ name: 'Способ отработки', value: workoffMethods });
        embed.addFields(
            { name: 'Причина', value: request.reason.slice(0, 1024) },
            { name: 'Выдача взыскания', value: sanctionMessageLink },
        );
        addEmbedMetadata(embed, [
            `Запрос: "${request.requestId}"`,
            `Дело: "${caseRecord.caseId}"`,
            `Взыскание: "${sanction.id}"`,
        ]);
        return embed.setFooter(getDefaultFooter()).setTimestamp(request.createdAt);
    }

    function buildRemovalRequestComponents(requestId) {
        return [new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`disciplineRemoval:approve:${requestId}`)
                .setLabel('Одобрить')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`disciplineRemoval:reject:${requestId}`)
                .setLabel('Отклонить')
                .setStyle(ButtonStyle.Danger),
        )];
    }

    return {
        addEmbedMetadata,
        buildCaseComponents,
        buildCaseEmbed,
        buildCombinedSanctionEmbed,
        buildRemovalRequestComponents,
        buildRemovalRequestEmbed,
        buildSanctionComponents,
        buildSanctionEmbed,
        formatCaseTargetIdentity,
        formatMemberIdentity,
        formatRecertificationAction,
        formatRecertificationExams,
        formatWorkoffParts,
        getSanctionLabel,
    };
}

module.exports = {
    createDisciplinePresentation,
};
