'use strict';

/**
 * Ingestion - section B of the plan.
 *
 * Two ways in, one pipeline out:
 *   URL  -> full (deep) `git clone`                       -> work tree
 *   ZIP  -> secure unzip + find the nested `.git` root    -> work tree
 *
 * Both then run the same engine pass (rename-aware git log -> snapshot) and
 * record `.mailmap` presence. Ingestion runs in the background: the API
 * returns immediately and the UI polls `meta.status` through
 * queued -> cloning/extracting -> parsing -> ready | error.
 */

const fs = require('fs');
const path = require('path');

const store = require('./store');
const engine = require('./engine');
const { runGit, runCommand } = require('./gitio');
const { slugify, shortId } = require('./util');

/** Validate a clone URL (or existing local path, which helps in tests). */
function validateUrl(url) {
  const u = String(url || '').trim();
  if (!u) throw new Error('repository URL is required');
  const looksRemote =
    /^(https?|git|ssh):\/\/\S+$/i.test(u) || /^git@[^\s:]+:\S+$/.test(u) || /^file:\/\/\S+$/i.test(u);
  if (looksRemote) return u;
  if (u.startsWith('/') && fs.existsSync(u)) return u; // local path convenience
  throw new Error(`unsupported repository URL: "${u.slice(0, 120)}"`);
}

function nameFromUrl(url) {
  const clean = String(url).replace(/\/+$/, '').replace(/\.git$/i, '');
  const base = clean.split(/[/:]/).filter(Boolean).pop();
  return base || 'repository';
}

function newId(name) {
  let id = `${slugify(name)}-${shortId()}`;
  while (fs.existsSync(store.repoDir(id))) id = `${slugify(name)}-${shortId()}`;
  return id;
}

/** Create the repository record (status: queued) and its directory. */
async function createRepo({ sourceType, source, name }) {
  const id = newId(name);
  store.createRepoDir(id);
  const meta = {
    id,
    name,
    sourceType, // 'url' | 'zip'
    source,
    status: 'queued',
    error: null,
    createdAt: new Date().toISOString(),
    head: null,
    commitCount: 0,
    counts: null,
    hasMailmap: false,
    shallow: false,
    aliases: {} // manual author merges (S4): { fromEmail: toEmail }, lowercase
  };
  store.saveMeta(id, meta);
  return meta;
}

function setPhase(id, status) {
  const meta = store.getMeta(id);
  if (!meta) return;
  meta.status = status;
  store.saveMeta(id, meta);
}

/** Background wrapper: run a task that resolves to a meta patch. */
function runInBackground(id, task) {
  task()
    .then((patch) => {
      const meta = store.getMeta(id);
      if (!meta) return;
      Object.assign(meta, patch, { status: 'ready', error: null });
      store.saveMeta(id, meta);
      console.log(`[rat] ingestion ${id} ready (${meta.commitCount} commits)`);
    })
    .catch((err) => {
      console.error(`[rat] ingestion ${id} failed:`, err.message);
      const meta = store.getMeta(id) || { id };
      meta.status = 'error';
      meta.error = String((err && err.message) || err).slice(0, 500);
      store.saveMeta(id, meta);
    });
}

/** Shared tail of both ingestion paths: snapshot the work tree. */
async function finalizeIngestion(id, worktreeDir) {
  setPhase(id, 'parsing');
  const hasMailmap = await runGit(['cat-file', '-e', 'HEAD:.mailmap'], { cwd: worktreeDir })
    .then(() => true)
    .catch(() => false);

  const snapshot = await engine.buildSnapshot(worktreeDir);
  store.saveSnapshot(id, snapshot);

  return {
    head: snapshot.head,
    commitCount: snapshot.counts.commits,
    counts: snapshot.counts,
    hasMailmap,
    shallow: snapshot.shallow
  };
}

/** Deep clone (full history - no --depth) and snapshot. */
async function ingestUrl(meta) {
  const dest = path.join(store.repoDir(meta.id), 'repo');
  setPhase(meta.id, 'cloning');
  await runGit(['clone', '--quiet', '--', meta.source, dest], { maxMB: 64 });
  return finalizeIngestion(meta.id, dest);
}

function startUrlIngestion(meta) {
  runInBackground(meta.id, () => ingestUrl(meta));
}

/** Find the folder that contains `.git` (zips usually wrap the repo). */
function findGitRoot(base) {
  const queue = [base];
  while (queue.length) {
    const dir = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.some((e) => e.name === '.git')) return dir;
    for (const e of entries) {
      if (e.isDirectory() && e.name !== '.git' && e.name !== '__MACOSX' && e.name !== 'node_modules') {
        queue.push(path.join(dir, e.name));
      }
    }
  }
  return null;
}

/** Reject entries that would escape the extraction directory (zip-slip). */
async function assertZipIsSafe(zipPath) {
  const { stdout } = await runCommand('unzip', ['-Z1', zipPath], { maxMB: 64 });
  const entries = stdout.toString('utf8').split('\n').filter(Boolean);
  for (const e of entries) {
    const norm = path.normalize(e);
    if (path.isAbsolute(e) || norm.startsWith('..')) {
      throw new Error('the zip contains unsafe (absolute or ..) paths and was rejected');
    }
  }
  return entries.length;
}

/** Extract a zip, locate the nested .git, move it into the repo dir, snapshot. */
async function ingestZip(meta, zipPath) {
  const extractDir = path.join(store.TMP_DIR, `${meta.id}-extract`);
  setPhase(meta.id, 'extracting');
  try {
    fs.mkdirSync(extractDir, { recursive: true });
    await assertZipIsSafe(zipPath);
    await runCommand('unzip', ['-qq', '-o', zipPath, '-d', extractDir], { maxMB: 64 });

    const repoRoot = findGitRoot(extractDir);
    if (!repoRoot) {
      throw new Error('no .git directory found inside the zip - upload the repository including its .git folder');
    }

    const dest = path.join(store.repoDir(meta.id), 'repo');
    fs.renameSync(repoRoot, dest);

    // If the .git root was nested, refuse to proceed without the real repo.
    setPhase(meta.id, 'parsing');
    return await finalizeIngestion(meta.id, dest);
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.rmSync(zipPath, { force: true });
  }
}

function startZipIngestion(meta, zipPath) {
  runInBackground(meta.id, () => ingestZip(meta, zipPath));
}

module.exports = {
  validateUrl,
  nameFromUrl,
  createRepo,
  ingestUrl,
  ingestZip,
  startUrlIngestion,
  startZipIngestion,
  findGitRoot
};
