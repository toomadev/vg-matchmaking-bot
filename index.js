// Silencia o aviso de depreciação do punycode que aparece no Node.js v22+
// Este aviso vem de dependências internas e não afeta o funcionamento do bot.
process.env.NODE_NO_WARNINGS = '1';

const { Telegraf, Markup } = require("telegraf");
const fs = require("fs");
const path = require("path");
const { pool, initDB } = require("./database");
const https = require("https");

async function testTelegramConn() {
    return new Promise((resolve) => {
        console.log("Testando conectividade direta com api.telegram.org...");
        const req = https.get("https://api.telegram.org", (res) => {
            console.log(`Status da conexão: ${res.statusCode}`);
            resolve(true);
        });
        req.on("error", (e) => {
            console.error(`ERRO DE REDE DIRETO: ${e.message}`);
            resolve(false);
        });
        req.setTimeout(10000, () => {
            console.error("TIMEOUT na conexão direta com Telegram.");
            req.destroy();
            resolve(false);
        });
    });
}
const { calculateVGIndex } = require("./ranking");
const {
    queue3v3,
    queue5v5,
    activeMatches,
    loadActiveMatches,
    addToQueue,
    removeFromQueue,
    createMatch,
    removeActiveMatch,
    returnToQueue
} = require("./matchmaking");

const bot = new Telegraf(process.env.BOT_TOKEN, {
    handlerTimeout: 90_000,
});

const pendingNick = new Set();

// Rastreia usuários online e seu status (online/away)
const onlineUsers = new Map(); // id -> { timestamp, status: 'online' | 'away' }

// Rastreia a última mensagem do saguão de cada usuário para auto-refresh
const lobbyMessages = new Map();

async function markOnline(id) {
    const user = onlineUsers.get(id);
    const wasOnline = !!user && user.status === 'online';
    
    onlineUsers.set(id, { timestamp: Date.now(), status: 'online' });
    
    if (!wasOnline) {
        await broadcastLobbyUpdate(id);
    }
}

function setAway(id) {
    const user = onlineUsers.get(id);
    if (user) {
        user.status = 'away';
        removeFromQueue(id); // Remove da fila se ficar ausente
        return true;
    }
    return false;
}

function countOnline() {
    const cutoff = Date.now() - 10 * 60 * 1000; // 10 minutos de inatividade
    let count = 0;
    for (const [id, data] of onlineUsers) {
        if (data.timestamp < cutoff) {
            onlineUsers.delete(id);
        } else if (data.status === 'online') {
            count++;
        }
    }
    return count;
}

function countSearching() {
    const ids = new Set([
        ...queue3v3.map(p => p.id),
        ...queue5v5.map(p => p.id)
    ]);
    return ids.size;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function formatFC(games, vg_index) {
    if (games < 10) return `${games}/10`;
    return `FC ${Number(vg_index).toFixed(2)}`;
}

async function getStatusText(userId) {
    const [rows] = await pool.execute("SELECT * FROM players WHERE telegram_id = ?", [userId]);
    const player = rows[0];
    const nick = player ? player.nickname : "Desconhecido";
    const isPenalty = player.penalty_until && new Date(player.penalty_until) > new Date();
    const fc = isPenalty ? "💀" : formatFC(player.games, player.vg_index);

    // Limpeza de expirados
    const now = new Date();
    const newsCutoff = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000); // 3 dias
    const eventCutoff = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2 horas após início

    await pool.execute("DELETE FROM news WHERE created_at < ?", [newsCutoff]);
    await pool.execute("DELETE FROM events WHERE event_time < ?", [eventCutoff]);

    // Buscar Notícias (Limite 3)
    const [newsRows] = await pool.execute("SELECT content FROM news ORDER BY created_at DESC LIMIT 3");
    // Buscar Eventos (Limite 4)
    const [eventRows] = await pool.execute("SELECT content, event_time FROM events ORDER BY event_time ASC LIMIT 4");

    const in3v3 = queue3v3.some(p => p.id === userId);
    const in5v5 = queue5v5.some(p => p.id === userId);

    const q3v3 = `${queue3v3.length}/6${in3v3 ? " 🎮" : ""}`;
    const q5v5 = `${queue5v5.length}/10${in5v5 ? " 🎮" : ""}`;

    let text = `─── 👤 ${nick} • ${fc} ───\n\n`;
    
    if (newsRows.length > 0) {
        text += `📰 NEWS\n`;
        newsRows.forEach(n => text += `» ${n.content}\n`);
        text += `──────────────────\n`;
    }
    
    if (eventRows.length > 0) {
        text += `📅 EVENTS\n`;
        eventRows.forEach(e => {
            const time = new Date(e.event_time).toLocaleTimeString("pt-BR", { hour: '2-digit', minute: '2-digit' });
            text += `» ${e.content} • ${time}h\n`;
        });
        text += `──────────────────\n`;
    }
    
    text += `📈 STATUS\n`;
    text += `🟢 Online ⇒ ${countOnline()}\n`;
    text += `🔍 Buscando ⇒ ${countSearching()}\n`;
    text += `🎮 Em Jogo ⇒ ${activeMatches.length}\n`;
    text += `──────────────────\n`;
    
    text += `⚔️ QUEUES\n`;
    text += `🎯 3v3 Casual ⇒ ${q3v3}\n`;
    text += `🔥 5v5 Ranked ⇒ ${q5v5}`;

    return text;
}

