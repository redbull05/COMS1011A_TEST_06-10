'use strict';

/**
 * RAT dashboard.
 *
 * Wires the whole page: health pill, repository list + selector, clone/zip
 * ingestion (async, polled by status), delete, metric tiles for the selected
 * repository, and sortable Files / Directories / Authors tables.
 *
 * API (see server/api.js):
 *   GET    /api/health
 *   GET    /api/repos
 *   POST   /api/repos/clone      { url }
 *   POST   /api/repos/upload     multipart file
 *   DELETE /api/repos/:id
 *   GET    /api/repos/:id/metrics | /files | /dirs | /authors
 */

const $ = (id) => document.getElementById(id);

const MAX_ROWS = 400;
const MAX_COMMIT_ROWS = 300;
const POLL_MS = 1500;
const ACTIVE_STATUSES = ['queued', 'cloning', 'extracting', 'parsing'];

const STATUS_TEXT = {
  queued: 'queued',
  cloning: 'cloning',
  extracting: 'extracting',
  parsing: 'parsing',
  error: 'failed'
};

const state = {
  repos: [],
  currentId: null,
  tab: 'files',
  totals: null,
  rows: { files: [], dirs: [], authors: [] },
  sort: {
    files: { key: 'churn', dir: -1 },
    dirs: { key: 'churn', dir: -1 },
    authors: { key: 'churn', dir: -1 }
  },
  busy: false,
  pollTimer: null,
  requestSeq: 0,
  filter: { from: null, to: null, commits: [], author: '', path: '', pathIsDir: false },
  commits: [],
  authorOptions: [],
  commitSearch: '',
  sourcesFor: null
};

const els = {};
for (const id of [
  'health-status', 'repo-select', 'btn-delete', 'repo-meta', 'clone-url', 'btn-clone',
  'zip-file', 'btn-upload', 'banner', 'repo-view', 'tiles', 'tabs', 'table-note',
  'metric-thead', 'metric-tbody', 'table-hint', 'empty-state', 'toast',
  'filters-flag', 'btn-filters-clear', 'filter-author', 'filter-from', 'filter-to',
  'path-chip', 'commits-summary', 'commit-search', 'commits-list'
]) {
  els[id] = $(id);
}

/* ------------------------------------------------------------------ utils */

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const fmtInt = (n) => Number(n || 0).toLocaleString('en-US');

function fmtRate(n) {
  const v = Number(n || 0);
  if (!Number.isFinite(v)) return '0';
  return String(Number(v.toFixed(2)));
}

const fmtPct = (n) => `${(Number(n || 0) * 100).toFixed(1)}%`;

const signed = (n) => (n > 0 ? `+${fmtInt(n)}` : fmtInt(n));

