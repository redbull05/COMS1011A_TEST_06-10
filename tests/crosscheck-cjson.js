'use strict';

/**
 * cJSON cross-check (network): deep-clones DaveGamble/cJSON and verifies the
 * engine's totals and per-file map against an independent parse of
 * `git log --no-merges --numstat -M50%` (text mode), plus the textbook awk
 * one-liner for the added-line total.
 */

const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const engine = require('../server/engine');
const metrics = require('../server/metrics');

const ROOT = path.join(__dirname, '..');
const CJSON_URL = 'https://github.com/DaveGamble/cJSON.git';
const CJSON_DIR = path.join(ROOT, 'data', 'tmp', 'cjson');

function normalizeRename(p) {
  if (!p.includes(' => ')) return p;
  const open = p.indexOf('{');
  if (open !== -1) {
    const close = p.indexOf('}', open);
    if (close !== -1) {
      const pre = p.slice(0, open);
      const mid = p.slice(open + 1, close);
      const suf = p.slice(close + 1);
      const arrow = mid.lastIndexOf(' => ');
      return pre + (arrow === -1 ? mid : mid.slice(arrow + 4)) + suf;
    }
  }
  return p.slice(p.lastIndexOf(' => ') + 4);
}

function independentParse(repoDir) {
  const out = execFileSync(
    'git',
    ['-C', repoDir, '-c', 'core.quotepath=false', 'log', '--no-merges', '-M50%', '--pretty=format:', '--numstat'],
    { encoding: 'utf8', maxBuffer: 1 << 30 }
  );
  const files = new Map();
  let addedTotal = 0;
  let removedTotal = 0;
  for (const raw of out.split('\n')) {
    if (!raw) continue;
    const parts = raw.split('\t');
    if (parts.length < 3 || parts[0] === '-') continue;
    const add = Number(parts[0]);
    const del = Number(parts[1]);
    if (!Number.isFinite(add) || !Number.isFinite(del)) continue;
    let p = parts.slice(2).join('\t');
    if (p.includes(' => ')) p = normalizeRename(p);
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    const row = files.get(p) || { added: 0, removed: 0 };
    row.added += add;
    row.removed += del;
    files.set(p, row);
    addedTotal += add;
    removedTotal += del;
  }
  return { files, addedTotal, removedTotal };
}

async function main() {
  console.log('=== RAT cross-check: cJSON ===');
  if (!fs.existsSync(path.join(CJSON_DIR, '.git'))) {
    fs.mkdirSync(path.dirname(CJSON_DIR), { recursive: true });
    console.log('cloning cJSON (full history)...');
    execFileSync('git', ['clone', '--quiet', '--', CJSON_URL, CJSON_DIR], { stdio: 'inherit' });
  }

  const snap = await engine.buildSnapshot(CJSON_DIR);
  const agg = metrics.aggregate(snap, {});
  const ind = independentParse(CJSON_DIR);

  const revCount = Number(
    execFileSync('git', ['-C', CJSON_DIR, 'rev-list', '--count', '--no-merges', 'HEAD'], { encoding: 'utf8' }).trim()
  );

  // textbook awk one-liner from the plan
  const awkTotal = Number(
    execFileSync('bash', [
      '-c',
      `git -C ${CJSON_DIR} log --no-merges -M50% --pretty=format: --numstat | awk '$1 != "-" && NF >= 3 { s += $1 } END { print s }'`
    ], { encoding: 'utf8' }).trim()
  );

  let failed = 0;
  const check = (label, fn) => {
    try {
      fn();
      console.log(`  ok   ${label}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL ${label}\n       ${err.message}`);
    }
  };

  check(`commit count matches git rev-list (${revCount})`, () =>
    assert.strictEqual(agg.totals.commits, revCount, 'commit count'));

  check(`added total (${agg.totals.added}) matches independent parse (${ind.addedTotal})`, () =>
    assert.strictEqual(agg.totals.added, ind.addedTotal, 'added total'));

  check(`removed total (${agg.totals.removed}) matches independent parse (${ind.removedTotal})`, () =>
    assert.strictEqual(agg.totals.removed, ind.removedTotal, 'removed total'));

  check(`added total matches awk one-liner (${awkTotal})`, () =>
    assert.strictEqual(agg.totals.added, awkTotal, 'awk added total'));

  check(`per-file map matches raw git for all ${agg.files.length} files`, () => {
    for (const row of agg.files) {
      const ref = ind.files.get(row.path);
      assert.ok(ref, `no raw-git row for ${row.path}`);
      assert.strictEqual(row.added, ref.added, `${row.path} added`);
      assert.strictEqual(row.removed, ref.removed, `${row.path} removed`);
    }
    for (const [p, ref] of ind.files) {
      const row = agg.files.find((r) => r.path === p);
      if (!row) {
        assert.strictEqual(ref.added + ref.removed, 0, `${p} present in git but missing from engine`);
      }
    }
  });

  console.log('---------------------------------------');
  if (failed) {
    console.log(`${failed} checks failed`);
    process.exit(1);
  }
  console.log('CROSS-CHECK OK');
}

main().catch((err) => {
  console.error('cross-check crashed:', err.message);
  console.error('(if this is a network problem, re-run when you have connectivity)');
  process.exit(1);
});
