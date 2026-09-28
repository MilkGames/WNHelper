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
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    PermissionFlagsBits,
} = require('discord.js');
const { getStaffAuditSettings } = require('../staff-audit');
const { getStaffListSettings } = require('../staff-lists');
const giveRolesService = require('../give-roles');
const staffAuditService = require('../staff-audit');
const examinationService = require('../examination');
const examinationInteractionService = require('../examination');
const vacationService = require('../vacations');
const {
    editMessageWithRetry,
    sendMessageWithRetry,
} = require('../../core/discord/request');
const { mutateDatabase, readDatabase } = require('./database');
const { getRulesPublicationGuildIds } = require('../../core/config/applicationConfig');
const { getDefaultFooter } = require('../../core/ui/defaultFooter');


function clone(value) {
    return value == null ? value : structuredClone(value);
}

function canPublishDiscordRules(guildId) {
    return getRulesPublicationGuildIds().has(String(guildId || ''));
}

function getPublicationRecord(guildId, kind) {
    const record = (readDatabase().settingsPublications || []).find((entry) => (
        String(entry.guildId) === String(guildId) && String(entry.kind) === String(kind)
    ));
    return record ? clone(record) : null;
}

async function savePublicationRecord({ guildId, kind, channelId, messageIds, metadata = null }) {
    return mutateDatabase((db) => {
        if (!Array.isArray(db.settingsPublications)) db.settingsPublications = [];
        const index = db.settingsPublications.findIndex((entry) => (
            String(entry.guildId) === String(guildId) && String(entry.kind) === String(kind)
        ));
        const now = Date.now();
        const record = {
            guildId: String(guildId),
            kind: String(kind),
            channelId: String(channelId),
            messageIds: (Array.isArray(messageIds) ? messageIds : [messageIds]).map(String),
            metadata: metadata && typeof metadata === 'object' ? clone(metadata) : null,
            createdAt: index === -1 ? now : db.settingsPublications[index].createdAt,
            updatedAt: now,
        };
        if (index === -1) db.settingsPublications.push(record);
        else db.settingsPublications[index] = record;
        return clone(record);
    });
}

async function fetchTrackedMessages(client, record) {
    if (!record?.channelId || !record.messageIds?.length) return null;
    const channel = await client.channels.fetch(record.channelId).catch(() => null);
    if (!channel?.messages?.fetch) return null;
    const messages = [];
    for (const messageId of record.messageIds) {
        const message = await channel.messages.fetch(messageId).catch(() => null);
        if (!message) return null;
        messages.push(message);
    }
    return { channel, messages };
}

async function publishPayloads(client, {
    guild,
    kind,
    channel,
    payloads,
    mode = 'new',
    nonceKey,
    metadata = null,
}) {
    const normalizedPayloads = Array.isArray(payloads) ? payloads : [payloads];
    let messages = [];
    let targetChannel = channel;

    if (mode === 'update') {
        const existing = getPublicationRecord(guild.id, kind);
        const tracked = await fetchTrackedMessages(client, existing);
        if (!tracked || tracked.messages.length !== normalizedPayloads.length) {
            const error = new Error('Ранее опубликованное сообщение не найдено. Опубликуйте новое сообщение.');
            error.userMessage = error.message;
            throw error;
        }
        targetChannel = tracked.channel;
        for (let index = 0; index < normalizedPayloads.length; index += 1) {
            await editMessageWithRetry(tracked.messages[index], normalizedPayloads[index]);
        }
        messages = tracked.messages;
    } else {
        for (let index = 0; index < normalizedPayloads.length; index += 1) {
            messages.push(await sendMessageWithRetry(targetChannel, normalizedPayloads[index], {
                nonceSeed: `settingsPublication:${kind}:${guild.id}:${targetChannel.id}:${nonceKey}:${index + 1}`,
            }));
        }
    }

    const channelId = String(targetChannel.id || messages[0]?.channelId);
    const messageIds = messages.map((message) => String(message.id));
    await savePublicationRecord({ guildId: guild.id, kind, channelId, messageIds, metadata });
    return {
        channelId,
        messageId: messageIds[0],
        messageIds,
        messageLink: `https://discord.com/channels/${guild.id}/${channelId}/${messageIds[0]}`,
        updated: mode === 'update',
    };
}