async function api(path, opts = {}) {
  const res = await fetch(path, { cache: 'no-store', ...opts });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* empty or non-JSON body */
  }
  if (!res.ok) {
    const err = new Error((body && body.error) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

let toastTimer = null;
function showToast(text, kind = 'ok') {
  els.toast.textContent = text;
  els.toast.className = `toast${kind === 'err' ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 4200);
}

function showBanner(html, kind = 'info') {
  els.banner.innerHTML = html;
  els.banner.className = `banner ${kind}`;
}

function hideBanner() {
  els.banner.className = 'banner hidden';
  els.banner.innerHTML = '';
}

const metaById = (id) => state.repos.find((r) => r.id === id) || null;
const isActive = (meta) => !!meta && ACTIVE_STATUSES.includes(meta.status);

/* ------------------------------------------------------------------ health */

async function checkHealth() {
  const el = els['health-status'];
  try {
    const data = await api('/api/health');
    el.className = 'status ok';
    el.innerHTML = '<span class="dot"></span>backend ok · v' + escapeHtml(data.version);
  } catch {
    el.className = 'status err';
    el.innerHTML = '<span class="dot"></span>backend unreachable';
  }
}

/* ------------------------------------------------------------- repo list */

async function refreshRepos() {
  state.repos = await api('/api/repos');
  renderRepoSelect();
  renderEmptyState();
}

function renderRepoSelect() {
  const sel = els['repo-select'];
  const keep = state.currentId;
  sel.innerHTML = '';

  if (!state.repos.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'no repositories yet';
    sel.appendChild(opt);
    sel.disabled = true;
    els['btn-delete'].disabled = true;
    return;
  }

  sel.disabled = false;
  els['btn-delete'].disabled = false;
  for (const r of state.repos) {
    const opt = document.createElement('option');
    opt.value = r.id;
    const suffix = r.status === 'ready' ? '' : ` — ${STATUS_TEXT[r.status] || r.status}`;
    opt.textContent = `${r.name}${suffix}`;
    sel.appendChild(opt);
  }
  if (keep && metaById(keep)) sel.value = keep;
}

function renderEmptyState() {
  const empty = !state.repos.length;
  els['empty-state'].classList.toggle('hidden', !empty);
  if (empty) els['repo-view'].classList.add('hidden');
}

function renderRepoMeta(meta) {
  const el = els['repo-meta'];
  if (!meta) {
    el.textContent = '';
    return;
  }
  const parts = [];
  if (meta.status === 'ready') {
    parts.push(`<span class="mono">${escapeHtml((meta.head || '').slice(0, 10))}</span>`);
    parts.push(`${fmtInt(meta.commitCount)} non-merge commits`);
    parts.push(`.mailmap ${meta.hasMailmap ? 'yes' : 'no'}`);
    parts.push(meta.shallow ? 'shallow clone' : 'full history');
  } else {
    parts.push(escapeHtml(STATUS_TEXT[meta.status] || meta.status));
  }
  const source = String(meta.source || '');
  parts.push(
    meta.sourceType === 'url'
      ? `cloned from <span class="mono">${escapeHtml(source)}</span>`
      : `uploaded zip <span class="mono">${escapeHtml(source)}</span>`
  );
  el.innerHTML = parts.join('<span class="sep">·</span>');
}

/* --------------------------------------------------------- repo selection */

async function selectRepo(id) {
  state.currentId = id;
  els['repo-select'].value = id;

  const meta = metaById(id);
  renderRepoMeta(meta);
  resetFilters();
  if (!meta) {
    els['repo-view'].classList.add('hidden');
    return;
  }
  if (meta.status === 'ready') {
    els['repo-view'].classList.remove('hidden');
    if (state.sourcesFor !== id) await loadFilterSources(id);
    await loadRepoData(id);
  } else {
    els['repo-view'].classList.add('hidden');
    renderIngestionBanner(meta);
  }
}

function renderIngestionBanner(meta) {
  if (meta.status === 'error') {
    showBanner(`Ingestion of <strong>${escapeHtml(meta.name)}</strong> failed: ${escapeHtml(meta.error || 'unknown error')}`, 'err');
    return;
  }
  const verb = {
    queued: 'Queued',
    cloning: 'Cloning',
    extracting: 'Extracting',
    parsing: 'Running the metric engine on'
  }[meta.status] || 'Processing';
  showBanner(`<span class="spinner"></span>${verb} <strong>${escapeHtml(meta.name)}</strong>… this page updates automatically.`, 'busy');
}

/* ------------------------------------------------------------------ filters */

function filtersActive() {
  const f = state.filter;
  return f.from != null || f.to != null || f.commits.length > 0 || !!f.author || !!f.path;
}

/** Query string shared by all four metric fetches (see parseFilter in api.js). */
function filterQS() {
  const f = state.filter;
  const q = new URLSearchParams();
  if (f.from != null) q.set('from', String(f.from));
  if (f.to != null) q.set('to', String(f.to));
  if (f.commits.length) q.set('commits', f.commits.join(','));
  if (f.author) q.set('author', f.author);
  if (f.path) {
    q.set('path', f.path);
    if (f.pathIsDir) q.set('pathIsDir', '1');
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

function updateFilterFlag() {
  const active = filtersActive();
  els['filters-flag'].classList.toggle('hidden', !active);
  els['btn-filters-clear'].disabled = !active;
}

/** Commit list + full author list, loaded once per repository (unfiltered). */
async function loadFilterSources(id) {
  try {
    const [commits, authors] = await Promise.all([
      api(`/api/repos/${id}/commits`),
      api(`/api/repos/${id}/authors`)
    ]);
    state.commits = commits.commits || [];
    state.authorOptions = authors.rows || [];
    state.sourcesFor = id;
    renderAuthorOptions();
    renderCommitList();
  } catch (err) {
    console.error('[rat] filter sources failed:', err);
  }
}

function renderAuthorOptions() {
  const sel = els['filter-author'];
  sel.innerHTML =
    '<option value="">all authors</option>' +
    state.authorOptions
      .map((a) => `<option value="${escapeHtml(a.email)}">${escapeHtml(a.name)} — ${escapeHtml(a.email)}</option>`)
      .join('');
  sel.value = state.filter.author || '';
}

function renderCommitList() {
  const q = state.commitSearch.trim().toLowerCase();
  const newestFirst = state.commits.slice().reverse();
  const matches = q
    ? newestFirst.filter(
        (c) =>
          c.h.startsWith(q) ||
          String(c.an || '').toLowerCase().includes(q) ||
          String(c.ae || '').toLowerCase().includes(q) ||
          String(c.me || '').toLowerCase().includes(q)
      )
    : newestFirst;

  const shown = matches.slice(0, MAX_COMMIT_ROWS);
  const rows = shown.map(
    (c) =>
      '<label class="commit-row">' +
      `<input type="checkbox" data-h="${c.h}"${state.filter.commits.includes(c.h) ? ' checked' : ''} />` +
      `<span class="h">${c.h.slice(0, 8)}</span>` +
      `<span class="date">${new Date(c.t * 1000).toISOString().slice(0, 10)}</span>` +
      `<span class="who">${escapeHtml(c.an || '')}</span>` +
      '</label>'
  );
  if (matches.length > MAX_COMMIT_ROWS) {
    rows.push(`<div class="commit-row more">showing first ${fmtInt(MAX_COMMIT_ROWS)} of ${fmtInt(matches.length)} — refine the search</div>`);
  }
  els['commits-list'].innerHTML = rows.length ? rows.join('') : '<div class="commit-row more">no commits match</div>';
  els['commits-summary'].textContent = `${state.filter.commits.length} selected`;
}

function renderPathChip() {
  const el = els['path-chip'];
  const f = state.filter;
  if (!f.path) {
    el.className = 'path-chip-empty';
    el.textContent = 'none — click a Files / Directories row to drill down';
    return;
  }
  el.className = 'path-chip';
  el.innerHTML =
    `<span class="mono">${escapeHtml(f.path)}</span>` +
    `<span class="kind">${f.pathIsDir ? 'directory' : 'file'}</span>` +
    '<button type="button" id="btn-path-clear" title="clear the path filter">✕</button>';
  document.getElementById('btn-path-clear').addEventListener('click', () => {
    state.filter.path = '';
    state.filter.pathIsDir = false;
    renderPathChip();
    applyFilters();
  });
}

function setPathFilter(path, isDir) {
  state.filter.path = path;
  state.filter.pathIsDir = !!isDir;
  renderPathChip();
  applyFilters();
}

function resetFilters() {
  state.filter = { from: null, to: null, commits: [], author: '', path: '', pathIsDir: false };
  state.commitSearch = '';
  els['filter-author'].value = '';
  els['filter-from'].value = '';
  els['filter-to'].value = '';
  els['commit-search'].value = '';
  renderPathChip();
  updateFilterFlag();
  renderCommitList();
}

function clearFilters() {
  resetFilters();
  applyFilters();
}

/** Re-fetch the four metric payloads with the current filter applied. */
function applyFilters() {
  updateFilterFlag();
  if (!state.currentId) return;
  const meta = metaById(state.currentId);
  if (meta && meta.status === 'ready') loadRepoData(state.currentId);
}

/* ------------------------------------------------------------ metric data */

async function loadRepoData(id) {
  const seq = ++state.requestSeq;
  hideBanner();
  els['table-note'].textContent = 'loading metrics…';
  els['metric-thead'].innerHTML = '';
  els['metric-tbody'].innerHTML = '';
  try {
    const qs = filterQS();
    const [metrics, files, dirs, authors] = await Promise.all([
      api(`/api/repos/${id}/metrics${qs}`),
      api(`/api/repos/${id}/files${qs}`),
      api(`/api/repos/${id}/dirs${qs}`),
      api(`/api/repos/${id}/authors${qs}`)
    ]);
    if (seq !== state.requestSeq) return; // superseded by a newer selection
    state.totals = metrics.totals;
    state.rows = { files: files.rows, dirs: dirs.rows, authors: authors.rows };
    renderTiles();
    renderTable();
  } catch (err) {
    if (seq !== state.requestSeq) return;
    els['repo-view'].classList.add('hidden');
    showBanner(escapeHtml(err.message), 'err');
  }
}

/* ------------------------------------------------------------------ tiles */

function tile(label, value, sub, cls = '') {
  return (
    `<div class="tile ${cls}">` +
    `<span class="tile-label">${label}</span>` +
    `<span class="tile-value">${value}</span>` +
    (sub ? `<span class="tile-sub">${sub}</span>` : '') +
    '</div>'
  );
}

function renderTiles() {
  const t = state.totals;
  if (!t) {
    els.tiles.innerHTML = '';
    return;
  }
  const growthCls = t.growth > 0 ? 'pos' : t.growth < 0 ? 'neg' : '';
  els.tiles.innerHTML = [
    tile('Commits |H̄|', fmtInt(t.commits), 'non-merge, reachable from HEAD'),
    tile('Added l+', fmtInt(t.added), 'lines added'),
    tile('Removed l−', fmtInt(t.removed), 'lines removed'),
    tile('Growth', `<span class="${growthCls}">${signed(t.growth)}</span>`, 'l+ − l−'),
    tile('Churn', fmtInt(t.churn), 'l+ + l−', 'accent'),
    tile('Modifications', fmtInt(t.modifications), 'commits with churn > 0'),
    tile('Mod frequency', fmtRate(t.modificationFrequency), 'n / |H̄|'),
    tile('Churn rate', fmtRate(t.churnRate), 'λ / |H̄|')
  ].join('');
}

/* ------------------------------------------------------------------ table */

const COLS = {
  files: [
    { key: 'path', label: 'Path', type: 'path' },
    { key: 'added', label: 'Added', type: 'num' },
    { key: 'removed', label: 'Removed', type: 'num' },
    { key: 'growth', label: 'Growth', type: 'signed' },
    { key: 'churn', label: 'Churn', type: 'num' },
    { key: 'modifications', label: 'Mods', type: 'num' },
    { key: 'modificationFrequency', label: 'Mod freq', type: 'rate' },
    { key: 'churnRate', label: 'Churn rate', type: 'rate' }
  ]
};
COLS.dirs = COLS.files;
COLS.authors = [
  { key: 'name', label: 'Author', type: 'name' },
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'modifications', label: 'Mods', type: 'num' },
  { key: 'churn', label: 'Churn', type: 'num' },
  { key: 'ownership', label: 'Ownership', type: 'own' }
];

const NUMERIC = new Set(['num', 'signed', 'rate', 'own']);

function renderTable() {
  const tab = state.tab;
  const cols = COLS[tab];
  const sort = state.sort[tab];
  const all = state.rows[tab] || [];

  const rows = all.slice().sort((a, b) => {
    const x = a[sort.key];
    const y = b[sort.key];
    const cmp = typeof x === 'string' ? String(x).localeCompare(String(y)) : (x || 0) - (y || 0);
    return cmp * sort.dir;
  });

  // header
  els['metric-thead'].innerHTML =
    '<tr>' +
    cols
      .map((c) => {
        const classes = ['sortable'];
        if (NUMERIC.has(c.type)) classes.push('num');
        if (sort.key === c.key) classes.push('sorted');
        const arrow = sort.key === c.key ? `<span class="arrow">${sort.dir === 1 ? '▲' : '▼'}</span>` : '';
        return `<th class="${classes.join(' ')}" data-key="${c.key}">${c.label}${arrow}</th>`;
      })
      .join('') +
    '</tr>';

  // body (rows are clickable: Files/Dirs rows drill into a path, author rows set the author filter)
  const shown = rows.slice(0, MAX_ROWS);
  const rowAttrs = (r) =>
    tab === 'authors'
      ? ` class="clickable" data-author="${escapeHtml(r.email)}" title="Filter by this author"`
      : ` class="clickable" data-path="${escapeHtml(r.path)}" data-kind="${tab === 'dirs' ? 'dir' : 'file'}" title="Filter by this path"`;
  els['metric-tbody'].innerHTML = shown.map((r) => `<tr${rowAttrs(r)}>${cols.map((c) => cell(c, r)).join('')}</tr>`).join('');

  // notes
  const sortCol = cols.find((c) => c.key === sort.key);
  els['table-note'].innerHTML =
    `${fmtInt(all.length)} ${tab === 'files' ? 'files' : tab === 'dirs' ? 'directories' : 'authors'}` +
    `<span class="sep" style="color:var(--faint)"> · sorted by ${escapeHtml(sortCol ? sortCol.label : sort.key)} ${sort.dir === 1 ? 'asc' : 'desc'}</span>`;

  els['table-hint'].textContent =
    all.length > MAX_ROWS
      ? `Showing the first ${fmtInt(MAX_ROWS)} of ${fmtInt(all.length)} rows — click a column header to re-sort.`
      : '';
}

function cell(c, r) {
  const v = r[c.key];
  switch (c.type) {
    case 'path': {
      const p = String(v || '');
      const cut = p.lastIndexOf('/');
      const dir = cut === -1 ? '' : p.slice(0, cut + 1);
      const file = cut === -1 ? p : p.slice(cut + 1);
      return `<td class="path">${dir ? `<span class="dir">${escapeHtml(dir)}</span>` : ''}<span class="file">${escapeHtml(file)}</span></td>`;
    }
    case 'num':
      return `<td class="num">${fmtInt(v)}</td>`;
    case 'signed': {
      const cls = v > 0 ? 'pos' : v < 0 ? 'neg' : '';
      return `<td class="num"><span class="${cls}">${signed(v)}</span></td>`;
    }
    case 'rate':
      return `<td class="num">${fmtRate(v)}</td>`;
    case 'name':
      return `<td class="name">${escapeHtml(v)}</td>`;
    case 'email':
      return `<td class="email">${escapeHtml(v)}</td>`;
    case 'own': {
      const pct = Math.max(0, Math.min(100, Number(v || 0) * 100));
      return (
        `<td class="num">` +
        `<span class="own-bar"><span class="own-fill" style="width:${pct.toFixed(1)}%"></span></span>` +
        `${fmtPct(v)}</td>`
      );
    }
    default:
      return `<td>${escapeHtml(String(v == null ? '' : v))}</td>`;
  }
}

/* ---------------------------------------------------------------- actions */

async function withBusy(btn, fn) {
  if (state.busy) return;
  state.busy = true;
  btn.disabled = true;
  try {
    await fn();
  } catch (err) {
    showToast(err.message, 'err');
    console.error('[rat]', err);
  } finally {
    state.busy = false;
    btn.disabled = false;
    syncDeleteButton();
  }
}

function syncDeleteButton() {
  els['btn-delete'].disabled = !state.currentId || !state.repos.length;
}

async function doClone() {
  const url = els['clone-url'].value.trim();
  if (!url) {
    showToast('enter a repository URL first', 'err');
    return;
  }
  await withBusy(els['btn-clone'], async () => {
    const meta = await api('/api/repos/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    els['clone-url'].value = '';
    showToast(`cloning ${meta.name}…`);
    await refreshRepos();
    await selectRepo(meta.id);
    maybePoll();
  });
}

async function doUpload() {
  const input = els['zip-file'];
  const file = input.files && input.files[0];
  if (!file) {
    showToast('choose a .zip file first', 'err');
    return;
  }
  await withBusy(els['btn-upload'], async () => {
    const fd = new FormData();
    fd.append('file', file, file.name);
    const meta = await api('/api/repos/upload', { method: 'POST', body: fd });
    input.value = '';
    showToast(`uploading ${meta.name}…`);
    await refreshRepos();
    await selectRepo(meta.id);
    maybePoll();
  });
}

async function doDelete() {
  const meta = metaById(state.currentId);
  if (!meta) return;
  if (!window.confirm(`Remove "${meta.name}" and all of its data?`)) return;
  await withBusy(els['btn-delete'], async () => {
    await api(`/api/repos/${encodeURIComponent(meta.id)}`, { method: 'DELETE' });
    showToast(`removed ${meta.name}`);
    state.currentId = null;
    state.totals = null;
    state.rows = { files: [], dirs: [], authors: [] };
    state.commits = [];
    state.authorOptions = [];
    state.sourcesFor = null;
    els['repo-view'].classList.add('hidden');
    hideBanner();
    renderRepoMeta(null);
    await refreshRepos();
    const next = state.repos[state.repos.length - 1];
    if (next) await selectRepo(next.id);
  });
}

/* ------------------------------------------------------------------ poll */

function maybePoll() {
  clearTimeout(state.pollTimer);
  if (!state.repos.some((r) => isActive(r)) && !state.busy) return;
  state.pollTimer = setTimeout(async () => {
    try {
      const current = metaById(state.currentId);
      const wasActive = isActive(current);
      await refreshRepos();
      const now = metaById(state.currentId);
      if (wasActive && now && now.status === 'ready') {
        showToast(`${now.name} is ready`);
        await selectRepo(now.id);
      } else if (wasActive && now && now.status === 'error') {
        renderRepoMeta(now);
        renderIngestionBanner(now);
      }
    } catch {
      /* server briefly unreachable - keep polling */
    }
    maybePoll();
  }, POLL_MS);
}

/* ------------------------------------------------------------------ init */

function wireEvents() {
  els['btn-clone'].addEventListener('click', doClone);
  els['clone-url'].addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doClone();
  });
  els['btn-upload'].addEventListener('click', doUpload);
  els['btn-delete'].addEventListener('click', doDelete);

  els['repo-select'].addEventListener('change', (e) => {
    selectRepo(e.target.value);
  });

  els['btn-filters-clear'].addEventListener('click', clearFilters);

  els['filter-author'].addEventListener('change', (e) => {
    state.filter.author = e.target.value;
    applyFilters();
  });

  for (const [id, key] of [
    ['filter-from', 'from'],
    ['filter-to', 'to']
  ]) {
    els[id].addEventListener('change', (e) => {
      const v = e.target.value;
      const ts = v ? Math.floor(Date.parse(`${v}T00:00:00Z`) / 1000) : null;
      state.filter[key] = Number.isFinite(ts) ? ts : null;
      applyFilters();
    });
  }

  els['commit-search'].addEventListener('input', (e) => {
    state.commitSearch = e.target.value;
    renderCommitList();
  });

  els['commits-list'].addEventListener('change', (e) => {
    const cb = e.target.closest('input[type="checkbox"][data-h]');
    if (!cb) return;
    const set = new Set(state.filter.commits);
    if (cb.checked) set.add(cb.dataset.h);
    else set.delete(cb.dataset.h);
    state.filter.commits = [...set];
    els['commits-summary'].textContent = `${state.filter.commits.length} selected`;
    applyFilters();
  });

  els['metric-tbody'].addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-path]');
    if (row) {
      setPathFilter(row.dataset.path, row.dataset.kind === 'dir');
      return;
    }
    const authorRow = e.target.closest('tr[data-author]');
    if (authorRow) {
      state.filter.author = authorRow.dataset.author;
      els['filter-author'].value = authorRow.dataset.author;
      applyFilters();
    }
  });

  els.tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    state.tab = btn.dataset.tab;
    for (const t of els.tabs.querySelectorAll('.tab')) t.classList.toggle('active', t === btn);
    renderTable();
  });

  els['metric-thead'].addEventListener('click', (e) => {
    const th = e.target.closest('th[data-key]');
    if (!th) return;
    const key = th.dataset.key;
    const sort = state.sort[state.tab];
    if (sort.key === key) {
      sort.dir = -sort.dir;
    } else {
      const col = COLS[state.tab].find((c) => c.key === key);
      sort.key = key;
      sort.dir = NUMERIC.has(col && col.type) ? -1 : 1;
    }
    renderTable();
  });
}

async function init() {
  wireEvents();
  checkHealth();
  try {
    await refreshRepos();
    const first = state.repos.find((r) => r.status === 'ready') || state.repos[state.repos.length - 1];
    if (first) await selectRepo(first.id);
    maybePoll();
  } catch (err) {
    showBanner(`Cannot reach the backend: ${escapeHtml(err.message)}`, 'err');
  }
}

init();
