'use strict';

/**
 * HTTP API tests for S4 (author merge) and S5 (timeline).
 *
 * Boots the real server on a scratch port, ingests two local fixtures through
 * the API (scratch: 2 authors, tri: 3 authors) and exercises:
 *   POST /api/repos/:id/authors/merge   (single, multi, chain re-point, 400s)
 *   POST /api/repos/:id/authors/reset
 *   GET  /api/repos/:id/timeline        (day/week/month, filters, 400s)
 */

const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const PORT = 3900 + (process.pid % 100);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = path.join(ROOT, 'data', 'tmp', 'http');

let passed = 0;
const failures = [];

function check(label, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${label}`);
  } catch (err) {
    failures.push(label);
    console.log(`  FAIL ${label}\n       ${err.message}`);
  }
}

function eq(actual, expected, what) {
  assert.strictEqual(actual, expected, `${what}: expected ${expected}, got ${actual}`);
}

function approx(actual, expected, what, eps = 1e-9) {
  assert.ok(Math.abs(actual - expected) < eps, `${what}: expected ~${expected}, got ${actual}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error('server did not start');
}

async function waitReady(id) {
  for (let i = 0; i < 100; i++) {
    const { json } = await api('GET', `/api/repos/${id}`);
    if (json.status === 'ready' || json.status === 'error') return json;
    await sleep(300);
  }
  throw new Error('ingestion never finished');
}

/** Deterministic 3-author fixture: X (+2), Y (+3), Z (+4) on consecutive days. */
function makeTriRepo(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const g = (args, env) =>
    execFileSync('git', ['-C', dir].concat(args), {
      stdio: 'pipe',
      env: { ...process.env, ...(env || {}) }
    });
  g(['init', '-q', '--initial-branch=main']);
  const authors = [
    ['X AA', 'x@example.com', 2, '2024-02-01T12:00:00+00:00'],
    ['Y BB', 'y@example.com', 3, '2024-02-02T12:00:00+00:00'],
    ['Z CC', 'z@example.com', 4, '2024-02-03T12:00:00+00:00']
  ];
  let total = 0; // cumulative: each commit appends exactly `lines` NEW lines
  for (const [name, email, lines, date] of authors) {
    total += lines;
    const content = Array.from({ length: total }, (_, i) => `line ${i + 1}\n`).join('');
    fs.writeFileSync(path.join(dir, 'f.txt'), content);
    g(['add', '-A']);
    const who = {
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date
    };
    g(['commit', '-q', '-m', `add ${lines} lines`], who);
  }
}

