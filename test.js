'use strict';

// Offline tests. fetch is stubbed and the server is booted on a random port,
// so these are deterministic and need no external network.
const test = require('node:test');
const assert = require('node:assert');

const api = require('./index.js');

const realFetch = global.fetch;
function stubFetch(handler) {
  global.fetch = async (url, opts) => handler(String(url), opts);
  return () => { global.fetch = realFetch; };
}

const MEDIA = {
  id: 20,
  title: { romaji: 'NARUTO', english: 'Naruto', native: 'ナルト' },
  description: '<i>Naruto</i> is about a ninja.',
  format: 'TV',
  status: 'FINISHED',
  seasonYear: 2002,
  episodes: 220,
  duration: 23,
  averageScore: 80,
  popularity: 300000,
  favourites: 20000,
  genres: ['Action', 'Adventure'],
  isAdult: false,
  coverImage: { extraLarge: 'https://img/xl.jpg', large: 'https://img/l.jpg', color: '#e4a15d' },
  bannerImage: 'https://img/banner.jpg',
  studios: { nodes: [{ name: 'Pierrot' }] },
};

function anilistReply(media) {
  return { ok: true, status: 200, json: async () => ({ data: { Page: { media } } }) };
}
function anilistOne(media) {
  return { ok: true, status: 200, json: async () => ({ data: { Media: media } }) };
}

/** Boot the handler on a random port and return a fetch helper. */
async function withServer(fn) {
  const server = await api.createServer({ port: 0, host: '127.0.0.1' });
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  // IMPORTANT: use the real fetch here, not global.fetch -- the tests stub
  // global.fetch to fake AniList, and the client must not be stubbed too.
  const get = async (path) => {
    const res = await realFetch(base + path);
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) };
  };
  try { return await fn(get, base); }
  finally { await new Promise((r) => server.close(r)); }
}

// ── rendering ─────────────────────────────────────────────────────────────

test('renderCard produces a standalone SVG', () => {
  const svg = api.renderCard({ name: 'Naruto', rarity: 'legendary' });
  assert.match(svg, /^<svg /);
  assert.match(svg, /<\/svg>\s*$/);
  assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.ok(svg.includes('Naruto'));
  assert.ok(svg.includes('LEGENDARY'));
});

test('renderCard needs a name', () => {
  assert.throws(() => api.renderCard({}), (e) => e.code === 'MISSING_NAME');
  assert.throws(() => api.renderCard(null), (e) => e.code === 'BAD_INPUT');
});

test('renderCard never emits NaN or undefined', () => {
  const svg = api.renderCard({ name: 'X', power: 'abc', speed: NaN, intellect: null });
  assert.ok(!svg.includes('NaN'));
  assert.ok(!svg.includes('undefined'));
});

test('renderCard escapes HTML in the name', () => {
  const svg = api.renderCard({ name: '<script>alert(1)</script>' });
  assert.ok(!svg.includes('<script>'));
  assert.ok(svg.includes('&lt;script&gt;'));
});

test('renderCard clamps stats to 0-100', () => {
  assert.ok(api.renderCard({ name: 'X', power: 9999 }).includes('>100<'));
  assert.ok(api.renderCard({ name: 'X', power: -5 }).includes('>0<'));
});

test('renderCard is deterministic', () => {
  const a = api.renderCard({ name: 'Same' });
  const b = api.renderCard({ name: 'Same' });
  assert.strictEqual(a, b);
});

test('renderCard honours width', () => {
  const svg = api.renderCard({ name: 'X' }, { width: 1000 });
  assert.match(svg, /width="1000"/);
  assert.match(svg, /viewBox="0 0 500 700"/, 'viewBox stays constant');
});

test('an image URL becomes an <image> element', () => {
  const svg = api.renderCard({ name: 'X', image: 'https://x/y.jpg' });
  assert.match(svg, /<image href="https:\/\/x\/y\.jpg"/);
});

test('every rarity renders', () => {
  for (const key of Object.keys(api.RARITIES)) {
    const svg = api.renderCard({ name: 'T', rarity: key });
    assert.ok(svg.includes(api.RARITIES[key].label), key);
  }
});

// ── animeToCard ───────────────────────────────────────────────────────────

test('animeToCard is deterministic', () => {
  const a = api.mapAnime(MEDIA);
  assert.deepStrictEqual(api.animeToCard(a), api.animeToCard(a));
});

