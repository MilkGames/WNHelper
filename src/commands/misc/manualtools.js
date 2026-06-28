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
const fs = require('fs/promises');
const path = require('path');
const { ApplicationCommandOptionType, PermissionFlagsBits } = require('discord.js');
const config = require('../../../config.json');

const giveRoles = require('../../models/giveRoles');
const blackListGiveRoles = require('../../models/blackListGiveRoles');
const { sendAmdScheduleNow } = require('../../utils/amdScheduleSender');
const {
    deferReplyWithRetry,
    editReplyWithRetry,
} = require('../../utils/discordRequest');
const logger = require('../../utils/logger');
const { updateAllServerMessages } = require('../../events/clientReady/editChannelMessage');

const CONFIG_PATH = path.join(__dirname, '../../../config.json');

function normalizeUserId(input) {
    return String(input || '').replace(/[<@!>]/g, '').trim();
}

function normalizeLeaderAppointmentDate(input) {
    const value = String(input || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;

    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));

    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
    ) {
        return null;
    }

    return value;
}

async function saveConfig() {
    await fs.writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 4)}\n`, 'utf8');
}

module.exports = {
    name: 'manualtools',
    description: 'Ручные админские действия с локальной БД и AMD сменами.',
    permissionsRequired: [PermissionFlagsBits.Administrator],
    options: [
        {
            name: 'delete_giveroles',
            description: 'Удалить запись пользователя из giveRoles.',
            type: ApplicationCommandOptionType.Subcommand,
            options: [
                {
                    name: 'user_id',
                    description: 'Discord ID пользователя или пинг.',
                    type: ApplicationCommandOptionType.String,
                    required: true,
                },
            ],
        },
        {
            name: 'delete_blacklist_giveroles',
            description: 'Удалить запись пользователя из blackListGiveRoles.',
            type: ApplicationCommandOptionType.Subcommand,
            options: [
                {
                    name: 'user_id',
                    description: 'Discord ID пользователя или пинг.',
                    type: ApplicationCommandOptionType.String,
                    required: true,
                },
            ],
        },
        {
            name: 'send_amd',
            description: 'Ручная отправка AMD-смен на текущий сервер.',
            type: ApplicationCommandOptionType.Subcommand,
        },
        {
            name: 'set_leader_date',
            description: 'Изменить дату назначения лидера фракции.',
            type: ApplicationCommandOptionType.Subcommand,
            options: [
                {
                    name: 'date',
                    description: 'Дата назначения в формате YYYY-MM-DD.',
                    type: ApplicationCommandOptionType.String,
                    required: true,
                },
            ],
        },
    ],

    callback: async (client, interaction) => {
        await deferReplyWithRetry(interaction, { ephemeral: true });

        try {
            const guildId = interaction.guildId;
            const subcommand = interaction.options.getSubcommand(true);

            if (subcommand === 'delete_giveroles') {
                const userId = normalizeUserId(interaction.options.getString('user_id', true));
                if (!/^\d{17,20}$/.test(userId)) {
                    await editReplyWithRetry(interaction, {
                        content: 'Укажите корректный Discord ID пользователя или пинг.',
                        ephemeral: true,
                    });
                    return;
                }

                const query = { guildId, userId };
                const existing = await giveRoles.findOne(query);
                if (!existing) {
                    await editReplyWithRetry(interaction, {
                        content: `Запись giveRoles для пользователя <@${userId}> на этом сервере не найдена.`,
                        ephemeral: true,
                    });
                    return;
                }

                await giveRoles.deleteOne(query);
                logger.info(`Ручные инструменты: удалена запись giveRoles для userId=${userId} guildId=${guildId}`);

                await editReplyWithRetry(interaction, {
                    content: `Запись giveRoles для пользователя <@${userId}> удалена вручную.`,
                    ephemeral: true,
                });
                return;
            }

            if (subcommand === 'delete_blacklist_giveroles') {
                const userId = normalizeUserId(interaction.options.getString('user_id', true));
                if (!/^\d{17,20}$/.test(userId)) {
                    await editReplyWithRetry(interaction, {
                        content: 'Укажите корректный Discord ID пользователя или пинг.',
                        ephemeral: true,
                    });
                    return;
                }

                const query = { guildId, userId };
                const existing = await blackListGiveRoles.findOne(query);
                if (!existing) {
                    await editReplyWithRetry(interaction, {
                        content: `Запись blackListGiveRoles для пользователя <@${userId}> на этом сервере не найдена.`,
                        ephemeral: true,
                    });
                    return;
                }

                await blackListGiveRoles.deleteOne(query);
                logger.info(`Ручные инструменты: удалена запись blackListGiveRoles для userId=${userId} guildId=${guildId}`);

                await editReplyWithRetry(interaction, {
                    content: `Запись blackListGiveRoles для пользователя <@${userId}> удалена вручную.`,
                    ephemeral: true,
                });
                return;
            }

            if (subcommand === 'send_amd') {
                const serverConfig = config.servers[guildId];
                if (!serverConfig) {
                    await editReplyWithRetry(interaction, {
                        content: 'Для этого сервера нет настроек в config.json.',
                        ephemeral: true,
                    });
                    return;
                }

                if (!serverConfig.amdShiftsChannelId) {
                    await editReplyWithRetry(interaction, {
                        content: 'Для этого сервера не настроен канал AMD-смен.',
                        ephemeral: true,
                    });
                    return;
                }

                const result = await sendAmdScheduleNow({
                    client,
                    guildId,
                    serverConfig,
                    reason: `вручную:${interaction.user.id}`,
                });

                await editReplyWithRetry(interaction, {
                    content: `AMD-смены отправлены вручную. Сообщение: ${result.messageLink}`,
                    ephemeral: true,
                });
                return;
            }

            if (subcommand === 'set_leader_date') {
                const serverConfig = config.servers[guildId];
                if (!serverConfig) {
                    await editReplyWithRetry(interaction, {
                        content: 'Для этого сервера нет настроек в config.json.',
                        ephemeral: true,
                    });
                    return;
                }

                const appointmentDate = normalizeLeaderAppointmentDate(interaction.options.getString('date', true));
                if (!appointmentDate) {
                    await editReplyWithRetry(interaction, {
                        content: 'Укажите дату назначения в формате YYYY-MM-DD, например 2026-06-28.',
                        ephemeral: true,
                    });
                    return;
                }

                serverConfig.leaderAppointmentDate = appointmentDate;
                await saveConfig();

                logger.info(`Ручные инструменты: дата назначения лидера для guildId=${guildId} изменена на ${appointmentDate}`);

                await editReplyWithRetry(interaction, {
                    content: `Дата назначения лидера изменена на ${appointmentDate}.`,
                    ephemeral: true,
                });

                await updateAllServerMessages(client, false);

                return;
            }

            await editReplyWithRetry(interaction, {
                content: 'Неизвестная подкоманда.',
                ephemeral: true,
            });
        } catch (error) {
            logger.error('Ручные инструменты: произошла ошибка при выполнении команды:', error);
            await editReplyWithRetry(interaction, {
                content: `Произошла ошибка при выполнении команды: ${error}`,
                ephemeral: true,
            });
        }
    },
};
