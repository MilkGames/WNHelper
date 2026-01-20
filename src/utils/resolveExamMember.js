const giveRoles = require('../models/giveRoles');

function normalizeText(text) {
    return String(text || '')
        .trim()
        .toLowerCase()
        .replace(/ё/g, 'е');
}

function extractDiscordId(text) {
    const s = String(text || '');
    const m = s.match(/<@!?(\d{17,20})>|\b(\d{17,20})\b/);
    return m ? (m[1] || m[2] || null) : null;
}

function extractStatic(text) {
    // Статик обычно 2-7 цифр, остальное Discord ID
    const s = String(text || '');
    const m = s.match(/\b(\d{2,7})\b/);
    return m ? m[1] : null;
}

function tokenizeName(text) {
    const cleaned = normalizeText(text)
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return cleaned ? cleaned.split(' ') : [];
}

function candidateTextFields(member) {
    const dn = member?.displayName || '';
    const un = member?.user?.username || '';
    const gn = member?.user?.globalName || '';
    return [dn, un, gn].filter(Boolean);
}

function scoreCandidate(member, nameTokens, staticMatch) {
    let score = 0;
    const displayName = normalizeText(member?.displayName || '');

    if (staticMatch && displayName.includes(String(staticMatch))) score += 100;

    const fields = candidateTextFields(member).map(tokenizeName);
    const allWords = new Set(fields.flat());

    let matched = 0;
    for (const t of nameTokens) {
        if (!t || t.length < 2) continue;

        // Приоритет displayName
        if (displayName.includes(t)) {
            score += 15;
            matched += 1;
            continue;
        }

        // Потом username/globalName
        const inOther = fields.slice(1).some((words) => words.some((w) => w.includes(t) || t.includes(w)));
        if (inOther) {
            score += 8;
            matched += 1;
            continue;
        }

        // И в крайнем случае - по словам
        if (allWords.has(t)) {
            score += 6;
            matched += 1;
        }
    }

    if (nameTokens.length >= 2 && matched >= 2) score += 40;
    else if (nameTokens.length === 1 && matched === 1) score += 10;

    return score;
}

async function searchMembers(guild, query, limit = 25) {
    const q = String(query || '').trim();
    if (q.length < 2) return [];

    if (typeof guild.members.search === 'function') {
        const res = await guild.members.search({ query: q, limit }).catch(() => null);
        return res ? Array.from(res.values()) : [];
    }

    const res = await guild.members.fetch({ query: q, limit }).catch(() => null);
    return res ? Array.from(res.values()) : [];
}

async function resolveExamMember(guild, rawInput) {
    const input = String(rawInput || '').trim();
    if (!input || input === '—') return { member: null, candidates: [] };

    // 1 - Discord ID / пинг
    const discordId = extractDiscordId(input);
    if (discordId) {
        const m = await guild.members.fetch(discordId).catch(() => null);
        return { member: m, candidates: [] };
    }

    // 2 - Статик
    const staticMatch = extractStatic(input);
    if (staticMatch) {
        const cached = guild.members.cache.find((m) => (m.displayName || '').includes(staticMatch)) || null;
        if (cached) return { member: cached, candidates: [] };

        // Попытка по локальной базе (если когда-то записывали static -> userId)
        const rec = await giveRoles.findOne({ guildId: guild.id, static: staticMatch }).catch(() => null);
        if (rec?.userId) {
            const m = await guild.members.fetch(rec.userId).catch(() => null);
            if (m) return { member: m, candidates: [] };
        }
    }

    // 3 - ФИО / текстовый ввод
    const tokens = tokenizeName(input)
        .filter((t) => !/^\d+$/.test(t))
        .filter((t) => t.length >= 2)
        .slice(0, 4);

    if (tokens.length === 0) return { member: null, candidates: [] };

    // Сначала пробуем по кэшу
    const cacheCandidates = Array.from(guild.members.cache.values());
    const cacheMatched = cacheCandidates.filter((m) => {
        const dn = normalizeText(m.displayName || '');
        return tokens.every((t) => dn.includes(t));
    });
    if (cacheMatched.length === 1) return { member: cacheMatched[0], candidates: [] };

    // Потом REST поиск по каждому токену
    const map = new Map();
    for (const t of tokens) {
        const res = await searchMembers(guild, t, 25);
        for (const m of res) map.set(m.id, m);
    }

    // Добавим кандидатов из кэша
    for (const m of cacheMatched) map.set(m.id, m);

    const candidates = Array.from(map.values());
    if (candidates.length === 0) return { member: null, candidates: [] };

    const ranked = candidates
        .map((m) => ({ m, score: scoreCandidate(m, tokens, staticMatch) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);

    if (ranked.length === 0) return { member: null, candidates: [] };

    const top = ranked[0];
    const second = ranked[1] || null;

    const topOk = top.score >= (tokens.length >= 2 ? 60 : 35);
    const clearLead = !second || (top.score - second.score >= 12);

    if (topOk && clearLead) {
        return { member: top.m, candidates: [] };
    }

    // Неоднозначно - вернём 5 лучших
    return {
        member: null,
        candidates: ranked.slice(0, 5).map((x) => x.m),
    };
}

module.exports = {
    resolveExamMember,
};