function buildDiscordRulesPayload() {
    const descriptionEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('Официальные правила данного дискорда')
        .setDescription(`Язык общения на сервере: русский.
Данный дискорд сервер **не является** официальным дискорд сервером проекта Majestic RP, на нём не действуют правила данного проекта и модерация со стороны администраторов данного проекта **не производится**!`);

    const severeViolationsEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('1. Грубые нарушения')
        .setDescription(`1.1. Запрещены оскорбления любого характера в любом виде.
1.2. Запрещено спамить упоминаниями (@).
1.3. Запрещён флуд (частая отправка однотипных сообщений).
1.4. Запрещены угрозы в любой форме.
1.5. Запрещён постинг любого NSFW контента в общедоступных каналах.
1.6. Запрещены провокации администрации и участников дискорд-сервера, а также токсичное поведение в чатах и голосовых каналах.
1.7. Запрещено иметь аватарки (или статусы) содержащие оскорбительный или NSFW контент.
1.8. Запрещено выдавать себя за создателя WN Helper / команду и/или руководство проекта Majestic RP.`);

    const minorViolationsEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('2. Нарушения низкой степени грубости')
        .setDescription(`2.1. Запрещены аудио или видеофайлы с крайне высокой громкостью (скримеры и др.).
2.2. Запрещена дезинформация в любом виде.
2.3. В голосовых каналах запрещено издавать какие либо неприятные, раздражающие или громкие звуки.
2.4. Любые предложения/идеи/баги/критика сообщаются исключительно в канал <#1293921827080503439>.`);

    const generalProvisionsEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('3. Общие положения')
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
        .setFooter(getDefaultFooter());

    return {
        embeds: [descriptionEmbed, severeViolationsEmbed, minorViolationsEmbed, generalProvisionsEmbed],
        allowedMentions: { parse: [] },
    };
}

function ensureTextChannel(guild, channel, label = 'Выбранный канал', { embedLinks = false } = {}) {
    if (!channel?.isTextBased?.() || typeof channel.send !== 'function') {
        const error = new Error(`${label} недоступен или не поддерживает сообщения.`);
        error.userMessage = error.message;
        throw error;
    }

    const me = guild?.members?.me;
    const permissions = me && typeof channel.permissionsFor === 'function'
        ? channel.permissionsFor(me)
        : null;
    if (permissions?.has) {
        const required = [
            [PermissionFlagsBits.ViewChannel, 'просматривать канал'],
            [PermissionFlagsBits.SendMessages, 'отправлять сообщения'],
            ...(embedLinks ? [[PermissionFlagsBits.EmbedLinks, 'встраивать ссылки']] : []),
        ];
        const missing = required
            .filter(([permission]) => !permissions.has(permission))
            .map(([, labelText]) => labelText);
        if (missing.length) {
            const error = new Error(`${label}: у бота нет прав ${missing.join(', ')}.`);
            error.userMessage = error.message;
            throw error;
        }
    }
    return channel;
}

async function resolvePublicationChannel(client, guild, {
    kind,
    requestedChannelId,
    mode,
    label,
    embedLinks = false,
}) {
    let channelId = requestedChannelId;
    if (mode === 'update') {
        const existing = getPublicationRecord(guild.id, kind);
        channelId = existing?.channelId || null;
        if (!channelId) {
            const error = new Error('Ранее опубликованное сообщение не зарегистрировано. Опубликуйте новое сообщение.');
            error.userMessage = error.message;
            throw error;
        }
    }

    const channel = guild.channels.cache.get(channelId)
        || await client.channels.fetch(channelId).catch(() => null);
    return ensureTextChannel(guild, channel, label, { embedLinks });
}

function roleList(roleIds) {
    return roleIds.length ? roleIds.map((roleId) => `<@&${roleId}>`).join(', ') : 'не настроены';
}

