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
const { ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder } = require('discord.js');
const config = require('../../../config.json');
const express = require('express');

module.exports = async (client) => {
    const app = express();
    const PORT = 80;

    app.use(express.json());

    app.get('/webhook', (req, res) =>{
        res.status(200).send('r7teciyheoq2a');
    });

    app.post('/webhook', async (req, res) => {
        try {
            const data = req.body;
            let testName = data.testName;
            let quickLink;
            switch (testName) {
                case "Тест на знание устава Weazel News | Dallas":
                    testName = "Устав";
                    quickLink = "https://app.onlinetestpad.com/tests/2h5yvxravpgmw/statistics/table";
                    break;
                case "Упрощённый тест на знание ПРО и ППО Weazel News | Dallas":
                    testName = "ПРО и ППО (упрощённый)";
                    quickLink = "https://app.onlinetestpad.com/tests/2zogqqsz34kpc/statistics/table";
                    break;
                case "Тест на знание ПРО и ППО Weazel News | Dallas":
                    testName = "ПРО и ППО (тестовый)";
                    quickLink = "https://app.onlinetestpad.com/tests/7vchtj53hnzui/statistics/table";
                    break;
                case "Письменный тест на знание ПРО и ППО Weazel News | Dallas":
                    testName = "ПРО и ППО (письменный)";
                    quickLink = "https://app.onlinetestpad.com/tests/qi7qrikeg7fxk/handchecks";
                    break;
            }
            const testUrl = data.url;
            const testMember = data.regparams[0].value;
            const testScore = data.results[0].value;
            const guildId = Object.keys(config.servers)[2];
            const guild = await client.guilds.fetch(guildId);
            const members = await guild.members.fetch();
            const nicknamePart = testMember.match(/\d+/);
            let member = members.find(member => member.displayName.includes(nicknamePart));
            if (!member) {
                member = members.find(member => member.displayName.includes(testMember));
                if (!member) member = "Пользователь не найден.";
            }
            let title = "Новая сдача экзамена! - НА РАССМОТРЕНИИ";
            let color = 0x3498DB;
            const examinerRoleId = config.servers[guildId].examinerRoleId;
            let content = `<@&${examinerRoleId}>`;
            if (member === "Пользователь не найден.") {
                title = "Новая сдача экзамена! - БРАК";
                color = 0xFF0000;
            }

            const examEmbed = new EmbedBuilder()
                .setColor(color)
                .setTitle(`${title}`)
                .addFields(
                    { name: 'Название экзамена:', value: `${testName}` },
                    { name: 'Ссылка на результат:', value: `${testUrl}` },
                    { name: 'Пользователь назвал себя как:', value: `${testMember}` },
                    { name: 'Результат поиска пользователя:', value: `${member}`},
                )
                .setTimestamp()
                .setFooter({ text: 'WN Helper by Michael Lindberg. Discord: milkgames', iconURL: 'https://i.imgur.com/zdxWb0s.jpeg' });

            if (testName !== "ПРО и ППО (письменный)") {
                if (testScore > 7) {
                    examEmbed.addFields({ name: 'Результат экзамена:', value: `${testScore} / 10 - СДАНО ✅`});
                }
                else {
                    examEmbed.addFields({ name: 'Результат экзамена:', value: `${testScore} / 10 - НЕ СДАНО ❌`});
                }
            }
            else {
                examEmbed.addFields({ name: 'Экзамен необходимо проверить.', value: ` `});
            }

            examEmbed.addFields({ name: 'Ссылка на быструю проверку экзамена:', value: `${quickLink}`});

            const row = new ActionRowBuilder();

            row.components.push(
                new ButtonBuilder()
                    .setCustomId('exam-confirm')
                    .setLabel('Сдано')
                    .setStyle(ButtonStyle.Success)
            );

            row.components.push(
                new ButtonBuilder()
                    .setCustomId('exam-decline')
                    .setLabel('Не сдано')
                    .setStyle(ButtonStyle.Danger)
            );

            row.components.push(
                new ButtonBuilder()
                    .setCustomId('exam-spam')
                    .setLabel('Брак')
                    .setStyle(ButtonStyle.Danger)
            );
            
            const examChannelId = config.servers[guildId].examChannelId;
            const examChannel = await client.channels.fetch(examChannelId);
            if (member === "Пользователь не найден.") {
                examChannel.send({ 
                    embeds: [examEmbed]
                });
            }
            else {
                examChannel.send({ 
                    content: content,
                    embeds: [examEmbed],
                    components: [row]
                });
            }
            res.status(200).send('Принято');
        } catch (error) {
            console.log(`Произошла ошибка при принятии результатов экзамена: ${error}`);
            res.status(400).send('Ошибка на стороне клиента');
        }
    });

    app.listen(PORT, () => {
        console.log(`Сервер запущен на порту: ${PORT}`);
    });
}