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
    name: 'kick',
    description: 'Kicks a member from the server.',
    //devOnly: Boolean
    //testOnly: Boolean
    deleted: true,
    options: [
        {
            name: 'target-user',
            description: 'The user to kick',
            required: true,
            type: ApplicationCommandOptionType.Mentionable,
        },
        {
            name: 'reason',
            description: 'The reason for kicking',
            type: ApplicationCommandOptionType.String,
        },
    ],
    permissionsRequired: [PermissionFlagsBits.KickMembers],
    botPermissions: [PermissionFlagsBits.KickMembers],

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
            await interaction.editReply("You can't kick that user, because they're the server owner.");
            return;
        }

        const targetUserRolePosition = targetUser.roles.highest.position;
        const requestUserRolePosition = interaction.member.roles.highest.position;
        const botRolePosition = interaction.guild.members.me.roles.highest.position;

        if (targetUserRolePosition >= requestUserRolePosition) {
            await interaction.editReply("You can't kick that user, because they have the same/higher role than you.");
            return;
        }

        if (targetUserRolePosition >= botRolePosition){
            await interaction.editReply("You can't kick that user, because they have the same/higher role than me.");
            return;
        }

        try {
            await targetUser.kick(reason);
            await interaction.editReply(`User ${targetUser} was kicked.\nReason: ${reason}.`);
        } catch (error) {
            console.log(`There was an error when trying to kick: ${error}.`);
            await interaction.editReply(`There was an error when trying to kick: ${error}.`);
        }
    },
};