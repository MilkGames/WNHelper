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
    MAX_SHIFT_SLOTS,
    PUBLICATION_MODES,
    getShiftSlotCount,
    normalizeColor: normalizeShiftColor,
    normalizeTime: normalizeShiftTime,
} = require('./schema');
function createShiftSettingsModalHandlers({
    SHIFT_ACCESS_GROUP_PAGE_SIZE,
    SHIFT_TYPE_PAGE_SIZE,
    acknowledgePanelInteraction,
    configSessionService,
    generateShiftAccessGroupId,
    generateShiftTypeId,
    getShiftType,
    parseNonNegativeInteger,
    parsePositiveInteger,
    parseShiftAccessReference,
    updatePanel,
}) {
    async function handleShiftTypeModal(client, interaction, session, parsed) {
        await acknowledgePanelInteraction(interaction);
        const name = interaction.fields.getTextInputValue('name').trim();
        const colorRaw = interaction.fields.getTextInputValue('color').trim();
        const currentShiftType = parsed.value && parsed.value !== 'new'
            ? getShiftType(session, parsed.value)
            : null;
        const publicationMode = currentShiftType?.publication?.mode === PUBLICATION_MODES.RANDOM
            ? PUBLICATION_MODES.RANDOM
            : PUBLICATION_MODES.FIXED;
        const publicationTimeRaw = publicationMode === PUBLICATION_MODES.FIXED
            ? interaction.fields.getTextInputValue('publicationTime').trim()
            : null;
        const publicationFromTimeRaw = publicationMode === PUBLICATION_MODES.RANDOM
            ? interaction.fields.getTextInputValue('publicationFromTime').trim()
            : null;
        const publicationToTimeRaw = publicationMode === PUBLICATION_MODES.RANDOM
            ? interaction.fields.getTextInputValue('publicationToTime').trim()
            : null;
        const maxSlotsPerMember = parseNonNegativeInteger(
            interaction.fields.getTextInputValue('maxSlotsPerMember')
        );
        const errors = [];
        const color = /^#?[0-9A-F]{6}$/i.test(colorRaw)
            ? normalizeShiftColor(colorRaw)
            : null;
        const publicationTime = publicationMode === PUBLICATION_MODES.FIXED
            ? normalizeShiftTime(publicationTimeRaw, null)
            : null;
        const publicationFromTime = publicationMode === PUBLICATION_MODES.RANDOM
            ? normalizeShiftTime(publicationFromTimeRaw, null)
            : null;
        const publicationToTime = publicationMode === PUBLICATION_MODES.RANDOM
            ? normalizeShiftTime(publicationToTimeRaw, null)
            : null;

        if (!name) errors.push('Название смен не может быть пустым.');
        if (!color) errors.push('Цвет должен быть указан в формате #RRGGBB.');
        if (publicationMode === PUBLICATION_MODES.FIXED && !publicationTime) {
            errors.push('Время публикации должно быть указано в формате HH:mm.');
        }
        if (publicationMode === PUBLICATION_MODES.RANDOM && (!publicationFromTime || !publicationToTime)) {
            errors.push('Границы случайной публикации должны быть указаны в формате HH:mm.');
        }
        if (maxSlotsPerMember === null || maxSlotsPerMember > MAX_SHIFT_SLOTS) {
            errors.push(`Лимит смен должен быть целым числом от 0 до ${MAX_SHIFT_SLOTS}.`);
        }

        const duplicate = (session.draft.shiftTypes || []).find((type) => (
            type.id !== parsed.value &&
            type.name.toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru')
        ));
        if (duplicate) errors.push(`Расписание смен с названием "${name}" уже существует.`);

        configSessionService.setSection(session, 'shiftTypes');
        if (errors.length) {
            configSessionService.setErrors(session, errors);
            await updatePanel(client, interaction, session);
            return;
        }

        if (parsed.value && parsed.value !== 'new') {
            const shiftType = getShiftType(session, parsed.value);
            if (!shiftType) {
                configSessionService.setErrors(session, ['Расписание смен больше не существует в текущей сессии.']);
                await updatePanel(client, interaction, session);
                return;
            }
            shiftType.name = name;
            shiftType.color = color;
            shiftType.publication = publicationMode === PUBLICATION_MODES.RANDOM
                ? {
                    mode: PUBLICATION_MODES.RANDOM,
                    fromTime: publicationFromTime,
                    toTime: publicationToTime,
                }
                : {
                    mode: PUBLICATION_MODES.FIXED,
                    time: publicationTime,
                };
            shiftType.maxSlotsPerMember = maxSlotsPerMember;
            session.selectedShiftTypeId = shiftType.id;
            configSessionService.markChanged(session, `Смены "${name}" изменены.`);
        } else {
            const shiftType = {
                id: generateShiftTypeId(session),
                name,
                headerTemplate: '✅ {name} на {date}:',
                enabled: true,
                channelId: null,
                color,
                publication: {
                    mode: PUBLICATION_MODES.FIXED,
                    time: publicationTime,
                },
                schedule: {
                    startTime: '10:00',
                    endTime: '23:00',
                    slotDurationMinutes: 60,
                },
                maxSlotsPerMember,
                rotateAccessDaily: false,
                accessGroups: [],
                managerRoleIds: [],
            };
            session.draft.shiftTypes.push(shiftType);
            session.selectedShiftTypeId = shiftType.id;
            session.selectedShiftAccessGroupId = null;
            session.shiftTypePage = Math.floor((session.draft.shiftTypes.length - 1) / SHIFT_TYPE_PAGE_SIZE);
            configSessionService.markChanged(session, `Смены "${name}" добавлены.`);
        }
        await updatePanel(client, interaction, session);
    }

    async function handleShiftScheduleModal(client, interaction, session, parsed) {
        await acknowledgePanelInteraction(interaction);
        const shiftType = getShiftType(session, parsed.value);
        configSessionService.setSection(session, 'shiftSchedule');
        if (!shiftType) {
            configSessionService.setErrors(session, ['Расписание смен больше не существует в текущей сессии.']);
            await updatePanel(client, interaction, session);
            return;
        }

        const startTime = normalizeShiftTime(
            interaction.fields.getTextInputValue('startTime').trim(),
            null
        );
        const endTime = normalizeShiftTime(
            interaction.fields.getTextInputValue('endTime').trim(),
            null
        );
        const slotDurationMinutes = parsePositiveInteger(
            interaction.fields.getTextInputValue('slotDurationMinutes')
        );
        const headerTemplate = interaction.fields.getTextInputValue('headerTemplate').trim();
        const errors = [];
        if (!startTime || !endTime) errors.push('Начало и конец смен должны быть указаны в формате HH:mm.');
        if (slotDurationMinutes === null || slotDurationMinutes < 5 || slotDurationMinutes > 1_440) {
            errors.push('Длительность слота должна быть целым числом от 5 до 1440 минут.');
        }
        if (!headerTemplate) errors.push('Шапка сообщения не может быть пустой.');

        const candidate = structuredClone(shiftType);
        if (startTime) candidate.schedule.startTime = startTime;
        if (endTime) candidate.schedule.endTime = endTime;
        if (slotDurationMinutes !== null) candidate.schedule.slotDurationMinutes = slotDurationMinutes;
        if (headerTemplate) candidate.headerTemplate = headerTemplate;
        const slotCount = getShiftSlotCount(candidate);
        if (!slotCount || slotCount > MAX_SHIFT_SLOTS) {
            errors.push(`Настройки создают ${slotCount} слотов. Допустимо от 1 до ${MAX_SHIFT_SLOTS}.`);
        }

        if (errors.length) {
            configSessionService.setErrors(session, errors);
            await updatePanel(client, interaction, session);
            return;
        }

        shiftType.schedule = candidate.schedule;
        shiftType.headerTemplate = candidate.headerTemplate;
        session.selectedShiftTypeId = shiftType.id;
        configSessionService.markChanged(session, `Расписание смен "${shiftType.name}" изменено.`);
        await updatePanel(client, interaction, session);
    }

    async function handleShiftAccessGroupModal(client, interaction, session, parsed) {
        await acknowledgePanelInteraction(interaction);
        const { shiftTypeId, groupId } = parseShiftAccessReference(parsed.value);
        const shiftType = getShiftType(session, shiftTypeId);
        configSessionService.setSection(session, 'shiftAccess');
        if (!shiftType) {
            configSessionService.setErrors(session, ['Расписание смен больше не существует в текущей сессии.']);
            await updatePanel(client, interaction, session);
            return;
        }

        const name = interaction.fields.getTextInputValue('name').trim();
        const delayMinutes = parseNonNegativeInteger(
            interaction.fields.getTextInputValue('delayMinutes')
        );
        const errors = [];
        if (!name) errors.push('Название группы доступа не может быть пустым.');
        if (delayMinutes === null || delayMinutes > 10_080) {
            errors.push('Задержка должна быть целым числом от 0 до 10080 минут.');
        }
        if (errors.length) {
            configSessionService.setErrors(session, errors);
            await updatePanel(client, interaction, session);
            return;
        }

        if (groupId && groupId !== 'new') {
            const group = (shiftType.accessGroups || []).find((entry) => entry.id === groupId);
            if (!group) {
                configSessionService.setErrors(session, ['Группа доступа больше не существует.']);
                await updatePanel(client, interaction, session);
                return;
            }
            group.name = name;
            group.delayMinutes = delayMinutes;
            session.selectedShiftAccessGroupId = group.id;
            configSessionService.markChanged(session, `Группа доступа "${name}" изменена.`);
        } else {
            const group = {
                id: generateShiftAccessGroupId(shiftType),
                name,
                delayMinutes,
                roleIds: [],
            };
            shiftType.accessGroups.push(group);
            session.selectedShiftAccessGroupId = group.id;
            configSessionService.markChanged(session, `Группа доступа "${name}" добавлена.`);
        }

        shiftType.accessGroups.sort((left, right) => (
            left.delayMinutes - right.delayMinutes || left.name.localeCompare(right.name, 'ru')
        ));
        const selectedIndex = shiftType.accessGroups.findIndex(
            (entry) => entry.id === session.selectedShiftAccessGroupId
        );
        session.shiftAccessGroupPage = Math.max(
            0,
            Math.floor(selectedIndex / SHIFT_ACCESS_GROUP_PAGE_SIZE)
        );
        session.selectedShiftTypeId = shiftType.id;
        await updatePanel(client, interaction, session);
    }

    return {
        handleShiftAccessGroupModal,
        handleShiftScheduleModal,
        handleShiftTypeModal,
    };
}

module.exports = {
    createShiftSettingsModalHandlers,
};
