'use strict';

/**
 * REST API for the RAT dashboard.
 *
 *   GET    /api/health
 *   GET    /api/repos                        list all repositories
 *   POST   /api/repos/clone                  { url, name? }        -> 202 meta
 *   POST   /api/repos/upload                 multipart zip file    -> 202 meta
 *   GET    /api/repos/:id                    meta (incl. status)
 *   GET    /api/repos/:id/commits            commit list ({h,t,an,ae,me,a,r})
 *   DELETE /api/repos/:id                    remove repo + data
 *   GET    /api/repos/:id/metrics            totals (all 5 categories summarized)
 *   GET    /api/repos/:id/files              file rows
 *   GET    /api/repos/:id/dirs               directory rows
 *   GET    /api/repos/:id/authors            author rows
 *
 * Metric endpoints accept the same optional filter params:
 *   ?from=<unix|iso>&to=<unix|iso>&commits=h1,h2&path=<p>&pathIsDir=1&author=<email>
 */

const path = require('path');

const store = require('./store');
const ingest = require('./ingest');
const metrics = require('./metrics');

const VERSION = '0.1.0';
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GB

class HttpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/* --------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------ */

function readBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (d) => {
      size += d.length;
      if (size > maxBytes) {
        reject(new HttpError(413, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, maxBytes = 1024 * 1024) {
  const buf = await readBuffer(req, maxBytes);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON request body');
  }
}

/** Minimal multipart/form-data reader (single file + text fields). */
async function readMultipart(req) {
  const ctype = String(req.headers['content-type'] || '');
  const m = /multipart\/form-data;.*boundary=(?:"([^"]+)"|([^;]+))/i.exec(ctype);
  if (!m) throw new HttpError(400, 'expected multipart/form-data with a boundary');
  const boundary = (m[1] || m[2]).trim();
  const body = await readBuffer(req, MAX_UPLOAD_BYTES);

  const delim = Buffer.from(`--${boundary}`);
  const parts = [];
  let idx = body.indexOf(delim);
  while (idx !== -1) {
    let start = idx + delim.length;
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break; // closing "--"
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2; // CRLF
    const next = body.indexOf(delim, start);
    if (next === -1) break;
    let end = next;
    if (body[end - 2] === 0x0d && body[end - 1] === 0x0a) end -= 2; // strip CRLF
    const part = body.subarray(start, end);
    const sep = part.indexOf('\r\n\r\n');
    if (sep !== -1) {
      const headerText = part.subarray(0, sep).toString('utf8');
      const disp = /name="([^"]*)"(?:;\s*filename="([^"]*)")?/i.exec(headerText);
      parts.push({
        name: disp ? disp[1] : '',
        filename: disp && disp[2] ? disp[2] : null,
        content: part.subarray(sep + 4)
      });
    }
    idx = next;
  }
  return parts;
}

function parseTimestamp(v) {
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(v);
  if (!Number.isNaN(t)) return Math.floor(t / 1000);
  throw new HttpError(400, `invalid timestamp: ${v}`);
}