function getLobbyKeyboard(userId) {
    const inQueue = isInQueue(userId);
    const user = onlineUsers.get(userId);
    const isAway = user && user.status === 'away';

    const buttons = [];
    
    if (isAway) {
        buttons.push([Markup.button.callback("🟢 Ficar Online", "SET_ONLINE")]);
    } else {
        const in3v3 = queue3v3.some(p => p.id === userId);
        const in5v5 = queue5v5.some(p => p.id === userId);

        buttons.push([
            Markup.button.callback(in3v3 ? "🎮 Buscando 3v3..." : "🎯 Entrar 3v3", "JOIN_3V3"),
            Markup.button.callback(in5v5 ? "🎮 Buscando 5v5..." : "🔥 Entrar 5v5", "JOIN_5V5")
        ]);
        
        if (inQueue) {
            buttons.push([Markup.button.callback("❌ Sair da fila", "QUIT")]);
        }
        
        buttons.push([Markup.button.callback("💤 Ficar Ausente", "SET_AWAY")]);
    }
    
    return Markup.inlineKeyboard(buttons);
}

function isInQueue(userId) {
    return queue3v3.some(p => p.id === userId) || queue5v5.some(p => p.id === userId);
}

async function showMainMenu(ctx) {
    await markOnline(ctx.from.id);
    const text = await getStatusText(ctx.from.id);
    const keyboard = getLobbyKeyboard(ctx.from.id);

    // Se já existe uma mensagem, tenta apagar para não poluir o chat
    const oldMsg = lobbyMessages.get(ctx.from.id);
    if (oldMsg) {
        try {
            await bot.telegram.deleteMessage(oldMsg.chatId, oldMsg.messageId);
        } catch (e) {}
    }

    const msg = await ctx.reply(text, keyboard);

    // Salva a mensagem para auto-refresh
    lobbyMessages.set(ctx.from.id, { chatId: msg.chat.id, messageId: msg.message_id });
}

// Atualiza a mensagem do saguão de um usuário específico (sem enviar nova)
async function refreshLobbyForUser(userId) {
    const msgRef = lobbyMessages.get(userId);
    if (!msgRef) return;

    try {
        const text = await getStatusText(userId);
        const keyboard = getLobbyKeyboard(userId);
        await bot.telegram.editMessageText(
            msgRef.chatId,
            msgRef.messageId,
            undefined,
            text,
            { ...keyboard, parse_mode: undefined }
        );
    } catch (err) {
        // Mensagem já igual — ignora
        if (err.description && err.description.includes("message is not modified")) return;
        // Mensagem sumiu — remove rastreamento
        if (err.description && err.description.includes("message to edit not found")) {
            lobbyMessages.delete(userId);
        }
    }
}

// Propaga atualização para todos os usuários online exceto quem já foi atualizado
async function broadcastLobbyUpdate(excludeUserId) {
    const ids = [...onlineUsers.keys()].filter(id => id !== excludeUserId);
    for (const userId of ids) {
        await refreshLobbyForUser(userId);
    }
}

// Auto-refresh e limpeza de inativos
setInterval(async () => {
    const now = Date.now();
    const awayCutoff = now - 2 * 60 * 1000; // 2 minutos para ficar Away
    const offlineCutoff = now - 10 * 60 * 1000; // 10 minutos para sumir do Online

    for (const [userId, data] of onlineUsers.entries()) {
        // Se inativo por 2 min e não está Away, coloca como Away
        if (data.timestamp < awayCutoff && data.status === 'online') {
            setAway(userId);
            await refreshLobbyForUser(userId);
            await broadcastLobbyUpdate(userId);
        }
        
        // Se inativo por 10 min, remove do mapa online
        if (data.timestamp < offlineCutoff) {
            onlineUsers.delete(userId);
        }
    }

    // Atualiza o saguão para quem ainda está online
    for (const userId of onlineUsers.keys()) {
        await refreshLobbyForUser(userId);
    }
}, 30 * 1000);

bot.start(async (ctx) => {
    await markOnline(ctx.from.id);
    const [rows] = await pool.execute(
        "SELECT * FROM players WHERE telegram_id = ?",
        [ctx.from.id]
    );
    const player = rows[0];

    if (!player) {
        pendingNick.add(ctx.from.id);
        return ctx.reply("👋 Bem-vindo ao VG Matchmaking BR!\n\nDigite seu nick para começar (3-16 caracteres):");
    }

    // Se já existe, apenas mostra o menu
    await showMainMenu(ctx);
});

