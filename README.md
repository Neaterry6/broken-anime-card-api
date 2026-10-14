# broken-anime-card-api

**A self-hosted anime card REST API.** Real AniList data rendered as SVG cards. Zero dependencies — no puppeteer, no cheerio, no axios, no express, no build step.

```bash
npx broken-anime-card-api
# or
npm install broken-anime-card-api
node server.js
```

```
broken-anime-card-api listening on http://localhost:3000
  info      GET /
  search    GET /api/search?q=naruto
  anime     GET /api/anime/20
  card      GET /api/card/20.svg
  random    GET /api/random.svg
  trending  GET /api/trending
  top       GET /api/top
```

## Why this exists

Most "anime card APIs" scrape a card site with a headless browser: launch Chromium, load 35,000 pages, parse the HTML, and break whenever the site changes a class name. That's slow, fragile, and heavy — puppeteer alone is ~300MB.

This does the opposite:

| | scraper approach | this |
|---|---|---|
| dependencies | puppeteer, cheerio, axios, express | **none** |
| install size | ~300MB | ~25KB |
| data source | parsed HTML | **real AniList JSON** |
| cards | downloaded images | **rendered SVG** |
| breaks when | the site changes markup | an API contract changes |
| needs a browser | yes | **no** |

Cards are **deterministic** — the same anime always produces the same card, so you can cache them forever.

## Endpoints

### `GET /`

Service info and the endpoint list.

### `GET /health`

Liveness plus uptime and cache size.

### `GET /api/search?q=&limit=`

Search anime. Returns card summaries with a `cardUrl` for each.

```bash
curl "localhost:3000/api/search?q=naruto&limit=5"
```

```json
{
  "ok": true,
  "query": "naruto",
  "count": 5,
  "results": [
    {
      "id": 20,
      "title": "Naruto",
      "year": 2002,
      "format": "TV",
      "score": 80,
      "episodes": 220,
      "isAdult": false,
      "cover": "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/...",
      "rarity": "mythic",
      "cardUrl": "/api/card/20.svg"
    }
  ]
}
```

### `GET /api/anime/:id`

One anime in full, plus its card fields.

```bash
curl "localhost:3000/api/anime/20"
```

Returns `{ ok, anime, card, cardUrl }`.

### `GET /api/card/:id.svg?width=`

The rendered card as an SVG image. Drop it straight into an `<img src>`.

```html
<img src="http://localhost:3000/api/card/20.svg" alt="Naruto card">
<img src="http://localhost:3000/api/card/20.svg?width=800" alt="Bigger">
```

### `GET /api/card.svg?q=`

Resolve by name instead of id.

```html
<img src="http://localhost:3000/api/card.svg?q=one%20piece">
```

### `GET /api/random.svg`

A random trending card. Good for a "card of the day".

### `GET /api/trending?limit=` and `GET /api/top?limit=`

Trending now, and highest rated of all time.

```bash
curl "localhost:3000/api/trending?limit=10"
```

## Using it as a library

Don't want the server? Import the pieces.

```js
const { renderCard, animeToCard, createHandler } = require('broken-anime-card-api');

// render a card directly
const svg = renderCard({
  name: 'Naruto Uzumaki',
  title: 'Pierrot',
  anime: '2002 · TV',
  rarity: 'legendary',
  power: 80, speed: 70, intellect: 85,
  abilities: ['Action', 'Adventure'],
  description: 'A ninja who never gives up.',
});

// or mount the handler in your own server
const express = require('express');
app.use(createHandler());
```

### `createServer(options?)`

```js
const { createServer } = require('broken-anime-card-api');

const server = await createServer({ port: 3000, host: '0.0.0.0' });
// port: 0 gives you a random free port — handy in tests
```

Returns a listening `http.Server`. Close it with `server.close()`.

### `createCache(options?)`

The in-memory TTL cache, exported so you can tune or replace it.

```js
const cache = createCache({ ttlMs: 60_000, max: 1000 });
```

## Card design

Cards are 5:7 (the standard trading-card ratio), rendered as pure SVG so they scale to any size without blurring.

- **six rarity tiers** — common, uncommon, rare, epic, legendary, mythic
- **rarity is derived from popularity**, so household names feel stronger
- **three stat bars** — power, speed, intellect
- **cover art** from AniList, with a monogram fallback
- **particles-free, deterministic** output you can cache

| field | meaning |
|---|---|
| `name` | title |
| `title` | main studio |
| `anime` | year and format |
| `rarity` | tier |
| `power` / `speed` / `intellect` | 0–100 |
| `abilities` | up to 3 genres |
| `description` | synopsis, wrapped to 3 lines |

## Errors

Every error is JSON with an `ok: false` and a `code`. No HTML error pages, no stack traces.

| code | HTTP | meaning |
|---|---|---|
| `MISSING_QUERY` | 400 | you forgot `?q=` |
| `BAD_ID` | 400 | id wasn't a number |
| `MISSING_NAME` | 400 | a card was rendered without a name |
| `BAD_INPUT` | 400 | renderCard got something that isn't an object |
| `NOT_FOUND` | 404 | no such anime |
| `RATE_LIMITED` | 429 | AniList is throttling — retried with backoff |
| `TIMEOUT` / `NETWORK` | 502 | couldn't reach AniList |
| `UPSTREAM_ERROR` | 502 | AniList returned an error |
| `BAD_RESPONSE` | 502 | AniList returned non-JSON |

```json
{ "ok": false, "error": "Pass ?q=<anime title>.", "code": "MISSING_QUERY" }
```

## Rate limits and caching

AniList is free and shared. This API caches every search and lookup in memory for **5 minutes** by default, so repeat requests never touch upstream. There's a test asserting the cached path is measurably faster.

If you're deploying publicly, put a real cache (Redis, CDN) in front and raise the TTL — anime metadata barely changes.

## Tests

```bash
npm test          # 36 offline tests, stubbed upstream, real HTTP server
npm run test:live # 10 tests against the real AniList API
```

The offline suite boots an actual server on a random port and hits it with real HTTP requests, so routing, status codes, headers and error handling are all genuinely exercised. The live suite proves real data flows end to end.

## Deploying

Anywhere that runs Node 18+. No build step, no native modules.

```bash
PORT=8080 node server.js
```

Works on Railway, Render, Fly, a VPS, or behind a reverse proxy. There is no filesystem state and no database.

## Credit

Data from [AniList](https://anilist.co). This is an unofficial client and is not
affiliated with AniList. Cover images belong to their original rights holders.

## Licence

MIT © Akewushola Abdulbakri Temitope (brokenvzn)
