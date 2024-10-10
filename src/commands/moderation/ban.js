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
const { Client, Interaction, ApplicationCommandOptionType, PermissionFlagsBits } = require('discord.js');

module.exports = {
    name: 'ban',
    description: 'Bans a member from the server.',
    //devOnly: Boolean
    //testOnly: Boolean
    deleted: true,
    options: [
        {
            name: 'target-user',
            description: 'The user to ban',
            required: true,
            type: ApplicationCommandOptionType.Mentionable,
        },
        {
            name: 'reason',
            description: 'The reason for banning',
            type: ApplicationCommandOptionType.String,
        },
    ],
    permissionsRequired: [PermissionFlagsBits.BanMembers],
    botPermissions: [PermissionFlagsBits.ManageRoles],

    callback: async (client, interaction) => {
        const targetUserId = interaction.options.get('target-user').value;
        const reason = interaction.options.get('reason')?.value || "No reason provided";

        await interaction.deferReply();

        const targetUser = await interaction.guild.members.fetch(targetUserId);

        if (!targetUser){
            await interaction.editReply("That user doesn't exist in this server.");
            return;
        }

        if (targetUser.id === interaction.guild.ownerId){
            await interaction.editReply("You can't ban that user, because they're the server owner.");
            return;
        }

        const targetUserRolePosition = targetUser.roles.highest.position;
        const requestUserRolePosition = interaction.member.roles.highest.position;
        const botRolePosition = interaction.guild.members.me.roles.highest.position;

        if (targetUserRolePosition >= requestUserRolePosition) {
            await interaction.editReply("You can't ban that user, because they have the same/higher role than you.");
            return;
        }

        if (targetUserRolePosition >= botRolePosition){
            await interaction.editReply("You can't ban that user, because they have the same/higher role than me.");
            return;
        }

        try {
            await targetUser.ban({ reason });
            await interaction.editReply(`User ${targetUser} was banned.\nReason: ${reason}.`);
        } catch (error) {
            console.log(`There was an error when banning: ${error}.`);
            await interaction.editReply(`There was an error when banning: ${error}.`);
        }
    },
};