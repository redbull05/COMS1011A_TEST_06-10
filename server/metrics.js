'use strict';

/**
 * Metric aggregation - the five categories of the brief, computed over a
 * commit set H (any subset of H-bar, the non-merge commits reachable from HEAD).
 *
 *   File:        l+, l-, growth = l+ - l-, churn = l+ + l-
 *   Directory:   the same four, rolled up recursively (prefix rollup, which
 *                is equivalent to the recursive definition in the brief)
 *   Repository:  directory metrics on the root
 *   Commit set:  sums of the four + Modifications (commits with churn > 0),
 *                Modification frequency n/|H|, Churn rate churn/|H|
 *   Author:      Author modifications, author churn,
 *                Ownership = author churn / total churn
 *                (authors with no churn in the view are omitted)
 *
 * A "filter" restricts H and/or the objects inside it:
 *   { from, to, commits: [hash...] | Set, path, pathIsDir, author }
 *   from/to implement H_t and H_i,j on committer dates (from inclusive,
 *   to exclusive), exactly as defined in the brief.
 *
 * Author merging works at query time: `aliases` maps a lowercase author key
 * (the post-.mailmap email shown in the Authors table) onto a canonical one;
 * resolveAlias() follows chains, so merges never need a re-parse.
 */

const { dirsOf } = require('./engine');
const { round } = require('./util');

function authorKeyOf(c) {
  return (c.me || c.ae || '').toLowerCase();
}

/** Follow the manual alias chain (applied on top of .mailmap). */
function resolveAlias(email, aliases) {
  let e = email;
  for (let i = 0; i < 8 && aliases && aliases[e]; i++) e = aliases[e];
  return e;
}

/**
 * Shared filter context: one definition of "which commits and which lines
 * count", used by both aggregate() and timeline() so they can never drift.
 */
function filterContext(filter = {}, aliases = null) {
  const from = filter.from != null ? Number(filter.from) : null;
  const to = filter.to != null ? Number(filter.to) : null;
  const commitSet = filter.commits
    ? filter.commits instanceof Set
      ? filter.commits
      : new Set(filter.commits)
    : null;
  const authorFilter = filter.author ? String(filter.author).toLowerCase() : null;
  const pathFilter = filter.path || null;
  const pathIsDir = !!filter.pathIsDir;

  const matchesPath = (p) =>
    !pathFilter || (pathIsDir ? p === pathFilter || p.startsWith(pathFilter + '/') : p === pathFilter);

  /** H filters: H_t (t <= committer date) and H_i,j (i <= t < j), plus
   *  manual commit sets and (post-merge) author selection. */
  const passes = (c) => {
    if (from != null && c.t < from) return false;
    if (to != null && c.t >= to) return false;
    if (commitSet && !commitSet.has(c.h)) return false;
    if (authorFilter && resolveAlias(authorKeyOf(c), aliases) !== authorFilter) return false;
    return true;
  };

  /** Path-filtered per-commit added/removed - identical semantics to the
   *  totals computed inside aggregate() (binary and pure renames never
   *  contribute; 0/0 rows are metric-neutral). */
  const churnOf = (c) => {
    if (!pathFilter) return [c.a, c.r];
    let a = 0;
    let r = 0;
    for (const [p, add, del] of c.c) {
      if (add === 0 && del === 0) continue;
      if (!matchesPath(p)) continue;
      a += add;
      r += del;
    }
    return [a, r];
  };

  return { from, to, commitSet, authorFilter, pathFilter, pathIsDir, matchesPath, passes, churnOf };
}

function newRow(p) {
  return { path: p, added: 0, removed: 0, modifications: 0 };
}

/**
 * Aggregate all five categories for the given filter.
 * Returns { totals, files, dirs, authors } with final numbers applied.
 */