// Comando manual para abrir o saguão caso algo trave
bot.command("saguao", async (ctx) => {
    await showMainMenu(ctx);
});

// Captura nick do novo usuário ou qualquer mensagem para abrir o saguão
bot.on("text", async (ctx, next) => {
    await markOnline(ctx.from.id);

    if (!pendingNick.has(ctx.from.id)) {
        // Se não está pendente de nick e não é comando, abre o saguão se não houver um ativo
        if (!ctx.message.text.startsWith("/")) {
            const msgRef = lobbyMessages.get(ctx.from.id);
            if (!msgRef) {
                return showMainMenu(ctx);
            }
        }
        return next();
    }

    const nick = sanitizeInput(ctx.message.text);
    if (nick.startsWith("/")) return next();

    if (nick.length < 3 || nick.length > 16) {
        return ctx.reply("Nick inválido. Use entre 3 e 16 caracteres:");
    }

    const [existing] = await pool.execute(
        "SELECT * FROM players WHERE nickname = ?",
        [nick]
    );
    if (existing.length > 0) {
        return ctx.reply("Este nick já está em uso. Escolha outro:");
    }

    await pool.execute(
        "INSERT INTO players (telegram_id, nickname) VALUES (?, ?)",
        [ctx.from.id, nick]
    );

    pendingNick.delete(ctx.from.id);
    await ctx.reply(`✅ Nick *${nick}* registrado!`, { parse_mode: "Markdown" });
    await showMainMenu(ctx);
});



bot.action("JOIN_3V3", async (ctx) => {
    await markOnline(ctx.from.id);
    const [rows] = await pool.execute(
        "SELECT nickname FROM players WHERE telegram_id = ?",
        [ctx.from.id]
    );
    const player = rows[0];
    if (!player) return ctx.answerCbQuery("Use /start primeiro.");

    const success = addToQueue("3v3", { id: ctx.from.id, name: player.nickname }, activeMatches, onlineUsers);
    if (!success) return ctx.answerCbQuery("Você já está em uma fila.");

    await ctx.answerCbQuery("Entrou na fila 3v3 ✅");

    // Atualiza a mensagem do próprio usuário imediatamente
    const text = await getStatusText(ctx.from.id);
    const keyboard = getLobbyKeyboard(ctx.from.id);
    try {
        await ctx.editMessageText(text, keyboard);
        const msg = ctx.callbackQuery.message;
        lobbyMessages.set(ctx.from.id, { chatId: msg.chat.id, messageId: msg.message_id });
    } catch (_) {}

    // Propaga atualização para todos os outros online
    await broadcastLobbyUpdate(ctx.from.id);

    await checkQueue("3v3");
});

bot.action("JOIN_5V5", async (ctx) => {
    await markOnline(ctx.from.id);
    const [rows] = await pool.execute(
        "SELECT nickname FROM players WHERE telegram_id = ?",
        [ctx.from.id]
    );
    const player = rows[0];
    if (!player) return ctx.answerCbQuery("Use /start primeiro.");

    const success = addToQueue("5v5", { id: ctx.from.id, name: player.nickname }, activeMatches, onlineUsers);
    if (!success) return ctx.answerCbQuery("Você já está em uma fila.");

    await ctx.answerCbQuery("Entrou na fila 5v5 ✅");

    const text = await getStatusText(ctx.from.id);
    const keyboard = getLobbyKeyboard(ctx.from.id);
    try {
        await ctx.editMessageText(text, keyboard);
        const msg = ctx.callbackQuery.message;
        lobbyMessages.set(ctx.from.id, { chatId: msg.chat.id, messageId: msg.message_id });
    } catch (_) {}

    // Propaga atualização para todos os outros online
    await broadcastLobbyUpdate(ctx.from.id);

    await checkQueue("5v5");
});

bot.action("QUIT", async (ctx) => {
    await markOnline(ctx.from.id);
    removeFromQueue(ctx.from.id);
    await ctx.answerCbQuery("Saiu da fila ✅");
    await refreshLobbyForUser(ctx.from.id);
    await broadcastLobbyUpdate(ctx.from.id);
});

bot.action("SET_AWAY", async (ctx) => {
    setAway(ctx.from.id);
    await ctx.answerCbQuery("Você está ausente 💤");
    await refreshLobbyForUser(ctx.from.id);
    await broadcastLobbyUpdate(ctx.from.id);
});

bot.action("SET_ONLINE", async (ctx) => {
    await markOnline(ctx.from.id);
    await ctx.answerCbQuery("Você está online 🟢");
    await refreshLobbyForUser(ctx.from.id);
    await broadcastLobbyUpdate(ctx.from.id);
});

