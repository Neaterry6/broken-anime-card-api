'use strict';

/**
 * broken-anime-card-api — a self-hosted anime card REST API.
 *
 * Improves on the shoob.gg scraper approach: instead of driving a headless
 * browser to parse HTML, this reads real anime data from AniList and renders
 * cards itself as SVG. No puppeteer, no cheerio, no axios, no express —
 * it runs on Node's built-in http server with zero dependencies.
 *
 *   const { createServer } = require('broken-anime-card-api');
 *   createServer({ port: 3000 });
 *
 * Endpoints:
 *   GET /                        service info
 *   GET /health                  liveness
 *   GET /api/search?q=           search anime, returns card summaries
 *   GET /api/anime/:id           one anime as a card
 *   GET /api/card/:id.svg        the rendered SVG card
 *   GET /api/random.svg          a random trending card
 *   GET /api/trending            trending list
 *   GET /api/top                 top rated list
 */

const http = require('http');

const ANILIST = 'https://graphql.anilist.co';
const USER_AGENT = 'broken-anime-card-api/1.0 (+https://github.com/Neaterry6/broken-anime-card-api)';

const RARITIES = Object.freeze({
  common:    { label: 'COMMON',    colors: ['#4b5563', '#9ca3af'], glow: '#9ca3af', stars: 1 },
  uncommon:  { label: 'UNCOMMON',  colors: ['#047857', '#34d399'], glow: '#34d399', stars: 2 },
  rare:      { label: 'RARE',      colors: ['#1d4ed8', '#60a5fa'], glow: '#60a5fa', stars: 3 },
  epic:      { label: 'EPIC',      colors: ['#6d28d9', '#c084fc'], glow: '#c084fc', stars: 4 },
  legendary: { label: 'LEGENDARY', colors: ['#b45309', '#fbbf24'], glow: '#fbbf24', stars: 5 },
  mythic:    { label: 'MYTHIC',    colors: ['#9d174d', '#fb7185'], glow: '#fb7185', stars: 6 },
});

const SIZE = Object.freeze({ width: 500, height: 700 });

class CardApiError extends Error {
  constructor(message, code, status = 500) {
    super(message);
    this.name = 'CardApiError';
    this.code = code;
    this.status = status;
  }
}

// ───────────────────────────── helpers ─────────────────────────────

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function hash(str) {
  let h = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function clampNum(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.round(v)));
}

function wrap(text, max, maxLines = 3) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (!line) { line = w; continue; }
    if ((line + ' ' + w).length <= max) line += ' ' + w;
    else { lines.push(line); line = w; if (lines.length === maxLines) break; }
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && lines.join(' ').length < String(text || '').length) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/.{2}$/, '') + '\u2026';
  }
  return lines;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ───────────────────────────── anilist ─────────────────────────────

const FIELDS = `
  id
  title { romaji english native }
  description(asHtml: false)
  format
  status
  seasonYear
  episodes
  duration
  averageScore
  popularity
  favourites
  genres
  isAdult
  coverImage { extraLarge large color }
  bannerImage
  studios(isMain: true) { nodes { name } }
`;

async function anilist(query, variables = {}, { timeoutMs = 20000, retries = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(ANILIST, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
    } catch (err) {
      clearTimeout(timer);
      const code = err.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK';
      lastError = new CardApiError(
        code === 'TIMEOUT' ? `Upstream timed out after ${timeoutMs}ms.` : `Could not reach AniList: ${err.message}`,
        code, 502
      );
      if (code === 'TIMEOUT' || attempt === retries) throw lastError;
      await sleep(400 * Math.pow(2, attempt));
      continue;
    }
    clearTimeout(timer);

    if (res.status === 429) {
      lastError = new CardApiError('Rate limited upstream. Slow down.', 'RATE_LIMITED', 429);
      if (attempt === retries) throw lastError;
      await sleep(800 * Math.pow(2, attempt));
      continue;
    }
    if (res.status >= 500) {
      lastError = new CardApiError(`Upstream returned ${res.status}.`, 'UPSTREAM_ERROR', 502);
      if (attempt === retries) throw lastError;
      await sleep(400 * Math.pow(2, attempt));
      continue;
    }
    if (!res.ok) throw new CardApiError(`Upstream returned ${res.status}.`, 'UPSTREAM_ERROR', 502);

    let json;
    try { json = await res.json(); }
    catch { throw new CardApiError('Upstream returned something that is not JSON.', 'BAD_RESPONSE', 502); }

    if (json.errors && json.errors.length) {
      const msg = json.errors[0].message || 'Upstream error.';
      throw new CardApiError(msg, 'UPSTREAM_ERROR', /not found/i.test(msg) ? 404 : 502);
    }
    return json.data;
  }
  throw lastError;
}

