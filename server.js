const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, randomInt, randomUUID } = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const PIN = process.env.ADMIN_PIN || randomBytes(3).toString('hex');
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'state.json');
const PUBLIC = path.join(__dirname, 'public');
const PAGES = {
  '/': 'main.html',
  '/admin': 'admin.html',
  '/play': 'play.html',
  '/style.css': 'style.css',
  '/common.js': 'common.js',
};
const IMAGES = path.join(__dirname, 'images');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

const board = JSON.parse(fs.readFileSync(path.join(__dirname, 'board.json'), 'utf8')).rounds;
if (board.length !== 2 || board.some((r) => r.length !== 5 || r.some((c) => c.clues.length !== 5))) {
  throw new Error('board.json needs 2 rounds, each with 5 categories of 5 clues');
}

// Top row excluded so the jackpot never sits on the cheapest clues.
const newGame = (players = []) => ({
  round: 0,
  players,
  used: [],
  jackpots: board.map(() => ({ cat: randomInt(5), idx: 1 + randomInt(4) })),
  current: null,
  control: null,
});

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return newGame();
  }
}

let state = loadState();
const clients = new Set();

const valueOf = (round, idx) => (idx + 1) * 100 * (round + 1);
const player = (id) => state.players.find((p) => p.id === id);
const fail = (status, message) => Object.assign(new Error(message), { status });
// Negative: enough to climb back to 0. Under 1000: up to 1000. Otherwise: all their points.
const maxWager = (score) => (score < 0 ? -score : Math.max(score, 1000));

function joinUrl() {
  // ponytail: first real adapter wins; the console lists all of them if it picks wrong.
  return `${lanUrls()[0] || `http://localhost:${PORT}`}/play`;
}

function lanUrls() {
  return Object.entries(os.networkInterfaces())
    .filter(([name]) => !/vethernet|wsl|virtualbox|vmware|loopback|docker/i.test(name))
    .flatMap(([, addrs]) => addrs)
    .filter((a) => a.family === 'IPv4' && !a.internal)
    .map((a) => `http://${a.address}:${PORT}`);
}

// Answers and jackpot positions never leave the server except in the admin view.
function view({ admin, token }) {
  const { round, used, jackpots, current: c } = state;
  const me = state.players.find((p) => p.token === token);
  return {
    admin,
    joinUrl: joinUrl(),
    me: me ? me.id : null,
    round,
    rounds: board.length,
    control: state.control,
    players: state.players.map(({ id, name, score }) => ({ id, name, score })),
    categories: board[round].map((cat, ci) => ({
      name: cat.name,
      cells: cat.clues.map((clue, i) => ({
        value: valueOf(round, i),
        used: used.includes(`${round}-${ci}-${i}`),
        ...(admin && {
          clue: clue.clue,
          answer: clue.answer,
          jackpot: jackpots[round].cat === ci && jackpots[round].idx === i,
        }),
      })),
    })),
    current: c && {
      ...c,
      category: board[round][c.cat].name,
      value: valueOf(round, c.idx),
      max: player(c.playerId) ? maxWager(player(c.playerId).score) : 0,
      clue: admin || c.phase === 'clue' ? board[round][c.cat].clues[c.idx].clue : undefined,
      answer: admin || c.revealed ? board[round][c.cat].clues[c.idx].answer : undefined,
      image: admin || c.phase === 'clue' ? board[round][c.cat].clues[c.idx].image : undefined,
      answerImage: admin || c.revealed ? board[round][c.cat].clues[c.idx].answerImage : undefined,
    },
  };
}

const send = (client) => client.res.write(`data: ${JSON.stringify(view(client))}\n\n`);

function changed() {
  // ponytail: sync write per action, fine at game-show click rates.
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  clients.forEach(send);
}

function setWager(amount) {
  const c = state.current;
  if (!c || c.phase !== 'wager') throw fail(409, 'Not taking wagers');
  const p = player(c.playerId);
  if (!p) throw fail(409, 'Pick a player first');
  const max = maxWager(p.score);
  if (!Number.isInteger(amount) || amount < 0 || amount > max) throw fail(400, `Bet 0 to ${max}`);
  c.wager = amount;
  c.phase = 'clue';
}

function endClue(c) {
  c.revealed = true;
  c.buzzOpen = false;
  c.buzzes = [];
}

function judge(correct) {
  const c = state.current;
  if (!c || c.phase !== 'clue' || c.revealed) throw fail(409, 'No clue to judge');
  const p = player(c.jackpot ? c.playerId : c.buzzes[0]);
  if (!p) throw fail(409, 'Nobody is answering');
  if (c.jackpot) {
    p.score += correct ? c.wager : -c.wager;
    if (correct) state.control = p.id;
    endClue(c);
  } else if (correct) {
    p.score += valueOf(state.round, c.idx);
    state.control = p.id;
    endClue(c);
  } else {
    // Next in the queue is up automatically.
    p.score -= valueOf(state.round, c.idx);
    c.buzzes.shift();
    c.locked.push(p.id);
  }
}

