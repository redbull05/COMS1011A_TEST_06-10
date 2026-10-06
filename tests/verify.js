'use strict';

/**
 * RAT verification suite (offline).
 *
 * 1. Builds the deterministic scratch repository (tools/make-scratch-repo.sh)
 *    whose metrics are hand-computed in the table below.
 * 2. Runs the real engine + metrics and asserts every number exactly.
 * 3. Independently re-parses the same repo with a different command
 *    (`git log --numstat -M50%`, text mode) and cross-checks totals and the
 *    per-file map.
 * 4. Runs both ingestion paths (zip + local clone) end-to-end and asserts the
 *    resulting snapshots are byte-identical to the work-tree parse.
 *
 * Hand-computed expectations (see the script header for the history):
 *   l+ total 29 | l- total 19 | growth 10 | churn 48 | |H| 10
 *   modifications 8 (c3 pure rename and c7 binary are NOT modifications)
 *   Alice (2 emails merged by .mailmap): mods 2, churn 18, ownership 0.375
 *   Bob: mods 6, churn 30, ownership 0.625
 */

const assert = require('assert');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const store = require('../server/store');
const engine = require('../server/engine');
const metrics = require('../server/metrics');
const ingest = require('../server/ingest');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, 'data', 'tmp', 'verify');
const SCRATCH = path.join(TMP, 'scratch');

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

const rowByPath = (rows, p) => rows.find((r) => r.path === p);

/* ------------------------------------------------------------------------ */
/* Independent cross-check: parse the text-mode numstat log (different path   */
/* through git than the engine's -z parsing).                                */
/* ------------------------------------------------------------------------ */

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
    if (parts.length < 3 || parts[0] === '-') continue; // binary rows
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

/* ------------------------------------------------------------------------ */