async function checkQueue(mode) {
    const match = await createMatch(mode);
    if (!match) return;

    const allPlayers = [...match.teamA, ...match.teamB];
    const playerNicks = {};

    for (const p of allPlayers) {
        const [rows] = await pool.execute(
            "SELECT nickname FROM players WHERE telegram_id = ?",
            [p.id]
        );
        playerNicks[p.id] = rows[0] ? rows[0].nickname : `Player${p.id}`;
    }

    const lobbyTexts = await getLobbyMatchText(match);
    const refs = [];

    for (const player of allPlayers) {
        const msg = await bot.telegram.sendMessage(
            player.id,
            lobbyTexts[player.id],
            Markup.inlineKeyboard([
                [Markup.button.callback("✅ Nick alterado", `CONFIRM_${match.match_id}`)]
            ])
        );
        refs.push({ userId: player.id, chatId: msg.chat.id, messageId: msg.message_id });
    }
    lobbyMatchMessages.set(match.match_id, refs);

    // Atualiza saguão de todos (fila diminuiu)
    for (const userId of onlineUsers.keys()) {
        await refreshLobbyForUser(userId);
    }

    // Timer de 1 minuto para confirmação
    setTimeout(async () => {
        const currentMatch = activeMatches.find(m => m.match_id === match.match_id);
        if (!currentMatch) return; // Partida já iniciou ou foi removida

        const totalPlayers = currentMatch.teamA.length + currentMatch.teamB.length;
        if (currentMatch.confirmations.length < totalPlayers) {
            // Cancelar partida e gerenciar filas
            const unconfirmed = [...currentMatch.teamA, ...currentMatch.teamB].filter(p => !currentMatch.confirmations.includes(p.id));
            const confirmed = [...currentMatch.teamA, ...currentMatch.teamB].filter(p => currentMatch.confirmations.includes(p.id));

            for (const p of unconfirmed) {
                await bot.telegram.sendMessage(p.id, "❌ Você não confirmou a troca de nick a tempo e foi para o final da fila.");
                returnToQueue(currentMatch.mode, p, false);
            }
            for (const p of confirmed) {
                await bot.telegram.sendMessage(p.id, "⏳ Outros jogadores não confirmaram. Você voltou para o início da fila.");
                returnToQueue(currentMatch.mode, p, true);
            }

            await removeActiveMatch(currentMatch.match_id);
            lobbyMatchMessages.delete(currentMatch.match_id);
            
            // Notifica todos online que a fila mudou
            for (const userId of onlineUsers.keys()) {
                await refreshLobbyForUser(userId);
            }
            
            // Tenta criar nova partida com os novos estados das filas
            await checkQueue(currentMatch.mode);
        }
    }, 60000);
}

async function getLobbyMatchText(match) {
    const playerDetails = {};
    const allPlayers = [...match.teamA, ...match.teamB];
    
    for (const p of allPlayers) {
        const [rows] = await pool.execute("SELECT nickname, games, vg_index, penalty_until FROM players WHERE telegram_id = ?", [p.id]);
        const pData = rows[0];
        const isPenalty = pData && pData.penalty_until && new Date(pData.penalty_until) > new Date();
        playerDetails[p.id] = {
            nick: pData ? pData.nickname : `Player${p.id}`,
            fc: isPenalty ? "💀" : formatFC(pData.games, pData.vg_index)
        };
    }

    const messages = {};
    for (const player of allPlayers) {
        const isTeamA = match.teamA.find(p => p.id === player.id);
        const allies = isTeamA ? match.teamA : match.teamB;
        const enemies = isTeamA ? match.teamB : match.teamA;

        const allyList = allies.map(p => `» ${playerDetails[p.id].nick} (${playerDetails[p.id].fc})`).join("\n");
        const enemyList = enemies.map((p, i) => `» player${i + 1} (${playerDetails[p.id].fc})`).join("\n");

        // Número de time e nick formatado para este jogador
        const playerTeam = player.teamNumber;
        const nickFormatted = `${match.sniping_code}-${playerTeam}_${playerDetails[player.id].nick}`;

        // Progresso de confirmações: quantos já confirmaram do total
        const confirmedCount = match.confirmations.length;
        const totalCount = match.teamA.length + match.teamB.length;
        const progressBar = Array.from({ length: totalCount }, (_, i) =>
            i < confirmedCount ? "✅" : "⬜"
        ).join("");

        let text = `━━━━━━━━━━━━━━━━━━\n`;
        text += `⚔️ PARTIDA #${match.match_id}\n`;
        text += `━━━━━━━━━━━━━━━━━━\n\n`;

        text += `👥 ALIADOS\n${allyList}\n\n`;

        text += `        VS\n\n`;

        text += `🚫 INIMIGOS\n${enemyList}\n`;
        text += `──────────────────\n\n`;

        text += `🎯 Sniping Code: ${match.sniping_code}\n\n`;
        text += `Mude seu nick para:\n`;
        text += `👉 \`${nickFormatted}\`\n\n`;

        text += `Confirmações: ${confirmedCount}/${totalCount}\n`;
        text += `${progressBar}`;

        messages[player.id] = text;
    }
    return messages;
}

// Armazena referências das mensagens de lobby para atualização em tempo real
const lobbyMatchMessages = new Map(); // matchCode -> [{userId, chatId, messageId}]

