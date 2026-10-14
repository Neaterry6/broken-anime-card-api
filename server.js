#!/usr/bin/env node
'use strict';

// Standalone launcher: `node server.js` or `npx broken-anime-card-api`.
const { createServer } = require('./index.js');

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

createServer({ port, host })
  .then((server) => {
    const addr = server.address();
    const shown = addr.port;
    console.log(`broken-anime-card-api listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${shown}`);
    console.log(`  info      GET /`);
    console.log(`  search    GET /api/search?q=naruto`);
    console.log(`  anime     GET /api/anime/20`);
    console.log(`  card      GET /api/card/20.svg`);
    console.log(`  random    GET /api/random.svg`);
    console.log(`  trending  GET /api/trending`);
    console.log(`  top       GET /api/top`);
  })
  .catch((err) => {
    console.error('Failed to start:', err.message);
    process.exit(1);
  });
