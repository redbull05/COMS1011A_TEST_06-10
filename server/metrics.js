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
 *
 * A "filter" restricts H and/or the objects inside it:
 *   { from, to, commits: [hash...] | Set, path, pathIsDir, author }
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

function newRow(p) {
  return { path: p, added: 0, removed: 0, modifications: 0 };
}

/**
 * Aggregate all five categories for the given filter.
 * Returns { totals, files, dirs, authors } with final numbers applied.
 */
function aggregate(snapshot, filter = {}, aliases = null) {
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

  const totals = { commits: 0, added: 0, removed: 0, growth: 0, churn: 0, modifications: 0 };
  const files = new Map();
  const dirs = new Map();
  const authors = new Map();

  const matchesPath = (p) =>
    !pathFilter || (pathIsDir ? p === pathFilter || p.startsWith(pathFilter + '/') : p === pathFilter);

  for (const c of snapshot.commits) {
    if (from != null && c.t < from) continue;
    if (to != null && c.t >= to) continue;
    if (commitSet && !commitSet.has(c.h)) continue;
    const key = resolveAlias(authorKeyOf(c), aliases);
    if (authorFilter && key !== authorFilter) continue;

    totals.commits++;

    // Per-commit rollups so each object counts a "modification" once per commit.
    let cAdded = 0;
    let cRemoved = 0;
    const cFiles = new Map();
    const cDirs = new Map();

    for (const [p, add, del] of c.c) {
      if (add === 0 && del === 0) continue; // pure rename: no metric impact
      if (!matchesPath(p)) continue;
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

    const arow = authors.get(key) || { name: '', email: key, modifications: 0, churn: 0 };
    arow.name = c.mn || c.an || arow.name; // latest commit's merged name wins
    if (cAdded + cRemoved > 0) arow.modifications++;
    arow.churn += cAdded + cRemoved;
    authors.set(key, arow);
  }

  totals.growth = totals.added - totals.removed;
  totals.churn = totals.added + totals.removed;
  totals.modifications; // already counted
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

module.exports = { aggregate, authorKeyOf, resolveAlias };