bot.action(/CONFIRM_(.+)/, async (ctx) => {
    const matchId = Number(ctx.match[1]);
    const match = activeMatches.find(m => m.match_id === matchId);
    if (!match) return;

    if (!match.confirmations.includes(ctx.from.id)) {
        match.confirmations.push(ctx.from.id);
    }

    await ctx.answerCbQuery("Confirmado ✅");

    // Atualiza a mensagem de todos os jogadores no lobby para mostrar o novo ✅
    const lobbyTexts = await getLobbyMatchText(match);
    const msgRefs = lobbyMatchMessages.get(matchId) || [];
    
    for (const ref of msgRefs) {
        try {
            await bot.telegram.editMessageText(
                ref.chatId,
                ref.messageId,
                undefined,
                lobbyTexts[ref.userId],
                Markup.inlineKeyboard([
                    [Markup.button.callback("✅ Nick alterado", `CONFIRM_${match.match_id}`)]
                ])
            );
        } catch (e) {
            // Ignora se a mensagem não mudou ou não foi encontrada
        }
    }

    const totalPlayers = match.teamA.length + match.teamB.length;
    if (match.confirmations.length !== totalPlayers) return;

    // Se todos confirmaram, remove as referências de mensagens do lobby
    lobbyMatchMessages.delete(matchId);

    const players = [...match.teamA, ...match.teamB];
    const countdownMessages = [];

    for (const player of players) {
        const msg = await bot.telegram.sendMessage(player.id, "🚀 Busca iniciando em:\n\n10");
        countdownMessages.push({ chatId: player.id, messageId: msg.message_id });
    }

    for (let i = 9; i >= 1; i--) {
        await sleep(1000);
        for (const msg of countdownMessages) {
            await bot.telegram.editMessageText(msg.chatId, msg.messageId, undefined, `🚀 Busca iniciando em:\n\n${i}`);
        }
    }

    await sleep(1000);

    for (const msg of countdownMessages) {
        await bot.telegram.editMessageText(msg.chatId, msg.messageId, undefined, "🎯 BUSQUEM AGORA");
    }

    // Marca o início real da partida para cálculo de remake
    match.start_time = new Date().toISOString();
    await pool.execute("UPDATE active_matches SET start_time = ? WHERE code = ?", [match.start_time, match.code]);

    // Após o countdown, aguarda 3 minutos para mostrar os botões de resultado
    setTimeout(async () => {
        for (const player of players) {
            const team = match.teamA.find(p => p.id === player.id) ? "A" : "B";
            await bot.telegram.sendMessage(
                player.id,
                `🏁 FIM DA PARTIDA ID: ${match.match_id}\n\nSeu time: ${team}\n\nSelecione o resultado real abaixo:`,
                Markup.inlineKeyboard([
                    [
                        Markup.button.callback("✅ Ganhei", `WIN_${match.match_id}`),
                        Markup.button.callback("❌ Perdi", `LOSE_${match.match_id}`)
                    ]
                ])
            );
        }
    }, 1000 * 60 * 3);
});

bot.action(/WIN_(.+)/, async (ctx) => {
    const matchId = Number(ctx.match[1]);
    const match = activeMatches.find(m => m.match_id === matchId);
    if (!match) return;
    match.results[ctx.from.id] = "win";
    await ctx.answerCbQuery("Resultado enviado ✅");
    await finalizeMatch(match);
});

bot.action(/LOSE_(.+)/, async (ctx) => {
    const matchId = Number(ctx.match[1]);
    const match = activeMatches.find(m => m.match_id === matchId);
    if (!match) return;
    match.results[ctx.from.id] = "lose";
    await ctx.answerCbQuery("Resultado enviado ✅");
    await finalizeMatch(match);
});

