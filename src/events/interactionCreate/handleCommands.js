/*
 * WN Helper Discord Bot
 * Copyright (C) 2024 MilkGames
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
const { devs, testServer } = require('../../../config.json');
const getLocalCommands = require('../../utils/getLocalCommands');
const logger = require('../../utils/logger');

async function safeReply(interaction, payload) {
    try {
        if (interaction.deferred || interaction.replied) {
            return await interaction.editReply(payload);
        }
        return await interaction.reply(payload);
    } catch (_) {
        // игнорируем "Unknown interaction" и подобные
    }
}

module.exports = async (client, interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const localCommands = getLocalCommands();
    const commandObject = localCommands.find((cmd) => cmd.name === interaction.commandName);
    if (!commandObject) return;

    const ctx = {
        command: commandObject.name,
        userId: interaction.user?.id,
        guildId: interaction.guildId || null,
        channelId: interaction.channelId || null,
    };

    logger.info('Команда стартовала', ctx);

    try {
        // DEV ONLY
        if (commandObject.devOnly) {
            if (!interaction.inGuild() || !interaction.member) {
                await safeReply(interaction, { content: 'Эта команда доступна только на сервере.', ephemeral: true });
                return;
            }
            if (!devs.includes(interaction.member.id)) {
                await safeReply(interaction, {
                    content: 'Данная команда доступна только для разработчиков!',
                    ephemeral: true,
                });
                return;
            }
        }

        // TEST ONLY
        if (commandObject.testOnly) {
            if (!interaction.inGuild() || interaction.guildId !== testServer) {
                await safeReply(interaction, {
                    content: 'Данная команда доступна только на тестовом сервере!',
                    ephemeral: true,
                });
                return;
            }
        }

        // MEMBER PERMISSIONS
        if (commandObject.permissionsRequired?.length) {
            if (!interaction.inGuild() || !interaction.memberPermissions) {
                await safeReply(interaction, {
                    content: 'Эта команда требует прав, поэтому работает только на сервере.',
                    ephemeral: true,
                });
                return;
            }

            for (const permission of commandObject.permissionsRequired) {
                if (!interaction.memberPermissions.has(permission)) {
                    await safeReply(interaction, {
                        content: 'У вас недостаточно прав для запуска данной команды.',
                        ephemeral: true,
                    });
                    return;
                }
            }
        }

        // BOT PERMISSIONS
        if (commandObject.botPermissions?.length) {
            if (!interaction.inGuild()) {
                await safeReply(interaction, {
                    content: 'Эта команда требует прав бота, поэтому работает только на сервере.',
                    ephemeral: true,
                });
                return;
            }

            const botMember = interaction.guild?.members?.me;
            if (!botMember) {
                await safeReply(interaction, {
                    content: 'Не удалось получить права бота на сервере. Попробуйте позже.',
                    ephemeral: true,
                });
                return;
            }

            for (const permission of commandObject.botPermissions) {
                if (!botMember.permissions.has(permission)) {
                    await safeReply(interaction, {
                        content: 'У меня недостаточно прав для запуска данной команды...',
                        ephemeral: true,
                    });
                    return;
                }
            }
        }

        await commandObject.callback(client, interaction);

        logger.info('Команда выполнена', ctx);
    } catch (error) {
        logger.error('Команда завершилась с ошибкой', ctx, error);
        await safeReply(interaction, {
            content: 'Произошла ошибка при выполнении команды. Ошибка залогирована.',
            ephemeral: true,
        });
    }
};
