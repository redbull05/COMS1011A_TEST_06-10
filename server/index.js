'use strict';

/**
 * RAT - Repo Analysis Tool
 * HTTP server: static frontend + REST API. Zero external dependencies.
 *
 * Sprint 0: scaffold. Sprint 1-2: ingestion (url clone + zip upload) and the
 * metric engine are live - see server/api.js, ingest.js, engine.js, metrics.js.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const { handleApi, VERSION } = require('./api');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

function serveStatic(res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  let u;
  try {
    u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return sendJson(res, 400, { error: 'bad request url' });
  }

  try {
    if (u.pathname === '/api' || u.pathname.startsWith('/api/')) {
      return await handleApi(req, res, u);
    }
    return serveStatic(res, u.pathname);
  } catch (err) {
    console.error('[rat] server error:', err);
    return sendJson(res, 500, { error: 'internal error', detail: String((err && err.message) || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[rat] v${VERSION} listening on http://localhost:${PORT} (bound ${HOST}:${PORT})`);
});
