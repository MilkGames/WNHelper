/*
 * WN Helper Discord Bot
 * Copyright (C) 2025 MilkGames
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
const { EmbedBuilder } = require('discord.js');
const config = require('../../../config.json');

function getMembers(members, max){
    let memberPings = members.map(member => `> <@${member.user.id}>`).join('\n');
    if (max == 0 && !memberPings) {
        memberPings += "> Отсутствует.";
    }
    for (i = 0; i < max - members.size; i++) {
        memberPings += "\n> Место вакантно.";
    }
    return memberPings;
}

module.exports = async (client) => {
    try {
        for (const serverId of Object.keys(config.servers)){
            const rddChannelId = config.servers[serverId].RDDStaffChannelId;
            const amdChannelId = config.servers[serverId].AMDStaffChannelId;
            const edChannelId = config.servers[serverId].EDStaffChannelId;
            const jdChannelId = config.servers[serverId].JDStaffChannelId;
            const RDDRoleId = config.servers[serverId].RDDRoleId;
            const AMDRoleId = config.servers[serverId].AMDRoleId;
            const EDRoleId = config.servers[serverId].EDRoleId;
            const JDRoleId = config.servers[serverId].JDRoleId;
            const partWorkRDDRoleId = config.servers[serverId].partWorkRDDRoleId;
            const partWorkAMDRoleId = config.servers[serverId].partWorkAMDRoleId;
            const partWorkEDRoleId = config.servers[serverId].partWorkEDRoleId;
            const partWorkJDRoleId = config.servers[serverId].partWorkJDRoleId;
            const depHeadRDRoleId = config.servers[serverId].depHeadRDRoleId;
            const depHeadDDRoleId = config.servers[serverId].depHeadDDRoleId;
            const depHeadAMDRoleId = config.servers[serverId].depHeadAMDRoleId;
            const depHeadEDRoleId = config.servers[serverId].depHeadEDRoleId;
            const depHeadJDRoleId = config.servers[serverId].depHeadJDRoleId;
            const headRDDRoleId = config.servers[serverId].headRDDRoleId;
            const headAMDRoleId = config.servers[serverId].headAMDRoleId;
            const headEDRoleId = config.servers[serverId].headEDRoleId;
            const headJDRoleId = config.servers[serverId].headJDRoleId;
            const depLeaderRoleId = config.servers[serverId].depLeaderRoleId;
            const leaderRoleId = config.servers[serverId].leaderRoleId;
            const traineeRoleId = config.servers[serverId].traineeRoleId;
            if (rddChannelId && amdChannelId && edChannelId && jdChannelId) {
                const guild = client.guilds.cache.get(serverId);
                const rddChannel = await client.channels.fetch(rddChannelId);
                const amdChannel = await client.channels.fetch(amdChannelId);
                const edChannel = await client.channels.fetch(edChannelId);
                const jdChannel = await client.channels.fetch(jdChannelId);
                let members;
        
                const editChannelMessage = async () => {
                    // создание embeds
                    const rddEmbed = new EmbedBuilder()
                        .setColor(0x2ECC71)
                        .setTitle(`Состав отдела Recruitment & Disciplinary Department`)
                        .setTimestamp()
                        .setFooter({ text: 'WN Helper by Michael Lindberg. Discord: milkgames', iconURL: 'https://i.imgur.com/zdxWb0s.jpeg' });
                    const amdEmbed = new EmbedBuilder()
                        .setColor(0xE67E22)
                        .setTitle(`Состав отдела Advertising Management Department`)
                        .setTimestamp()
                        .setFooter({ text: 'WN Helper by Michael Lindberg. Discord: milkgames', iconURL: 'https://i.imgur.com/zdxWb0s.jpeg' });
                    const edEmbed = new EmbedBuilder()
                        .setColor(0xFFC0CB)
                        .setTitle(`Состав отдела Event Department`)
                        .setTimestamp()
                        .setFooter({ text: 'WN Helper by Michael Lindberg. Discord: milkgames', iconURL: 'https://i.imgur.com/zdxWb0s.jpeg' });
                    const jdEmbed = new EmbedBuilder()
                        .setColor(0x3498DB)
                        .setTitle(`Состав отдела Journalism Department`)
                        .setTimestamp()
                        .setFooter({ text: 'WN Helper by Michael Lindberg. Discord: milkgames', iconURL: 'https://i.imgur.com/zdxWb0s.jpeg' });
                
                    members = await guild.members.fetch();

                    // проход по кураторам
                    RDDCurators = members.filter(member => 
                        member.roles.cache.has(headRDDRoleId) &&
                        member.roles.cache.has(depLeaderRoleId) &&
                        !member.roles.cache.has(leaderRoleId));
                    AMDCurators = members.filter(member => 
                        member.roles.cache.has(headAMDRoleId) &&
                        member.roles.cache.has(depLeaderRoleId) &&
                        !member.roles.cache.has(leaderRoleId));
                    EDCurators = members.filter(member => 
                        member.roles.cache.has(headEDRoleId) &&
                        member.roles.cache.has(depLeaderRoleId) &&
                        !member.roles.cache.has(leaderRoleId));
                    JDCurators = members.filter(member => 
                        member.roles.cache.has(headJDRoleId) &&
                        member.roles.cache.has(depLeaderRoleId) &&
                        !member.roles.cache.has(leaderRoleId));

                    rddEmbed.addFields({ name: "Следящий за отделом:", value: getMembers(RDDCurators, 0) });
                    amdEmbed.addFields({ name: "Следящий за отделом:", value: getMembers(AMDCurators, 0) });
                    edEmbed.addFields({ name: "Следящий за отделом:", value: getMembers(EDCurators, 0) });
                    jdEmbed.addFields({ name: "Следящий за отделом:", value: getMembers(JDCurators, 0) });

                    // проход по хэдам
                    RDDHead = members.filter(member => 
                        member.roles.cache.has(headRDDRoleId) &&
                        !member.roles.cache.has(depLeaderRoleId) &&
                        !member.roles.cache.has(leaderRoleId));
                    AMDHead = members.filter(member => 
                        member.roles.cache.has(headAMDRoleId) &&
                        !member.roles.cache.has(depLeaderRoleId) &&
                        !member.roles.cache.has(leaderRoleId));
                    EDHead = members.filter(member => 
                        member.roles.cache.has(headEDRoleId) &&
                        !member.roles.cache.has(depLeaderRoleId) &&
                        !member.roles.cache.has(leaderRoleId));
                    JDHead = members.filter(member => 
                        member.roles.cache.has(headJDRoleId) &&
                        !member.roles.cache.has(depLeaderRoleId) &&
                        !member.roles.cache.has(leaderRoleId));

                    rddEmbed.addFields(
                        { name: "**\nСтарший состав:\n**", value: " " },
                        { name: "Глава отдела:", value: getMembers(RDDHead, 1) });
                    amdEmbed.addFields(
                        { name: "**\nСтарший состав:\n**", value: " " },
                        { name: "Глава отдела:", value: getMembers(AMDHead, 1) });
                    edEmbed.addFields(
                        { name: "**\nСтарший состав:\n**", value: " " },
                        { name: "Глава отдела:", value: getMembers(EDHead, 1) });
                    jdEmbed.addFields(
                        { name: "**\nСтарший состав:\n**", value: " " },
                        { name: "Глава отдела:", value: getMembers(JDHead, 1) });

                    // проход по депам

                    RDDepHead = members.filter(member => member.roles.cache.has(depHeadRDRoleId));
                    DDDepHead = members.filter(member => member.roles.cache.has(depHeadDDRoleId));
                    AMDDepHead = members.filter(member => member.roles.cache.has(depHeadAMDRoleId));
                    EDDepHead = members.filter(member => member.roles.cache.has(depHeadEDRoleId));
                    JDDepHead = members.filter(member => member.roles.cache.has(depHeadJDRoleId));

                    rddEmbed.addFields({ name: "Заместители главы отдела DD:", value: getMembers(DDDepHead, 1) });
                    rddEmbed.addFields({ name: "Заместители главы отдела RD:", value: getMembers(RDDepHead, 2) });
                    amdEmbed.addFields({ name: "Заместители главы отдела:", value: getMembers(AMDDepHead, 3) });
                    edEmbed.addFields({ name: "Заместители главы отдела:", value: getMembers(EDDepHead, 3) });
                    jdEmbed.addFields({ name: "Заместители главы отдела:", value: getMembers(JDDepHead, 3) });

                    // основной состав

                    RDD = members.filter(member => 
                        member.roles.cache.has(RDDRoleId) &&
                        !member.roles.cache.has(headRDDRoleId) &&
                        !member.roles.cache.has(depHeadRDRoleId) &&
                        !member.roles.cache.has(depHeadDDRoleId) &&
                        !member.roles.cache.has(traineeRoleId));
                    AMD = members.filter(member => 
                        member.roles.cache.has(AMDRoleId) &&
                        !member.roles.cache.has(headAMDRoleId) &&
                        !member.roles.cache.has(depHeadAMDRoleId) &&
                        !member.roles.cache.has(traineeRoleId));
                    ED = members.filter(member => 
                        member.roles.cache.has(EDRoleId) &&
                        !member.roles.cache.has(headEDRoleId) &&
                        !member.roles.cache.has(depHeadEDRoleId) &&
                        !member.roles.cache.has(traineeRoleId));
                    JD = members.filter(member => 
                        member.roles.cache.has(JDRoleId) &&
                        !member.roles.cache.has(headJDRoleId) &&
                        !member.roles.cache.has(depHeadJDRoleId) &&
                        !member.roles.cache.has(traineeRoleId));

                    rddEmbed.addFields(
                        { name: "**\nОсновной состав:\n**", value: " " },
                        { name: " ", value: getMembers(RDD, 0) });
                    amdEmbed.addFields(
                        { name: "**\nОсновной состав:\n**", value: " " },
                        { name: " ", value: getMembers(AMD, 0) });
                    edEmbed.addFields(
                        { name: "**\nОсновной состав:\n**", value: " " },
                        { name: " ", value: getMembers(ED, 0) });
                    jdEmbed.addFields(
                        { name: "**\nОсновной состав:\n**", value: " " },
                        { name: " ", value: getMembers(JD, 0) });

                    // подработка
                    
                    RDpart = members.filter(member => member.roles.cache.has(partWorkRDDRoleId));
                    AMDpart = members.filter(member => member.roles.cache.has(partWorkAMDRoleId));
                    EDpart = members.filter(member => member.roles.cache.has(partWorkEDRoleId));
                    JDpart = members.filter(member => member.roles.cache.has(partWorkJDRoleId));

                    rddEmbed.addFields(
                        { name: "**\nСотрудники при подработке:\n**", value: " " },
                        { name: " ", value: getMembers(RDpart, 0) },
                        { name: " ", value: "-# Информация обновляется каждый час." });
                    amdEmbed.addFields(
                        { name: "**\nСотрудники при подработке:\n**", value: " " },
                        { name: " ", value: getMembers(AMDpart, 0) },
                        { name: " ", value: "-# Информация обновляется каждый час." });
                    edEmbed.addFields(
                        { name: "**\nСотрудники при подработке:\n**", value: " " },
                        { name: " ", value: getMembers(EDpart, 0) },
                        { name: " ", value: "-# Информация обновляется каждый час." });
                    jdEmbed.addFields(
                        { name: "**\nСотрудники при подработке:\n**", value: " " },
                        { name: " ", value: getMembers(JDpart, 0) },
                        { name: " ", value: "-# Информация обновляется каждый час." });
                    
                    let rddMessage = (await rddChannel.messages.fetch()).first();
                    let amdMessage = (await amdChannel.messages.fetch()).first();
                    let edMessage = (await edChannel.messages.fetch()).first();
                    let jdMessage = (await jdChannel.messages.fetch()).first();

                    if (rddMessage) rddMessage.edit({ embeds: [rddEmbed] });
                    else rddChannel.send({ embeds: [rddEmbed] });
                    if (amdMessage) amdMessage.edit({ embeds: [amdEmbed] });
                    else amdChannel.send({ embeds: [amdEmbed] });
                    if (edMessage) edMessage.edit({ embeds: [edEmbed] });
                    else edChannel.send({ embeds: [edEmbed] });
                    if (jdMessage) jdMessage.edit({ embeds: [jdEmbed] });
                    else jdChannel.send({ embeds: [jdEmbed] });
                };
                editChannelMessage();
                setInterval(editChannelMessage, 360000);
            }
        }
    } catch (error) {
        console.log(`Произошла ошибка при обновлении сообщения в канале: ${error}`);
    }
}