function validateGiveRolesPanel(guild, config) {
    if (config?.features?.giveRoles !== true) return ['Функция выдачи ролей отключена.'];
    return giveRolesService.getCreateMessageErrors(guild, config);
}

function buildGiveRolesPanelPayload() {
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('gr-open-modal')
            .setLabel('Подать заявку на роли')
            .setStyle(ButtonStyle.Primary)
    );
    const text =
        `Чтобы подать заявку на получение начальных ролей Weazel News, нажмите кнопку ниже и заполните форму.\n\n` +
        `Заявки, составленные не по форме, могут быть отклонены.\n\n` +
        `Если вам нужны дополнительные должностные или служебные роли, ` +
        `обратитесь к руководству Weazel News.\n` +
        `Если вы новый куратор фракции, пинганите Главного Куратора ` +
        `государственных фракций или его заместителя в любом другом канале.\n` +
        `-# WN Helper by Michael Lindberg. Discord: milkgames`;
    return {
        content: text,
        components: [row],
        allowedMentions: { parse: [] },
    };
}

async function publishGiveRolesPanel(client, { guild, config, nonceKey, mode = 'new' }) {
    const errors = validateGiveRolesPanel(guild, config);
    if (errors.length) {
        const error = new Error(errors.join('\n'));
        error.userMessage = `Панель выдачи ролей нельзя опубликовать:\n${errors.map((entry) => `- ${entry}`).join('\n')}`;
        throw error;
    }
    const channel = await resolvePublicationChannel(client, guild, {
        kind: 'giveRoles',
        requestedChannelId: config.channels?.getRoleChannelId,
        mode,
        label: 'Канал подачи заявок на выдачу ролей',
    });
    return publishPayloads(client, {
        guild,
        kind: 'giveRoles',
        channel,
        payloads: buildGiveRolesPanelPayload(),
        mode,
        nonceKey,
    });
}

