
const { Telegraf, Markup } = require('telegraf');
const fs   = require('fs');
const path = require('path');
const https = require('https');

const { pool }              = require('../database');

// ─── UTILS ────────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sanitizeInput(text) { return String(text || '').replace(/[<>"\']/g, '').trim(); }

async function testTelegramConn() {
    return new Promise((resolve) => {
        const req = https.get('https://api.telegram.org', res => { resolve(true); });
        req.on('error', () => resolve(false));
        req.setTimeout(10000, () => { req.destroy(); resolve(false); });
    });
}

// ─── HANDLERS ─────────────────────────────────────────────────────────────────
function setupHandlers(bot) {
    const pendingNick = new Set();

    // /start - Registra o usuário se necessário e abre o app
    bot.start(async (ctx) => {
        const [rows] = await pool.execute('SELECT * FROM players WHERE telegram_id = ?', [ctx.from.id]);
        
        if (!rows[0]) {
            // Novo usuário - pede o nick
            pendingNick.add(ctx.from.id);
            return ctx.reply('👋 Bem-vindo ao VG Matchmaking BR!\n\nDigite seu nick para começar (3-16 caracteres):');
        }
        
        // Usuário já registrado - oferece o app
        await sendAppPortal(ctx);
    });

    // /saguao - Abre o app
    bot.command('saguao', async (ctx) => {
        await sendAppPortal(ctx);
    });

    // /tutorial - Mostra o tutorial novamente
    bot.command('tutorial', async (ctx) => {
        await sendAppPortal(ctx);
    });

    // Mensagens de texto - para registro de nick
    bot.on('text', async (ctx, next) => {
        if (!pendingNick.has(ctx.from.id)) {
            return next();
        }

        const nick = sanitizeInput(ctx.message.text);
        if (nick.startsWith('/')) return next();
        if (nick.length < 3 || nick.length > 16) {
            return ctx.reply('Nick inválido. Use entre 3 e 16 caracteres:');
        }

        const [existing] = await pool.execute('SELECT * FROM players WHERE nickname = ?', [nick]);
        if (existing.length > 0) {
            return ctx.reply('Este nick já está em uso. Escolha outro:');
        }

        // Registra o novo jogador
        await pool.execute('INSERT INTO players (telegram_id, nickname) VALUES (?, ?)', [ctx.from.id, nick]);
        pendingNick.delete(ctx.from.id);
        
        await ctx.reply(`✅ Nick *${nick}* registrado!`, { parse_mode: 'Markdown' });
        await sleep(500);
        await sendAppPortal(ctx);
    });
}

// ─── FUNÇÃO: Enviar o Portal do App com Tutorial ────────────────────────────────
async function sendAppPortal(ctx) {
    const WEBAPP_URL = process.env.WEBAPP_URL;
    if (!WEBAPP_URL) {
        return ctx.reply('❌ WebApp URL não configurada.');
    }

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.webApp('🎮 Abrir VG Matchmaking', WEBAPP_URL)],
    ]);

    // Tutorial com escapes corretos para MarkdownV2
    const tutorial = 
        '*⚡ VG Matchmaking BR*\n\n' +
        '*📖 COMO USAR:*\n\n' +
        '*1️⃣ Escolha a Fila*\n' +
        '   🎯 *3v3 Ranked* — Competitivo, ganha/perde FC\n' +
        '   🔥 *5v5 Casual* — Sem pontos, apenas diversão\n\n' +
        '*2️⃣ Aguarde a Partida*\n' +
        '   Quando 6 ou 10 jogadores forem encontrados, você receberá:\n' +
        '   • ID da partida \\(#XXXXX\\)\n' +
        '   • Sniping Code \\(ex: VG\\-1\\_\\)\n' +
        '   • Nomes dos seus aliados\n\n' +
        '*3️⃣ Mude Seu Nick*\n' +
        '   Antes de entrar no jogo, mude seu nick para:\n' +
        '   `SNIPING_CODE-NUMERO_SeuNick`\n' +
        '   Exemplo: `VG-1_Seu_Nick`\n\n' +
        '*4️⃣ Jogue\\!*\n' +
        '   Encontre seus aliados \\(mesma cor\\) e vença\\!\n\n' +
        '*💡 DICAS:*\n' +
        '   • Fique *Online* para ser encontrado\n' +
        '   • Clique em *Ausente* se precisar sair\n' +
        '   • Veja seu *Perfil* e *Ranking*\n' +
        '   • Busque outros jogadores por nick\n\n' +
        '*🚀 Pronto\\? Toque no botão abaixo\\!*';

    await ctx.reply(tutorial, { parse_mode: 'MarkdownV2', ...keyboard });
}

// ─── INICIALIZAÇÃO ────────────────────────────────────────────────────────────
async function startBot() {
    const BOT_TOKEN = process.env.BOT_TOKEN;
    if (!BOT_TOKEN) {
        console.error('[BOT] BOT_TOKEN não configurado');
        return;
    }

    const bot = new Telegraf(BOT_TOKEN);
    
    // Testa conexão com Telegram
    const isConnected = await testTelegramConn();
    if (!isConnected) {
        console.warn('[BOT] Sem conexão com Telegram API');
    }

    setupHandlers(bot);

    // Inicia o polling
    bot.launch();
    console.log('[BOT] ✅ Bot iniciado e aguardando mensagens...');

    // Graceful shutdown
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

// ─── EXPORT ───────────────────────────────────────────────────────────────────
module.exports = { startBot };
