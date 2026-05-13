process.env.NODE_NO_WARNINGS = '1';

const { Telegraf, Markup } = require('telegraf');
const fs   = require('fs');
const path = require('path');
const https = require('https');

const { pool }              = require('../database');
const { calculateVGIndex }  = require('../ranking');
const {
    queue3v3, queue5v5, activeMatches,
    addToQueue, removeFromQueue, createMatch, removeActiveMatch, returnToQueue
} = require('../matchmaking');

// Importa o estado compartilhado do server.js
const { onlineUsers, lobbyMessages, broadcastState, notifyPlayer, formatFC } = require('../server');

// ─── UTILS ────────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sanitizeInput(text) { return String(text || '').replace(/[<>"\']/g, '').trim(); }

const MD = { parse_mode: 'MarkdownV2' };
function mono(text) { return '```\n' + text + '\n```'; }
function mdKeyboard(keyboard) { return { parse_mode: 'MarkdownV2', ...keyboard }; }

async function testTelegramConn() {
    return new Promise((resolve) => {
        const req = https.get('https://api.telegram.org', res => { resolve(true); });
        req.on('error', () => resolve(false));
        req.setTimeout(10000, () => { req.destroy(); resolve(false); });
    });
}

// ─── PRESENCE ─────────────────────────────────────────────────────────────────
async function markOnline(id) {
    const user = onlineUsers.get(id);
    const wasOnline = !!user && user.status === 'online';
    onlineUsers.set(id, { timestamp: Date.now(), status: 'online' });
    if (!wasOnline) await broadcastState();
}

function setAway(id) {
    const user = onlineUsers.get(id);
    if (user) { user.status = 'away'; removeFromQueue(id); return true; }
    return false;
}

function countOnline() {
    const cutoff = Date.now() - 10 * 60 * 1000;
    let count = 0;
    for (const [id, data] of onlineUsers) {
        if (data.timestamp < cutoff) onlineUsers.delete(id);
        else if (data.status === 'online') count++;
    }
    return count;
}
function countSearching() {
    return new Set([...queue3v3.map(p => p.id), ...queue5v5.map(p => p.id)]).size;
}
function isInQueue(userId) {
    return queue3v3.some(p => p.id === userId) || queue5v5.some(p => p.id === userId);
}

// ─── LAYOUTS ──────────────────────────────────────────────────────────────────
async function getStatusText(userId) {
    const [rows] = await pool.execute('SELECT * FROM players WHERE telegram_id = ?', [userId]);
    const player    = rows[0];
    const nick      = player ? player.nickname : 'Desconhecido';
    const isPenalty = player && player.penalty_until && new Date(player.penalty_until) > new Date();
    const fc        = isPenalty ? '💀' : formatFC(player?.games, player?.vg_index);

    const now = new Date();
    await pool.execute('DELETE FROM news WHERE created_at < ?', [new Date(now - 3 * 24 * 3600 * 1000)]);
    await pool.execute('DELETE FROM events WHERE event_time < ?', [new Date(now - 2 * 3600 * 1000)]);

    const [newsRows]  = await pool.execute('SELECT content FROM news ORDER BY created_at DESC LIMIT 3');
    const [eventRows] = await pool.execute('SELECT content, event_time FROM events ORDER BY event_time ASC LIMIT 4');

    const in3v3 = queue3v3.some(p => p.id === userId);
    const in5v5 = queue5v5.some(p => p.id === userId);
    const userStatus = onlineUsers.get(userId);
    const isAway = userStatus && userStatus.status === 'away';

    let text = `⚡ VG MATCHMAKING BR\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    text += `👤 JOGADOR\n   ${nick}\n   FC: ${fc}`;
    if (isAway) text += `  |  💤 Ausente`;
    text += `\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    if (newsRows.length > 0) {
        text += `📰 NOTÍCIAS\n`;
        newsRows.forEach(n => { text += `   » ${n.content}\n`; });
        text += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    }
    if (eventRows.length > 0) {
        text += `📅 EVENTOS\n`;
        eventRows.forEach(e => {
            const t = new Date(e.event_time).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            text += `   » ${e.content} • ${t}h\n`;
        });
        text += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    }

    text += `📡 STATUS ATUAL\n`;
    text += `   ⬤ Online     ${countOnline()} jogadores\n`;
    text += `   ◈ Buscando   ${countSearching()} jogadores\n`;
    text += `   ⬡ Em Jogo    ${activeMatches.length} partida(s)\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    text += `⚔  FILAS ABERTAS\n`;
    text += `   3v3 Casual  ${queue3v3.length}/6${in3v3 ? '  ← você está aqui' : ''}\n`;
    text += `   5v5 Ranked  ${queue5v5.length}/10${in5v5 ? '  ← você está aqui' : ''}`;
    return text;
}

function getLobbyMatchText(match, playerId, playerDetails) {
    const isTeamA       = match.teamA.some(p => p.id === playerId);
    const allies        = isTeamA ? match.teamA : match.teamB;
    const enemies       = isTeamA ? match.teamB : match.teamA;
    const thisPlayer    = [...match.teamA, ...match.teamB].find(p => p.id === playerId);
    const nickFormatted = `${match.sniping_code}-${thisPlayer.teamNumber}_${playerDetails[playerId].nick}`;
    const confirmedCount = match.confirmations.length;
    const totalCount     = match.teamA.length + match.teamB.length;
    const dots = Array.from({ length: totalCount }, (_, i) => i < confirmedCount ? '✔' : '□').join(' ');

    let text = `⚔  PARTIDA ENCONTRADA\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    text += `🆔 ID DA PARTIDA\n   #${match.match_id}  |  Modo: ${match.mode === '3v3' ? '3v3 Casual' : '5v5 Ranked'}\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    text += `🟦 SEU TIME\n`;
    allies.forEach(p => { text += `   ▸ ${playerDetails[p.id].nick}    FC ${playerDetails[p.id].fc}\n`; });
    text += `\n🟥 ADVERSÁRIOS\n`;
    enemies.forEach(() => { text += `   ▸ oculto\n`; });
    text += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    text += `🎯 SNIPING CODE\n   ${match.sniping_code}\n\n`;
    text += `📝 MUDE SEU NICK PARA\n   ${nickFormatted}\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    text += `✅ CONFIRMAÇÕES\n   ${dots}  (${confirmedCount}/${totalCount})`;
    return text;
}

