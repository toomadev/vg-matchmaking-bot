const { pool } = require("./database");

let queue3v3 = [];
let queue5v5 = [];
let activeMatches = [];

async function loadActiveMatches() {
    const [rows] = await pool.execute("SELECT * FROM active_matches");
    activeMatches.length = 0;
    for (const match of rows) {
        activeMatches.push({
            ...match,
            teamA: JSON.parse(match.team_a_ids),
            teamB: JSON.parse(match.team_b_ids),
            confirmations: JSON.parse(match.confirmations),
            results: JSON.parse(match.results)
        });
    }
}

function generateSnipingCode() {
    let code;
    do {
        code = Math.floor(Math.random() * 6000) + 4000;
    } while (activeMatches.some(m => m.sniping_code === code));
    return code;
}

function isPlayerInMatch(id, activeMatches) {
    return activeMatches.some(m => 
        m.teamA.some(p => p.id === id) || 
        m.teamB.some(p => p.id === id)
    );
}

function addToQueue(mode, player, activeMatches, onlineUsers) {
    // Garante que o jogador está online antes de entrar na fila
    const user = onlineUsers.get(player.id);
    if (!user || user.status !== 'online') return false;

    const alreadyIn3v3 = queue3v3.find(p => p.id === player.id);
    const alreadyIn5v5 = queue5v5.find(p => p.id === player.id);

    if (alreadyIn3v3 || alreadyIn5v5) return false;
    
    // Verifica se o jogador já está em uma partida ativa
    if (isPlayerInMatch(player.id, activeMatches)) return false;

    if (mode === "3v3") queue3v3.push(player);
    if (mode === "5v5") queue5v5.push(player);

    return true;
}

function removeFromQueue(id) {
    const index3 = queue3v3.findIndex(p => p.id === id);
    if (index3 !== -1) queue3v3.splice(index3, 1);

    const index5 = queue5v5.findIndex(p => p.id === id);
    if (index5 !== -1) queue5v5.splice(index5, 1);
}

function returnToQueue(mode, player, priority = false) {
    let queue;
    if (mode === "3v3") queue = queue3v3;
    else queue = queue5v5;

    const exists = queue.some(p => p.id === player.id);
    if (exists) return;

    if (priority) {
        queue.unshift(player); // Início da fila
    } else {
        queue.push(player); // Final da fila
    }
}

async function createMatch(mode) {
    let size;
    let queue;
    
    if (mode === "3v3") {
        size = 6;
        queue = queue3v3;
    } else {
        size = 10;
        queue = queue5v5;
    }

    if (queue.length < size) return null;

    const players = queue.splice(0, size);
    
    // Remove esses jogadores de QUALQUER outra fila que possam estar (garantia extra)
    for (const p of players) {
        removeFromQueue(p.id);
    }

    const shuffled = [...players].sort(() => Math.random() - 0.5);
    const half = size / 2;

    // Atribui número de time aleatório (1 ou 2) — metade recebe 1, metade recebe 2
    const teamNumber = Math.random() < 0.5 ? 1 : 2;
    const teamA = shuffled.slice(0, half).map(p => ({ ...p, teamNumber }));
    const teamB = shuffled.slice(half).map(p => ({ ...p, teamNumber: teamNumber === 1 ? 2 : 1 }));

    const snipingCode = generateSnipingCode();

    const [result] = await pool.execute(
        `INSERT INTO active_matches (sniping_code, mode, team_a_ids, team_b_ids, confirmations, results, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
            snipingCode,
            mode,
            JSON.stringify(teamA),
            JSON.stringify(teamB),
            JSON.stringify([]),
            JSON.stringify({}),
            new Date().toISOString()
        ]
    );

    const match = {
        match_id: result.insertId,
        sniping_code: snipingCode,
        mode,
        teamA,
        teamB,
        confirmations: [],
        results: {}
    };

    activeMatches.push(match);
    return match;
}

async function removeActiveMatch(matchId) {
    await pool.execute("DELETE FROM active_matches WHERE match_id = ?", [matchId]);
    const index = activeMatches.findIndex(m => m.match_id === matchId);
    if (index !== -1) activeMatches.splice(index, 1);
}

module.exports = {
    queue3v3,
    queue5v5,
    activeMatches,
    loadActiveMatches,
    addToQueue,
    removeFromQueue,
    returnToQueue,
    createMatch,
    removeActiveMatch
};
