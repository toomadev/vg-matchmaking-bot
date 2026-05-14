process.env.NODE_NO_WARNINGS = '1';

// ─── PONTO DE ENTRADA ÚNICO ───────────────────────────────────────────────────
// Este arquivo inicia o servidor Express (Mini App) e o bot Telegraf juntos.

const path = require('path');
const { initDB }           = require(path.join(__dirname, 'database'));
const { loadActiveMatches } = require(path.join(__dirname, 'matchmaking'));
const { startServer }      = require(path.join(__dirname, 'server'));
const botModule            = require(path.join(__dirname, 'bot/index'));

console.log(botModule);

const { startBot } = botModule;

(async () => {
    try {
        console.log('[BOOT] Inicializando banco de dados...');
        await initDB();

        console.log('[BOOT] Carregando partidas ativas...');
        await loadActiveMatches();

        console.log('[BOOT] Iniciando servidor Express + Socket.IO...');
        await startServer();

        console.log('[BOOT] Iniciando bot Telegram...');
        await startBot();

        console.log('[BOOT] ✅ Tudo online!');
    } catch (err) {
        console.error('[BOOT] Erro fatal:', err);
        process.exit(1);
    }
})();
