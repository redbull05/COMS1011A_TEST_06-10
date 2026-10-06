'use strict';

/**
 * Repository store.
 *
 * Layout on disk (git-ignored):
 *   data/repos/<id>/meta.json       repository metadata + ingestion status
 *   data/repos/<id>/snapshot.json   parsed metric snapshot (see engine.js)
 *   data/repos/<id>/repo/           the work tree (clone or extracted zip)
 *   data/tmp/                       scratch space for zip uploads / tests
 *
 * Meta files are small and re-read on demand; snapshots are cached in memory
 * after the first load (they can be tens of MB for big repositories).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const REPOS_DIR = path.join(DATA_DIR, 'repos');
const TMP_DIR = path.join(DATA_DIR, 'tmp');

for (const d of [DATA_DIR, REPOS_DIR, TMP_DIR]) fs.mkdirSync(d, { recursive: true });

const snapshots = new Map(); // id -> snapshot

function repoDir(id) {
  return path.join(REPOS_DIR, id);
}
function metaPath(id) {
  return path.join(repoDir(id), 'meta.json');
}
function snapshotPath(id) {
  return path.join(repoDir(id), 'snapshot.json');
}

function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, file);
}

function createRepoDir(id) {
  fs.mkdirSync(repoDir(id), { recursive: true });
}

function getMeta(id) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
  } catch {
    return null;
  }
}

function saveMeta(id, meta) {
  writeJsonAtomic(metaPath(id), meta);
}

/** All repository metas, oldest first. Recovers repos stuck mid-ingestion. */
function loadAll() {
  const out = [];
  let ids = [];
  try {
    ids = fs.readdirSync(REPOS_DIR);
  } catch {
    return out;
  }
  for (const id of ids) {
    if (id.startsWith('.')) continue;
    const meta = getMeta(id);
    if (!meta) continue;
    if (['queued', 'cloning', 'extracting', 'parsing'].includes(meta.status)) {
      meta.status = 'error';
      meta.error = 'ingestion was interrupted by a server restart';
      saveMeta(id, meta);
    }
    out.push(meta);
  }
  return out.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

function getSnapshot(id) {
  if (snapshots.has(id)) return snapshots.get(id);
  const meta = getMeta(id);
  if (!meta || meta.status !== 'ready') return null;
  try {
    const snap = JSON.parse(fs.readFileSync(snapshotPath(id), 'utf8'));
    snapshots.set(id, snap);
    return snap;
  } catch {
    return null;
  }
}

function saveSnapshot(id, snap) {
  writeJsonAtomic(snapshotPath(id), snap);
  snapshots.set(id, snap);
}

function deleteRepo(id) {
  snapshots.delete(id);
  fs.rmSync(repoDir(id), { recursive: true, force: true });
}

module.exports = {
  ROOT,
  DATA_DIR,
  REPOS_DIR,
  TMP_DIR,
  repoDir,
  createRepoDir,
  getMeta,
  saveMeta,
  loadAll,
  getSnapshot,
  saveSnapshot,
  deleteRepo
};