function mapAnime(m) {
  if (!m) return null;
  return {
    id: m.id,
    title: m.title?.english || m.title?.romaji || m.title?.native || null,
    titleRomaji: m.title?.romaji || null,
    titleEnglish: m.title?.english || null,
    titleNative: m.title?.native || null,
    synopsis: m.description ? m.description.replace(/<[^>]+>/g, '').trim() : null,
    format: m.format || null,
    status: m.status || null,
    year: m.seasonYear ?? null,
    episodes: m.episodes ?? null,
    duration: m.duration ?? null,
    score: m.averageScore ?? null,
    popularity: m.popularity ?? null,
    favourites: m.favourites ?? null,
    genres: m.genres || [],
    isAdult: !!m.isAdult,
    cover: m.coverImage?.extraLarge || m.coverImage?.large || null,
    banner: m.bannerImage || null,
    studios: (m.studios?.nodes || []).map((s) => s.name),
  };
}

// ───────────────────────────── card model ─────────────────────────────

/** Turn an anime record into card fields, deterministically. */
function animeToCard(a) {
  const seed = hash(a.title || String(a.id));
  const rarityKeys = Object.keys(RARITIES);
  // popularity maps to rarity so well-known shows feel stronger
  const pop = a.popularity || 0;
  let rarity;
  if (pop > 200000) rarity = 'mythic';
  else if (pop > 100000) rarity = 'legendary';
  else if (pop > 50000) rarity = 'epic';
  else if (pop > 15000) rarity = 'rare';
  else if (pop > 3000) rarity = 'uncommon';
  else rarity = rarityKeys[seed % 2]; // common / uncommon

  return {
    name: a.title || 'Unknown',
    title: a.studios?.[0] || null,
    anime: a.year ? `${a.year}${a.format ? ' · ' + a.format : ''}` : (a.format || null),
    description: a.synopsis || null,
    image: a.cover || null,
    rarity,
    power: clampNum(a.score ? a.score : 50 + (seed % 50), 0, 100, 60),
    speed: clampNum(50 + ((seed >> 3) % 50), 0, 100, 60),
    intellect: clampNum(a.episodes ? Math.min(100, 40 + a.episodes / 5) : 50 + ((seed >> 7) % 50), 0, 100, 60),
    abilities: (a.genres || []).slice(0, 3),
    /** Extra, API-only fields. */
    animeId: a.id,
    score: a.score,
    popularity: a.popularity,
    isAdult: a.isAdult,
    cover: a.cover,
    banner: a.banner,
    genres: a.genres,
    status: a.status,
    episodes: a.episodes,
    year: a.year,
  };
}

// ───────────────────────────── svg renderer ─────────────────────────────

function stars(n, x, y, color) {
  let out = '';
  for (let i = 0; i < n; i++) {
    const cx = x + i * 20;
    const pts = [];
    for (let p = 0; p < 10; p++) {
      const r = p % 2 === 0 ? 8 : 3.4;
      const ang = (Math.PI / 5) * p - Math.PI / 2;
      pts.push(`${(cx + r * Math.cos(ang)).toFixed(1)},${(y + r * Math.sin(ang)).toFixed(1)}`);
    }
    out += `<polygon points="${pts.join(' ')}" fill="${color}"/>`;
  }
  return out;
}