function getCountdownText(count) {
    const filled = Math.round((10 - count) * 2);
    const bar    = '█'.repeat(filled) + '░'.repeat(20 - filled);
    return `⏱ BUSCA INICIANDO EM\n━━━━━━━━━━━━━━━━━━━━━━\n\n          ${count}\n\n   ${bar}\n━━━━━━━━━━━━━━━━━━━━━━\n\n⚡ Preparem-se para buscar`;
}

function getResultRequestText(matchId, team) {
    return `🏁 FIM DE PARTIDA\n━━━━━━━━━━━━━━━━━━━━━━\n\n🆔 ID DA PARTIDA\n   #${matchId}\n\n👤 SEU TIME\n   Time ${team}\n━━━━━━━━━━━━━━━━━━━━━━\n\n❓ QUAL FOI O RESULTADO?\n   Reporte em até 5 min\n━━━━━━━━━━━━━━━━━━━━━━`;
}

function getProfileText(player) {
    const isPenalty = player.penalty_until && new Date(player.penalty_until) > new Date();
    const fcText    = isPenalty ? '💀' : formatFC(player.games, player.vg_index);
    const wr        = player.games > 0 ? ((player.wins / player.games) * 100).toFixed(1) : '0.0';
    let text = `👤 PERFIL DO JOGADOR\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    text += `🎮 IDENTIDADE\n   ${player.nickname}\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    text += `📊 ESTATÍSTICAS\n   FC        ${fcText}\n   Vitórias  ${player.wins}\n   Derrotas  ${player.losses}\n   Partidas  ${player.games}\n   Win Rate  ${wr}%\n━━━━━━━━━━━━━━━━━━━━━━`;
    return text;
}

function getRankingText(rows) {
    const medals = ['🥇', '🥈', '🥉'];
    let text = `🏆 TOP PLAYERS BR\n━━━━━━━━━━━━━━━━━━━━━━\n\n   NICK            FC      JOGOS\n   ──────────────────────────\n`;
    if (rows.length === 0) return text + `   Nenhum jogador com 10+ partidas ainda.`;
    rows.forEach((p, i) => {
        const isPenalty = p.penalty_until && new Date(p.penalty_until) > new Date();
        const fc     = isPenalty ? '💀      ' : `${formatFC(p.games, p.vg_index)}`.padEnd(8);
        const prefix = i < 3 ? medals[i] : ` ${i + 1}`;
        text += `${prefix} ${p.nickname.padEnd(14)}  ${fc}  ${p.games}\n`;
    });
    text += `━━━━━━━━━━━━━━━━━━━━━━\n   Mín. 10 partidas para rankear`;
    return text;
}