function buildKaInfoPayloads(config) {
    staffAuditService.assertFeatureEnabled(config);
    const settings = getStaffAuditSettings(config);
    const staffListSettings = getStaffListSettings(config);
    const initialRank = giveRolesService.getInitialRank(config);
    const inviteDepartment = giveRolesService.getInviteDepartment(config);
    const giveRolesSettings = giveRolesService.getGiveRolesSettings(config);
    const dbRank = giveRolesSettings.dbRankNumber
        ? staffAuditService.getRank(config, giveRolesSettings.dbRankNumber)
        : null;
    const transitionRank = settings.departmentTransitionRankNumber;
    const footer = getDefaultFooter();

    const overviewEmbed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle('Как работает кадровый аудит бота WN Helper')
        .setDescription([
            'Кадровый аудит объединяет само действие в Discord и запись о нём. Готовые записи принятия, изменения ранга и увольнения отправляются в ' +
                (settings.channelId ? `<#${settings.channelId}>` : '**основной канал пока не настроен**') +
                ', даже если команда вызвана в другом месте.',
            '',
            '**Начать действие можно несколькими способами:**',
            '- slash-команды: `/invite`, `/rank`, `/uval` и `/massaudit`',
            '- меню **Приложения** (ПКМ на компьютере) на участнике: **Принять сотрудника**, **Изменить ранг**, **Уволить сотрудника**',
            '- меню **Приложения** (ПКМ на компьютере) на сообщении: **Повысить по отчёту** и **Уволить по заявлению**',
            '',
            'Контекстные команды на сообщении не умеют сами определять, утверждён ли отчёт или заявление. Они доверяют фиксированной структуре первого embed, поэтому запускайте их только на сообщениях нужной формы.',
            '',
            'Если целью выбран участник сервера, бот берёт статик из цифр в конце никнейма. Когда цифр нет, передайте `static`, если выбранный способ это позволяет. Текстовое имя без Discord ID всегда требует `static` и создаёт только запись КА без изменения ролей и никнейма.',
            '',
            'Активный отпуск может закрывать доступ к кадровому аудиту. Это зависит от выбранного типа отпуска; при блокировке бот покажет ссылку на заявку.',
        ].join('\n'));

    const safetyEmbed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle('Как бот проверяет ранги и права')
        .setDescription([
            'Проверки немного отличаются в зависимости от способа запуска, поэтому здесь важны детали.',
            '',
            '- для изменения ранга участника исполнитель обычно должен иметь ровно одну настроенную роль ранга',
            '- исключение: при повышении на ранг без Discord-роли исполнитель без роли ранга может провести операцию; сравнение иерархии пропускается, но правило выдачи целевого ранга продолжает действовать',
            '- в `/rank` текущим считается ранг слева в `action`; если у него есть Discord-роль, она должна быть у сотрудника',
            '- в меню на участнике несколько ролей рангов сразу блокируют запуск; текущий ранг определяется по роли или подтверждается вручную, если в настройках есть ранги без ролей',
            '- в массовом КА текущим считается ранг слева в `action`; если у сотрудника найдена роль ранга, она сверяется с этим числом',
            '- текущий и новый ранги участника должны быть ниже ранга исполнителя',
            '- текстовая запись без Discord-участника не проходит проверку иерархии, потому что сравнивать роли невозможно',
            '- право выдать выбранный ранг отдельно определяется его правилом: без ограничений, только для выбранных ролей или запрещено',
            '- повышение участника может быть заблокировано активным взысканием',
            '',
            'Перед изменением ролей бот проверяет, существуют ли нужные роли и может ли он ими управлять. С никнеймами поведение различается: при выходе из стажировочного отдела и увольнении невозможность изменить никнейм останавливает операцию, а при принятии ошибка никнейма записывается в лог, но уже выданные роли и запись КА не откатываются.',
        ].join('\n'));

    const inviteEmbed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle('Принятие сотрудника')
        .setDescription([
            '**Команда:** `/invite member:<сотрудник>`',
            '**Через меню:** участник -> **Приложения** -> **Принять сотрудника**',
            '',
            '**Значения по умолчанию:**',
            '- ранг: ' + (initialRank ? `**${initialRank.number} - ${initialRank.name}**` : '**начальный ранг не настроен**'),
            '- причина: `Собеседование`',
            '- отдел: ' + (inviteDepartment ? `**${inviteDepartment.shortName} - ${inviteDepartment.fullName}**` : '**отдел не настроен**'),
            '',
            'Для принятия отдельное сравнение ранга сотрудника с рангом исполнителя не выполняется. Доступ определяется правилом выдачи выбранного ранга.',
            '',
            'Для участника сервера бот выдаёт недостающие основную роль Weazel News, роль выбранного ранга, если она настроена, и роль основного состава отдела. Затем он пытается привести никнейм к формату `ОТДЕЛ | Имя Фамилия | Статик`.',
            '',
            'Если `department` передан явно или отдел выбран в меню, он считается выбранным вручную и указывается отдельным полем в записи КА. Когда он отличается от стандартного отдела принятия, роль стандартного отдела снимается.',
            '',
            'Ранг без Discord-роли также допустим как значение по умолчанию: запись КА создаётся, но роль ранга не выдаётся. Для текстового имени роли и никнейм не меняются вообще.',
        ].join('\n'));

    const rankEmbed = new EmbedBuilder()
        .setColor(0x2ECC70)
        .setTitle('Изменение ранга')
        .setDescription([
            '**Команда:** `/rank member:<сотрудник> action:2-3 reason:<причина>`',
            '**Через меню:** участник -> **Приложения** -> **Изменить ранг**',
            '',
            '`action` принимает переход вида `2-3` или `4-2`. Оба числа должны соответствовать настроенным рангам и не могут совпадать.',
            '',
            'После проверок бот снимает у сотрудника все другие настроенные роли рангов и выдаёт роль нового ранга. Поэтому лишняя старая роль ранга тоже будет удалена. Если у нового ранга Discord-роли нет, старые настроенные роли рангов снимаются, а новая роль не появляется.',
            '',
            'В `/rank` ранг слева является заявленным текущим рангом. Если у него настроена роль, сотрудник обязан её иметь; наличие других ролей рангов само по себе slash-команду не останавливает, потому что они будут синхронизированы.',
            '',
            'В меню на участнике несколько ролей рангов блокируют открытие. Если все ранги имеют роли, текущий ранг берётся из единственного совпадения; если хотя бы один ранг роли не имеет, интерфейс просит подтвердить текущий ранг вручную. Сессия действует 15 минут.',
            '',
            'Для текстового имени изменение ролей, отдела и никнейма не выполняется: создаётся только запись КА.',
        ].join('\n'));

    const promotionEmbed = new EmbedBuilder()
        .setColor(0x2ECC70)
        .setTitle('Повышения, дневной лимит и ДБ')
        .setDescription([
            'Для Discord-участника обычно доступно только **одно повышение за московский календарный день**. Любой переход на больший номер ранга расходует лимит; понижения и `/invite` его не расходуют. Для текстовой записи без Discord ID дневной лимит не применяется.',
            '',
            `Роли, которые обходят лимит: ${roleList(settings.promotionLimitBypassRoleIds)}.`,
            '',
            `Дата назначения директора: ${staffListSettings.leaderAppointmentDate ? `**${staffListSettings.leaderAppointmentDate}**` : '**не настроена**'}. Срок директора: **${staffListSettings.leaderTermDays} дней**.`,
            'Период открытых дверей (День Блата) действует в день назначения или очередного срока директора и весь следующий московский день. В этот период дневной лимит отключён.',
            '',
            dbRank
                ? `Кнопка **Одобрить (ДБ)** появляется в новых заявках на выдачу ролей только в этот период. Настроенный ранг ДБ: **${dbRank.number} - ${dbRank.name}**. Если у ранга нет Discord-роли, он будет указан в кадровом аудите без выдачи отдельной роли.`
                : 'Кнопка **Одобрить (ДБ)** не появится, пока для ДБ не выбран существующий ранг.',
            '',
            'Резерв дневного повышения создаётся до изменения ролей. Это не позволяет двум одновременным действиям провести сотруднику два повышения за один день.',
        ].join('\n'));

    const transitionEmbed = new EmbedBuilder()
        .setColor(0x2ECC70)
        .setTitle('Выход из стажировочного отдела')
        .setDescription([
            transitionRank
                ? `Порог автоматического перехода настроен на **${transitionRank} ранг**.`
                : 'Порог не настроен, поэтому автоматическая смена отдела отключена.',
            '',
            'Переход запускается только при повышении, которое пересекает порог. Например, при пороге `3` действие `1-2` ничего не меняет, а `2-3` и `1-3` запускают переход.',
            '',
            'У участника должна быть ровно одна роль постоянного отдела, отличного от стандартного стажировочного. Бот оставляет эту роль, снимает роль стажировочного отдела, если она есть, и меняет префикс никнейма на постоянный отдел.',
            '',
            'Если постоянный отдел не найден, найдено несколько отделов, бот не может снять стажировочную роль или изменить никнейм, операция останавливается до изменения ранговых ролей.',
            '',
            '`keep_department:true` в `/rank` или массовом КА и кнопка **Отдел: не менять** в меню отключают этот переход. Для текстовой записи смена отдела никогда не выполняется.',
        ].join('\n'));

    const reportEmbed = new EmbedBuilder()
        .setColor(0x2ECC70)
        .setTitle('Повышение по отчёту')
        .setDescription([
            'Откройте меню **Приложения** у сообщения и выберите **Повысить по отчёту**.',
            '',
            'Бот не проверяет автора, статус или текст "одобрено". Он читает только фиксированные поля первого embed:',
            '- целевой ранг - из второго поля',
            '- Discord ID сотрудника - из последнего поля',
            '- причина записи КА - ссылка на исходное сообщение',
            '',
            'Начальным становится ближайший настроенный ранг ниже целевого. Затем применяются обычные проверки изменения ранга, включая роль начального ранга, иерархию, право выдачи, взыскания и дневной лимит.',
            '',
            'После изменения ролей, возможного перехода отдела и публикации записи КА бот пытается поставить на исходное сообщение реакцию ✅. Если сообщение удалено или реакцию поставить нельзя, выполненное кадровое действие не откатывается.',
        ].join('\n'));

    const dismissalEmbed = new EmbedBuilder()
        .setColor(0xFF2C2C)
        .setTitle('Увольнение сотрудника')
        .setDescription([
            '**Команда:** `/uval member:<сотрудник> reason:<причина>`',
            '**Через меню:** участник -> **Приложения** -> **Уволить сотрудника**',
            '**По сообщению:** **Приложения** -> **Уволить по заявлению**',
            '',
            'Увольнять самого себя нельзя. Если у сотрудника найдена одна настроенная роль ранга, исполнитель тоже должен иметь ровно одну роль ранга, а его ранг должен быть выше. Несколько ролей рангов у сотрудника блокируют увольнение. Если роль ранга не найдена, проверка иерархии пропускается.',
            '',
            'Обычное увольнение участника может быть остановлено активным взысканием. Новая операция для того же сотрудника не создаётся, пока предыдущая выполняется или требует восстановления.',
            '',
            `При снятии ролей всегда сохраняются @everyone, интеграционные управляемые роли Discord и следующие настроенные исключения: ${roleList(settings.dismissalKeepRoleIds)}. Все остальные роли должны быть доступны боту и снимаются. Невозможность снять хотя бы одну такую роль или изменить никнейм останавливает этот шаг.`,
            '',
            'Для текстового имени роли и никнейм не меняются, лимит увольнений не расходуется и подтверждение сверх лимита не требуется. Бот создаёт запись КА и закрывает связанные взыскания по статику, если они найдены.',
        ].join('\n'));

    const dismissalLimitEmbed = new EmbedBuilder()
        .setColor(0xFF2C2C)
        .setTitle('Лимит увольнений и подтверждение')
        .setDescription([
            `Лимит для одного исполнителя: **${settings.dismissalLimitCount} увольнений участников Discord** за скользящее окно **${settings.dismissalLimitWindowMinutes} минут**.`,
            `Роли без лимита: ${roleList(settings.dismissalLimitExemptRoleIds)}.`,
            '',
            'Следующее увольнение после достижения лимита резервируется, но не выполняется сразу: оно отправляется на подтверждение.',
            `Канал подтверждения: ${settings.dismissalApprovalChannelId ? `<#${settings.dismissalApprovalChannelId}>` : '**не настроен**'}.`,
            `Подтверждающие роли: ${roleList(settings.dismissalApprovalRoleIds)}.`,
            '',
            'Если канал или роли подтверждения не настроены, бот сохранит заблокированную операцию и сообщит об ошибке вместо увольнения. Исполнитель не может подтвердить собственную операцию сверх лимита.',
            '',
            'В массовом КА несколько ожидающих подтверждения увольнений одного исполнителя и одного сервера могут быть собраны в одно сообщение.',
        ].join('\n'));

    const offboardingEmbed = new EmbedBuilder()
        .setColor(0xFF2C2C)
        .setTitle('Что закрывает увольнение')
        .setDescription([
            'Увольнение выполняется по шагам и затрагивает связанные процессы. Для Discord-участника бот последовательно:',
            '',
            '- закрывает активные заявки на выдачу ролей',
            '- закрывает очереди экзаменации, попытки и заявки на лекции или пересдачи',
            '- завершает активные отпуска',
            '- освобождает занятые смены',
            '- закрывает связанные взыскания',
            '- снимает роли и удаляет префикс отдела или должности из никнейма',
            '- публикует запись увольнения',
            '- пытается поставить ✅ на исходное заявление, если увольнение запущено через него',
            '- отменяет другие ожидающие строки массового КА для уже уволенного сотрудника',
            '- ставит в очередь обновление составов, счётчиков и сообщений смен',
            '',
            'Завершённые шаги сохраняются. Если операция оборвалась, `/manualtools retry_uval` продолжит её без повторения отмеченных шагов. Повторить своё увольнение может исходный исполнитель, чужое - пользователь с ролью подтверждения увольнений.',
        ].join('\n'));

    const massAuditEmbed = new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle('Массовый кадровый аудит')
        .setDescription([
            '`/massaudit` без параметров открывает форму. Параметр `file` принимает только TXT-файл до 100 КБ.',
            `В одном пакете разрешено до **${settings.massAuditMaxItems} операций**, и один сотрудник может встречаться только один раз. Для текстовых целей дубликаты определяются по \`static\`.`,
            '',
            '**Примеры строк:**',
            '`invite member:123456789012345678 rank:1 department:rdd static:7658 reason:"Собеседование"`',
            '`rank member:123456789012345678 static:7658 action:2-3 reason:"Отчёт" keep_department:false`',
            '`uval member:Michael Lindberg static:7658 reason:"ПСЖ"`',
            '',
            '`member` принимает числовой Discord ID, техническую запись `<@ID>` или обычное текстовое имя. `@username` и username не используются для поиска Discord-участника: при наличии `static` они будут сохранены как буквальный текст. Текстовое имя может содержать пробелы без кавычек до следующего параметра `key:` и всегда требует `static`.',
            '',
            'Во всех трёх действиях для Discord-участника бот сначала ищет статик в конце никнейма, а если его там нет - использует переданный `static`. Для текстовой цели роли и никнейм не изменяются: создаётся только запись КА.',
            '',
            'До подтверждения бот проверяет весь пакет: существующих Discord-участников, настройки ролей, иерархию, правила выдачи и взыскания. Запустить или отменить пакет может только создатель, а подтверждение действует 24 часа.',
            '',
            'Строки выполняются последовательно. Ошибка одной строки не останавливает остальные. Перед первым выполнением строки с Discord-участником бот сравнивает никнейм и роли с предпросмотром; изменившаяся строка пропускается. Для текстовой цели такое сравнение не применяется.',
            '',
            '`/manualtools retry_massaudit` повторяет строки со статусом ошибки и продолжает уже подтверждённые увольнения; команда доступна создателю пакета. Если первая попытка уже успела изменить роли или никнейм, повторная проверка может отметить строку как изменившуюся - такую ситуацию нужно сверить вручную. Завершённые, отклонённые и пропущенные строки автоматически не повторяются.',
        ].join('\n'));

    const deleteEmbed = new EmbedBuilder()
        .setColor(0xF39C12)
        .setTitle('Запрос на удаление записи КА')
        .setDescription([
            `Добавьте реакцию ❌ к сообщению в ${settings.channelId ? `<#${settings.channelId}>` : '**основном канале КА**'}.`,
            settings.deleteRequestChannelId
                ? `Бот отправит ссылку на запись в <#${settings.deleteRequestChannelId}>.`
                : 'Канал запросов на удаление пока не настроен.',
            `Уведомляемые роли: ${roleList(settings.deleteNotifyRoleIds)}.`,
            '',
            'Обработчик не проверяет кадровый ранг или специальную роль пользователя, поставившего реакцию. Он работает только в основном канале КА и только когда настроены канал запросов и хотя бы одна уведомляемая роль.',
            '',
            'Исходное сообщение автоматически не удаляется. Ответственные получают ссылку и принимают решение вручную.',
        ].join('\n'));

    const recoveryEmbed = new EmbedBuilder()
        .setColor(0xF39C12)
        .setTitle('Если действие завершилось не полностью')
        .setDescription([
            'Не запускайте ту же операцию заново без проверки. Скопируйте ID из ответа или лога и используйте подходящий инструмент:',
            '',
            '- принятие или изменение ранга: `/manualtools retry_staff_action operation_id:<ID>`',
            '- увольнение: `/manualtools retry_uval uval_id:<ID>`',
            '- массовый КА: `/manualtools retry_massaudit massaudit_id:<ID>`',
            '',
            'Принятие, изменение ранга и увольнение сохраняют завершённые шаги и продолжаются с незавершённой части. Отправка записей использует стабильные идентификаторы сообщений, чтобы снизить риск дублей при повторе.',
            '',
            'Массовый КА работает иначе: он повторяет только строки со статусом ошибки и заново сверяет состояние участника. Поэтому итог каждого повторного запуска обязательно нужно прочитать, а не считать весь пакет автоматически завершённым.',
        ].join('\n'))
        .setFooter(footer);

    return [
        { embeds: [overviewEmbed, safetyEmbed], allowedMentions: { parse: [] } },
        { embeds: [inviteEmbed, rankEmbed], allowedMentions: { parse: [] } },
        { embeds: [promotionEmbed, transitionEmbed, reportEmbed], allowedMentions: { parse: [] } },
        { embeds: [dismissalEmbed, dismissalLimitEmbed], allowedMentions: { parse: [] } },
        { embeds: [offboardingEmbed, massAuditEmbed], allowedMentions: { parse: [] } },
        { embeds: [deleteEmbed, recoveryEmbed], allowedMentions: { parse: [] } },
    ];
}
async function publishKaInfo(client, { guild, config, channelId, nonceKey, mode = 'new' }) {
    const channel = await resolvePublicationChannel(client, guild, {
        kind: 'kaInfo',
        requestedChannelId: channelId,
        mode,
        label: 'Канал справки кадрового аудита',
        embedLinks: true,
    });
    return publishPayloads(client, {
        guild,
        kind: 'kaInfo',
        channel,
        payloads: buildKaInfoPayloads(config),
        mode,
        nonceKey,
    });
}