async function finalizeMatch(match) {
    const totalPlayers = match.teamA.length + match.teamB.length;
    const responses = Object.keys(match.results).length;
    if (responses !== totalPlayers) return;

    // Verificar Remake (menos de 7 minutos)
    const startTime = new Date(match.start_time);
    const endTime = new Date();
    const durationSeconds = Math.floor((endTime - startTime) / 1000);
    const isRemake = durationSeconds < 420; // 7 minutos = 420 segundos

    const teamAWins = match.teamA.filter(p => match.results[p.id] === "win").length;
    const teamBWins = match.teamB.filter(p => match.results[p.id] === "win").length;

    let winner = "DRAW";
    let hasConflict = false;

    // Lógica de Consistência por Maioria
    if (teamAWins > (match.teamA.length + match.teamB.length) / 2) {
        winner = "A";
    } else if (teamBWins > (match.teamA.length + match.teamB.length) / 2) {
        winner = "B";
    } else {
        hasConflict = true;
    }

    // Se ambos os lados marcarem vitória, é um conflito obrigatório para relatório
    const teamAClaimWin = match.teamA.some(p => match.results[p.id] === "win");
    const teamBClaimWin = match.teamB.some(p => match.results[p.id] === "win");
    if (teamAClaimWin && teamBClaimWin) {
        hasConflict = true;
    }

    if (isRemake) {
        const players = [...match.teamA, ...match.teamB];
        for (const p of players) {
            await bot.telegram.sendMessage(p.id, "♻️ Partida encerrada em menos de 7 minutos. Remake detectado, o histórico não será afetado.");
        }
    } else if (!hasConflict) {
        // Processar resultados normais
        const winners = winner === "A" ? match.teamA : match.teamB;
        const losers  = winner === "A" ? match.teamB : match.teamA;

        for (const player of winners) {
            const [rows] = await pool.execute("SELECT * FROM players WHERE telegram_id = ?", [player.id]);
            const cur = rows[0];
            const wins = cur.wins + 1;
            const games = cur.games + 1;
            await pool.execute(
                "UPDATE players SET wins = ?, games = ?, vg_index = ? WHERE telegram_id = ?",
                [wins, games, calculateVGIndex(wins, games), player.id]
            );
        }

        for (const player of losers) {
            const [rows] = await pool.execute("SELECT * FROM players WHERE telegram_id = ?", [player.id]);
            const cur = rows[0];
            const losses = cur.losses + 1;
            const games  = cur.games + 1;
            await pool.execute(
                "UPDATE players SET losses = ?, games = ?, vg_index = ? WHERE telegram_id = ?",
                [losses, games, calculateVGIndex(cur.wins, games), player.id]
            );
        }
    }

    // Salvar no histórico
    const conflictData = hasConflict ? JSON.stringify(match.results) : null;
    await pool.execute(
        "INSERT INTO matches (code, mode, winner_team, created_at, duration_seconds, is_remake, conflict_report) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [match.sniping_code, match.mode, winner, new Date().toISOString(), durationSeconds, isRemake, conflictData]
    );

    if (hasConflict) {
        // Notificar administradores
        const [admins] = await pool.execute("SELECT telegram_id FROM players WHERE is_admin = TRUE");
        for (const admin of admins) {
            await bot.telegram.sendMessage(admin.telegram_id, `⚠️ CONFLITO DE RESULTADO NA PARTIDA ID: ${match.match_id}\nUse /relatorio ${match.match_id} para analisar.`);
        }
    }

    await removeActiveMatch(match.match_id);

    // Atualiza saguão e reenvia mensagem para jogadores
    for (const userId of onlineUsers.keys()) {
        await refreshLobbyForUser(userId);
    }

    const players = [...match.teamA, ...match.teamB];
    for (const player of players) {
        const text = await getStatusText(player.id);
        const keyboard = getLobbyKeyboard(player.id);
        const msg = await bot.telegram.sendMessage(player.id, text, keyboard);
        lobbyMessages.set(player.id, { chatId: msg.chat.id, messageId: msg.message_id });
    }
}

bot.command("perfil", async (ctx) => {
    await markOnline(ctx.from.id);
    const nick = ctx.message.text.split(" ").slice(1).join(" ").trim();
    
    let player;
    if (!nick) {
        const [rows] = await pool.execute("SELECT * FROM players WHERE telegram_id = ?", [ctx.from.id]);
        player = rows[0];
        if (!player) return ctx.reply("Você não está registrado. Use /start.");
    } else {
        const [rows] = await pool.execute("SELECT * FROM players WHERE nickname = ?", [nick]);
        player = rows[0];
        if (!player) return ctx.reply(`Jogador *${nick}* não encontrado.`, { parse_mode: "Markdown" });
    }

    const wr = player.games > 0 ? ((player.wins / player.games) * 100).toFixed(1) : 0;
    const isPenalty = player.penalty_until && new Date(player.penalty_until) > new Date();
    const fcText = isPenalty ? "💀" : formatFC(player.games, player.vg_index);
    
    let text = `─── 👤 ${player.nickname} ───\n\n`;
    text += `📊 ESTATÍSTICAS\n`;
    text += `» FC: ${fcText}\n`;
    text += `» Vitórias: ${player.wins}\n`;
    text += `» Derrotas: ${player.losses}\n`;
    text += `» Partidas: ${player.games}\n`;
    text += `» Win Rate: ${wr}%\n`;
    text += `──────────────────`;

    await ctx.reply(text);
    await sleep(1000);
    await showMainMenu(ctx);
});

bot.command("report", async (ctx) => {
    markOnline(ctx.from.id);
    const reportText = ctx.message.text.split(" ").slice(1).join(" ").trim();

    if (!reportText) {
        return ctx.reply("Use: /report <sua denúncia>\nExemplo: /report O jogador player1 não trocou o nick.");
    }

    const [rows] = await pool.execute("SELECT nickname FROM players WHERE telegram_id = ?", [ctx.from.id]);
    const nick = rows[0] ? rows[0].nickname : "Desconhecido";

    const timestamp = new Date().toLocaleString("pt-BR");
    const reportLine = `[${timestamp}] De: ${nick} (ID:${ctx.from.id})\nDenúncia: ${reportText}\n----------------------------------\n`;

    const reportsDir = path.join(__dirname, "reports");
    if (!fs.existsSync(reportsDir)) {
        fs.mkdirSync(reportsDir);
    }

    fs.appendFileSync(path.join(reportsDir, "denuncias.txt"), reportLine);

    await ctx.reply("✅ Sua denúncia foi enviada e será analisada pelos administradores.");
    await sleep(1000);
    await showMainMenu(ctx);
});

