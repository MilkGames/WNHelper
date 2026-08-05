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
    EmbedBuilder,
    StringSelectMenuBuilder,
} = require('discord.js');
const { getDefaultFooter } = require('../../core/ui/defaultFooter');

function uniq(values) {
    return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
}

function createShiftPresentation({ getCurrentAccessState, normalizeShiftType, renderShiftHeader }) {
    function formatRoleMentions(roleIds, limit = 4) {
        const unique = uniq(roleIds);
        if (!unique.length) return 'без ролей';
        const shown = unique.slice(0, limit).map((roleId) => `<@&${roleId}>`).join(' ');
        return unique.length > limit ? `${shown} и ещё ${unique.length - limit}` : shown;
    }

    function formatGroup(group) {
        return `**${group.name}** (${formatRoleMentions(group.roleIds)})`;
    }

    function buildAccessLines(shiftType, record, nowMs = Date.now()) {
        const access = getCurrentAccessState(shiftType, record, nowMs);
        if (access.unrestricted) {
            return ['Доступ к выбору смен открыт всем участникам сервера.'];
        }

        const lines = [];
        if (shiftType.rotateAccessDaily && access.firstGroup) {
            lines.push(`Сегодня первой получает доступ группа ${formatGroup(access.firstGroup)}.`);
        }

        if (access.stageIndex < 0) {
            const eta = access.nextStage
                ? Math.max(0, access.nextStage.delayMinutes - access.elapsedMinutes)
                : null;
            lines.push('Выбор смен пока закрыт.');
            if (access.nextStage) {
                lines.push(`Первый доступ через ~${eta} мин: ${formatGroup(access.nextStage.addedGroup)}.`);
            }
            return lines;
        }

        const shownGroups = access.currentGroups.slice(0, 6).map(formatGroup);
        const hiddenGroupCount = access.currentGroups.length - shownGroups.length;
        lines.push(
            `Сейчас доступ открыт для: ${shownGroups.join(', ')}` +
            `${hiddenGroupCount > 0 ? ` и ещё ${hiddenGroupCount} групп` : ''}.`
        );
        if (access.nextStage) {
            const eta = Math.max(0, access.nextStage.delayMinutes - access.elapsedMinutes);
            lines.push(`Следующее расширение через ~${eta} мин: ${formatGroup(access.nextStage.addedGroup)}.`);
        }
        return lines;
    }

    function packEmbedLines(lines, maxLength = 3_500) {
        const chunks = [];
        let current = [];
        let currentLength = 0;

        for (const rawLine of lines) {
            const line = String(rawLine ?? '');
            const extraLength = line.length + (current.length ? 1 : 0);
            if (current.length && currentLength + extraLength > maxLength) {
                chunks.push(current.join('\n'));
                current = [];
                currentLength = 0;
            }
            current.push(line);
            currentLength += line.length + (current.length > 1 ? 1 : 0);
        }

        if (current.length) chunks.push(current.join('\n'));
        return chunks.length ? chunks : [''];
    }

    function buildScheduleEmbeds(shiftType, record, nowMs = Date.now()) {
        const type = normalizeShiftType(shiftType);
        const slotLines = record.slots.map((slot) => {
            const display = slot.memberId ? `<@${slot.memberId}>` : 'Свободно';
            return `${slot.number}) ${slot.startTime}-${slot.endTime}: ${display}`;
        });
        const managerLine = type.managerRoleIds.length
            ? `Освободить чужую смену могут: ${formatRoleMentions(type.managerRoleIds, 10)}.`
            : 'Освобождать чужие смены никто не может.';
        const statusLine = record.status === 'active'
            ? null
            : 'Расписание закрыто. Список выбора больше не активен.';

        const lines = [
            renderShiftHeader(type, record.dateKey),
            '',
            ...slotLines,
            '',
            '**Выберите нужную смену в списке ниже. Повторный выбор своей смены освобождает её.**',
            type.maxSlotsPerMember > 0
                ? `Максимум смен на одного сотрудника: ${type.maxSlotsPerMember}.`
                : 'Количество смен на одного сотрудника не ограничено.',
            managerLine,
            '',
            ...buildAccessLines(type, record, nowMs),
            ...(statusLine ? ['', statusLine] : []),
        ];

        const descriptions = packEmbedLines(lines);
        return descriptions.map((description, index) => {
            const embed = new EmbedBuilder()
                .setColor(type.color)
                .setDescription(description);
            if (index === 0) embed.setTitle(type.name);
            if (index === descriptions.length - 1) {
                embed.setFooter(getDefaultFooter());
            }
            return embed;
        });
    }

    function buildScheduleEmbed(shiftType, record, nowMs = Date.now()) {
        return buildScheduleEmbeds(shiftType, record, nowMs)[0];
    }

    function buildScheduleComponents(shiftType, record) {
        const disabled = record.status !== 'active';
        const rows = [];
        for (let index = 0; index < record.slots.length; index += 25) {
            const slots = record.slots.slice(index, index + 25);
            const first = slots[0]?.number;
            const last = slots.at(-1)?.number;
            const menu = new StringSelectMenuBuilder()
                .setCustomId(`shift:${shiftType.id}:${Math.floor(index / 25)}`)
                .setPlaceholder(`Выберите смену ${first}-${last}`)
                .setMinValues(1)
                .setMaxValues(1)
                .setDisabled(disabled)
                .addOptions(slots.map((slot) => ({
                    label: `${slot.number}. ${slot.startTime}-${slot.endTime}`.slice(0, 100),
                    description: slot.memberId ? 'Занято' : 'Свободно',
                    value: slot.id,
                })));
            rows.push(new ActionRowBuilder().addComponents(menu));
        }
        return rows;
    }

    function buildSchedulePayload(shiftType, record, nowMs = Date.now()) {
        return {
            content: '',
            embeds: buildScheduleEmbeds(shiftType, record, nowMs),
            components: buildScheduleComponents(shiftType, record),
            allowedMentions: { parse: [] },
        };
    }

    return {
        buildAccessLines,
        buildScheduleComponents,
        buildScheduleEmbed,
        buildScheduleEmbeds,
        buildSchedulePayload,
    };
}

module.exports = {
    createShiftPresentation,
};