async function publishVacationPanel(client, { guild, config, channelId, nonceKey, mode = 'new' }) {
    const errors = vacationService.validatePanelPublication(guild, config);
    if (errors.length) {
        const error = new Error(errors.join('\n'));
        error.userMessage = `Панель отпусков нельзя опубликовать:\n${errors.map((entry) => `- ${entry}`).join('\n')}`;
        throw error;
    }
    const channel = await resolvePublicationChannel(client, guild, {
        kind: 'vacation',
        requestedChannelId: channelId,
        mode,
        label: 'Канал панели отпусков',
        embedLinks: true,
    });
    return publishPayloads(client, {
        guild,
        kind: 'vacation',
        channel,
        payloads: vacationService.buildPanelPayload(),
        mode,
        nonceKey,
    });
}

async function publishExaminationPanel(client, { guild, config, channelId, mode = 'both', nonceKey, publicationMode = 'new' }) {
    const errors = examinationService.validatePanelPublication(guild, config, mode);
    if (errors.length) {
        const error = new Error(errors.join('\n'));
        error.userMessage = `Панель экзаменации нельзя опубликовать:\n${errors.map((entry) => `- ${entry}`).join('\n')}`;
        throw error;
    }
    const channel = await resolvePublicationChannel(client, guild, {
        kind: 'examination',
        requestedChannelId: channelId,
        mode: publicationMode,
        label: 'Канал панели экзаменации',
        embedLinks: true,
    });
    return publishPayloads(client, {
        guild,
        kind: 'examination',
        channel,
        payloads: examinationInteractionService.buildPanelPayload(mode),
        mode: publicationMode,
        nonceKey,
        metadata: { mode },
    });
}

async function publishDiscordRules(client, { guild, channelId, nonceKey, mode = 'new' }) {
    if (!canPublishDiscordRules(guild.id)) {
        const error = new Error('Публикация правил доступна только на разрешённом сервере.');
        error.userMessage = error.message;
        throw error;
    }
    const channel = await resolvePublicationChannel(client, guild, {
        kind: 'discordRules',
        requestedChannelId: channelId,
        mode,
        label: 'Канал правил Discord',
        embedLinks: true,
    });
    return publishPayloads(client, {
        guild,
        kind: 'discordRules',
        channel,
        payloads: buildDiscordRulesPayload(),
        mode,
        nonceKey,
    });
}

module.exports = {
    buildDiscordRulesPayload,
    buildGiveRolesPanelPayload,
    buildKaInfoPayloads,
    canPublishDiscordRules,
    getPublicationRecord,
    publishDiscordRules,
    publishExaminationPanel,
    publishGiveRolesPanel,
    publishKaInfo,
    publishVacationPanel,
    validateGiveRolesPanel,
};