function parseFilter(url) {
  const q = url.searchParams;
  const filter = {};
  if (q.has('from') && q.get('from') !== '') filter.from = parseTimestamp(q.get('from'));
  if (q.has('to') && q.get('to') !== '') filter.to = parseTimestamp(q.get('to'));
  if (q.has('commits') && q.get('commits') !== '') {
    filter.commits = q.get('commits').split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (q.has('path') && q.get('path') !== '') filter.path = q.get('path');
  if (q.get('pathIsDir') === '1' || q.get('pathIsDir') === 'true') filter.pathIsDir = true;
  if (q.has('author') && q.get('author') !== '') filter.author = q.get('author');
  return filter;
}

function requireRepo(id) {
  const meta = store.getMeta(id);
  if (!meta) throw new HttpError(404, 'repository not found');
  return meta;
}

function requireSnapshot(id) {
  const meta = requireRepo(id);
  if (meta.status !== 'ready') {
    const extra = meta.error ? `: ${meta.error}` : '';
    throw new HttpError(409, `repository is not ready (status: ${meta.status})${extra}`);
  }
  const snap = store.getSnapshot(id);
  if (!snap) throw new HttpError(500, 'snapshot is missing on disk');
  return { meta, snap };
}

/* Result cache so the tiles + table fetches share one aggregation pass. */
const aggCache = new Map();
function aggregateCached(id, snap, filter, aliases) {
  const key = `${id}|${JSON.stringify(filter)}|${JSON.stringify(aliases || null)}`;
  if (aggCache.has(key)) return aggCache.get(key);
  const result = metrics.aggregate(snap, filter, aliases);
  aggCache.set(key, result);
  if (aggCache.size > 24) aggCache.delete(aggCache.keys().next().value);
  return result;
}
function clearRepoCache(id) {
  for (const key of [...aggCache.keys()]) {
    if (key.startsWith(id + '|')) aggCache.delete(key);
  }
}

/* --------------------------------------------------------------------------
 * Handlers
 * ------------------------------------------------------------------------ */

const routes = [
  {
    method: 'GET',
    pattern: '/api/health',
    handler: async () => ({ ok: true, service: 'rat', version: VERSION, time: new Date().toISOString() })
  },
  {
    method: 'GET',
    pattern: '/api/repos',
    handler: async () => store.loadAll()
  },
  {
    method: 'POST',
    pattern: '/api/repos/clone',
    handler: async ({ req }) => {
      const body = await readJson(req);
      const url = ingest.validateUrl(body.url);
      const name = String(body.name || '').trim() || ingest.nameFromUrl(url);
      const meta = await ingest.createRepo({ sourceType: 'url', source: url, name });
      ingest.startUrlIngestion(meta);
      return { status: 202, body: meta };
    }
  },
  {
    method: 'POST',
    pattern: '/api/repos/upload',
    handler: async ({ req }) => {
      const parts = await readMultipart(req);
      const file = parts.find((p) => p.filename);
      if (!file || !file.content.length) throw new HttpError(400, 'no zip file found in the upload');
      const filename = path.basename(file.filename);
      if (!/\.zip$/i.test(filename)) throw new HttpError(400, 'only .zip uploads are accepted');
      const name = String(filename.replace(/\.zip$/i, '')).trim() || 'repository';

      const meta = await ingest.createRepo({ sourceType: 'zip', source: filename, name });
      const zipPath = path.join(store.TMP_DIR, `${meta.id}.zip`);
      require('fs').writeFileSync(zipPath, file.content);
      ingest.startZipIngestion(meta, zipPath);
      return { status: 202, body: meta };
    }
  },
  {
    method: 'GET',
    pattern: '/api/repos/:id',
    handler: async ({ params }) => requireRepo(params.id)
  },
  {
    method: 'GET',
    pattern: '/api/repos/:id/commits',
    handler: async ({ params }) => {
      const { snap } = requireSnapshot(params.id);
      return {
        commits: snap.commits.map((c) => ({ h: c.h, t: c.t, an: c.an, ae: c.ae, me: c.me, a: c.a, r: c.r }))
      };
    }
  },
  {
    method: 'DELETE',
    pattern: '/api/repos/:id',
    handler: async ({ params }) => {
      requireRepo(params.id);
      clearRepoCache(params.id);
      store.deleteRepo(params.id);
      return { ok: true };
    }
  },
  {
    method: 'GET',
    pattern: '/api/repos/:id/metrics',
    handler: async ({ params, url }) => {
      const { meta, snap } = requireSnapshot(params.id);
      const filter = parseFilter(url);
      const result = aggregateCached(meta.id, snap, filter, meta.aliases || null);
      return { filter, totals: result.totals };
    }
  },
  {
    method: 'GET',
    pattern: '/api/repos/:id/files',
    handler: async ({ params, url }) => {
      const { meta, snap } = requireSnapshot(params.id);
      const filter = parseFilter(url);
      return { filter, rows: aggregateCached(meta.id, snap, filter, meta.aliases || null).files };
    }
  },
  {
    method: 'GET',
    pattern: '/api/repos/:id/dirs',
    handler: async ({ params, url }) => {
      const { meta, snap } = requireSnapshot(params.id);
      const filter = parseFilter(url);
      return { filter, rows: aggregateCached(meta.id, snap, filter, meta.aliases || null).dirs };
    }
  },
  {
    method: 'GET',
    pattern: '/api/repos/:id/authors',
    handler: async ({ params, url }) => {
      const { meta, snap } = requireSnapshot(params.id);
      const filter = parseFilter(url);
      return { filter, rows: aggregateCached(meta.id, snap, filter, meta.aliases || null).authors };
    }
  }
];

function matchRoute(method, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  for (const r of routes) {
    if (r.method !== method) continue;
    const rp = r.pattern.split('/').filter(Boolean);
    if (rp.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < rp.length; i++) {
      if (rp[i].startsWith(':')) params[rp[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (rp[i] !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route: r, params };
  }
  return null;
}

async function handleApi(req, res, url) {
  const match = matchRoute(req.method, url.pathname);
  if (!match) {
    return sendJson(res, 404, { error: 'no such endpoint' });
  }
  try {
    const result = await match.route.handler({ req, res, url, params: match.params });
    if (res.writableEnded) return;
    if (result && typeof result === 'object' && 'status' in result && 'body' in result) {
      return sendJson(res, result.status, result.body);
    }
    return sendJson(res, 200, result);
  } catch (err) {
    if (err instanceof HttpError) return sendJson(res, err.code, { error: err.message });
    console.error('[rat] api error:', err);
    return sendJson(res, 500, { error: 'internal error', detail: String((err && err.message) || err) });
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

module.exports = { handleApi, VERSION };
