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
    ButtonStyle,
    ChannelSelectMenuBuilder,
    ChannelType,
    ModalBuilder,
    RoleSelectMenuBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
} = require('discord.js');
const {
    MAX_SHIFT_SLOTS,
    PUBLICATION_MODES,
    getShiftSlotCount,
} = require('./schema');

const SHIFT_TYPE_PAGE_SIZE = 5;
const SHIFT_ACCESS_GROUP_PAGE_SIZE = 5;

function createShiftSettingsRenderer({
    customId,
    createButton,
    createFooterRow,
    formatStatus,
    getSelectedShiftType,
    getSelectedShiftAccessGroup,
}) {
    function createShiftTypeModal(session, shiftType = null) {
        const modal = new ModalBuilder()
            .setCustomId(customId(session, 'shift_type_modal', shiftType?.id || 'new'))
            .setTitle(shiftType ? 'Изменение смен' : 'Добавление смен');

        const name = new TextInputBuilder()
            .setCustomId('name')
            .setLabel('Название смен')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(100);
        if (shiftType?.name) name.setValue(shiftType.name);

        const color = new TextInputBuilder()
            .setCustomId('color')
            .setLabel('Цвет сообщения (#RRGGBB)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(7)
            .setValue(shiftType?.color || '#F1C40F');

        const publicationMode = shiftType?.publication?.mode === PUBLICATION_MODES.RANDOM
            ? PUBLICATION_MODES.RANDOM
            : PUBLICATION_MODES.FIXED;
        const publicationInputs = [];
        if (publicationMode === PUBLICATION_MODES.RANDOM) {
            publicationInputs.push(
                new TextInputBuilder()
                    .setCustomId('publicationFromTime')
                    .setLabel('Начало окна публикации (HH:mm, Москва)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMaxLength(5)
                    .setValue(shiftType?.publication?.fromTime || '20:00'),
                new TextInputBuilder()
                    .setCustomId('publicationToTime')
                    .setLabel('Конец окна публикации (HH:mm, Москва)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMaxLength(5)
                    .setValue(shiftType?.publication?.toTime || '22:00')
            );
        } else {
            publicationInputs.push(
                new TextInputBuilder()
                    .setCustomId('publicationTime')
                    .setLabel('Время публикации (HH:mm, Москва)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMaxLength(5)
                    .setValue(shiftType?.publication?.time || '21:00')
            );
        }

        const maxSlots = new TextInputBuilder()
            .setCustomId('maxSlotsPerMember')
            .setLabel('Максимум смен на сотрудника (0 = без лимита)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(3)
            .setValue(String(shiftType?.maxSlotsPerMember ?? 1));

        modal.addComponents(
            new ActionRowBuilder().addComponents(name),
            new ActionRowBuilder().addComponents(color),
            ...publicationInputs.map((input) => new ActionRowBuilder().addComponents(input)),
            new ActionRowBuilder().addComponents(maxSlots),
        );
        return modal;
    }

    function createShiftScheduleModal(session, shiftType) {
        const modal = new ModalBuilder()
            .setCustomId(customId(session, 'shift_schedule_modal', shiftType.id))
            .setTitle(`Расписание: ${shiftType.name}`.slice(0, 45));

        const startTime = new TextInputBuilder()
            .setCustomId('startTime')
            .setLabel('Начало смен (HH:mm)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(5)
            .setValue(shiftType.schedule.startTime);
        const endTime = new TextInputBuilder()
            .setCustomId('endTime')
            .setLabel('Конец смен (HH:mm, не включительно)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(5)
            .setValue(shiftType.schedule.endTime);
        const duration = new TextInputBuilder()
            .setCustomId('slotDurationMinutes')
            .setLabel('Длительность одного слота в минутах')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(4)
            .setValue(String(shiftType.schedule.slotDurationMinutes));
        const headerTemplate = new TextInputBuilder()
            .setCustomId('headerTemplate')
            .setLabel('Шапка ({name} и {date})')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(200)
            .setValue(shiftType.headerTemplate || '✅ {name} на {date}:');

        modal.addComponents(
            new ActionRowBuilder().addComponents(startTime),
            new ActionRowBuilder().addComponents(endTime),
            new ActionRowBuilder().addComponents(duration),
            new ActionRowBuilder().addComponents(headerTemplate),
        );
        return modal;
    }

    function createShiftAccessGroupModal(session, shiftType, group = null) {
        const modal = new ModalBuilder()
            .setCustomId(customId(
                session,
                'shift_access_group_modal',
                `${shiftType.id}:${group?.id || 'new'}`
            ))
            .setTitle(group ? 'Изменение группы доступа' : 'Добавление группы доступа');

        const name = new TextInputBuilder()
            .setCustomId('name')
            .setLabel('Название группы')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(80);
        if (group?.name) name.setValue(group.name);

        const delay = new TextInputBuilder()
            .setCustomId('delayMinutes')
            .setLabel('Задержка после публикации, минут')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(5)
            .setValue(String(group?.delayMinutes ?? 0));

        modal.addComponents(
            new ActionRowBuilder().addComponents(name),
            new ActionRowBuilder().addComponents(delay),
        );
        return modal;
    }

    function formatPublication(shiftType) {
        if (shiftType?.publication?.mode === PUBLICATION_MODES.RANDOM) {
            return `случайно в промежутке ${shiftType.publication.fromTime}-${shiftType.publication.toTime} по Москве`;
        }
        return `${shiftType?.publication?.time || '21:00'} по Москве`;
    }

    function renderShiftTypes(session, guild) {
        const shiftTypes = session.draft.shiftTypes || [];
        const pageCount = Math.max(Math.ceil(shiftTypes.length / SHIFT_TYPE_PAGE_SIZE), 1);
        const page = Math.min(Math.max(session.shiftTypePage || 0, 0), pageCount - 1);
        const pageTypes = shiftTypes.slice(page * SHIFT_TYPE_PAGE_SIZE, (page + 1) * SHIFT_TYPE_PAGE_SIZE);
        const selected = getSelectedShiftType(session);
        const lines = [
            `## Настройки WN Helper - ${guild.name}`,
            formatStatus(session),
            '',
            `Настроено расписаний смен: ${shiftTypes.length}.`,
        ];

        if (!shiftTypes.length) {
            lines.push('Расписания смен пока не добавлены.');
        } else {
            lines.push(`Список, страница ${page + 1}/${pageCount}:`);
            for (const type of pageTypes) {
                const prefix = selected?.id === type.id ? '→' : '•';
                const state = type.enabled ? 'включён' : 'выключен';
                const channel = type.channelId ? `<#${type.channelId}>` : 'канал не выбран';
                lines.push(`${prefix} ${type.name} - ${state}; ${channel}; ${getShiftSlotCount(type)} слотов.`);
            }
        }

        lines.push('', selected
            ? [
                `Выбрано расписание: **${selected.name}**.`,
                `Публикация: ${formatPublication(selected)}; если смены к выбранному времени уже начались - на следующий день.`,
                `Слоты: ${selected.schedule.startTime}-${selected.schedule.endTime}, по ${selected.schedule.slotDurationMinutes} мин.`,
                `Групп доступа: ${selected.accessGroups.length}; ежедневная ротация: ${selected.rotateAccessDaily ? 'включена' : 'выключена'}.`,
            ].join('\n')
            : 'Выбери расписание смен либо добавь новое.');

        const components = [];
        if (pageTypes.length) {
            components.push(new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(customId(session, 'shift_type_select'))
                    .setPlaceholder('Выбрать расписание смен')
                    .setMinValues(1)
                    .setMaxValues(1)
                    .addOptions(pageTypes.map((type) => ({
                        label: type.name.slice(0, 100),
                        description: `${type.enabled ? 'Включён' : 'Выключен'} • ${getShiftSlotCount(type)} слотов`.slice(0, 100),
                        value: type.id,
                        default: selected?.id === type.id,
                    })))
            ));
        }

        components.push(new ActionRowBuilder().addComponents(
            createButton(session, 'shift_type_add', 'Добавить', ButtonStyle.Success),
            createButton(session, 'shift_type_edit', 'Основное', ButtonStyle.Primary).setDisabled(!selected),
            createButton(
                session,
                'shift_type_toggle',
                selected?.enabled ? 'Выключить' : 'Включить',
                selected?.enabled ? ButtonStyle.Secondary : ButtonStyle.Success,
                selected?.id || '-'
            ).setDisabled(!selected),
            createButton(session, 'nav', 'Канал', ButtonStyle.Primary, 'shiftTypeChannel').setDisabled(!selected),
            createButton(
                session,
                'shift_publication_mode_toggle',
                selected?.publication?.mode === PUBLICATION_MODES.RANDOM ? 'Случайно' : 'Фиксированно',
                ButtonStyle.Secondary,
                selected?.id || '-'
            ).setDisabled(!selected),
        ));

        components.push(new ActionRowBuilder().addComponents(
            createButton(session, 'nav', 'Расписание', ButtonStyle.Primary, 'shiftSchedule').setDisabled(!selected),
            createButton(session, 'nav', 'Доступ', ButtonStyle.Primary, 'shiftAccess').setDisabled(!selected),
            createButton(session, 'nav', 'Управление', ButtonStyle.Primary, 'shiftManagers').setDisabled(!selected),
            createButton(session, 'nav', 'Публикация', ButtonStyle.Success, 'shiftPublish').setDisabled(!selected),
            createButton(session, 'nav', 'Удалить', ButtonStyle.Danger, 'shiftDelete').setDisabled(!selected),
        ));

        if (pageCount > 1) {
            components.push(new ActionRowBuilder().addComponents(
                createButton(session, 'shift_type_page', 'Предыдущая', ButtonStyle.Secondary, page - 1)
                    .setDisabled(page <= 0),
                createButton(session, 'shift_type_page', 'Следующая', ButtonStyle.Secondary, page + 1)
                    .setDisabled(page >= pageCount - 1),
            ));
        }
        components.push(createFooterRow(session));
        return { content: lines.join('\n'), components };
    }

    function renderShiftTypeChannel(session, guild) {
        const selected = getSelectedShiftType(session);
        if (!selected) {
            session.section = 'shiftTypes';
            return renderShiftTypes(session, guild);
        }

        const content = [
            `## Настройки WN Helper - ${guild.name}`,
            formatStatus(session),
            '',
            `Смены: **${selected.name}**`,
            `Канал: ${selected.channelId ? `<#${selected.channelId}>` : 'не выбран'}`,
            '',
            'Выбери текстовый канал, в котором будет публиковаться это расписание.',
        ].join('\n');

        const channelSelect = new ChannelSelectMenuBuilder()
            .setCustomId(customId(session, 'shift_type_channel_set', selected.id))
            .setPlaceholder('Выбрать канал смен')
            .setMinValues(1)
            .setMaxValues(1)
            .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

        return {
            content,
            components: [
                new ActionRowBuilder().addComponents(channelSelect),
                createFooterRow(session, {
                    includeClear: {
                        action: 'shift_type_channel_clear',
                        value: selected.id,
                    },
                    backSection: 'shiftTypes',
                }),
            ],
        };
    }

    function renderShiftSchedule(session, guild) {
        const selected = getSelectedShiftType(session);
        if (!selected) {
            session.section = 'shiftTypes';
            return renderShiftTypes(session, guild);
        }
        const content = [
            `## Настройки WN Helper - ${guild.name}`,
            formatStatus(session),
            '',
            `Смены: **${selected.name}**`,
            `Начало: ${selected.schedule.startTime}`,
            `Конец: ${selected.schedule.endTime} (не включительно)`,
            `Длительность слота: ${selected.schedule.slotDurationMinutes} мин.`,
            `Итоговое количество слотов: ${getShiftSlotCount(selected)}.`,
            `Шапка: ${selected.headerTemplate}`,
            '',
            `Расписание может переходить через полночь. Смены выбираются из выпадающих списков; поддерживается до ${MAX_SHIFT_SLOTS} слотов.`,
        ].join('\n');
        return {
            content,
            components: [
                new ActionRowBuilder().addComponents(
                    createButton(session, 'shift_schedule_edit', 'Изменить расписание', ButtonStyle.Primary, selected.id)
                ),
                createFooterRow(session, { backSection: 'shiftTypes' }),
            ],
        };
    }

    function renderShiftAccess(session, guild) {
        const selected = getSelectedShiftType(session);
        if (!selected) {
            session.section = 'shiftTypes';
            return renderShiftTypes(session, guild);
        }
        const groups = selected.accessGroups || [];
        const pageCount = Math.max(Math.ceil(groups.length / SHIFT_ACCESS_GROUP_PAGE_SIZE), 1);
        const page = Math.min(Math.max(session.shiftAccessGroupPage || 0, 0), pageCount - 1);
        const pageGroups = groups.slice(page * SHIFT_ACCESS_GROUP_PAGE_SIZE, (page + 1) * SHIFT_ACCESS_GROUP_PAGE_SIZE);
        const group = getSelectedShiftAccessGroup(session);
        const lines = [
            `## Настройки WN Helper - ${guild.name}`,
            formatStatus(session),
            '',
            `Смены: **${selected.name}**`,
            `Ежедневная ротация групп: ${selected.rotateAccessDaily ? 'включена' : 'выключена'}.`,
            '',
        ];

        if (!groups.length) {
            lines.push('Группы не настроены - доступ к сменам открыт всем участникам сервера.');
        } else {
            lines.push('Группы открываются накопительно в указанном порядке:');
            for (const item of pageGroups) {
                const prefix = group?.id === item.id ? '→' : '•';
                lines.push(`${prefix} ${item.name}: через ${item.delayMinutes} мин.; ролей: ${item.roleIds.length}.`);
            }
            if (selected.rotateAccessDaily) {
                lines.push('', 'При ротации группы меняются местами ежедневно, а задержки остаются привязаны к позициям списка.');
            }
        }
        lines.push('', group
            ? [
                `Выбрана группа: **${group.name}**.`,
                group.roleIds.length
                    ? `Роли: ${group.roleIds.map((roleId) => `<@&${roleId}>`).join(' ')}`
                    : 'Роли не выбраны.',
            ].join('\n')
            : 'Выбери группу для настройки ролей.');

        const components = [];
        if (pageGroups.length) {
            components.push(new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(customId(session, 'shift_access_group_select'))
                    .setPlaceholder('Выбрать группу доступа')
                    .setMinValues(1)
                    .setMaxValues(1)
                    .addOptions(pageGroups.map((item) => ({
                        label: item.name.slice(0, 100),
                        description: `Через ${item.delayMinutes} мин. • ролей: ${item.roleIds.length}`.slice(0, 100),
                        value: item.id,
                        default: group?.id === item.id,
                    })))
            ));
        }

        if (group) {
            components.push(new ActionRowBuilder().addComponents(
                new RoleSelectMenuBuilder()
                    .setCustomId(customId(session, 'shift_access_group_roles_set', `${selected.id}:${group.id}`))
                    .setPlaceholder('Полностью заменить роли выбранной группы')
                    .setMinValues(1)
                    .setMaxValues(25)
            ));
        }

        components.push(new ActionRowBuilder().addComponents(
            createButton(session, 'shift_access_group_add', 'Добавить группу', ButtonStyle.Success, selected.id),
            createButton(session, 'shift_access_group_edit', 'Название и задержка', ButtonStyle.Primary).setDisabled(!group),
            createButton(
                session,
                'shift_access_rotation_toggle',
                selected.rotateAccessDaily ? 'Выключить ротацию' : 'Включить ротацию',
                selected.rotateAccessDaily ? ButtonStyle.Secondary : ButtonStyle.Success,
                selected.id
            ),
            createButton(session, 'shift_access_group_delete', 'Удалить группу', ButtonStyle.Danger).setDisabled(!group),
        ));

        if (pageCount > 1) {
            components.push(new ActionRowBuilder().addComponents(
                createButton(session, 'shift_access_group_page', 'Предыдущая', ButtonStyle.Secondary, page - 1)
                    .setDisabled(page <= 0),
                createButton(session, 'shift_access_group_page', 'Следующая', ButtonStyle.Secondary, page + 1)
                    .setDisabled(page >= pageCount - 1),
            ));
        }
        components.push(createFooterRow(session, { backSection: 'shiftTypes' }));
        return { content: lines.join('\n'), components };
    }

    function renderShiftManagers(session, guild) {
        const selected = getSelectedShiftType(session);
        if (!selected) {
            session.section = 'shiftTypes';
            return renderShiftTypes(session, guild);
        }
        const content = [
            `## Настройки WN Helper - ${guild.name}`,
            formatStatus(session),
            '',
            `Смены: **${selected.name}**`,
            'Роли, которые могут освобождать чужие смены:',
            selected.managerRoleIds.length
                ? selected.managerRoleIds.map((roleId) => `• <@&${roleId}>`).join('\n')
                : '• роли не выбраны',
            '',
            'Выбор ниже полностью заменяет текущий список. Эти роли не дают автоматического доступа к занятию смен.',
        ].join('\n');
        const roleSelect = new RoleSelectMenuBuilder()
            .setCustomId(customId(session, 'shift_manager_roles_set', selected.id))
            .setPlaceholder('Выбрать роли управления сменами')
            .setMinValues(1)
            .setMaxValues(25);
        return {
            content,
            components: [
                new ActionRowBuilder().addComponents(roleSelect),
                createFooterRow(session, {
                    includeClear: {
                        action: 'shift_manager_roles_clear',
                        value: selected.id,
                    },
                    backSection: 'shiftTypes',
                }),
            ],
        };
    }

    function renderShiftPublish(session, guild) {
        const selected = getSelectedShiftType(session);
        if (!selected) {
            session.section = 'shiftTypes';
            return renderShiftTypes(session, guild);
        }
        const hasUnsavedChanges = (session.changes || []).length > 0;
        const ready = selected.enabled && Boolean(selected.channelId) && !hasUnsavedChanges;
        const content = [
            `## Настройки WN Helper - ${guild.name}`,
            formatStatus(session),
            '',
            `Смены: **${selected.name}**`,
            `Состояние: ${selected.enabled ? 'включены' : 'выключены'}`,
            `Канал: ${selected.channelId ? `<#${selected.channelId}>` : 'не выбран'}`,
            '',
            hasUnsavedChanges
                ? 'Сначала сохраните изменения настроек.'
                : 'Кнопка ниже принудительно публикует следующее расписание либо восстанавливает его удалённое сообщение.',
        ].join('\n');
        return {
            content,
            components: [
                new ActionRowBuilder().addComponents(
                    createButton(
                        session,
                        'shift_publish_confirm',
                        'Опубликовать следующее расписание',
                        ButtonStyle.Success,
                        selected.id
                    ).setDisabled(!ready)
                ),
                createFooterRow(session, { backSection: 'shiftTypes' }),
            ],
        };
    }

    function renderShiftDelete(session, guild) {
        const selected = getSelectedShiftType(session);
        if (!selected) {
            session.section = 'shiftTypes';
            return renderShiftTypes(session, guild);
        }
        const content = [
            `## Настройки WN Helper - ${guild.name}`,
            formatStatus(session),
            '',
            `Удалить смены **${selected.name}**?`,
            'Новые расписания больше публиковаться не будут. Уже опубликованные останутся активными до собственного времени завершения.',
        ].join('\n');
        return {
            content,
            components: [new ActionRowBuilder().addComponents(
                createButton(session, 'shift_type_delete_confirm', 'Удалить смены', ButtonStyle.Danger, selected.id),
                createButton(session, 'nav', 'Назад', ButtonStyle.Secondary, 'shiftTypes'),
                createButton(session, 'save', 'Сохранить', ButtonStyle.Success),
                createButton(session, 'cancel', 'Отменить', ButtonStyle.Danger),
            )],
        };
    }

    return {
        createShiftAccessGroupModal,
        createShiftScheduleModal,
        createShiftTypeModal,
        renderShiftAccess,
        renderShiftDelete,
        renderShiftManagers,
        renderShiftPublish,
        renderShiftSchedule,
        renderShiftTypeChannel,
        renderShiftTypes,
    };
}

module.exports = {
    createShiftSettingsRenderer,
};