const actions = {
  open({ cat, idx }) {
    if (state.current) throw fail(409, 'Close the current clue first');
    if (!board[state.round][cat]?.clues[idx]) throw fail(400, 'No such tile');
    const spot = state.jackpots[state.round];
    const jackpot = spot.cat === cat && spot.idx === idx;
    state.current = {
      cat,
      idx,
      jackpot,
      playerId: jackpot && player(state.control) ? state.control : null,
      wager: null,
      phase: jackpot ? 'wager' : 'clue',
      revealed: false,
      buzzOpen: false,
      buzzes: [],
      locked: [],
    };
  },
  jackpotPlayer({ playerId }) {
    if (state.current?.phase !== 'wager' || !player(playerId)) throw fail(409, 'Cannot pick that player');
    state.current.playerId = playerId;
  },
  wager: ({ amount }) => setWager(amount),
  buzzers({ open }) {
    const c = state.current;
    if (!c || c.jackpot || c.revealed) throw fail(409, 'No clue to buzz on');
    c.buzzOpen = Boolean(open);
  },
  correct: () => judge(true),
  wrong: () => judge(false),
  reveal() {
    if (state.current?.phase !== 'clue') throw fail(409, 'No clue showing');
    endClue(state.current);
  },
  close() {
    if (!state.current) throw fail(409, 'No clue open');
    const { cat, idx } = state.current;
    const key = `${state.round}-${cat}-${idx}`;
    if (!state.used.includes(key)) state.used.push(key);
    state.current = null;
  },
  cancel() {
    state.current = null;
  },
  round({ round }) {
    if (state.current) throw fail(409, 'Close the current clue first');
    if (!board[round]) throw fail(400, 'No such board');
    state.round = round;
  },
  score({ playerId, score }) {
    const p = player(playerId);
    if (!p || !Number.isInteger(score)) throw fail(400, 'Bad score');
    p.score = score;
  },
  remove({ playerId }) {
    state.players = state.players.filter((p) => p.id !== playerId);
    const c = state.current;
    if (c) {
      c.buzzes = c.buzzes.filter((id) => id !== playerId);
      c.locked = c.locked.filter((id) => id !== playerId);
      if (c.playerId === playerId) c.playerId = null;
    }
    if (state.control === playerId) state.control = null;
  },
  newGame() {
    state = newGame(state.players.map((p) => ({ ...p, score: 0 })));
  },
};

function join({ name }) {
  name = String(name ?? '').trim();
  if (!name || name.length > 20) throw fail(400, 'Name must be 1 to 20 characters');
  if (state.players.length >= 30) throw fail(409, 'Game is full');
  if (state.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    throw fail(409, 'That name is taken');
  }
  const p = { id: randomUUID(), token: randomUUID(), name, score: 0 };
  state.players.push(p);
  return { token: p.token };
}

function playerByToken(token) {
  const p = state.players.find((x) => x.token === token);
  if (!p) throw fail(401, 'Join the game first');
  return p;
}

function buzz({ token }) {
  const { id } = playerByToken(token);
  const c = state.current;
  // ponytail: arrival order at the server decides, so Wi-Fi lag counts. Fine in one room.
  if (!c?.buzzOpen || c.buzzes.includes(id) || c.locked.includes(id)) throw fail(409, 'Buzzers closed');
  c.buzzes.push(id);
}

function playerWager({ token, amount }) {
  const { id } = playerByToken(token);
  if (state.current?.playerId !== id) throw fail(403, 'Not your jackpot');
  setWager(amount);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10_000) reject(fail(413, 'Too large'));
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        if (typeof parsed !== 'object' || parsed === null) throw new Error();
        resolve(parsed);
      } catch {
        reject(fail(400, 'Bad JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function handlePost(req, url) {
  const body = await readJson(req);
  if (url.pathname === '/api/join') return join(body);
  if (url.pathname === '/api/buzz') return buzz(body);
  if (url.pathname === '/api/wager') return playerWager(body);
  if (url.pathname === '/api/admin') {
    if (req.headers['x-pin'] !== PIN) throw fail(401, 'Wrong PIN');
    if (!Object.hasOwn(actions, body.action)) throw fail(400, 'Unknown action');
    return actions[body.action](body);
  }
  throw fail(404, 'Not found');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'POST') {
    try {
      const result = await handlePost(req, url);
      changed();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result ?? {}));
    } catch (err) {
      if (!err.status) console.error(err);
      res.writeHead(err.status || 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.status ? err.message : 'Server error' }));
    }
    return;
  }

  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    const client = { res, admin: url.searchParams.get('pin') === PIN, token: url.searchParams.get('token') };
    clients.add(client);
    req.on('close', () => clients.delete(client));
    send(client);
    return;
  }

  if (url.pathname.startsWith('/images/')) {
    // basename keeps requests inside images/.
    // ponytail: anyone who guesses a file name can open it early; use unguessable names if that matters.
    let name;
    try {
      name = path.basename(decodeURIComponent(url.pathname));
    } catch {
      name = '';
    }
    const type = Object.hasOwn(TYPES, path.extname(name).toLowerCase()) && TYPES[path.extname(name).toLowerCase()];
    fs.readFile(path.join(IMAGES, name), (err, data) => {
      if (err || !type?.startsWith('image/')) return res.writeHead(404).end('Not found');
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }).end(data);
    });
    return;
  }

  const page = Object.hasOwn(PAGES, url.pathname) && PAGES[url.pathname];
  if (!page) {
    res.writeHead(404).end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(page)], 'Cache-Control': 'no-cache' });
  fs.createReadStream(path.join(PUBLIC, page)).pipe(res);
});

setInterval(() => clients.forEach((c) => c.res.write(': ping\n\n')), 25_000).unref();

server.listen(PORT, () => {
  const urls = lanUrls();
  const list = (page) => (urls.length ? urls : [`http://localhost:${PORT}`]).map((u) => u + page).join('  or  ');
  console.log(`Main screen   ${list('/')}`);
  console.log(`Admin screen  ${list('/admin')}`);
  console.log(`Players       ${list('/play')}`);
  console.log(`Admin PIN     ${PIN}`);
});