async function main() {
  console.log('=== RAT verify: scratch repository ===');
  fs.mkdirSync(TMP, { recursive: true });
  execFileSync('bash', [path.join(ROOT, 'tools', 'make-scratch-repo.sh'), SCRATCH], { stdio: 'pipe' });

  const snap = await engine.buildSnapshot(SCRATCH);
  const agg = metrics.aggregate(snap, {});

  /* --- per-commit parse ------------------------------------------------- */
  const perCommit = [
    [11, 0], // c1: .mailmap + a.txt
    [5, 2],  // c2: a.txt edit (alias email)
    [0, 0],  // c3: pure rename
    [3, 1],  // c4: rename + edit
    [0, 15], // c5: delete
    [6, 0],  // c6: dir1 + dir2
    [0, 0],  // c7: binary only
    [1, 0],  // c8: append
    [1, 1],  // c9: modify
    [2, 0]   // c10: cross-dir rename + append
  ];

  check(`parsed ${perCommit.length} commits`, () => eq(snap.commits.length, perCommit.length, 'commit count'));
  snap.commits.forEach((c, i) => {
    check(`c${i + 1} added/removed = ${perCommit[i][0]}/${perCommit[i][1]}`, () => {
      eq(c.a, perCommit[i][0], 'added');
      eq(c.r, perCommit[i][1], 'removed');
    });
  });

  check('initial commit has no parent', () => eq(snap.commits[0].p.length, 0, 'parents'));
  check('c2 keeps raw alias email', () => eq(snap.commits[1].ae, 'alice@other.com', 'raw email'));
  check('c2 is mailmap-merged', () => {
    eq(snap.commits[1].me, 'alice@example.com', 'merged email');
    eq(snap.commits[1].mn, 'Alice A', 'merged name');
  });

  /* --- rename purity + binary exclusion --------------------------------- */
  check('pure rename contributes zero churn (all rows 0/0)', () => {
    for (const [, add, del] of snap.commits[2].c) {
      eq(add, 0, 'rename added');
      eq(del, 0, 'rename removed');
    }
  });
  check('binary commit has no file rows', () => {
    eq(snap.commits[6].c.length, 0, 'rows');
  });
  check('logo.bin never appears in file metrics', () => {
    eq(rowByPath(agg.files, 'logo.bin'), undefined, 'binary row');
  });
  check('rename+edit attributed to the new path (c.txt +3/-1)', () => {
    const row = rowByPath(agg.files, 'c.txt');
    eq(row.added, 3, 'added');
    eq(row.removed, 16, 'removed (15 from the later delete)');
  });
  check('b.txt (pure rename target) is absent or all-zero', () => {
    const row = rowByPath(agg.files, 'b.txt');
    if (row) {
      eq(row.added, 0, 'added');
      eq(row.removed, 0, 'removed');
      eq(row.churn, 0, 'churn');
    }
  });

  /* --- repository totals (commit-set metrics over all of H-bar) --------- */
  check('repository totals', () => {
    eq(agg.totals.commits, 10, '|H|');
    eq(agg.totals.added, 29, 'l+');
    eq(agg.totals.removed, 19, 'l-');
    eq(agg.totals.growth, 10, 'growth');
    eq(agg.totals.churn, 48, 'churn');
    eq(agg.totals.modifications, 8, 'modifications');
    approx(agg.totals.modificationFrequency, 0.8, 'modification frequency');
    approx(agg.totals.churnRate, 4.8, 'churn rate');
  });

  /* --- file metrics ------------------------------------------------------ */
  const fileExpectations = {
    '.mailmap': { added: 1, removed: 0, modifications: 1 },
    'a.txt': { added: 15, removed: 2, modifications: 2, churn: 17 },
    'c.txt': { added: 3, removed: 16, modifications: 2, churn: 19 },
    'dir1/file.txt': { added: 6, removed: 1, modifications: 3, churn: 7 },
    'dir2/file2.txt': { added: 2, removed: 0, modifications: 1, churn: 2 },
    'dir3/f3.txt': { added: 2, removed: 0, modifications: 1, churn: 2 }
  };
  for (const [p, exp] of Object.entries(fileExpectations)) {
    check(`file ${p} = +${exp.added}/-${exp.removed}`, () => {
      const row = rowByPath(agg.files, p);
      assert.ok(row, `row for ${p} missing`);
      eq(row.added, exp.added, 'added');
      eq(row.removed, exp.removed, 'removed');
      eq(row.modifications, exp.modifications, 'modifications');
      if (exp.churn != null) eq(row.churn, exp.churn, 'churn');
    });
  }

  /* --- directory metrics ------------------------------------------------- */
  const dirExpectations = {
    dir1: { added: 6, removed: 1, modifications: 3, churn: 7 },
    dir2: { added: 2, removed: 0, modifications: 1, churn: 2 },
    dir3: { added: 2, removed: 0, modifications: 1, churn: 2 }
  };
  check(`exactly ${Object.keys(dirExpectations).length} directories have metrics`, () =>
    eq(agg.dirs.length, Object.keys(dirExpectations).length, 'dir count'));
  for (const [p, exp] of Object.entries(dirExpectations)) {
    check(`dir ${p} = +${exp.added}/-${exp.removed} mods ${exp.modifications}`, () => {
      const row = rowByPath(agg.dirs, p);
      assert.ok(row, `row for ${p} missing`);
      eq(row.added, exp.added, 'added');
      eq(row.removed, exp.removed, 'removed');
      eq(row.modifications, exp.modifications, 'modifications');
      eq(row.churn, exp.churn, 'churn');
    });
  }

  /* --- author metrics (mailmap-merged) ----------------------------------- */
  check('exactly 2 authors after .mailmap merge', () => eq(agg.authors.length, 2, 'author count'));
  check('raw alias email is merged away', () => {
    assert.ok(!agg.authors.some((a) => a.email === 'alice@other.com'), 'alice@other.com still present');
  });
  check('Alice: mods 2, churn 18, ownership 0.375', () => {
    const a = agg.authors.find((x) => x.email === 'alice@example.com');
    assert.ok(a, 'alice missing');
    eq(a.name, 'Alice Adams', 'name');
    eq(a.modifications, 2, 'modifications');
    eq(a.churn, 18, 'churn');
    approx(a.ownership, 0.375, 'ownership');
  });
  check('Bob: mods 6, churn 30, ownership 0.625', () => {
    const b = agg.authors.find((x) => x.email === 'bob@example.com');
    assert.ok(b, 'bob missing');
    eq(b.modifications, 6, 'modifications');
    eq(b.churn, 30, 'churn');
    approx(b.ownership, 0.625, 'ownership');
  });
  check('ownerships sum to 1', () => {
    approx(agg.authors.reduce((s, a) => s + a.ownership, 0), 1, 'ownership sum', 1e-6);
  });

  /* --- independent cross-check vs raw git -------------------------------- */
  console.log('--- cross-check vs raw git (text-mode numstat) ---');
  const ind = independentParse(SCRATCH);
  check('cross-check: totals match', () => {
    eq(ind.addedTotal, agg.totals.added, 'added total');
    eq(ind.removedTotal, agg.totals.removed, 'removed total');
  });
  check('cross-check: every engine file row matches raw git', () => {
    for (const row of agg.files) {
      const ref = ind.files.get(row.path);
      assert.ok(ref, `no raw-git row for ${row.path}`);
      eq(row.added, ref.added, `${row.path} added`);
      eq(row.removed, ref.removed, `${row.path} removed`);
    }
  });
  check('cross-check: no raw-git path missed (except zero-churn renames)', () => {
    for (const [p, ref] of ind.files) {
      const row = rowByPath(agg.files, p);
      if (!row) {
        eq(ref.added + ref.removed, 0, `${p} present in git but missing from engine`);
      }
    }
  });

  /* --- S3: filtering semantics (windows, commit sets, author, path) ------- */
  console.log('--- S3 filters: Ht / Hi,j windows, manual commit sets, author, path ---');
  const H = snap.commits;

  check('from = c5 date -> H6 = c5..c10', () => {
    const a = metrics.aggregate(snap, { from: H[4].t });
    eq(a.totals.commits, 6, '|H|');
    eq(a.totals.added, 10, 'added');
    eq(a.totals.removed, 16, 'removed');
    eq(a.totals.growth, -6, 'growth');
    eq(a.totals.churn, 26, 'churn');
    eq(a.totals.modifications, 5, 'modifications');
    eq(a.totals.modificationFrequency, 0.833333, 'modification frequency');
    eq(a.totals.churnRate, 4.333333, 'churn rate');
  });

  check('to = c3 date (exclusive) -> only c1, c2', () => {
    const a = metrics.aggregate(snap, { to: H[2].t });
    eq(a.totals.commits, 2, '|H|');
    eq(a.totals.added, 16, 'added');
    eq(a.totals.removed, 2, 'removed');
    eq(a.totals.churn, 18, 'churn');
    eq(a.totals.modificationFrequency, 1, 'modification frequency');
    eq(a.totals.churnRate, 9, 'churn rate');
  });

  check('window [c4, c7) -> c4..c6', () => {
    const a = metrics.aggregate(snap, { from: H[3].t, to: H[6].t });
    eq(a.totals.commits, 3, '|H|');
    eq(a.totals.added, 9, 'added');
    eq(a.totals.removed, 16, 'removed');
    eq(a.totals.churn, 25, 'churn');
    eq(a.totals.churnRate, 8.333333, 'churn rate');
  });

  check('manual commit set [c3, c4]: pure rename contributes nothing', () => {
    const a = metrics.aggregate(snap, { commits: [H[2].h, H[3].h] });
    eq(a.totals.commits, 2, '|H|');
    eq(a.totals.added, 3, 'added');
    eq(a.totals.removed, 1, 'removed');
    eq(a.totals.churn, 4, 'churn');
    eq(a.totals.modifications, 1, 'modifications');
    eq(a.totals.modificationFrequency, 0.5, 'modification frequency');
    eq(a.totals.churnRate, 2, 'churn rate');
  });

  check('author filter (mailmap-merged alice@example.com)', () => {
    const a = metrics.aggregate(snap, { author: 'alice@example.com' });
    eq(a.totals.commits, 3, '|H| (c1..c3, incl. the pure rename)');
    eq(a.totals.added, 16, 'added');
    eq(a.totals.removed, 2, 'removed');
    eq(a.totals.churn, 18, 'churn');
    eq(a.totals.modifications, 2, 'modifications');
    eq(a.totals.modificationFrequency, 0.666667, 'modification frequency');
    eq(a.totals.churnRate, 6, 'churn rate');
    eq(a.authors.length, 1, 'author rows');
    approx(a.authors[0].ownership, 1, 'ownership within the filtered set');
  });

  check('author filter (bob@example.com)', () => {
    const a = metrics.aggregate(snap, { author: 'bob@example.com' });
    eq(a.totals.commits, 7, '|H|');
    eq(a.totals.added, 13, 'added');
    eq(a.totals.removed, 17, 'removed');
    eq(a.totals.churn, 30, 'churn');
    eq(a.totals.modifications, 6, 'modifications');
    eq(a.totals.modificationFrequency, 0.857143, 'modification frequency');
    eq(a.totals.churnRate, 4.285714, 'churn rate');
  });

  check('path filter on dir1 (directory): objects filtered, |H| unchanged', () => {
    const a = metrics.aggregate(snap, { path: 'dir1', pathIsDir: true });
    eq(a.totals.commits, 10, '|H|');
    eq(a.totals.added, 6, 'added');
    eq(a.totals.removed, 1, 'removed');
    eq(a.totals.churn, 7, 'churn');
    eq(a.totals.modifications, 3, 'modifications');
    eq(a.totals.modificationFrequency, 0.3, 'modification frequency');
    eq(a.totals.churnRate, 0.7, 'churn rate');
    eq(a.files.length, 1, 'file rows under dir1');
    eq(a.files[0].path, 'dir1/file.txt', 'the file row');
  });

  check('path filter on a.txt (file)', () => {
    const a = metrics.aggregate(snap, { path: 'a.txt' });
    eq(a.totals.commits, 10, '|H|');
    eq(a.totals.added, 15, 'added');
    eq(a.totals.removed, 2, 'removed');
    eq(a.totals.churn, 17, 'churn');
    eq(a.totals.modifications, 2, 'modifications');
    eq(a.totals.modificationFrequency, 0.2, 'modification frequency');
    eq(a.totals.churnRate, 1.7, 'churn rate');
    eq(a.files.length, 1, 'file rows');
  });

  check('per-object author metrics: only Bob touched dir1, ownership 1', () => {
    const a = metrics.aggregate(snap, { path: 'dir1', pathIsDir: true });
    eq(a.authors.length, 1, 'authors on dir1');
    eq(a.authors[0].email, 'bob@example.com', 'author of dir1');
    eq(a.authors[0].churn, 7, 'author churn on dir1');
    approx(a.authors[0].ownership, 1, 'ownership of dir1');
  });

  check('empty commit set -> all zero, frequency/rate 0', () => {
    const a = metrics.aggregate(snap, { from: H[9].t + 1 });
    eq(a.totals.commits, 0, '|H|');
    eq(a.totals.added, 0, 'added');
    eq(a.totals.churn, 0, 'churn');
    eq(a.totals.modificationFrequency, 0, 'modification frequency');
    eq(a.totals.churnRate, 0, 'churn rate');
    eq(a.files.length, 0, 'file rows');
    eq(a.authors.length, 0, 'author rows');
  });

  /* --- S4: manual author merge (aliases applied at query time) ------------ */
  console.log('--- S4 author merge: manual aliases on top of .mailmap ---');
  const ALIASES = { 'alice@example.com': 'bob@example.com' };
  const mergedAgg = metrics.aggregate(snap, {}, ALIASES);
  check('merge: exactly 1 author after aliasing Alice into Bob', () =>
    eq(mergedAgg.authors.length, 1, 'author count'));
  check('merge: the single author is the canonical email', () =>
    eq(mergedAgg.authors[0].email, 'bob@example.com', 'email'));
  check('merge: churn is the full 48', () => eq(mergedAgg.authors[0].churn, 48, 'churn'));
  check('merge: modifications sum to 8', () =>
    eq(mergedAgg.authors[0].modifications, 8, 'mods'));
  check('merge: ownership is 1', () => approx(mergedAgg.authors[0].ownership, 1, 'ownership'));
  check('merge: repository totals are unaffected by aliasing', () => {
    eq(mergedAgg.totals.added, agg.totals.added, 'added');
    eq(mergedAgg.totals.churn, agg.totals.churn, 'churn');
    eq(mergedAgg.totals.commits, agg.totals.commits, 'commits');
  });
  check('merge: alias chains resolve transitively', () => {
    const chained = metrics.aggregate(snap, {}, {
      'alice@example.com': 'tmp@example.com',
      'tmp@example.com': 'bob@example.com'
    });
    eq(chained.authors.length, 1, 'author count');
    eq(chained.authors[0].email, 'bob@example.com', 'resolved email');
    eq(chained.authors[0].churn, 48, 'churn');
  });
  check('merge: aliases compose with filters (Alice view becomes empty)', () => {
    const a = metrics.aggregate(snap, { author: 'alice@example.com' }, ALIASES);
    eq(a.totals.commits, 0, 'commits');
    const b = metrics.aggregate(snap, { author: 'bob@example.com' }, ALIASES);
    eq(b.totals.commits, 10, 'commits');
    eq(b.totals.churn, 48, 'churn');
  });

  /* --- S5: timeline buckets ------------------------------------------------ */
  console.log('--- S5 timeline: day / week / month buckets ---');
  const day = metrics.timeline(snap, {}, null, 'day');
  check('timeline: one bucket per day (10)', () => eq(day.length, 10, 'buckets'));
  check('timeline: daily buckets each hold 1 commit', () =>
    day.every((b) => b.commits === 1));
  check('timeline: daily sums match the totals (+29/-19)', () => {
    eq(day.reduce((s, b) => s + b.added, 0), 29, 'added');
    eq(day.reduce((s, b) => s + b.removed, 0), 19, 'removed');
    eq(day.reduce((s, b) => s + b.commits, 0), 10, 'commits');
  });
  const week = metrics.timeline(snap, {}, null, 'week');
  check('timeline: two Monday-start weeks (2024-01-01 is a Monday)', () => {
    eq(week.length, 2, 'bucket count');
    eq(week[0].start, Date.UTC(2024, 0, 1) / 1000, 'week 1 starts Mon 2024-01-01');
    eq(week[0].commits, 7, 'c1..c7 in week 1');
    eq(week[1].commits, 3, 'c8..c10 in week 2');
  });
  check('timeline: weekly sums are +25/-18 and +4/-1', () => {
    eq(week[0].added, 25, 'w1 added');
    eq(week[0].removed, 18, 'w1 removed');
    eq(week[1].added, 4, 'w2 added');
    eq(week[1].removed, 1, 'w2 removed');
  });
  const month = metrics.timeline(snap, {}, null, 'month');
  check('timeline: a single month bucket (+29/-19)', () => {
    eq(month.length, 1, 'bucket count');
    eq(month[0].added, 29, 'added');
    eq(month[0].removed, 19, 'removed');
    eq(month[0].start, Date.UTC(2024, 0, 1) / 1000, 'month starts 2024-01-01');
    eq(month[0].end, Date.UTC(2024, 1, 1) / 1000, 'month ends 2024-02-01');
  });
  check('timeline: Ht window keeps c5..c10 (6 commits, +10/-16)', () => {
    const t = metrics.timeline(snap, { from: Date.UTC(2024, 0, 5) / 1000 }, null, 'day');
    eq(t.reduce((s, b) => s + b.commits, 0), 6, 'commits');
    eq(t.reduce((s, b) => s + b.added, 0), 10, 'added');
    eq(t.reduce((s, b) => s + b.removed, 0), 16, 'removed');
  });
  check('timeline: path filter only counts the object lines', () => {
    const t = metrics.timeline(snap, { path: 'a.txt' }, null, 'month');
    eq(t.reduce((s, b) => s + b.commits, 0), 10, 'commits still counted');
    eq(t.reduce((s, b) => s + b.added, 0), 15, 'added');
    eq(t.reduce((s, b) => s + b.removed, 0), 2, 'removed');
  });
  check('timeline: unknown bucket is rejected', () => {
    let threw = false;
    try {
      metrics.timeline(snap, {}, null, 'fortnight');
    } catch {
      threw = true;
    }
    assert.ok(threw, 'expected a throw');
  });

  /* --- ingestion paths: zip and local clone ------------------------------- */
  console.log('--- ingestion: zip upload == local clone == work-tree parse ---');
  const zipPath = path.join(TMP, 'scratch.zip');
  fs.rmSync(zipPath, { force: true });
  execFileSync('zip', ['-q', '-r', zipPath, 'scratch'], { cwd: TMP });

  const zipMeta = await ingest.createRepo({ sourceType: 'zip', source: 'scratch.zip', name: 'verify-zip' });
  await ingest.ingestZip(zipMeta, zipPath);
  const zipSnap = JSON.parse(fs.readFileSync(path.join(store.repoDir(zipMeta.id), 'snapshot.json'), 'utf8'));

  const cloneMeta = await ingest.createRepo({ sourceType: 'url', source: SCRATCH, name: 'verify-clone' });
  await ingest.ingestUrl(cloneMeta);
  const cloneSnap = JSON.parse(fs.readFileSync(path.join(store.repoDir(cloneMeta.id), 'snapshot.json'), 'utf8'));

  check('zip ingestion produces an identical commit history', () => {
    eq(zipSnap.commits.length, snap.commits.length, 'commit count');
    eq(JSON.stringify(zipSnap.commits), JSON.stringify(snap.commits), 'commit data');
  });
  check('clone ingestion produces an identical commit history', () => {
    eq(cloneSnap.commits.length, snap.commits.length, 'commit count');
    eq(JSON.stringify(cloneSnap.commits), JSON.stringify(snap.commits), 'commit data');
  });
  check('zip snapshot aggregates to identical totals', () => {
    const zipAgg = metrics.aggregate(zipSnap, {});
    eq(JSON.stringify(zipAgg), JSON.stringify(agg), 'aggregate equality');
  });

  store.deleteRepo(zipMeta.id);
  store.deleteRepo(cloneMeta.id);

  /* ----------------------------------------------------------------------- */
  console.log('---------------------------------------');
  console.log(`${passed} checks passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('failed checks:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
  console.log('VERIFY OK');
}

main().catch((err) => {
  console.error('verify crashed:', err);
  process.exit(1);
});