bot.command("changenick", async (ctx) => {
    markOnline(ctx.from.id);
    const newNick = ctx.message.text.split(" ").slice(1).join(" ").trim();

    if (!newNick) return ctx.reply("Use: /changenick <nick>");
    if (newNick.length < 3 || newNick.length > 16) return ctx.reply("Nick deve ter entre 3 e 16 caracteres.");

    const [existing] = await pool.execute(
        "SELECT * FROM players WHERE nickname = ? AND telegram_id != ?",
        [newNick, ctx.from.id]
    );
    if (existing.length > 0) return ctx.reply("Nick já em uso. Escolha outro.");

    await pool.execute("UPDATE players SET nickname = ? WHERE telegram_id = ?", [newNick, ctx.from.id]);
    await ctx.reply(`Nick alterado para *${newNick}*!`, { parse_mode: "Markdown" });
    await showMainMenu(ctx);
});

bot.command("ranking", async (ctx) => {
    await markOnline(ctx.from.id);
    const [rows] = await pool.execute(
        "SELECT * FROM players WHERE games >= 10 ORDER BY vg_index DESC, games DESC LIMIT 10"
    );

    let text = "🏆 TOP PLAYERS BR\n\n";
    if (rows.length === 0) {
        text += "Nenhum jogador com 10+ partidas ainda.";
    }

    for (let i = 0; i < rows.length; i++) {
        const p = rows[i];
        const isPenalty = p.penalty_until && new Date(p.penalty_until) > new Date();
        const fcText = isPenalty ? "💀" : formatFC(p.games, p.vg_index);
        text += `${i + 1}. ${p.nickname} - ${fcText} (${p.games} jogos)\n`;
    }

    await ctx.reply(text);
    await sleep(1000);
    await showMainMenu(ctx);
});

bot.command("noticia", async (ctx) => {
    const [adminCheck] = await pool.execute("SELECT is_admin FROM players WHERE telegram_id = ?", [ctx.from.id]);
    if (!adminCheck[0] || !adminCheck[0].is_admin) return ctx.reply("Apenas administradores.");

    const content = sanitizeInput(ctx.message.text.split(" ").slice(1).join(" "));
    if (!content) return ctx.reply("Use: /noticia <texto>");

    // Inserir nova notícia
    await pool.execute("INSERT INTO news (content) VALUES (?)", [content]);
    
    // Manter apenas as 3 mais recentes
    await pool.execute("DELETE FROM news WHERE id NOT IN (SELECT id FROM (SELECT id FROM news ORDER BY created_at DESC LIMIT 3) as x)");

    await ctx.reply("✅ Notícia publicada!");
    await broadcastLobbyUpdate();
});

bot.command("evento", async (ctx) => {
    const [adminCheck] = await pool.execute("SELECT is_admin FROM players WHERE telegram_id = ?", [ctx.from.id]);
    if (!adminCheck[0] || !adminCheck[0].is_admin) return ctx.reply("Apenas administradores.");

    const args = ctx.message.text.split(" ").slice(1).join(" ");
    const parts = args.split("|");
    if (parts.length < 2) return ctx.reply("Use: /evento <texto> | <HH:mm>\nExemplo: /evento Torneio 3v3 | 20:00");

    const content = sanitizeInput(parts[0]);
    const timeStr = parts[1].trim();
    
    // Criar objeto Date para hoje no horário especificado
    const [hours, minutes] = timeStr.split(":").map(Number);
    const eventTime = new Date();
    eventTime.setHours(hours, minutes, 0, 0);

    // Se o horário já passou hoje, assume que é para amanhã
    if (eventTime < new Date()) {
        eventTime.setDate(eventTime.getDate() + 1);
    }

    await pool.execute("INSERT INTO events (content, event_time) VALUES (?, ?)", [content, eventTime]);
    
    // Manter apenas os 4 mais recentes
    await pool.execute("DELETE FROM events WHERE id NOT IN (SELECT id FROM (SELECT id FROM events ORDER BY created_at DESC LIMIT 4) as x)");

    await ctx.reply(`✅ Evento agendado para às ${timeStr}!`);
    await broadcastLobbyUpdate();
});

