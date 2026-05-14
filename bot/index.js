
const { Telegraf, Markup } = require('telegraf');
const fs   = require('fs');
const path = require('path');
const https = require('https');

const { pool } = require(path.join(__dirname, '../database'));

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
        
        await ctx.reply(`✅ Nick <b>${nick}</b> registrado!`, { parse_mode: 'HTML' });
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

    // Tutorial em HTML (muito mais robusto que Markdown para caracteres especiais)
    const tutorial = 
        '⚡ <b>VG Matchmaking BR</b>\n\n' +
        '📖 <b>COMO USAR:</b>\n\n' +
        '1️⃣ <b>Escolha a Fila</b>\n' +
        '   🎯 <b>3v3 Ranked</b> — Competitivo, ganha/perde FC\n' +
        '   🔥 <b>5v5 Casual</b> — Sem pontos, apenas diversão\n\n' +
        '2️⃣ <b>Aguarde a Partida</b>\n' +
        '   Quando 6 ou 10 jogadores forem encontrados, você receberá:\n' +
        '   • ID da partida (#XXXXX)\n' +
        '   • Sniping Code (ex: VG-1_)\n' +
        '   • Nomes dos seus aliados\n\n' +
        '3️⃣ <b>Mude Seu Nick</b>\n' +
        '   Antes de entrar no jogo, mude seu nick para:\n' +
        '   <code>SNIPING_CODE-NUMERO_SeuNick</code>\n' +
        '   Exemplo: <code>VG-1_Seu_Nick</code>\n\n' +
        '4️⃣ <b>Jogue!</b>\n' +
        '   Encontre seus aliados (mesma cor) e vença!\n\n' +
        '💡 <b>DICAS:</b>\n' +
        '   • Fique <b>Online</b> para ser encontrado\n' +
        '   • Clique em <b>Ausente</b> se precisar sair\n' +
        '   • Veja seu <b>Perfil</b> e <b>Ranking</b>\n' +
        '   • Busque outros jogadores por nick\n\n' +
        '🚀 <b>Pronto? Toque no botão abaixo!</b>';

    await ctx.reply(tutorial, { parse_mode: 'HTML', ...keyboard });
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