function getPenaltyText(nick, days) {
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + days);
    const expiryStr = expiry.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    let text = `💀 JOGADOR PENALIZADO\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    text += `👤 JOGADOR\n   ${nick}\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    text += `⚠️  PUNIÇÃO APLICADA\n   Motivo    Não confirmou\n   Duração   ${days} dias\n   Derrota   +2 registradas\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    text += `📊 FC ATUAL\n   💀 BLOQUEADO\n\n📅 EXPIRA EM\n   ${expiryStr}`;
    return text;
}

// ─── BOT ──────────────────────────────────────────────────────────────────────
let bot;
const pendingNick   = new Set();
const lobbyMatchMessages = new Map();

function getLobbyKeyboard(userId) {
    const inQueue = isInQueue(userId);
    const user    = onlineUsers.get(userId);
    const isAway  = user && user.status === 'away';
    const buttons = [];

    if (isAway) {
        buttons.push([Markup.button.callback('🟢 Ficar Online', 'SET_ONLINE')]);
    } else {
        const in3v3 = queue3v3.some(p => p.id === userId);
        const in5v5 = queue5v5.some(p => p.id === userId);
        buttons.push([
            Markup.button.callback(in3v3 ? '🎮 Buscando 3v3...' : '🎯 Entrar 3v3', 'JOIN_3V3'),
            Markup.button.callback(in5v5 ? '🎮 Buscando 5v5...' : '🔥 Entrar 5v5', 'JOIN_5V5'),
        ]);
        if (inQueue) buttons.push([Markup.button.callback('❌ Sair da fila', 'QUIT')]);
        buttons.push([Markup.button.callback('💤 Ficar Ausente', 'SET_AWAY')]);
    }

    // Botão para abrir o Mini App
    const WEBAPP_URL = process.env.WEBAPP_URL;
    if (WEBAPP_URL) {
        buttons.push([Markup.button.webApp('🌐 Abrir VG App', WEBAPP_URL)]);
    }

    return Markup.inlineKeyboard(buttons);
}

async function showMainMenu(ctx) {
    await markOnline(ctx.from.id);
    const text     = await getStatusText(ctx.from.id);
    const keyboard = getLobbyKeyboard(ctx.from.id);
    const oldMsg   = lobbyMessages.get(ctx.from.id);
    if (oldMsg) {
        try { await bot.telegram.deleteMessage(oldMsg.chatId, oldMsg.messageId); } catch (_) {}
    }
    const msg = await ctx.reply(mono(text), mdKeyboard(keyboard));
    lobbyMessages.set(ctx.from.id, { chatId: msg.chat.id, messageId: msg.message_id });
}

async function refreshLobbyForUser(userId) {
    const msgRef = lobbyMessages.get(userId);
    if (!msgRef) return;
    try {
        const text     = await getStatusText(userId);
        const keyboard = getLobbyKeyboard(userId);
        await bot.telegram.editMessageText(msgRef.chatId, msgRef.messageId, undefined, mono(text), mdKeyboard(keyboard));
    } catch (err) {
        if (err.description?.includes('message is not modified')) return;
        if (err.description?.includes('message to edit not found')) lobbyMessages.delete(userId);
    }
}

async function broadcastLobbyUpdate(excludeUserId) {
    const ids = [...onlineUsers.keys()].filter(id => id !== excludeUserId);
    for (const userId of ids) await refreshLobbyForUser(userId);
    await broadcastState(); // também atualiza os clientes WebApp
}

// Auto-refresh / away timer
setInterval(async () => {
    const now        = Date.now();
    const awayCutoff = now - 2  * 60 * 1000;
    const deadCutoff = now - 10 * 60 * 1000;
    for (const [userId, data] of onlineUsers.entries()) {
        if (data.timestamp < deadCutoff) { onlineUsers.delete(userId); continue; }
        if (data.timestamp < awayCutoff && data.status === 'online') {
            setAway(userId);
            await refreshLobbyForUser(userId);
            await broadcastLobbyUpdate(userId);
        }
    }
    for (const userId of onlineUsers.keys()) await refreshLobbyForUser(userId);
    await broadcastState();
}, 30 * 1000);

// ─── HANDLERS ─────────────────────────────────────────────────────────────────
function setupHandlers() {
    bot.start(async (ctx) => {
        await markOnline(ctx.from.id);
        const [rows] = await pool.execute('SELECT * FROM players WHERE telegram_id = ?', [ctx.from.id]);
        if (!rows[0]) {
            pendingNick.add(ctx.from.id);
            return ctx.reply('👋 Bem-vindo ao VG Matchmaking BR!\n\nDigite seu nick para começar (3-16 caracteres):');
        }
        await showMainMenu(ctx);
    });

    bot.command('saguao', async (ctx) => { await showMainMenu(ctx); });

    bot.on('text', async (ctx, next) => {
        await markOnline(ctx.from.id);
        if (!pendingNick.has(ctx.from.id)) {
            if (!ctx.message.text.startsWith('/') && !lobbyMessages.get(ctx.from.id)) return showMainMenu(ctx);
            return next();
        }
        const nick = sanitizeInput(ctx.message.text);
        if (nick.startsWith('/')) return next();
        if (nick.length < 3 || nick.length > 16) return ctx.reply('Nick inválido. Use entre 3 e 16 caracteres:');
        const [existing] = await pool.execute('SELECT * FROM players WHERE nickname = ?', [nick]);
        if (existing.length > 0) return ctx.reply('Este nick já está em uso. Escolha outro:');
        await pool.execute('INSERT INTO players (telegram_id, nickname) VALUES (?, ?)', [ctx.from.id, nick]);
        pendingNick.delete(ctx.from.id);
        await ctx.reply(`✅ Nick *${nick}* registrado!`, { parse_mode: 'Markdown' });
        await showMainMenu(ctx);
    });

    bot.action('JOIN_3V3', async (ctx) => {
        await markOnline(ctx.from.id);
        const [rows] = await pool.execute('SELECT nickname FROM players WHERE telegram_id = ?', [ctx.from.id]);
        if (!rows[0]) return ctx.answerCbQuery('Use /start primeiro.');
        const success = addToQueue('3v3', { id: ctx.from.id, name: rows[0].nickname }, activeMatches, onlineUsers);
        if (!success) return ctx.answerCbQuery('Você já está em uma fila.');
        await ctx.answerCbQuery('Entrou na fila 3v3 ✅');
        try {
            const text = await getStatusText(ctx.from.id);
            await ctx.editMessageText(mono(text), mdKeyboard(getLobbyKeyboard(ctx.from.id)));
            const msg = ctx.callbackQuery.message;
            lobbyMessages.set(ctx.from.id, { chatId: msg.chat.id, messageId: msg.message_id });
        } catch (_) {}
        await broadcastLobbyUpdate(ctx.from.id);
        await checkQueue('3v3');
    });

    bot.action('JOIN_5V5', async (ctx) => {
        await markOnline(ctx.from.id);
        const [rows] = await pool.execute('SELECT nickname FROM players WHERE telegram_id = ?', [ctx.from.id]);
        if (!rows[0]) return ctx.answerCbQuery('Use /start primeiro.');
        const success = addToQueue('5v5', { id: ctx.from.id, name: rows[0].nickname }, activeMatches, onlineUsers);
        if (!success) return ctx.answerCbQuery('Você já está em uma fila.');
        await ctx.answerCbQuery('Entrou na fila 5v5 ✅');
        try {
            const text = await getStatusText(ctx.from.id);
            await ctx.editMessageText(mono(text), mdKeyboard(getLobbyKeyboard(ctx.from.id)));
            const msg = ctx.callbackQuery.message;
            lobbyMessages.set(ctx.from.id, { chatId: msg.chat.id, messageId: msg.message_id });
        } catch (_) {}
        await broadcastLobbyUpdate(ctx.from.id);
        await checkQueue('5v5');
    });

    bot.action('QUIT', async (ctx) => {
        await markOnline(ctx.from.id);
        removeFromQueue(ctx.from.id);
        await ctx.answerCbQuery('Saiu da fila ✅');
        await refreshLobbyForUser(ctx.from.id);
        await broadcastLobbyUpdate(ctx.from.id);
    });

    bot.action('SET_AWAY', async (ctx) => {
        setAway(ctx.from.id);
        await ctx.answerCbQuery('Você está ausente 💤');
        await refreshLobbyForUser(ctx.from.id);
        await broadcastLobbyUpdate(ctx.from.id);
    });

    bot.action('SET_ONLINE', async (ctx) => {
        await markOnline(ctx.from.id);
        await ctx.answerCbQuery('Você está online 🟢');
        await refreshLobbyForUser(ctx.from.id);
        await broadcastLobbyUpdate(ctx.from.id);
    });

    // ─── MATCH FLOW ───────────────────────────────────────────────────────────

    async function getPlayerDetails(allPlayers) {
        const details = {};
        for (const p of allPlayers) {
            const [rows] = await pool.execute(
                'SELECT nickname, games, vg_index, penalty_until FROM players WHERE telegram_id = ?', [p.id]
            );
            const pd        = rows[0];
            const isPenalty = pd && pd.penalty_until && new Date(pd.penalty_until) > new Date();
            details[p.id]   = {
                nick: pd ? pd.nickname : `Player${p.id}`,
                fc:   isPenalty ? '💀' : formatFC(pd?.games, pd?.vg_index),
            };
        }
        return details;
    }

    async function checkQueue(mode) {
        const match = await createMatch(mode);
        if (!match) return;

        const allPlayers    = [...match.teamA, ...match.teamB];
        const playerDetails = await getPlayerDetails(allPlayers);
        const refs          = [];

        for (const player of allPlayers) {
            const text = getLobbyMatchText(match, player.id, playerDetails);
            const msg  = await bot.telegram.sendMessage(
                player.id, mono(text),
                { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Nick alterado', `CONFIRM_${match.match_id}`)]]) }
            );
            refs.push({ userId: player.id, chatId: msg.chat.id, messageId: msg.message_id });
            // Notifica WebApp do jogador
            await notifyPlayer(player.id, 'match_found', { matchId: match.match_id });
        }
        lobbyMatchMessages.set(match.match_id, refs);
        await broadcastState();

        setTimeout(async () => {
            const cur = activeMatches.find(m => m.match_id === match.match_id);
            if (!cur) return;
            const total = cur.teamA.length + cur.teamB.length;
            if (cur.confirmations.length < total) {
                const unconfirmed = allPlayers.filter(p => !cur.confirmations.includes(p.id));
                const confirmed   = allPlayers.filter(p =>  cur.confirmations.includes(p.id));
                for (const p of unconfirmed) {
                    await bot.telegram.sendMessage(p.id, '❌ Você não confirmou a tempo e foi para o final da fila.');
                    returnToQueue(cur.mode, p, false);
                }
                for (const p of confirmed) {
                    await bot.telegram.sendMessage(p.id, '⏳ Outros jogadores não confirmaram. Você voltou para o início da fila.');
                    returnToQueue(cur.mode, p, true);
                }
                await removeActiveMatch(cur.match_id);
                lobbyMatchMessages.delete(cur.match_id);
                await broadcastState();
                await checkQueue(cur.mode);
            }
        }, 60000);
    }

    bot.action(/CONFIRM_(.+)/, async (ctx) => {
        const matchId = Number(ctx.match[1]);
        const match   = activeMatches.find(m => m.match_id === matchId);
        if (!match) return;
        if (!match.confirmations.includes(ctx.from.id)) match.confirmations.push(ctx.from.id);
        await ctx.answerCbQuery('Confirmado ✅');

        const playerDetails = await getPlayerDetails([...match.teamA, ...match.teamB]);
        const msgRefs       = lobbyMatchMessages.get(matchId) || [];
        for (const ref of msgRefs) {
            try {
                await bot.telegram.editMessageText(
                    ref.chatId, ref.messageId, undefined,
                    mono(getLobbyMatchText(match, ref.userId, playerDetails)),
                    { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Nick alterado', `CONFIRM_${match.match_id}`)]]) }
                );
            } catch (_) {}
        }
        await broadcastState();

        const total = match.teamA.length + match.teamB.length;
        if (match.confirmations.length !== total) return;
        lobbyMatchMessages.delete(matchId);

        const players = [...match.teamA, ...match.teamB];
        const cdMsgs  = [];
        for (const p of players) {
            const msg = await bot.telegram.sendMessage(p.id, mono(getCountdownText(10)), MD);
            cdMsgs.push({ chatId: p.id, messageId: msg.message_id });
            await notifyPlayer(p.id, 'countdown_start', { matchId });
        }

        for (let i = 9; i >= 1; i--) {
            await sleep(1000);
            for (const msg of cdMsgs) {
                await bot.telegram.editMessageText(msg.chatId, msg.messageId, undefined, mono(getCountdownText(i)), MD).catch(() => {});
            }
        }
        await sleep(1000);
        for (const msg of cdMsgs) {
            await bot.telegram.editMessageText(msg.chatId, msg.messageId, undefined,
                mono(`⚔  BUSQUEM AGORA!\n━━━━━━━━━━━━━━━━━━━━━━\n\n   Code: ${match.sniping_code}\n\n   ████████████████████\n━━━━━━━━━━━━━━━━━━━━━━\n\n🎯 Abram a sala e busquem!`),
                MD
            ).catch(() => {});
        }

        match.start_time = new Date().toISOString();
        await pool.execute('UPDATE active_matches SET start_time = ? WHERE match_id = ?', [match.start_time, match.match_id]);
        await broadcastState();

        setTimeout(async () => {
            for (const player of players) {
                const team = match.teamA.find(p => p.id === player.id) ? 'A' : 'B';
                await bot.telegram.sendMessage(
                    player.id,
                    mono(getResultRequestText(match.match_id, team)),
                    { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard([[
                        Markup.button.callback('✅ Ganhei', `WIN_${match.match_id}`),
                        Markup.button.callback('❌ Perdi',  `LOSE_${match.match_id}`),
                    ]]) }
                );
                await notifyPlayer(player.id, 'result_request', { matchId: match.match_id, team });
            }
        }, 1000 * 60 * 3);
    });

    bot.action(/WIN_(.+)/, async (ctx) => {
        const match = activeMatches.find(m => m.match_id === Number(ctx.match[1]));
        if (!match) return;
        match.results[ctx.from.id] = 'win';
        await ctx.answerCbQuery('Resultado enviado ✅');
        await finalizeMatch(match);
    });

    bot.action(/LOSE_(.+)/, async (ctx) => {
        const match = activeMatches.find(m => m.match_id === Number(ctx.match[1]));
        if (!match) return;
        match.results[ctx.from.id] = 'lose';
        await ctx.answerCbQuery('Resultado enviado ✅');
        await finalizeMatch(match);
    });

    async function finalizeMatch(match) {
        const totalPlayers = match.teamA.length + match.teamB.length;
        if (Object.keys(match.results).length !== totalPlayers) return;

        const durationSeconds = Math.floor((new Date() - new Date(match.start_time)) / 1000);
        const isRemake        = durationSeconds < 420;
        const teamAWins  = match.teamA.filter(p => match.results[p.id] === 'win').length;
        const teamBWins  = match.teamB.filter(p => match.results[p.id] === 'win').length;
        const aClaimWin  = match.teamA.some(p => match.results[p.id] === 'win');
        const bClaimWin  = match.teamB.some(p => match.results[p.id] === 'win');
        let winner       = 'DRAW';
        let hasConflict  = aClaimWin && bClaimWin;

        if (!hasConflict) {
            if      (teamAWins > totalPlayers / 2) winner = 'A';
            else if (teamBWins > totalPlayers / 2) winner = 'B';
            else                                   hasConflict = true;
        }

        const players = [...match.teamA, ...match.teamB];
        if (isRemake) {
            for (const p of players) await bot.telegram.sendMessage(p.id, mono(`♻️ REMAKE DETECTADO\n━━━━━━━━━━━━━━━━━━━━━━\n\nPartida encerrada em menos de 7 minutos.\nHistórico não será afetado.`), MD);
        } else if (!hasConflict) {
            const winners = winner === 'A' ? match.teamA : match.teamB;
            const losers  = winner === 'A' ? match.teamB : match.teamA;
            for (const player of winners) {
                const [rows] = await pool.execute('SELECT * FROM players WHERE telegram_id = ?', [player.id]);
                const cur = rows[0];
                const wins = cur.wins + 1, games = cur.games + 1;
                await pool.execute('UPDATE players SET wins=?,games=?,vg_index=? WHERE telegram_id=?',
                    [wins, games, calculateVGIndex(wins, games), player.id]);
            }
            for (const player of losers) {
                const [rows] = await pool.execute('SELECT * FROM players WHERE telegram_id = ?', [player.id]);
                const cur = rows[0];
                const losses = cur.losses + 1, games = cur.games + 1;
                await pool.execute('UPDATE players SET losses=?,games=?,vg_index=? WHERE telegram_id=?',
                    [losses, games, calculateVGIndex(cur.wins, games), player.id]);
            }
        }

        const conflictData = hasConflict ? JSON.stringify(match.results) : null;
        await pool.execute(
            'INSERT INTO matches (code,mode,winner_team,created_at,duration_seconds,is_remake,conflict_report) VALUES (?,?,?,?,?,?,?)',
            [match.sniping_code, match.mode, winner, new Date().toISOString(), durationSeconds, isRemake, conflictData]
        );

        if (hasConflict) {
            const [admins] = await pool.execute('SELECT telegram_id FROM players WHERE is_admin=TRUE');
            for (const admin of admins)
                await bot.telegram.sendMessage(admin.telegram_id,
                    mono(`⚠️ CONFLITO DE RESULTADO\n━━━━━━━━━━━━━━━━━━━━━━\n\nPartida ID: #${match.match_id}\nUse /relatorio ${match.match_id} para analisar.`),
                    MD);
        }

        await removeActiveMatch(match.match_id);
        await broadcastState();
        for (const userId of onlineUsers.keys()) await refreshLobbyForUser(userId);

        for (const player of players) {
            const text     = await getStatusText(player.id);
            const keyboard = getLobbyKeyboard(player.id);
            const msg      = await bot.telegram.sendMessage(player.id, mono(text), mdKeyboard(keyboard));
            lobbyMessages.set(player.id, { chatId: msg.chat.id, messageId: msg.message_id });
        }
    }

    // ─── COMMANDS ─────────────────────────────────────────────────────────────
    bot.command('perfil', async (ctx) => {
        await markOnline(ctx.from.id);
        const nick = ctx.message.text.split(' ').slice(1).join(' ').trim();
        let player;
        if (!nick) {
            const [rows] = await pool.execute('SELECT * FROM players WHERE telegram_id = ?', [ctx.from.id]);
            player = rows[0];
            if (!player) return ctx.reply('Você não está registrado. Use /start.');
        } else {
            const [rows] = await pool.execute('SELECT * FROM players WHERE nickname = ?', [nick]);
            player = rows[0];
            if (!player) return ctx.reply(`Jogador *${nick}* não encontrado.`, { parse_mode: 'Markdown' });
        }
        await ctx.reply(mono(getProfileText(player)), MD);
        await sleep(1000);
        await showMainMenu(ctx);
    });

    bot.command('ranking', async (ctx) => {
        await markOnline(ctx.from.id);
        const [rows] = await pool.execute(
            'SELECT * FROM players WHERE games >= 10 ORDER BY vg_index DESC, games DESC LIMIT 10'
        );
        await ctx.reply(mono(getRankingText(rows)), MD);
        await sleep(1000);
        await showMainMenu(ctx);
    });

    bot.command('report', async (ctx) => {
        markOnline(ctx.from.id);
        const reportText = ctx.message.text.split(' ').slice(1).join(' ').trim();
        if (!reportText) return ctx.reply('Use: /report <sua denúncia>');
        const [rows] = await pool.execute('SELECT nickname FROM players WHERE telegram_id = ?', [ctx.from.id]);
        const nick   = rows[0] ? rows[0].nickname : 'Desconhecido';
        const line   = `[${new Date().toLocaleString('pt-BR')}] De: ${nick} (ID:${ctx.from.id})\nDenúncia: ${reportText}\n----------------------------------\n`;
        const reportsDir = path.join(__dirname, '..', 'reports');
        if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir);
        fs.appendFileSync(path.join(reportsDir, 'denuncias.txt'), line);
        await ctx.reply('✅ Sua denúncia foi enviada e será analisada pelos administradores.');
        await sleep(1000);
        await showMainMenu(ctx);
    });

    bot.command('changenick', async (ctx) => {
        markOnline(ctx.from.id);
        const newNick = sanitizeInput(ctx.message.text.split(' ').slice(1).join(' '));
        if (!newNick || newNick.length < 3 || newNick.length > 16)
            return ctx.reply('Use: /changenick <nick> (3–16 caracteres)');
        const [existing] = await pool.execute('SELECT * FROM players WHERE nickname = ? AND telegram_id != ?', [newNick, ctx.from.id]);
        if (existing.length > 0) return ctx.reply('Nick já em uso. Escolha outro.');
        await pool.execute('UPDATE players SET nickname = ? WHERE telegram_id = ?', [newNick, ctx.from.id]);
        await ctx.reply(`Nick alterado para *${newNick}*!`, { parse_mode: 'Markdown' });
        await showMainMenu(ctx);
    });

    bot.command('noticia', async (ctx) => {
        const [adminCheck] = await pool.execute('SELECT is_admin FROM players WHERE telegram_id = ?', [ctx.from.id]);
        if (!adminCheck[0]?.is_admin) return ctx.reply('Apenas administradores.');
        const content = sanitizeInput(ctx.message.text.split(' ').slice(1).join(' '));
        if (!content) return ctx.reply('Use: /noticia <texto>');
        await pool.execute('INSERT INTO news (content) VALUES (?)', [content]);
        await pool.execute('DELETE FROM news WHERE id NOT IN (SELECT id FROM (SELECT id FROM news ORDER BY created_at DESC LIMIT 3) as x)');
        await ctx.reply('✅ Notícia publicada!');
        await broadcastLobbyUpdate();
    });

    bot.command('evento', async (ctx) => {
        const [adminCheck] = await pool.execute('SELECT is_admin FROM players WHERE telegram_id = ?', [ctx.from.id]);
        if (!adminCheck[0]?.is_admin) return ctx.reply('Apenas administradores.');
        const args  = ctx.message.text.split(' ').slice(1).join(' ');
        const parts = args.split('|');
        if (parts.length < 2) return ctx.reply('Use: /evento <texto> | <HH:mm>');
        const content = sanitizeInput(parts[0]);
        const [hours, minutes] = parts[1].trim().split(':').map(Number);
        const eventTime = new Date();
        eventTime.setHours(hours, minutes, 0, 0);
        if (eventTime < new Date()) eventTime.setDate(eventTime.getDate() + 1);
        await pool.execute('INSERT INTO events (content, event_time) VALUES (?, ?)', [content, eventTime]);
        await ctx.reply(`✅ Evento agendado para às ${parts[1].trim()}!`);
        await broadcastLobbyUpdate();
    });

    bot.command('relatorio', async (ctx) => {
        const [adminCheck] = await pool.execute('SELECT is_admin FROM players WHERE telegram_id = ?', [ctx.from.id]);
        if (!adminCheck[0]?.is_admin) return ctx.reply('Apenas administradores.');
        const matchId = ctx.message.text.split(' ')[1];
        if (!matchId) {
            const [conflicts] = await pool.execute('SELECT id, created_at FROM matches WHERE conflict_report IS NOT NULL ORDER BY id DESC LIMIT 10');
            if (conflicts.length === 0) return ctx.reply('Nenhum conflito encontrado.');
            let text = '⚠️ CONFLITOS RECENTES\n━━━━━━━━━━━━━━━━━━━━━━\n\n';
            conflicts.forEach(c => { text += `ID: #${c.id}  —  ${c.created_at}\nUse /relatorio ${c.id}\n\n`; });
            return ctx.reply(mono(text), MD);
        }
        const [matchRows] = await pool.execute('SELECT * FROM matches WHERE id = ?', [matchId]);
        if (!matchRows.length) return ctx.reply('Partida não encontrada.');
        const match = matchRows[0];
        if (!match.conflict_report) return ctx.reply('Esta partida não possui conflitos registrados.');
        const results = JSON.parse(match.conflict_report);
        let text = `📄 CONFLITO — PARTIDA #${matchId}\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
        const buttons = [];
        for (const [id, res] of Object.entries(results)) {
            const [pRows] = await pool.execute('SELECT nickname FROM players WHERE telegram_id = ?', [id]);
            const nick = pRows[0] ? pRows[0].nickname : `ID:${id}`;
            text += `${nick}: ${res === 'win' ? '✅ MARCOU VITÓRIA' : '❌ MARCOU DERROTA'}\n`;
            buttons.push([Markup.button.callback(`💀 Penalizar ${nick}`, `PENALIZE_${id}_${matchId}`)]);
        }
        await ctx.reply(mono(text), { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(buttons) });
    });

    bot.action(/PENALIZE_(.+)_(.+)/, async (ctx) => {
        const [adminCheck] = await pool.execute('SELECT is_admin FROM players WHERE telegram_id = ?', [ctx.from.id]);
        if (!adminCheck[0]?.is_admin) return ctx.answerCbQuery('Acesso negado.');
        const targetId  = ctx.match[1];
        const penalDays = 7;
        const penalDate = new Date();
        penalDate.setDate(penalDate.getDate() + penalDays);
        const [pRows] = await pool.execute('SELECT nickname, losses, games, wins FROM players WHERE telegram_id = ?', [targetId]);
        if (pRows.length > 0) {
            const cur = pRows[0];
            await pool.execute('UPDATE players SET penalty_until=?,losses=?,games=?,vg_index=? WHERE telegram_id=?',
                [penalDate.toISOString(), cur.losses + 2, cur.games + 2, calculateVGIndex(cur.wins, cur.games + 2), targetId]);
            await bot.telegram.sendMessage(Number(targetId), mono(getPenaltyText(cur.nickname, penalDays)), MD);
        }
        await ctx.answerCbQuery('Jogador penalizado! 💀 + 2 Derrotas');
        await ctx.reply('✅ Penalidade aplicada com sucesso.');
        await broadcastState();
    });

    bot.command('makeadmin', async (ctx) => {
        const allowedId = process.env.ADMIN_TELEGRAM_ID ? Number(process.env.ADMIN_TELEGRAM_ID) : null;
        if (!allowedId || ctx.from.id !== allowedId) return ctx.reply('Sem permissão.');
        await pool.execute('UPDATE players SET is_admin = TRUE WHERE telegram_id = ?', [ctx.from.id]);
        ctx.reply('Você agora é administrador.');
    });
}

// ─── EXPORT ───────────────────────────────────────────────────────────────────
async function startBot() {
    bot = new Telegraf(process.env.BOT_TOKEN, { handlerTimeout: 90_000 });
    setupHandlers();

    const launchBot = async (retries = 5) => {
        for (let i = 0; i < retries; i++) {
            try {
                console.log(`[BOT] Tentativa ${i + 1}/${retries}...`);
                await bot.launch({ allowedUpdates: ['message', 'callback_query'] });
                return;
            } catch (err) {
                console.error(`[BOT] Falha ${i + 1}:`, err.message);
                if (i === retries - 1) throw err;
                await sleep(Math.pow(2, i) * 1000);
            }
        }
    };

    await launchBot();
    console.log('[BOT] ✅ Bot online!');
    process.once('SIGINT',  () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

module.exports = { startBot };
