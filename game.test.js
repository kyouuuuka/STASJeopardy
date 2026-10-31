const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = 3977;
const base = `http://localhost:${PORT}`;
const post = async (url, body, headers) => {
  const res = await fetch(base + url, { method: 'POST', body: JSON.stringify(body), headers });
  return { status: res.status, ...(await res.json()) };
};
const admin = (action, args) => post('/api/admin', { action, ...args }, { 'x-pin': 't' });

async function snapshot(query = '') {
  const res = await fetch(`${base}/events${query}`);
  const reader = res.body.getReader();
  const { value } = await reader.read();
  await reader.cancel();
  return JSON.parse(Buffer.from(value).toString().replace('data: ', ''));
}

test('full game flow', async (t) => {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT, ADMIN_PIN: 't', STATE_FILE: path.join(os.tmpdir(), `stas-${Date.now()}.json`) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => server.kill());
  await new Promise((resolve, reject) => {
    server.stdout.once('data', resolve);
    server.once('exit', () => reject(new Error('server failed to start')));
  });

  const a = await post('/api/join', { name: 'Ana' });
  const b = await post('/api/join', { name: 'Ben' });
  assert.equal((await post('/api/join', { name: 'ana' })).status, 409);
  assert.equal((await post('/api/admin', { action: 'newGame' }, { 'x-pin': 'bad' })).status, 401);
  assert.equal((await post('/api/admin', { action: 'constructor' }, { 'x-pin': 't' })).status, 400);

  const adminView = await snapshot('?pin=t');
  const cells = adminView.categories.flatMap((c, cat) => c.cells.map((cell, idx) => ({ ...cell, cat, idx })));
  const jackpot = cells.find((c) => c.jackpot);
  assert.equal(cells.filter((c) => c.jackpot).length, 1);
  const normal = cells.find((c) => !c.jackpot && c.value === 100);

  // Public view hides answers and jackpot position.
  const pub = await snapshot();
  for (const cell of pub.categories.flatMap((c) => c.cells)) {
    assert.deepEqual(Object.keys(cell).sort(), ['used', 'value']);
  }
  assert.ok(!JSON.stringify(pub).includes('token'));

  await admin('open', { cat: normal.cat, idx: normal.idx });
  const open = (await snapshot()).current;
  assert.equal(open.clue, normal.clue);
  assert.equal(open.answer, undefined);

  // Buzz queue: closed, first in line, wrong locks out, next one wins.
  assert.equal((await post('/api/buzz', { token: a.token })).status, 409);
  await admin('buzzers', { open: true });
  await post('/api/buzz', { token: a.token });
  await post('/api/buzz', { token: b.token });
  await admin('wrong');
  assert.equal((await post('/api/buzz', { token: a.token })).status, 409);
  await admin('correct');
  let v = await snapshot();
  assert.deepEqual(v.players.map((p) => p.score), [-100, 100]);
  assert.equal(v.current.answer, normal.answer);
  assert.equal(v.control, v.players[1].id);
  await admin('close');
  v = await snapshot();
  assert.equal(v.categories[normal.cat].cells[normal.idx].used, true);

  // Jackpot limits: negative climbs to 0, under 1000 gets 1000, above bets own score.
  await admin('open', { cat: jackpot.cat, idx: jackpot.idx });
  v = await snapshot();
  const [ana, ben] = v.players;
  assert.equal(v.current.clue, undefined);
  assert.equal(v.current.max, 1000);
  assert.equal((await post('/api/wager', { token: a.token, amount: 0 })).status, 403);
  assert.equal((await post('/api/wager', { token: b.token, amount: 1001 })).status, 400);
  await admin('jackpotPlayer', { playerId: ana.id });
  assert.equal((await snapshot()).current.max, 100);
  assert.equal((await post('/api/wager', { token: a.token, amount: 101 })).status, 400);
  await admin('jackpotPlayer', { playerId: ben.id });
  await admin('score', { playerId: ben.id, score: 1500 });
  assert.equal((await snapshot()).current.max, 1500);
  assert.equal((await post('/api/wager', { token: b.token, amount: 1501 })).status, 400);
  await admin('score', { playerId: ben.id, score: 100 });

  // A missed jackpot loses the bet.
  assert.equal((await post('/api/buzz', { token: a.token })).status, 409);
  assert.equal((await post('/api/wager', { token: b.token, amount: 100 })).status, 200);
  await admin('wrong');
  assert.deepEqual((await snapshot()).players.map((p) => p.score), [-100, 0]);
  await admin('close');

  // Board 2 doubles values and has its own jackpot.
  await admin('round', { round: 1 });
  v = await snapshot('?pin=t');
  assert.deepEqual(v.categories[0].cells.map((c) => c.value), [200, 400, 600, 800, 1000]);
  assert.equal(v.categories.flatMap((c) => c.cells).filter((c) => c.jackpot).length, 1);
});