function statBar(label, value, x, y, width, color) {
  const LABEL_W = 112;
  const VALUE_W = 42;
  const barW = Math.max(20, width - LABEL_W - VALUE_W);
  const filled = Math.round((value / 100) * barW);
  return `
    <text x="${x}" y="${y + 11}" font-family="Segoe UI, Arial, sans-serif" font-size="13"
          fill="#c9cbe0" letter-spacing="1.2">${esc(label.toUpperCase())}</text>
    <rect x="${x + LABEL_W}" y="${y}" width="${barW}" height="13" rx="6.5" fill="rgba(255,255,255,0.10)"/>
    <rect x="${x + LABEL_W}" y="${y}" width="${filled}" height="13" rx="6.5" fill="${color}"/>
    <text x="${x + LABEL_W + barW + 8}" y="${y + 11}" font-family="Segoe UI, Arial, sans-serif"
          font-size="12" fill="#ffffff" font-weight="700">${value}</text>`;
}

/**
 * Render a card as a standalone SVG string.
 * @param {object} card Fields from animeToCard() or hand-written.
 * @param {object} [options]
 */
function renderCard(card, options = {}) {
  if (!card || typeof card !== 'object') {
    throw new CardApiError('renderCard() needs a card object.', 'BAD_INPUT', 400);
  }
  const name = String(card.name || '').trim();
  if (!name) throw new CardApiError('A card needs a name.', 'MISSING_NAME', 400);

  const rarityKey = RARITIES[String(card.rarity || '').toLowerCase()]
    ? String(card.rarity).toLowerCase()
    : Object.keys(RARITIES)[hash(name) % 6];
  const r = RARITIES[rarityKey];

  const width = clampNum(options.width, 240, 2000, SIZE.width);
  const scale = width / SIZE.width;
  const height = Math.round(SIZE.height * scale);
  const shine = options.shine !== false;
  const id = 'c' + hash(name + rarityKey).toString(36);

  const power = clampNum(card.power, 0, 100, 60);
  const speed = clampNum(card.speed, 0, 100, 60);
  const intellect = clampNum(card.intellect, 0, 100, 60);
  const abilities = Array.isArray(card.abilities) ? card.abilities.slice(0, 3).map(String) : [];

  const statY = SIZE.height - 150;
  const statX = 38;

  const NAME_MAX_W = SIZE.width - 34 - 34;
  let nameSize = 18;
  for (let s = 30; s >= 18; s--) {
    if (name.length * (s * 0.58 + 0.5) <= NAME_MAX_W) { nameSize = s; break; }
  }
  const maxChars = Math.floor(NAME_MAX_W / (nameSize * 0.58 + 0.5));
  const nameText = name.length > maxChars ? name.slice(0, Math.max(1, maxChars - 1)) + '\u2026' : name;

  const abilityRaw = abilities.join('  \u00b7  ').toUpperCase();
  const abilityMax = Math.floor((SIZE.width - 76) / (12 * 0.58 + 1.4));
  const abilityShown = abilityRaw.length > abilityMax
    ? abilityRaw.slice(0, Math.max(1, abilityMax - 1)).trimEnd() + '\u2026'
    : abilityRaw;

  const animeLine = card.anime
    ? `<text x="${statX}" y="${SIZE.height - 122}" font-family="Segoe UI, Arial, sans-serif"
             font-size="11.5" fill="${r.colors[1]}" letter-spacing="0.6">${esc(card.anime)}</text>`
    : '';
  const descLines = card.description ? wrap(card.description, 44, 3) : [];
  const descBase = card.anime ? SIZE.height - 106 : SIZE.height - 118;
  const desc = descLines.map((l, i) =>
    `<text x="${statX}" y="${descBase + i * 15}" font-family="Segoe UI, Arial, sans-serif"
           font-size="11.5" fill="#8b90a6">${esc(l)}</text>`).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"
     viewBox="0 0 ${SIZE.width} ${SIZE.height}" role="img" aria-label="${esc(name)} card">
  <defs>
    <linearGradient id="${id}bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0b0b14"/><stop offset="55%" stop-color="#12101f"/><stop offset="100%" stop-color="#08080e"/>
    </linearGradient>
    <linearGradient id="${id}frame" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${r.colors[0]}"/><stop offset="100%" stop-color="${r.colors[1]}"/>
    </linearGradient>
    <linearGradient id="${id}art" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${r.colors[1]}" stop-opacity="0.30"/><stop offset="100%" stop-color="#07070d" stop-opacity="0.95"/>
    </linearGradient>
    ${shine ? `<linearGradient id="${id}shine" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.16"/><stop offset="45%" stop-color="#ffffff" stop-opacity="0.02"/><stop offset="100%" stop-color="#ffffff" stop-opacity="0.10"/>
    </linearGradient>` : ''}
    <filter id="${id}glow" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="7" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <clipPath id="${id}clip"><rect x="12" y="12" width="${SIZE.width - 24}" height="${SIZE.height - 24}" rx="22"/></clipPath>
  </defs>
  <rect x="0" y="0" width="${SIZE.width}" height="${SIZE.height}" rx="28" fill="url(#${id}bg)"/>
  <g clip-path="url(#${id}clip)">
    <rect x="12" y="12" width="${SIZE.width - 24}" height="330" fill="${r.colors[1]}" opacity="0.10"/>
    ${card.image
      ? `<image href="${esc(card.image)}" x="12" y="12" width="${SIZE.width - 24}" height="330"
                preserveAspectRatio="xMidYMid slice" clip-path="url(#${id}clip)"/>`
      : `<circle cx="${SIZE.width / 2}" cy="170" r="86" fill="none" stroke="${r.colors[1]}" stroke-width="2" opacity="0.55"/>
         <text x="${SIZE.width / 2}" y="192" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif"
               font-size="66" font-weight="800" fill="${r.colors[1]}" opacity="0.85">${esc(name.charAt(0).toUpperCase())}</text>`}
    <rect x="12" y="12" width="${SIZE.width - 24}" height="330" fill="url(#${id}art)"/>
    <rect x="12" y="300" width="${SIZE.width - 24}" height="86" fill="#08080f" opacity="0.80"/>
    <text x="34" y="344" font-family="Segoe UI, Arial, sans-serif" font-size="${nameSize}"
          font-weight="800" fill="#ffffff" letter-spacing="0.5">${esc(nameText)}</text>
    ${card.title ? `<text x="34" y="368" font-family="Segoe UI, Arial, sans-serif" font-size="13"
                         fill="${r.colors[1]}" letter-spacing="1.1">${esc(String(card.title).toUpperCase())}</text>` : ''}
    <rect x="${SIZE.width - 34 - 116}" y="322" width="116" height="28" rx="14" fill="${r.colors[0]}" opacity="0.95"/>
    <text x="${SIZE.width - 34 - 58}" y="341" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif"
          font-size="12" font-weight="800" fill="#ffffff" letter-spacing="1.6">${esc(r.label)}</text>
    ${stars(r.stars, 34, 392, r.glow)}
    ${abilityShown ? `<text x="${statX}" y="${SIZE.height - 176}" font-family="Segoe UI, Arial, sans-serif"
             font-size="12" fill="${r.glow}" letter-spacing="1.4">${esc(abilityShown)}</text>` : ''}
    ${statBar('Power', power, statX, statY - 44, SIZE.width - 76, r.colors[1])}
    ${statBar('Speed', speed, statX, statY - 20, SIZE.width - 76, r.colors[1])}
    ${statBar('Intellect', intellect, statX, statY + 4, SIZE.width - 76, r.colors[1])}
    ${animeLine}
    ${desc}
    ${shine ? `<rect x="12" y="12" width="${SIZE.width - 24}" height="${SIZE.height - 24}" rx="22" fill="url(#${id}shine)"/>` : ''}
  </g>
  <rect x="12" y="12" width="${SIZE.width - 24}" height="${SIZE.height - 24}" rx="22"
        fill="none" stroke="url(#${id}frame)" stroke-width="4" filter="url(#${id}glow)"/>
  <rect x="12" y="12" width="${SIZE.width - 24}" height="${SIZE.height - 24}" rx="22"
        fill="none" stroke="${r.colors[1]}" stroke-width="1.5" opacity="0.7"/>
</svg>`;
}

// ───────────────────────────── data layer ─────────────────────────────

/** Simple in-memory TTL cache so we don't hammer AniList. */
function createCache({ ttlMs = 5 * 60 * 1000, max = 500 } = {}) {
  const store = new Map();
  return {
    get(key) {
      const hit = store.get(key);
      if (!hit) return undefined;
      if (Date.now() > hit.expires) { store.delete(key); return undefined; }
      return hit.value;
    },
    set(key, value) {
      if (store.size >= max) {
        // drop the oldest entry
        const first = store.keys().next().value;
        if (first !== undefined) store.delete(first);
      }
      store.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    },
    clear() { store.clear(); },
    get size() { return store.size; },
  };
}

const defaultCache = createCache();

async function findAnime(query, options = {}) {
  const limit = clampNum(options.limit, 1, 25, 10);
  const cacheKey = `search:${String(query).toLowerCase()}:${limit}`;
  const cached = defaultCache.get(cacheKey);
  if (cached) return cached;

  const data = await anilist(
    `query ($q: String, $perPage: Int) {
       Page(perPage: $perPage) { media(search: $q, type: ANIME, sort: SEARCH_MATCH) { ${FIELDS} } }
     }`,
    { q: query, perPage: limit },
    options
  );
  const results = (data?.Page?.media || []).map(mapAnime).filter(Boolean);
  defaultCache.set(cacheKey, results);
  return results;
}

async function fetchAnimeById(id, options = {}) {
  const cacheKey = `anime:${id}`;
  const cached = defaultCache.get(cacheKey);
  if (cached) return cached;

  const num = Number(id);
  if (!Number.isFinite(num) || num <= 0) {
    throw new CardApiError('A numeric anime id is required.', 'BAD_ID', 400);
  }
  const data = await anilist(`query ($id: Int) { Media(id: $id) { ${FIELDS} } }`, { id: num }, options);
  const mapped = mapAnime(data?.Media);
  if (!mapped) throw new CardApiError('Anime not found.', 'NOT_FOUND', 404);
  defaultCache.set(cacheKey, mapped);
  return mapped;
}

async function fetchList(kind, options = {}) {
  const limit = clampNum(options.limit, 1, 25, 10);
  const sort = kind === 'top' ? 'SCORE_DESC' : 'TRENDING_DESC';
  const cacheKey = `list:${kind}:${limit}`;
  const cached = defaultCache.get(cacheKey);
  if (cached) return cached;

  const data = await anilist(
    `query ($perPage: Int) { Page(perPage: $perPage) { media(sort: ${sort}, type: ANIME) { ${FIELDS} } } }`,
    { perPage: limit },
    options
  );
  const results = (data?.Page?.media || []).map(mapAnime).filter(Boolean);
  defaultCache.set(cacheKey, results);
  return results;
}

// ───────────────────────────── http layer ─────────────────────────────

function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=60',
  });
  res.end(payload);
}

function sendSvg(res, svg) {
  res.writeHead(200, {
    'content-type': 'image/svg+xml; charset=utf-8',
    'content-length': Buffer.byteLength(svg),
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=300',
  });
  res.end(svg);
}

const ROUTES = {
  info: {
    name: 'broken-anime-card-api',
    description: 'Anime card REST API. Real AniList data rendered as SVG cards. Zero dependencies.',
    note: 'Cards are deterministic: the same anime always produces the same card.',
    endpoints: {
      info: 'GET /',
      health: 'GET /health',
      search: 'GET /api/search?q=naruto&limit=10',
      anime: 'GET /api/anime/:id',
      card: 'GET /api/card/:id.svg?width=500',
      cardByName: 'GET /api/card.svg?q=naruto',
      random: 'GET /api/random.svg',
      trending: 'GET /api/trending?limit=10',
      top: 'GET /api/top?limit=10',
      example: 'GET /api/anime/20',
    },
  },
};

/**
 * Build the request handler. Exported so it can be mounted in an existing
 * server or tested directly.
 */
function createHandler(options = {}) {
  const renderOptions = options.render || {};

  return async function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      return res.end();
    }
    if (req.method !== 'GET') {
      return sendJson(res, 405, { ok: false, error: 'Method not allowed. Use GET.' });
    }

    try {
      // ── meta ──
      if (path === '/' || path === '/api') return sendJson(res, 200, ROUTES.info);

      if (path === '/health') {
        return sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()), cached: defaultCache.size });
      }

      // ── card by name (must come before /api/card/:id) ──
      if (path === '/api/card.svg' || path === '/api/random.svg') {
        let anime;
        if (path === '/api/random.svg') {
          const list = await fetchList('trending', { limit: 25 });
          anime = list[Math.floor(Math.random() * list.length)];
        } else {
          const q = url.searchParams.get('q');
          if (!q || !q.trim()) throw new CardApiError('Pass ?q=<anime title>.', 'MISSING_QUERY', 400);
          const hits = await findAnime(q.trim(), { limit: 1 });
          anime = hits[0];
        }
        if (!anime) throw new CardApiError('No anime matched.', 'NOT_FOUND', 404);
        const width = url.searchParams.get('width');
        return sendSvg(res, renderCard(animeToCard(anime), { ...renderOptions, width: width ? Number(width) : undefined }));
      }

      // ── card svg by id ──
      const cardMatch = path.match(/^\/api\/card\/(\d+)\.svg$/);
      if (cardMatch) {
        const anime = await fetchAnimeById(cardMatch[1]);
        const width = url.searchParams.get('width');
        return sendSvg(res, renderCard(animeToCard(anime), { ...renderOptions, width: width ? Number(width) : undefined }));
      }

      // ── search ──
      if (path === '/api/search') {
        const q = url.searchParams.get('q');
        if (!q || !q.trim()) throw new CardApiError('Pass ?q=<anime title>.', 'MISSING_QUERY', 400);
        const limit = url.searchParams.get('limit');
        const hits = await findAnime(q.trim(), { limit: limit ? Number(limit) : undefined });
        return sendJson(res, 200, {
          ok: true,
          query: q,
          count: hits.length,
          results: hits.map((a) => {
            const card = animeToCard(a);
            return {
              id: a.id, title: a.title, year: a.year, format: a.format,
              score: a.score, episodes: a.episodes, isAdult: a.isAdult,
              cover: a.cover, rarity: card.rarity, cardUrl: `/api/card/${a.id}.svg`,
            };
          }),
        });
      }

      // ── one anime ──
      const animeMatch = path.match(/^\/api\/anime\/(\d+)$/);
      if (animeMatch) {
        const a = await fetchAnimeById(animeMatch[1]);
        return sendJson(res, 200, {
          ok: true,
          anime: a,
          card: animeToCard(a),
          cardUrl: `/api/card/${a.id}.svg`,
        });
      }

      // ── lists ──
      if (path === '/api/trending' || path === '/api/top') {
        const kind = path === '/api/top' ? 'top' : 'trending';
        const limit = url.searchParams.get('limit');
        const list = await fetchList(kind, { limit: limit ? Number(limit) : undefined });
        return sendJson(res, 200, {
          ok: true,
          kind,
          count: list.length,
          results: list.map((a) => ({
            id: a.id, title: a.title, year: a.year, score: a.score,
            cover: a.cover, rarity: animeToCard(a).rarity, cardUrl: `/api/card/${a.id}.svg`,
          })),
        });
      }

      return sendJson(res, 404, {
        ok: false,
        error: 'Not found.',
        see: '/',
      });
    } catch (err) {
      const status = err instanceof CardApiError ? err.status : 500;
      const code = err instanceof CardApiError ? err.code : 'INTERNAL';
      // don't leak stack traces
      return sendJson(res, status, {
        ok: false,
        error: err.message || 'Something went wrong.',
        code,
      });
    }
  };
}

/**
 * Create and start the API server.
 *
 * @param {object} [options]
 * @param {number} [options.port=3000] 0 for a random free port.
 * @param {string} [options.host='0.0.0.0']
 * @returns {Promise<import('http').Server>} The listening server.
 */
function createServer(options = {}) {
  const port = options.port === undefined ? 3000 : Number(options.port);
  const host = options.host || '0.0.0.0';
  const server = http.createServer(createHandler(options));

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

module.exports = {
  createServer,
  createHandler,
  createCache,
  renderCard,
  animeToCard,
  mapAnime,
  anilist,
  RARITIES,
  SIZE,
  CardApiError,
  USER_AGENT,
};