function aggregate(snapshot, filter = {}, aliases = null) {
  const ctx = filterContext(filter, aliases);

  const totals = { commits: 0, added: 0, removed: 0, growth: 0, churn: 0, modifications: 0 };
  const files = new Map();
  const dirs = new Map();
  const authors = new Map();

  for (const c of snapshot.commits) {
    if (!ctx.passes(c)) continue;

    totals.commits++;

    // Per-commit rollups so each object counts a "modification" once per commit.
    let cAdded = 0;
    let cRemoved = 0;
    const cFiles = new Map();
    const cDirs = new Map();

    for (const [p, add, del] of c.c) {
      if (add === 0 && del === 0) continue; // pure rename: no metric impact
      if (!ctx.matchesPath(p)) continue;
      cAdded += add;
      cRemoved += del;

      const fr = cFiles.get(p) || [0, 0];
      fr[0] += add;
      fr[1] += del;
      cFiles.set(p, fr);

      for (const d of dirsOf(p)) {
        const dr = cDirs.get(d) || [0, 0];
        dr[0] += add;
        dr[1] += del;
        cDirs.set(d, dr);
      }
    }

    if (cAdded + cRemoved > 0) totals.modifications++;
    totals.added += cAdded;
    totals.removed += cRemoved;

    for (const [p, [add, del]] of cFiles) {
      const row = files.get(p) || newRow(p);
      row.added += add;
      row.removed += del;
      if (add + del > 0) row.modifications++;
      files.set(p, row);
    }

    for (const [d, [add, del]] of cDirs) {
      const row = dirs.get(d) || newRow(d);
      row.added += add;
      row.removed += del;
      if (add + del > 0) row.modifications++;
      dirs.set(d, row);
    }

    const key = resolveAlias(authorKeyOf(c), aliases);
    // Authors enter the table only via churn in the current view, so a path
    // filter lists the authors of the visible object; existing rows may still
    // refresh their display name from later commits (e.g. a pure rename).
    const churn = cAdded + cRemoved;
    let arow = authors.get(key);
    if (churn > 0) {
      arow = arow || { name: '', email: key, modifications: 0, churn: 0 };
      arow.modifications++;
      arow.churn += churn;
    }
    if (arow) {
      arow.name = c.mn || c.an || arow.name; // latest merged name wins
      authors.set(key, arow);
    }
  }

  totals.growth = totals.added - totals.removed;
  totals.churn = totals.added + totals.removed;
  totals.modificationFrequency = totals.commits ? round(totals.modifications / totals.commits, 6) : 0;
  totals.churnRate = totals.commits ? round(totals.churn / totals.commits, 6) : 0;

  const finalizeObject = (row) => ({
    path: row.path,
    added: row.added,
    removed: row.removed,
    growth: row.added - row.removed,
    churn: row.added + row.removed,
    modifications: row.modifications,
    modificationFrequency: totals.commits ? round(row.modifications / totals.commits, 6) : 0,
    churnRate: totals.commits ? round((row.added + row.removed) / totals.commits, 6) : 0
  });

  const fileRows = [...files.values()].map(finalizeObject).sort((x, y) => y.churn - x.churn);
  const dirRows = [...dirs.values()]
    .filter((r) => r.path !== '')
    .map(finalizeObject)
    .sort((x, y) => y.churn - x.churn);

  const totalChurn = totals.churn;
  const authorRows = [...authors.values()]
    .map((a) => ({
      name: a.name || a.email,
      email: a.email,
      modifications: a.modifications,
      churn: a.churn,
      ownership: totalChurn > 0 ? round(a.churn / totalChurn, 6) : 0
    }))
    .sort((x, y) => y.churn - x.churn);

  return { totals, files: fileRows, dirs: dirRows, authors: authorRows };
}

/* --------------------------------------------------------------------------
 * Timeline (S5): bucket the commit set by committer date.
 *   day   -> UTC calendar days
 *   week  -> Monday-start weeks
 *   month -> UTC calendar months
 * Each bucket sums the (filter-consistent) per-commit added/removed, so the
 * buckets always add up to the totals of the same view.
 * ------------------------------------------------------------------------ */

const DAY = 86400;
const BUCKETS = ['day', 'week', 'month'];

function bucketStart(t, bucket) {
  if (bucket === 'day') return Math.floor(t / DAY) * DAY;
  if (bucket === 'week') {
    const day = Math.floor(t / DAY);
    return (day - ((day + 3) % 7)) * DAY; // epoch day 0 = Thursday -> Monday start
  }
  const d = new Date(t * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
}

function bucketEnd(start, bucket) {
  if (bucket === 'day') return start + DAY;
  if (bucket === 'week') return start + 7 * DAY;
  const d = new Date(start * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000);
}

/** Bucket the filtered commit set by committer date. */
function timeline(snapshot, filter = {}, aliases = null, bucket = 'week') {
  if (!BUCKETS.includes(bucket)) {
    throw new Error(`unknown bucket "${bucket}" (use day, week or month)`);
  }
  const ctx = filterContext(filter, aliases);
  const map = new Map();

  for (const c of snapshot.commits) {
    if (!ctx.passes(c)) continue;
    const start = bucketStart(c.t, bucket);
    const row = map.get(start) || { start, end: bucketEnd(start, bucket), commits: 0, added: 0, removed: 0 };
    const [a, r] = ctx.churnOf(c);
    row.commits++;
    row.added += a;
    row.removed += r;
    map.set(start, row);
  }

  return [...map.values()]
    .map((row) => ({ ...row, growth: row.added - row.removed, churn: row.added + row.removed }))
    .sort((x, y) => x.start - y.start);
}

module.exports = {
  aggregate,
  timeline,
  filterContext,
  authorKeyOf,
  resolveAlias,
  bucketStart,
  bucketEnd
};