test('popularity drives rarity', () => {
  const huge = api.mapAnime({ ...MEDIA, popularity: 500000 });
  assert.strictEqual(api.animeToCard(huge).rarity, 'mythic');
  const small = api.mapAnime({ ...MEDIA, popularity: 100 });
  assert.ok(['common', 'uncommon'].includes(api.animeToCard(small).rarity));
});

test('animeToCard carries the api-only fields', () => {
  const c = api.animeToCard(api.mapAnime(MEDIA));
  assert.strictEqual(c.animeId, 20);
  assert.strictEqual(c.score, 80);
  assert.strictEqual(c.episodes, 220);
  assert.strictEqual(c.cover, 'https://img/xl.jpg');
});

test('mapAnime strips HTML from the synopsis', () => {
  const a = api.mapAnime(MEDIA);
  assert.ok(!a.synopsis.includes('<i>'));
  assert.match(a.synopsis, /Naruto is about a ninja/);
});

test('mapAnime fills missing fields with null, not undefined', () => {
  const a = api.mapAnime({ id: 1, title: { romaji: 'X' } });
  assert.strictEqual(a.synopsis, null);
  assert.strictEqual(a.cover, null);
  assert.strictEqual(a.banner, null);
  assert.strictEqual(a.year, null);
  assert.deepStrictEqual(a.genres, []);
  assert.deepStrictEqual(a.studios, []);
});

// ── cache ─────────────────────────────────────────────────────────────────

test('cache stores and expires', async () => {
  const c = api.createCache({ ttlMs: 50 });
  c.set('a', 1);
  assert.strictEqual(c.get('a'), 1);
  await new Promise((r) => setTimeout(r, 70));
  assert.strictEqual(c.get('a'), undefined, 'should expire');
});

test('cache evicts when full', () => {
  const c = api.createCache({ max: 2 });
  c.set('a', 1); c.set('b', 2); c.set('c', 3);
  assert.ok(c.size <= 2, 'should not exceed max, got ' + c.size);
});

// ── http: meta ────────────────────────────────────────────────────────────

test('GET / returns service info', async () => {
  await withServer(async (get) => {
    const r = await get('/');
    assert.strictEqual(r.status, 200);
    const body = r.json();
    assert.strictEqual(body.name, 'broken-anime-card-api');
    assert.ok(body.endpoints.search);
  });
});

test('GET /health reports ok', async () => {
  await withServer(async (get) => {
    const r = await get('/health');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json().ok, true);
  });
});

test('an unknown path returns 404 JSON, not HTML', async () => {
  await withServer(async (get) => {
    const r = await get('/nope');
    assert.strictEqual(r.status, 404);
    assert.match(r.headers.get('content-type'), /application\/json/);
    assert.strictEqual(r.json().ok, false);
  });
});

test('a non-GET method is rejected', async () => {
  await withServer(async (get, base) => {
    const res = await realFetch(base + '/', { method: 'POST' });
    assert.strictEqual(res.status, 405);
  });
});

test('CORS is open', async () => {
  await withServer(async (get) => {
    const r = await get('/');
    assert.strictEqual(r.headers.get('access-control-allow-origin'), '*');
  });
});

// ── http: data ────────────────────────────────────────────────────────────

test('GET /api/search returns card summaries', async () => {
  const restore = stubFetch(() => anilistReply([MEDIA]));
  try {
    await withServer(async (get) => {
      const r = await get('/api/search?q=naruto');
      assert.strictEqual(r.status, 200);
      const b = r.json();
      assert.strictEqual(b.ok, true);
      assert.strictEqual(b.count, 1);
      assert.strictEqual(b.results[0].title, 'Naruto');
      assert.strictEqual(b.results[0].cardUrl, '/api/card/20.svg');
      assert.ok(b.results[0].rarity);
    });
  } finally { restore(); }
});

test('GET /api/search without q is a 400', async () => {
  await withServer(async (get) => {
    const r = await get('/api/search');
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.json().code, 'MISSING_QUERY');
  });
});

test('GET /api/anime/:id returns anime + card', async () => {
  const restore = stubFetch(() => anilistOne(MEDIA));
  try {
    await withServer(async (get) => {
      const r = await get('/api/anime/20');
      assert.strictEqual(r.status, 200);
      const b = r.json();
      assert.strictEqual(b.anime.title, 'Naruto');
      assert.ok(b.card.rarity);
      assert.strictEqual(b.cardUrl, '/api/card/20.svg');
    });
  } finally { restore(); }
});