async function main() {
  console.log('=== RAT http tests: author merge + timeline ===');
  execFileSync('bash', [path.join(ROOT, 'tools', 'make-scratch-repo.sh'), path.join(TMP, 'scratch')], {
    stdio: 'pipe'
  });
  makeTriRepo(path.join(TMP, 'tri'));

  const server = spawn('node', [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  let scratchId = null;
  let triId = null;
  try {
    await waitForServer();

    /* --- ingest both fixtures through the API --------------------------- */
    let r = await api('POST', '/api/repos/clone', { url: path.join(TMP, 'scratch'), name: 'http-scratch' });
    eq(r.status, 202, 'clone scratch accepted');
    scratchId = r.json.id;
    const sMeta = await waitReady(scratchId);
    check('scratch repo ready with 10 commits', () => eq(sMeta.commitCount, 10, 'commits'));

    r = await api('POST', '/api/repos/clone', { url: path.join(TMP, 'tri'), name: 'http-tri' });
    triId = r.json.id;
    const tMeta = await waitReady(triId);
    check('tri repo ready with 3 commits', () => eq(tMeta.commitCount, 3, 'commits'));

    /* --- S4: merge ------------------------------------------------------- */
    r = await api('GET', `/api/repos/${scratchId}/authors`);
    const before = r.json.rows;
    check('scratch starts with 2 authors (mailmap already merged alias)', () =>
      eq(before.length, 2, 'authors'));

    r = await api('POST', `/api/repos/${scratchId}/authors/merge`, {
      from: ['alice@example.com'],
      into: 'bob@example.com'
    });
    check('merge returns the merged author rows', () => {
      eq(r.status, 200, 'status');
      eq(r.json.rows.length, 1, 'author count');
      eq(r.json.rows[0].churn, 48, 'churn');
      approx(r.json.rows[0].ownership, 1, 'ownership');
      eq(r.json.aliases['alice@example.com'], 'bob@example.com', 'alias map');
    });

    r = await api('GET', `/api/repos/${scratchId}/authors`);
    check('merge persists across requests (still 1 author)', () => {
      eq(r.json.rows.length, 1, 'author count');
      eq(r.json.rows[0].churn, 48, 'churn');
    });

    r = await api('GET', `/api/repos/${scratchId}/metrics`);
    check('repository totals are unchanged by the merge', () => {
      eq(r.json.totals.added, 29, 'added');
      eq(r.json.totals.removed, 19, 'removed');
      eq(r.json.totals.churn, 48, 'churn');
    });

    r = await api('POST', `/api/repos/${scratchId}/authors/merge`, {
      from: ['nobody@example.com'],
      into: 'bob@example.com'
    });
    check('merging an unknown email is a 400', () => eq(r.status, 400, 'status'));

    r = await api('POST', `/api/repos/${scratchId}/authors/merge`, {
      from: ['bob@example.com'],
      into: 'bob@example.com'
    });
    check('merging an email into itself is a 400', () => eq(r.status, 400, 'status'));

    r = await api('POST', `/api/repos/${scratchId}/authors/merge`, { from: [], into: 'bob@example.com' });
    check('empty from list is a 400', () => eq(r.status, 400, 'status'));

    r = await api('POST', `/api/repos/${scratchId}/authors/merge`, { from: ['alice@example.com'] });
    check('missing into is a 400', () => eq(r.status, 400, 'status'));

    r = await api('POST', '/api/repos/does-not-exist/authors/merge', {
      from: ['a@x'],
      into: 'b@x'
    });
    check('merging on an unknown repo is a 404', () => eq(r.status, 404, 'status'));

    /* --- chain re-pointing: merge x -> y, then y -> z ------------------- */
    r = await api('POST', `/api/repos/${triId}/authors/merge`, {
      from: ['x@example.com'],
      into: 'y@example.com'
    });
    check('tri: first merge leaves 2 authors', () => eq(r.json.rows.length, 2, 'authors'));

    r = await api('POST', `/api/repos/${triId}/authors/merge`, {
      from: ['y@example.com'],
      into: 'z@example.com'
    });
    check('tri: second merge re-points the chain (1 author, all churn)', () => {
      eq(r.status, 200, 'status');
      eq(r.json.rows.length, 1, 'author count');
      eq(r.json.rows[0].email, 'z@example.com', 'canonical email');
      eq(r.json.rows[0].churn, 9, 'churn (2+3+4)');
      approx(r.json.rows[0].ownership, 1, 'ownership');
      eq(r.json.aliases['x@example.com'], 'z@example.com', 'x re-pointed to z');
      eq(r.json.aliases['y@example.com'], 'z@example.com', 'y merged into z');
    });

    /* --- reset ----------------------------------------------------------- */
    r = await api('POST', `/api/repos/${triId}/authors/reset`);
    check('reset restores all authors', () => {
      eq(r.status, 200, 'status');
      eq(r.json.rows.length, 3, 'author count');
      eq(Object.keys(r.json.aliases).length, 0, 'aliases empty');
    });

    r = await api('GET', `/api/repos/${triId}/authors`);
    check('reset persists (3 authors again)', () => {
      eq(r.json.rows.length, 3, 'author count');
      eq(r.json.rows.find((a) => a.email === 'x@example.com').churn, 2, 'x churn');
    });

    /* --- S5: timeline ---------------------------------------------------- */
    r = await api('GET', `/api/repos/${scratchId}/timeline?bucket=day`);
    check('timeline day: 10 buckets summing to the totals', () => {
      eq(r.json.bucket, 'day', 'bucket echoed');
      eq(r.json.rows.length, 10, 'buckets');
      eq(r.json.rows.reduce((s, b) => s + b.commits, 0), 10, 'commits');
      eq(r.json.rows.reduce((s, b) => s + b.added, 0), 29, 'added');
      eq(r.json.rows.reduce((s, b) => s + b.removed, 0), 19, 'removed');
    });

    r = await api('GET', `/api/repos/${scratchId}/timeline`);
    check('timeline defaults to week (2 buckets: 7 + 3 commits)', () => {
      eq(r.json.bucket, 'week', 'default bucket');
      eq(r.json.rows.length, 2, 'buckets');
      eq(r.json.rows[0].commits, 7, 'week 1');
      eq(r.json.rows[1].commits, 3, 'week 2');
    });

    r = await api('GET', `/api/repos/${scratchId}/timeline?bucket=month`);
    check('timeline month: 1 bucket (+29/-19)', () => {
      eq(r.json.rows.length, 1, 'buckets');
      eq(r.json.rows[0].added, 29, 'added');
      eq(r.json.rows[0].removed, 19, 'removed');
    });

    r = await api('GET', `/api/repos/${scratchId}/timeline?bucket=fortnight`);
    check('timeline rejects an unknown bucket with 400', () => eq(r.status, 400, 'status'));

    r = await api('GET', `/api/repos/${scratchId}/timeline?bucket=day&from=${Date.UTC(2024, 0, 5) / 1000}`);
    check('timeline respects the Ht window (6 commits, +10/-16)', () => {
      eq(r.json.rows.reduce((s, b) => s + b.commits, 0), 6, 'commits');
      eq(r.json.rows.reduce((s, b) => s + b.added, 0), 10, 'added');
      eq(r.json.rows.reduce((s, b) => s + b.removed, 0), 16, 'removed');
    });

    r = await api('GET', `/api/repos/${scratchId}/timeline?bucket=day&path=a.txt`);
    check('timeline respects the path filter (+15/-2 on a.txt)', () => {
      eq(r.json.rows.reduce((s, b) => s + b.added, 0), 15, 'added');
      eq(r.json.rows.reduce((s, b) => s + b.removed, 0), 2, 'removed');
    });

    r = await api('GET', '/api/repos/does-not-exist/timeline');
    check('timeline on an unknown repo is a 404', () => eq(r.status, 404, 'status'));
  } finally {
    if (scratchId) await api('DELETE', `/api/repos/${scratchId}`).catch(() => {});
    if (triId) await api('DELETE', `/api/repos/${triId}`).catch(() => {});
    server.kill('SIGTERM');
  }

  console.log('---------------------------------------');
  console.log(`${passed} checks passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('failed checks:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
  console.log('HTTP TESTS OK');
}

main().catch((err) => {
  console.error('http tests crashed:', err);
  process.exit(1);
});
