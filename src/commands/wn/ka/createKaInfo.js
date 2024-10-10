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
const { Client, Interaction, ApplicationCommandOptionType, PermissionFlagsBits, EmbedBuilder, ButtonBuilder } = require('discord.js');

module.exports = {
    name: 'createkainfo',
    description: 'Добавляет сообщение с выдачей ролей для Trainee Department в выбранном канале.',
    //devOnly: Boolean
    //testOnly: Boolean
    deletedBoston: true,
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

            const inviteEmbed = new EmbedBuilder()
                .setColor(0x3498DB)
                .setTitle('Список команд кадрового аудита бота WN Helper:')
                .setDescription(`\`\`\`/invite - Принятие игрока во фракцию\`\`\`
**Пример использования:**

> /invite **member**:@тег

**Обязательные опции:**

- **member** - Тег сотрудника **или** его никнейм. К примеру: <@343809308967829504> или Michael Lindberg

**Необязательные опции:**

- **static** - Статик сотрудника, которого вы приняли. К примеру: 7658
- **rank** - Ранг, на который принимают сотрудника. К примеру: 1
- **reason** - Причина, по которой человека приняли. К примеру: Собеседование или ДБ

**Важное примечание:**

Бот сам понимает, прописали вы тег сотрудника или его никнейм.

В случае, если указан **тег сотрудника** и не указаны другие данные, опции принимают следующие значения:

- **static** - Автоматически заполняется в зависимости от того, какой статик указан у нового сотрудника в дискорде.
- - В случае, если в его дискорде статик не указан - бот выдаст ошибку.
- **rank** - 1
- **reason** - Собеседование

В случае, если указан **никнейм сотрудника** и не указаны другие данные, опции принимают следующие значения:

- **static** - Автоматически выдаст ошибку при его отсутствии
- **rank** - 1
- **reason** - Собеседование

Также вам не нужно отправлять данную команду в канале кадрового аудита.
Кадровый аудит автоматически заполнится в том канале, в котором необходимо.`);
            
            const rankEmbed = new EmbedBuilder()
                .setColor(0x2ECC70)
                .setDescription(`\`\`\`/rank - Изменение ранга игроку во фракции\`\`\`
**Пример использования:**

> /rank **member**:@тег **action**:Повышен 2-3 **reason**:ДБ

**Обязательные опции:**

- **member** - Тег сотрудника **или** его никнейм. К примеру: <@343809308967829504> или Michael Lindberg
- **action** - Действие с рангом сотрудника. К примеру: Повышен 2-3
- **reason** - Причина повышения сотрудника. К примеру: <ссылка на отчёт на повышение> или ДБ

**Необязательные опции:**

- **static** - Статик сотрудника, которому вы изменяете ранг. К примеру: 7658

**Важное примечание:**

Бот сам понимает, прописали вы тег сотрудника или его никнейм.

В случае, если указан **тег сотрудника** и не указаны другие данные, опции принимают следующие значения:

- **static** - Автоматически заполняется в зависимости от того, какой статик указан у сотрудника в дискорде.
- - В случае, если в его дискорде статик не указан - бот выдаст ошибку.

В случае, если указан **никнейм сотрудника** и не указаны другие данные, опции принимают следующие значения:

- **static** - Автоматически выдаст ошибку при его отсутствии

Также вам не нужно отправлять данную команду в канале кадрового аудита.
Кадровый аудит автоматически заполнится в том канале, в котором необходимо.`);

            const rankReportEmbed = new EmbedBuilder()
                .setColor(0x2ECC70)
                .setDescription(`**Повышение сотрудников по отчёту**

У бота есть функционал для мгновенного повышения сотрудников по отчёту на повышение.
Для этого необходимо нажать правой кнопкой мыши по **отчёту** сотрудника, выбрать **Приложения** и нажать на кнопку **Повысить по отчёту**.
В всплывающем окне необходимо ввести изменение ранга, к примеру: **4-5** и нажать на **Отправить**.
Бот автоматически за вас заполнит кадровый аудит и сам подберёт переменные, которые ему нужны для кадрового аудита.

**Важное примечание:**

Ограничение ввода в поле **Введите изменение ранга:** - 5 символов.
Бот автоматически заполнит строку как **Повышен [ваша строка]**.`);

            const uvalEmbed = new EmbedBuilder()
                .setColor(0xFF2C2C)
                .setDescription(`\`\`\`/uval - Увольнение сотрудника из фракции\`\`\`
**Пример использования:**

> /uval **member**:@тег **reason**:5.4 устава

**Обязательные опции:**

- **member** - Тег сотрудника **или** его никнейм. К примеру: <@343809308967829504> или Michael Lindberg
- **reason** - Причина увольнения сотрудника. К примеру: <ссылка на заявку на увольнение> или пункт устава

**Необязательные опции:**

- **static** - Статик сотрудника, которого вы увольняете. К примеру: 7658

**Важное примечание:**

Бот сам понимает, прописали вы тег сотрудника или его никнейм.

В случае, если указан **тег сотрудника** и не указаны другие данные, опции принимают следующие значения:

- **static** - Автоматически заполняется в зависимости от того, какой статик указан у сотрудника в дискорде.
- - В случае, если в его дискорде статик не указан - бот выдаст ошибку.

Также никнейм сотрудника будет автоматически изменён и все роли, которые у него были (кроме Гражданин, Везунчик и WN Legend) будут с него сняты.
В случае, если роли Гражданин у сотрудника не было, он её получит.

В случае, если указан **никнейм сотрудника** и не указаны другие данные, опции принимают следующие значения:

- **static** - Автоматически выдаст ошибку при его отсутствии

Также вам не нужно отправлять данную команду в канале кадрового аудита.
Кадровый аудит автоматически заполнится в том канале, в котором необходимо.`)
                .setFooter({ text: 'WN Helper by Michael Lindberg. Discord: milkgames', iconURL: 'https://i.imgur.com/zdxWb0s.jpeg' })

            const embeds = [inviteEmbed, rankEmbed, rankReportEmbed, uvalEmbed];

            await channel.send({ embeds: embeds });
            await interaction.reply({
                content: `Сообщение создано успешно в канале ${channel}!`,
                ephemeral: true,
            });
            return;
        } catch (error) {
            console.log(`Произошла ошибка при создании сообщения с информацией о кадровом аудите: ${error}`);
            await interaction.reply({
                content: `Произошла ошибка при создании сообщения с информацией о кадровом аудите: ${error}`,
                ephemeral: true,
            });
        }
    },
};