bot.command("relatorio", async (ctx) => {
    const [adminCheck] = await pool.execute("SELECT is_admin FROM players WHERE telegram_id = ?", [ctx.from.id]);
    if (!adminCheck[0] || !adminCheck[0].is_admin) return ctx.reply("Apenas administradores.");

    const matchId = ctx.message.text.split(" ")[1];
    
    if (!matchId) {
        // Se não passar ID, mostra os últimos 10 conflitos pendentes
        const [conflicts] = await pool.execute("SELECT id, created_at FROM matches WHERE conflict_report IS NOT NULL ORDER BY id DESC LIMIT 10");
        if (conflicts.length === 0) return ctx.reply("Nenhum conflito encontrado.");
        
        let text = "⚠️ CONFLITOS RECENTES:\n\n";
        conflicts.forEach(c => {
            text += `ID: ${c.id} - ${c.created_at}\nUse /relatorio ${c.id} para ver detalhes.\n\n`;
        });
        return ctx.reply(text);
    }

    const [matchRows] = await pool.execute("SELECT * FROM matches WHERE id = ?", [matchId]);
    if (matchRows.length === 0) return ctx.reply("Partida não encontrada.");

    const match = matchRows[0];
    if (!match.conflict_report) return ctx.reply("Esta partida não possui conflitos registrados.");
    
    const results = JSON.parse(match.conflict_report);
    
    let text = `📄 RELATÓRIO DE CONFLITO - PARTIDA ID: ${matchId}\n\n`;
    const buttons = [];

    for (const [id, res] of Object.entries(results)) {
        const [pRows] = await pool.execute("SELECT nickname FROM players WHERE telegram_id = ?", [id]);
        const nick = pRows[0] ? pRows[0].nickname : `ID:${id}`;
        text += `${nick}: ${res === "win" ? "✅ MARCOU VITÓRIA" : "❌ MARCOU DERROTA"}\n`;
        buttons.push([Markup.button.callback(`💀 Penalizar ${nick}`, `PENALIZE_${id}_${matchId}`)]);
    }

    await ctx.reply(text, Markup.inlineKeyboard(buttons));
});

bot.action(/PENALIZE_(.+)_(.+)/, async (ctx) => {
    const [adminCheck] = await pool.execute("SELECT is_admin FROM players WHERE telegram_id = ?", [ctx.from.id]);
    if (!adminCheck[0] || !adminCheck[0].is_admin) return ctx.answerCbQuery("Acesso negado.");

    const targetId = ctx.match[1];
    const matchId = ctx.match[2];

    const penaltyDate = new Date();
    penaltyDate.setDate(penaltyDate.getDate() + 7); // 7 dias de penalidade

    // Penalidade: Caveirinha + Perda de 2 partidas
    const [pRows] = await pool.execute("SELECT losses, games, wins FROM players WHERE telegram_id = ?", [targetId]);
    if (pRows.length > 0) {
        const cur = pRows[0];
        const newLosses = cur.losses + 2;
        const newGames = cur.games + 2;
        await pool.execute(
            "UPDATE players SET penalty_until = ?, losses = ?, games = ?, vg_index = ? WHERE telegram_id = ?",
            [penaltyDate.toISOString(), newLosses, newGames, calculateVGIndex(cur.wins, newGames), targetId]
        );
    }
    
    await ctx.answerCbQuery("Jogador penalizado! 💀 + 2 Derrotas");
    await ctx.reply(`O jogador foi penalizado:\n- 💀 no lugar do FC por 7 dias\n- Adicionado 2 derrotas ao histórico`);
});

bot.command("makeadmin", async (ctx) => {
    const allowedId = process.env.ADMIN_TELEGRAM_ID ? Number(process.env.ADMIN_TELEGRAM_ID) : null;
    if (!allowedId || ctx.from.id !== allowedId) {
        return ctx.reply("Sem permissão.");
    }
    await pool.execute("UPDATE players SET is_admin = TRUE WHERE telegram_id = ?", [ctx.from.id]);
    ctx.reply("Você agora é administrador.");
});

(async () => {
    try {
        console.log("Iniciando banco de dados...");
        await initDB();
        console.log("Carregando partidas ativas...");
        await loadActiveMatches();
        
        await testTelegramConn();
        console.log("Conectando ao Telegram...");
        
        // Função de inicialização com retentativas
        const launchBot = async (retries = 5) => {
            for (let i = 0; i < retries; i++) {
                try {
                    console.log(`Tentativa de conexão ${i + 1} de ${retries}...`);
                    await bot.launch({
                        allowedUpdates: ['message', 'callback_query'],
                    });
                    return true;
                } catch (err) {
                    console.error(`Falha na tentativa ${i + 1}:`, err.message);
                    if (i === retries - 1) throw err;
                    const waitTime = Math.pow(2, i) * 1000;
                    console.log(`Aguardando ${waitTime/1000}s antes de tentar novamente...`);
                    await new Promise(resolve => setTimeout(resolve, waitTime));
                }
            }
        };

        await launchBot();

        console.log("BOT ONLINE");

        // Enable graceful stop
        process.once('SIGINT', () => bot.stop('SIGINT'));
        process.once('SIGTERM', () => bot.stop('SIGTERM'));
    } catch (error) {
        console.error("Erro fatal durante a inicialização:", error);
        process.exit(1);
    }
})();