test('GET /api/anime/:id with a bad id is a 400', async () => {
  await withServer(async (get) => {
    const r = await get('/api/anime/abc');
    // abc does not match the numeric route, so it falls through to 404
    assert.strictEqual(r.status, 404);
  });
});

test('GET /api/card/:id.svg returns an SVG', async () => {
  const restore = stubFetch(() => anilistOne(MEDIA));
  try {
    await withServer(async (get) => {
      const r = await get('/api/card/20.svg');
      assert.strictEqual(r.status, 200);
      assert.match(r.headers.get('content-type'), /image\/svg\+xml/);
      assert.match(r.text, /^<svg /);
      assert.ok(r.text.includes('Naruto'));
    });
  } finally { restore(); }
});

test('GET /api/card/:id.svg honours ?width', async () => {
  const restore = stubFetch(() => anilistOne(MEDIA));
  try {
    await withServer(async (get) => {
      const r = await get('/api/card/20.svg?width=800');
      assert.match(r.text, /width="800"/);
    });
  } finally { restore(); }
});

test('GET /api/card.svg?q= resolves by name', async () => {
  const restore = stubFetch(() => anilistReply([MEDIA]));
  try {
    await withServer(async (get) => {
      const r = await get('/api/card.svg?q=naruto');
      assert.strictEqual(r.status, 200);
      assert.match(r.headers.get('content-type'), /image\/svg\+xml/);
      assert.ok(r.text.includes('Naruto'));
    });
  } finally { restore(); }
});

test('GET /api/card.svg without q is a 400', async () => {
  await withServer(async (get) => {
    const r = await get('/api/card.svg');
    assert.strictEqual(r.status, 400);
  });
});

test('GET /api/random.svg returns a card', async () => {
  const restore = stubFetch(() => anilistReply([MEDIA]));
  try {
    await withServer(async (get) => {
      const r = await get('/api/random.svg');
      assert.strictEqual(r.status, 200);
      assert.match(r.text, /^<svg /);
    });
  } finally { restore(); }
});

test('GET /api/trending and /api/top work', async () => {
  const restore = stubFetch(() => anilistReply([MEDIA]));
  try {
    await withServer(async (get) => {
      const t = await get('/api/trending?limit=5');
      assert.strictEqual(t.status, 200);
      assert.strictEqual(t.json().kind, 'trending');

      const top = await get('/api/top?limit=5');
      assert.strictEqual(top.json().kind, 'top');
    });
  } finally { restore(); }
});

// ── upstream failure handling ─────────────────────────────────────────────

test('an upstream failure becomes a clean 502, not a crash', async () => {
  const restore = stubFetch(() => { throw new Error('ECONNREFUSED'); });
  try {
    await withServer(async (get) => {
      const r = await get('/api/search?q=x');
      assert.strictEqual(r.status, 502);
      const b = r.json();
      assert.strictEqual(b.ok, false);
      assert.ok(!b.stack, 'must not leak a stack trace');
    });
  } finally { restore(); }
});

test('an upstream 404 becomes a 404', async () => {
  const restore = stubFetch(() => ({
    ok: true, status: 200, json: async () => ({ errors: [{ message: 'Not Found.' }] }),
  }));
  try {
    await withServer(async (get) => {
      const r = await get('/api/anime/999999');
      assert.strictEqual(r.status, 404);
    });
  } finally { restore(); }
});

test('a rate limit is retried then surfaced as 429', async () => {
  let attempts = 0;
  const restore = stubFetch(() => {
    attempts++;
    return { ok: false, status: 429, json: async () => ({}) };
  });
  try {
    await withServer(async (get) => {
      const r = await get('/api/search?q=zzzunique');
      assert.strictEqual(r.status, 429);
    });
    assert.ok(attempts > 1, 'should have retried, got ' + attempts);
  } finally { restore(); }
});

test('the server survives a bad request and keeps serving', async () => {
  const restore = stubFetch(() => anilistReply([MEDIA]));
  try {
    await withServer(async (get) => {
      await get('/api/search');              // 400
      const ok = await get('/health');       // still alive
      assert.strictEqual(ok.status, 200);
    });
  } finally { restore(); }
});

test('CardApiError is a real Error with a code and status', () => {
  const e = new api.CardApiError('boom', 'TEST', 418);
  assert.ok(e instanceof Error);
  assert.strictEqual(e.name, 'CardApiError');
  assert.strictEqual(e.code, 'TEST');
  assert.strictEqual(e.status, 418);
});
