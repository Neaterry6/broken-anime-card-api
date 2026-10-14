'use strict';

// Live tests — these hit the real AniList API and boot a real server.
// Run with `npm run test:live`.
const test = require('node:test');
const assert = require('node:assert');

const api = require('./index.js');

const realFetch = global.fetch;

async function withServer(fn) {
  const server = await api.createServer({ port: 0, host: '127.0.0.1' });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const get = async (path) => {
    const res = await realFetch(base + path);
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) };
  };
  try { return await fn(get, base); }
  finally { await new Promise((r) => server.close(r)); }
}

test('live: /api/search returns real AniList data', async () => {
  await withServer(async (get) => {
    const r = await get('/api/search?q=naruto&limit=5');
    assert.strictEqual(r.status, 200);
    const b = r.json();
    assert.strictEqual(b.ok, true);
    assert.ok(b.count > 0, 'should find results');
    const first = b.results[0];
    assert.ok(first.title, 'should have a title');
    assert.ok(first.id > 0);
    assert.ok(first.cover, 'should have cover art');
    assert.ok(first.rarity, 'should have a rarity');
  });
});

test('live: /api/anime/:id returns a full record', async () => {
  await withServer(async (get) => {
    const r = await get('/api/anime/20'); // Naruto
    assert.strictEqual(r.status, 200);
    const b = r.json();
    assert.strictEqual(b.anime.id, 20);
    assert.ok(b.anime.title);
    assert.ok(b.anime.episodes > 0, 'should know the episode count');
    assert.ok(b.card.rarity, 'should have a card rarity');
  });
});

test('live: /api/card/:id.svg renders a real card', async () => {
  await withServer(async (get) => {
    const r = await get('/api/card/20.svg');
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(r.text, /^<svg /);
    assert.ok(r.text.includes('Naruto'), 'card should carry the title');
    assert.ok(!r.text.includes('NaN'));
  });
});

test('live: the rendered card is valid SVG a browser can parse', async () => {
  await withServer(async (get) => {
    const r = await get('/api/card/20.svg');
    // structural sanity: tags must balance
    const opens = (r.text.match(/<g[ >]/g) || []).length;
    const closes = (r.text.match(/<\/g>/g) || []).length;
    assert.strictEqual(opens, closes, 'every <g> must close');
    const defsOpen = (r.text.match(/<defs>/g) || []).length;
    const defsClose = (r.text.match(/<\/defs>/g) || []).length;
    assert.strictEqual(defsOpen, defsClose);
  });
});

test('live: /api/trending returns real trending anime', async () => {
  await withServer(async (get) => {
    const r = await get('/api/trending?limit=5');
    assert.strictEqual(r.status, 200);
    const b = r.json();
    assert.strictEqual(b.kind, 'trending');
    assert.ok(b.count > 0);
    for (const a of b.results) assert.ok(a.title, 'every entry needs a title');
  });
});

test('live: /api/top returns high scorers', async () => {
  await withServer(async (get) => {
    const r = await get('/api/top?limit=5');
    const b = r.json();
    assert.ok(b.count > 0);
    assert.ok(b.results[0].score >= 80, 'top rated should score well, got ' + b.results[0].score);
  });
});

test('live: /api/random.svg works end to end', async () => {
  await withServer(async (get) => {
    const r = await get('/api/random.svg');
    assert.strictEqual(r.status, 200);
    assert.match(r.text, /^<svg /);
  });
});

test('live: caching means the second search does not re-hit upstream', async () => {
  await withServer(async (get) => {
    const t0 = Date.now();
    await get('/api/search?q=bleach&limit=3');
    const first = Date.now() - t0;
    const t1 = Date.now();
    await get('/api/search?q=bleach&limit=3');
    const second = Date.now() - t1;
    // the cached one should be dramatically faster
    assert.ok(second < first, `cached ${second}ms should beat uncached ${first}ms`);
  });
});

test('live: a genuinely missing id returns 404, not a crash', async () => {
  await withServer(async (get) => {
    const r = await get('/api/anime/999999999');
    assert.ok([404, 502].includes(r.status), 'got ' + r.status);
    assert.strictEqual(r.json().ok, false);
  });
});

test('live: the card is deterministic across requests', async () => {
  await withServer(async (get) => {
    const a = await get('/api/card/20.svg');
    const b = await get('/api/card/20.svg');
    assert.strictEqual(a.text, b.text, 'same anime must produce the same card');
  });
});
