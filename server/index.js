'use strict';

/**
 * RAT - Repo Analysis Tool
 * Sprint 0: HTTP server that serves the static frontend and a health endpoint.
 *
 * Zero external dependencies: Node built-ins only (http, fs, path).
 * The API route table grows sprint by sprint (see api/ modules in later sprints).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const VERSION = '0.1.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
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

/* ------------------------------------------------------------------ */
/* API route table. Keys are "METHOD /path"; exact-match for now.      */
/* ------------------------------------------------------------------ */
const api = {
  'GET /api/health': (req, res) =>
    sendJson(res, 200, {
      ok: true,
      service: 'rat',
      version: VERSION,
      time: new Date().toISOString()
    })
};

const server = http.createServer(async (req, res) => {
  let u;
  try {
    u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return sendJson(res, 400, { error: 'bad request url' });
  }

  const key = `${req.method} ${u.pathname}`;
  const handler = api[key];

  try {
    if (handler) return await handler(req, res, u);
    if (u.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'no such endpoint' });
    return serveStatic(res, u.pathname);
  } catch (err) {
    console.error('[rat] handler error:', err);
    return sendJson(res, 500, { error: 'internal error', detail: String((err && err.message) || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[rat] listening on http://localhost:${PORT} (bound ${HOST}:${PORT})`);
});
