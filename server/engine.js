'use strict';

/**
 * RAT metric engine.
 *
 * One `git log` pass per repository produces a "snapshot" of every non-merge
 * commit reachable from HEAD. Git does the hard work for us:
 *   --no-merges        only non-merge commits are measured (H-bar)
 *   -M50%              rename detection at 50% similarity
 *   --numstat -z       added/removed line counts, NUL-delimited pathnames
 *   %aN/%aE            author name/email after .mailmap merging
 *   %an/%ae            raw author name/email (kept for the author-merge UI)
 *
 * Verified output shape (git 2.43, -z mode), per commit:
 *   \x01<H40>\x02<parents>\x02<ct>\x02<an>\x02<ae>\x02<aN>\x02<aE>\n
 *   <added>\t<removed>\t<path>\0                    normal record
 *   -\t-\t<path>\0                                  binary file (excluded)
 *   <added>\t<removed>\t\0<old>\0<new>\0            rename: attributed to <new>
 *   ...followed by one extra \0 before the next \x01.
 *
 * Deletions arrive as `0\t<N>\t<oldpath>` so removed lines land on the old
 * path, and a pure rename arrives as `0\t0\t...` so it changes nothing.
 */

const { runGit } = require('./gitio');

const LOG_FORMAT = '%x01%H%x02%P%x02%ct%x02%an%x02%ae%x02%aN%x02%aE';

const LOG_ARGS = [
  '-c', 'core.quotepath=false',
  'log',
  '--no-merges',
  '-M50%',
  '--use-mailmap',
  '--numstat',
  '-z',
  `--pretty=format:${LOG_FORMAT}`
];

/** All ancestor directories of a path (without the root). */
function dirsOf(p) {
  const out = [];
  let idx = p.indexOf('/');
  while (idx !== -1) {
    out.push(p.slice(0, idx));
    idx = p.indexOf('/', idx + 1);
  }
  return out;
}

function statOf(tok) {
  const parts = tok.split('\t');
  const add = parts[0] === '-' ? null : Number(parts[0]);
  const del = parts[1] === '-' ? null : Number(parts[1]);
  return [add, del];
}

function pushChange(commit, p, add, del) {
  commit.c.push([p, add, del]);
  commit.a += add;
  commit.r += del;
}

/** Parse one commit block (header line + numstat records) of the -z log. */
function parseBlock(block) {
  const nl = block.indexOf('\n');
  const header = nl === -1 ? block : block.slice(0, nl);
  const body = nl === -1 ? '' : block.slice(nl + 1);
  const f = header.split('\x02');

  const commit = {
    h: f[0],                            // hash
    p: f[1] ? f[1].split(' ').filter(Boolean) : [], // parents ([] = initial)
    t: Number(f[2]) || 0,               // committer timestamp (unix seconds)
    an: f[3] || '', ae: f[4] || '',     // raw author (name, email)
    mn: f[5] || f[3] || '',             // mailmap-merged author
    me: (f[6] || f[4] || '').toLowerCase(),
    a: 0, r: 0,                         // per-commit added / removed totals
    c: []                               // [path, added, removed] rows
  };

  const tokens = body.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;

    // Rename / copy stat part: "a\tr\t" followed by old-path and new-path tokens.
    if (/^(\d+|-)\t(\d+|-)\t$/.test(tok)) {
      const newPath = tokens[i + 2] || '';
      i += 2; // consume old + new path tokens
      const [add, del] = statOf(tok);
      if (add !== null && newPath) pushChange(commit, newPath, add, del);
      continue;
    }

    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(tok);
    if (!m) continue; // stray token
    const [add, del] = statOf(tok);
    if (add === null) continue; // binary file -> excluded by Git's detection
    pushChange(commit, m[3], add, del);
  }

  return commit;
}

/**
 * Split the raw log output into commit blocks and parse each one.
 * Chunks that do not start with a 40-hex hash are filename content that
 * happened to contain \x01; they are re-attached to the previous block.
 */
function parseLog(raw) {
  const commits = [];
  let current = null;
  for (const chunk of raw.split('\x01')) {
    if (!chunk) continue;
    if (/^[0-9a-f]{40}\x02/.test(chunk)) {
      if (current !== null) commits.push(parseBlock(current));
      current = chunk;
    } else if (current !== null) {
      current += '\x01' + chunk;
    }
  }
  if (current !== null) commits.push(parseBlock(current));
  commits.reverse(); // oldest first (stable ordering for tests and UI)
  return commits;
}

/** Precomputed object counts shown in the repository list. */
function summarize(commits) {
  const files = new Set();
  const dirs = new Set(['']);
  const authors = new Set();
  for (const c of commits) {
    authors.add(c.me || c.ae);
    for (const [p] of c.c) {
      files.add(p);
      for (const d of dirsOf(p)) dirs.add(d);
    }
  }
  return { commits: commits.length, files: files.size, dirs: dirs.size, authors: authors.size };
}

/**
 * Build the metric snapshot for a work tree.
 * Returns { version, generatedAt, head, shallow, counts, commits }.
 */
async function buildSnapshot(repoDir) {
  const head = await runGit(['rev-parse', 'HEAD'], { cwd: repoDir })
    .then((r) => r.stdout.toString('utf8').trim())
    .catch(() => null); // unborn HEAD: repository without commits

  const shallow = await runGit(['rev-parse', '--is-shallow-repository'], { cwd: repoDir })
    .then((r) => r.stdout.toString('utf8').trim() === 'true')
    .catch(() => false);

  let commits = [];
  if (head) {
    const { stdout } = await runGit(LOG_ARGS, { cwd: repoDir, maxMB: 2048 });
    commits = parseLog(stdout.toString('utf8'));
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    head,
    shallow,
    counts: summarize(commits),
    commits
  };
}

module.exports = { buildSnapshot, parseLog, dirsOf };
