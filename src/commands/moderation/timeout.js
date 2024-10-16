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
const { ApplicationCommandOptionType, PermissionFlagsBits } = require('discord.js');
const ms = require('ms');

module.exports = {
    /**
    * @param {Client} client
    * @param {Interaction} interaction
    */

    name: 'timeout',
    description: 'Timeout a user.',
    deleted: true,
    options: [
        {
            name: 'target-user',
            description: 'The user you want to timeout.',
            type: ApplicationCommandOptionType.Mentionable,
            required: true,
        },
        {
            name: 'duration',
            description: 'Timeout duration (30m, 1h, 1 day).',
            type: ApplicationCommandOptionType.String,
            required: true,
        },
        {
            name: 'reason',
            description: 'The reason for the timeout.',
            type: ApplicationCommandOptionType.String,
        },
    ],
    permissionsRequired: [PermissionFlagsBits.ModerateMembers],
    botPermissions: [PermissionFlagsBits.ModerateMembers],

    callback: async (client, interaction) => {
        const mentionable = interaction.options.get('target-user').value;
        const duration = interaction.options.get('duration').value;
        const reason = interaction.options.get('reason')?.value || "No reason provided";

        await interaction.deferReply();

        const targetUser = await interaction.guild.members.fetch(mentionable);
        if (!targetUser){
            await interaction.editReply("That user doesn't exist in this server.");
            return;
        }

        if (targetUser.user.bot){
            await interaction.editReply("I can't timeout a bot.");
            return;
        }

        const msDuration = ms(duration);
        if (isNaN(msDuration)){
            await interaction.editReply("Please provide a valid timeout duration.");
            return;
        }

        if (msDuration < 5000 || msDuration > 2.419e9){
            await interaction.editReply("Timeout duration can't be less than 5 seconds or more than 28 days.");
            return;
        }

        const targetUserRolePosition = targetUser.roles.highest.position;
        const requestUserRolePosition = interaction.member.roles.highest.position;
        const botRolePosition = interaction.guild.members.me.roles.highest.position;

        if (targetUserRolePosition >= requestUserRolePosition){
            await interaction.editReply(
                "You can't timeout that user because they have the same/higher role than you."
            );
            return;
        }

        if (targetUserRolePosition >= botRolePosition){
            await interaction.editReply(
                "I can't timeout that user because they have the same/higher role than me."
            );
            return;
        }

        try {
            const { default: prettyMs} = await import('pretty-ms');

            if (targetUser.isCommunicationDisabled()){
                await targetUser.timeout(msDuration, reason);
                await interaction.editReply(`${targetUser}'s timeout has been updated to ${prettyMs(msDuration, { verbose : true })}. 
                \nReason: ${reason}.`);
                return;
            }

            await targetUser.timeout(msDuration, reason);
            await interaction.editReply(`${targetUser} was timed out for ${prettyMs(msDuration, { verbose : true })}
            \nReason: ${reason}.`);
        } catch (error) {
            console.log(`There was an error when timing out: ${error}`);
        }
    },
}