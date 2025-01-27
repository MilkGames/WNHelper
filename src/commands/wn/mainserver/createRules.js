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
const config = require('../../../../config.json');
const { ApplicationCommandOptionType, PermissionFlagsBits, EmbedBuilder } = require('discord.js');

module.exports = {
    name: 'createrules',
    description: 'Добавляет сообщение с правилами дискорда в выбранном канале.',
    //devOnly: Boolean
    //testOnly: Boolean
    mainOnly: true,
    options: [
        {
            name: 'channel',
            description: 'Выберите канал, в который будет отправлено сообщение.',
            required: true,
            type: ApplicationCommandOptionType.Channel,
        },
    ],
    permissionsRequired: [PermissionFlagsBits.Administrator],
    botPermissions: [PermissionFlagsBits.ManageRoles],

    callback: async (client, interaction) => {
        try {
            const channel = interaction.options.getChannel('channel');
            if (!channel) return;

            const descriptionEmbed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle("Официальные правила данного дискорда")
                .setDescription(`Язык общения на сервере: русский.
Данный дискорд сервер **не является** официальным дискорд сервером проекта Majestic RP, на нём не действуют правила данного проекта и модерация со стороны администраторов данного проекта **не производится**!`);

            const sViolationsEmbed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle("1. Грубые нарушения")
                .setDescription(`1.1. Запрещены оскорбления любого характера в любом виде.
1.2. Запрещено спамить упоминаниями (@).
1.3. Запрещён флуд (частая отправка однотипных сообщений).
1.4. Запрещены угрозы в любой форме.
1.5. Запрещён постинг любого NSFW контента в общедоступных каналах.
1.6. Запрещены провокации администрации и участников дискорд-сервера, а также токсичное поведение в чатах и голосовых каналах.
1.7. Запрещено иметь аватарки (или статусы) содержащие оскорбительный или NSFW контент.
1.8. Запрещено выдавать себя за создателя WN Helper / команду и/или руководство проекта Majestic RP.`);

            const lsViolationsEmbed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle("2. Нарушения низкой степени грубости")
                .setDescription(`2.1. Запрещены аудио или видеофайлы с крайне высокой громкостью (скримеры и др.).
2.2. Запрещена дезинформация в любом виде.
2.3. В голосовых каналах запрещено издавать какие либо неприятные, раздражающие или громкие звуки.
2.4. Любые предложения/идеи/баги/критика сообщаются исключительно в канал <#1293921827080503439>.`);

            const genProvisionsEmbed = new EmbedBuilder()
                .setColor(0xFF0000)
                .setTitle("3. Общие положения")
                .setDescription(`3.1. Правила распространяются **исключительно** на этот дискорд сервер.
3.2. За нарушения правил Вы можете получить мут/тайм-аут/кик/бан на дискорд сервере.
3.3. Обжаловать любое наказание можно у <@343809308967829504>.
3.4. Система наказаний работает по нарастающему принципу (сначала предупреждение, затем мут, затем кик, затем бан).
\`\`\`diff
-Исключение: за грубое нарушение возможна выдача самого строгого наказания.\`\`\`
3.5. Лидеры и заместители лидера WN автоматически получают доступ к тестированию бота WN Helper и специальные ники, выделяющие их
3.6. Не существует единой формы ников на данном сервере, за исключением лидеров/заместителей лидера WN.
В данном случае форма ника следующая: Сервер | Имя Фамилия
\`\`\`Пример: Dallas | Michael Lindberg\`\`\``)
                .setFooter({ text: 'WN Helper by Michael Lindberg. Discord: milkgames', iconURL: 'https://i.imgur.com/zdxWb0s.jpeg' });
            
            const embeds = [descriptionEmbed, sViolationsEmbed, lsViolationsEmbed, genProvisionsEmbed];
            await channel.send({ embeds: embeds });
            await interaction.reply({
                content: `Сообщение создано успешно в канале ${channel}!`,
                ephemeral: true,
            });
            return;
        } catch (error) {
            console.log(`Произошла ошибка при публикации правил: ${error}.`);
            await interaction.reply({
                content: `Произошла ошибка при публикации правил: ${error}.`,
                ephemeral: true,
            });
        }
    },
};
