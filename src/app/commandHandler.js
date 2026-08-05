/*
 * WN Helper Discord Bot
 * Copyright (C) 2024-2026 MilkGames
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
const { MessageFlags } = require('discord.js');
const { getCommand } = require('./commandRegistry');
const {
    editReplyWithRetry,
    replyWithRetry,
} = require('../core/discord/request');
const { getDatabaseStatus } = require('../core/database/status');
const { isOwnerUser } = require('../core/runtime/instance');
const { buildPublicErrorMessage } = require('../core/ui/errorMessage');
const logger = require('../core/logging/logger');
const vacationAccessGuard = require('../modules/vacations');

function normalizeCommandOptionValue(option) {
    const value = option?.value;
    if (value === null || value === undefined) {
        const resolved = option?.user || option?.member || option?.role || option?.channel || option?.attachment;
        if (!resolved) return null;
        if (option?.attachment) {
            return {
                id: String(resolved.id || ''),
                name: String(resolved.name || ''),
                size: Number(resolved.size || 0),
                contentType: resolved.contentType || null,
            };
        }
        return String(resolved.id || resolved.user?.id || '');
    }
    if (['string', 'number', 'boolean'].includes(typeof value)) return value;
    if (typeof value === 'bigint') return value.toString();
    return String(value);
}

function extractCommandParameters(interaction) {
    const result = {};

    function visit(options) {
        for (const option of Array.isArray(options) ? options : []) {
            if (!option?.name) continue;
            if (Array.isArray(option.options)) {
                if (Number(option.type) === 2) result.group = option.name;
                else result.subcommand = option.name;
                visit(option.options);
                continue;
            }
            result[option.name] = normalizeCommandOptionValue(option);
            if (option.focused === true) result.focusedOption = option.name;
        }
    }

    visit(interaction?.options?.data);
    return result;
}

const RECOVERY_MANUAL_TOOLS = new Set([
    'instance_status',
    'shutdown_instance',
    'database_status',
    'database_compare',
    'database_resolve',
    'database_apply',
]);

function isAllowedInRecovery(interaction, commandName) {
    if (commandName !== 'manualtools') return false;
    const subcommand = interaction.options?.getSubcommand?.(false);
    return RECOVERY_MANUAL_TOOLS.has(subcommand);
}

async function safeReply(interaction, payload) {
    try {
        if (interaction.deferred || interaction.replied) {
            const editPayload = { ...(payload || {}) };
            delete editPayload.flags;
            return await editReplyWithRetry(interaction, editPayload);
        }
        return await replyWithRetry(interaction, payload);
    } catch (_) {
        // ответ мог протухнуть или уже быть подтверждён другим обработчиком
    }
}

async function commandHandler(client, interaction) {
    if (!interaction.isChatInputCommand() && !interaction.isAutocomplete()) return;

    const commandObject = getCommand(interaction.commandName);
    if (!commandObject) return;

    const databaseStatus = getDatabaseStatus();
    if (databaseStatus.recoveryMode && !isAllowedInRecovery(interaction, commandObject.name)) {
        if (interaction.isAutocomplete()) {
            await interaction.respond([]).catch(() => undefined);
            return;
        }
        await safeReply(interaction, {
            content: 'Бот работает в режиме восстановления базы данных. Доступны только служебные действия восстановления.',
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
        });
        return;
    }

    if (interaction.isAutocomplete()) {
        if (typeof commandObject.autocomplete !== 'function') {
            await interaction.respond([]).catch(() => undefined);
            return;
        }

        try {
            await commandObject.autocomplete(client, interaction);
        } catch (error) {
            logger.error('Автодополнение команды завершилось с ошибкой', {
                command: commandObject.name,
                userId: interaction.user?.id,
                guildId: interaction.guildId || null,
            }, error);
            await interaction.respond([]).catch(() => undefined);
        }
        return;
    }

    const ctx = {
        command: commandObject.name,
        userId: interaction.user?.id,
        guildId: interaction.guildId || null,
        channelId: interaction.channelId || null,
    };
    const parameters = extractCommandParameters(interaction);

    logger.info('Команда стартовала', { ...ctx, parameters });

    try {
        if (commandObject.ownerOnly === true && !isOwnerUser(interaction.user?.id)) {
            logger.warn('Отклонена owner-only команда', ctx);
            await safeReply(interaction, {
                content: 'Эта команда доступна только владельцу бота.',
                flags: MessageFlags.Ephemeral,
                allowedMentions: { parse: [] },
            });
            return;
        }

        const vacationGroup = vacationAccessGuard.getCommandGroup(commandObject.name);
        if (vacationGroup && interaction.inGuild()) {
            const member = interaction.member?.roles?.cache
                ? interaction.member
                : await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
            const block = vacationAccessGuard.getBlock(interaction.guildId, interaction.user.id, vacationGroup, member);
            if (block.blocked) {
                await safeReply(interaction, {
                    content: vacationAccessGuard.buildMessage(block),
                    flags: MessageFlags.Ephemeral,
                    allowedMentions: { parse: [] },
                });
                return;
            }
        }

        // права бота
        if (commandObject.botPermissions?.length) {
            if (!interaction.inGuild()) {
                await safeReply(interaction, {
                    content: 'Эта команда требует прав бота, поэтому работает только на сервере.',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            const botMember = interaction.guild?.members?.me;
            if (!botMember) {
                await safeReply(interaction, {
                    content: 'Не удалось получить права бота на сервере. Попробуйте позже.',
                    flags: MessageFlags.Ephemeral,
                });
                return;
            }

            for (const permission of commandObject.botPermissions) {
                if (!botMember.permissions.has(permission)) {
                    await safeReply(interaction, {
                        content: 'У меня недостаточно прав для запуска данной команды...',
                        flags: MessageFlags.Ephemeral,
                    });
                    return;
                }
            }
        }

        await commandObject.callback(client, interaction);

        logger.info('Команда выполнена', ctx);
    } catch (error) {
        logger.error('Команда завершилась с ошибкой', { ...ctx, parameters }, error);
        await safeReply(interaction, {
            content: buildPublicErrorMessage(
                error,
                'Произошла ошибка при выполнении команды. Ошибка записана в лог.'
            ),
            ...(!commandObject.publicResponses ? { flags: MessageFlags.Ephemeral } : {}),
            allowedMentions: { parse: [] },
        });
    }
}

module.exports = commandHandler;
module.exports.extractCommandParameters = extractCommandParameters;
