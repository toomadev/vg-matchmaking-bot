const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const cors       = require('cors');

const { pool }                              = require('./database');
const { queue3v3, queue5v5, activeMatches } = require('./matchmaking');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── ESTADO COMPARTILHADO COM O BOT ──────────────────────────────────────────
const onlineUsers   = new Map();
const lobbyMessages = new Map();

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
function formatFC(games, vg_index) {
    if (games < 10) return `${games}/10`;
    return `FC ${Number(vg_index).toFixed(2)}`;
}

// ─── ESTADO GLOBAL ────────────────────────────────────────────────────────────
async function getGlobalState() {
    const [topPlayers] = await pool.execute(
        'SELECT nickname, wins, losses, games, vg_index, penalty_until FROM players WHERE games >= 10 ORDER BY vg_index DESC, games DESC LIMIT 10'
    );
    return {
        online:    countOnline(),
        searching: countSearching(),
        inGame:    activeMatches.length,
        queue3v3:  queue3v3.length,
        queue5v5:  queue5v5.length,
        matches:   activeMatches.map(m => ({
            id: m.match_id, mode: m.mode,
            confirmed: m.confirmations.length,
            total:     m.teamA.length + m.teamB.length,
        })),
        ranking: topPlayers.map((p, i) => ({
            pos: i + 1, nick: p.nickname,
            fc: formatFC(p.games, p.vg_index), fcRaw: Number(p.vg_index).toFixed(2),
            games: p.games, wins: p.wins, losses: p.losses,
            penalty: !!(p.penalty_until && new Date(p.penalty_until) > new Date()),
        })),
    };
}

async function broadcastState() {
    const state = await getGlobalState();
    io.emit('state_update', state);
}

async function notifyPlayer(telegramId, event, data) {
    io.to(`player_${telegramId}`).emit(event, data);
}

// ─── API REST ─────────────────────────────────────────────────────────────────
app.get('/api/state', async (req, res) => {
    try { res.json(await getGlobalState()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/player/:telegramId', async (req, res) => {
    try {
        const uid = Number(req.params.telegramId);
        const [rows] = await pool.execute('SELECT * FROM players WHERE telegram_id = ?', [uid]);
        if (!rows[0]) return res.status(404).json({ error: 'not_found' });
        const p         = rows[0];
        const isPenalty = p.penalty_until && new Date(p.penalty_until) > new Date();
        const wr        = p.games > 0 ? ((p.wins / p.games) * 100).toFixed(1) : '0.0';
        const [rankRows]  = await pool.execute('SELECT COUNT(*) as pos FROM players WHERE vg_index > ? AND games >= 10', [p.vg_index]);
        const [totalRows] = await pool.execute('SELECT COUNT(*) as total FROM players WHERE games >= 10');
        const match = activeMatches.find(m => m.teamA.some(pl => pl.id === uid) || m.teamB.some(pl => pl.id === uid));
        res.json({
            nick: p.nickname, id: p.telegram_id,
            fc: isPenalty ? null : formatFC(p.games, p.vg_index),
            fcRaw: Number(p.vg_index).toFixed(2),
            wins: p.wins, losses: p.losses, games: p.games, winRate: wr,
            penalty: isPenalty, penaltyUntil: p.penalty_until,
            rank: p.games >= 10 ? rankRows[0].pos + 1 : null,
            totalRanked: totalRows[0].total, isAdmin: !!p.is_admin,
            inQueue3v3: queue3v3.some(q => q.id === uid),
            inQueue5v5: queue5v5.some(q => q.id === uid),
            inMatch: !!match,
            online: onlineUsers.get(uid)?.status === 'online',
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ranking', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            'SELECT nickname, wins, losses, games, vg_index, penalty_until FROM players WHERE games >= 10 ORDER BY vg_index DESC, games DESC LIMIT 10'
        );
        res.json(rows.map((p, i) => ({
            pos: i + 1, nick: p.nickname,
            fc: formatFC(p.games, p.vg_index), fcRaw: Number(p.vg_index).toFixed(2),
            games: p.games, wins: p.wins,
            penalty: !!(p.penalty_until && new Date(p.penalty_until) > new Date()),
        })));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/match/:telegramId', async (req, res) => {
    try {
        const uid   = Number(req.params.telegramId);
        const match = activeMatches.find(m => m.teamA.some(p => p.id === uid) || m.teamB.some(p => p.id === uid));
        if (!match) return res.json({ inMatch: false });
        const isTeamA = match.teamA.some(p => p.id === uid);
        const me      = [...match.teamA, ...match.teamB].find(p => p.id === uid);
        const allies  = isTeamA ? match.teamA : match.teamB;
        const alliesDetails = [];
        for (const p of allies) {
            const [rows] = await pool.execute('SELECT nickname, games, vg_index FROM players WHERE telegram_id = ?', [p.id]);
            if (rows[0]) alliesDetails.push({ nick: rows[0].nickname, fc: formatFC(rows[0].games, rows[0].vg_index) });
        }
        res.json({
            inMatch: true, matchId: match.match_id, mode: match.mode,
            snipingCode: match.sniping_code, myTeamNumber: me?.teamNumber,
            myNickFormat: `${match.sniping_code}-${me?.teamNumber}_`,
            confirmed: match.confirmations.length, total: match.teamA.length + match.teamB.length,
            allies: alliesDetails, iConfirmed: match.confirmations.includes(uid),
            started: !!match.start_time,
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/news', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT content, created_at FROM news ORDER BY created_at DESC LIMIT 3');
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Rota interna: bot dispara broadcast
app.post('/api/internal/broadcast', async (req, res) => {
    if (req.body.secret !== process.env.INTERNAL_SECRET) return res.status(403).json({ error: 'forbidden' });
    await broadcastState();
    res.json({ ok: true });
});

// Presença via Mini App
app.post('/api/presence', async (req, res) => {
    const { telegramId } = req.body;
    if (!telegramId) return res.status(400).json({ error: 'missing telegramId' });
    onlineUsers.set(Number(telegramId), { timestamp: Date.now(), status: 'online' });
    await broadcastState();
    res.json({ ok: true });
});

// ─── SOCKET.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    getGlobalState().then(state => socket.emit('state_update', state));
    socket.on('join_player', (tid) => socket.join(`player_${tid}`));
});

// ─── EXPORT ───────────────────────────────────────────────────────────────────
function startServer() {
    return new Promise((resolve) => {
        const PORT = process.env.PORT || 3000;
        server.listen(PORT, () => {
            console.log(`[SERVER] http://localhost:${PORT}`);
            resolve();
        });
    });
}

module.exports = { io, onlineUsers, lobbyMessages, broadcastState, notifyPlayer, formatFC, startServer };
