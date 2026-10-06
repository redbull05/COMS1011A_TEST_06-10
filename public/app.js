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
  sourcesFor: null,
  bucket: 'week',
  timeline: [],
  checkedEmails: new Set()
};

const els = {};
for (const id of [
  'health-status', 'btn-tips', 'repo-select', 'btn-delete', 'repo-meta', 'clone-url', 'btn-clone',
  'zip-file', 'btn-upload', 'banner', 'repo-view', 'tiles', 'tabs', 'table-note',
  'metric-thead', 'metric-tbody', 'table-hint', 'empty-state', 'toast',
  'filters-flag', 'btn-filters-clear', 'filter-author', 'filter-from', 'filter-to',
  'path-chip', 'commits-summary', 'commit-search', 'commits-list',
  'metric-table', 'bucket-switch', 'chart', 'chart-hint',
  'merge-bar', 'merge-hint', 'btn-reset-merges', 'merge-controls', 'merge-into',
  'btn-merge', 'btn-merge-clear'
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
  state.checkedEmails.clear();
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
    const tq = qs ? `${qs}&bucket=${state.bucket}` : `?bucket=${state.bucket}`;
    const [metrics, files, dirs, authors, tl] = await Promise.all([
      api(`/api/repos/${id}/metrics${qs}`),
      api(`/api/repos/${id}/files${qs}`),
      api(`/api/repos/${id}/dirs${qs}`),
      api(`/api/repos/${id}/authors${qs}`),
      api(`/api/repos/${id}/timeline${tq}`)
    ]);
    if (seq !== state.requestSeq) return; // superseded by a newer selection
    state.totals = metrics.totals;
    state.rows = { files: files.rows, dirs: dirs.rows, authors: authors.rows };
    state.timeline = tl.rows || [];
    const valid = new Set(state.rows.authors.map((a) => a.email));
    state.checkedEmails = new Set([...state.checkedEmails].filter((e) => valid.has(e)));
    renderTiles();
    renderChart();
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
  { key: '__check', label: '', type: 'check' },
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
        if (c.type === 'check') {
          const all =
            state.rows.authors.length > 0 &&
            state.rows.authors.every((a) => state.checkedEmails.has(a.email));
          return `<th class="check"><input type="checkbox" id="check-all" aria-label="select all authors" data-tip="Selects every author in this view for merging."${all ? ' checked' : ''} /></th>`;
        }
        const classes = ['sortable'];
        if (NUMERIC.has(c.type)) classes.push('num');
        if (sort.key === c.key) classes.push('sorted');
        const arrow = sort.key === c.key ? `<span class="arrow">${sort.dir === 1 ? '▲' : '▼'}</span>` : '';
        return `<th class="${classes.join(' ')}" data-key="${c.key}" data-tip="Click to sort — first click is high-to-low, click again to flip.">${c.label}${arrow}</th>`;
      })
      .join('') +
    '</tr>';

  // body (rows are clickable: Files/Dirs rows drill into a path, author rows set the author filter)
  const shown = rows.slice(0, MAX_ROWS);
  const rowAttrs = (r) =>
    tab === 'authors'
      ? ` class="clickable" data-author="${escapeHtml(r.email)}" title="Filter by this author" data-tip="Click a row to filter the whole dashboard by that author."`
      : ` class="clickable" data-path="${escapeHtml(r.path)}" data-kind="${tab === 'dirs' ? 'dir' : 'file'}" title="Filter by this path" data-tip="Click a row to drill down into that file or directory."`;
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

  renderMergeBar();
}

function cell(c, r) {
  const v = r[c.key];
  switch (c.type) {
    case 'check':
      return (
        `<td class="check"><input type="checkbox" class="row-check" data-email="${escapeHtml(r.email)}"` +
        ` aria-label="select ${escapeHtml(r.name)}" data-tip="Tick two or more authors, then use Merge into to combine them under one email."${state.checkedEmails.has(r.email) ? ' checked' : ''} /></td>`
      );
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
    state.timeline = [];
    state.checkedEmails.clear();
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

/* ------------------------------------------------------------------ chart */

function fmtBucketLabel(ts, bucket) {
  const d = new Date(ts * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return bucket === 'month' ? `${y}-${m}` : `${m}-${day}`;
}

const MAX_CHART_BUCKETS = 600;

/** Hand-rolled SVG bar chart (zero dependencies): added vs removed per bucket. */
function renderChart() {
  const el = els.chart;
  const all = state.timeline || [];
  if (!all.length) {
    el.innerHTML = '<p class="chart-empty">no commit activity in the current view</p>';
    els['chart-hint'].textContent = '';
    return;
  }
  const cut = all.length > MAX_CHART_BUCKETS ? all.slice(-MAX_CHART_BUCKETS) : all;
  const W = 1040;
  const H = 280;
  const PL = 58;
  const PR = 14;
  const PT = 18;
  const PB = 52;
  const iw = W - PL - PR;
  const ih = H - PT - PB;
  const max = Math.max(1, ...cut.map((r) => Math.max(r.added, r.removed)));
  const top = 4 * Math.ceil(max / 4);
  const n = cut.length;
  const slot = iw / n;
  const barW = Math.max(2, Math.min(16, slot * 0.34));
  const y = (v) => PT + ih * (1 - v / top);

  let g = '';
  for (let i = 0; i <= 4; i++) {
    const v = (top / 4) * i;
    const yy = y(v);
    g += `<line x1="${PL}" y1="${yy.toFixed(1)}" x2="${W - PR}" y2="${yy.toFixed(1)}" stroke="#2b3478" stroke-width="1"${i === 0 ? '' : ' stroke-dasharray="3 5"'} />`;
    g += `<text x="${PL - 8}" y="${(yy + 4).toFixed(1)}" text-anchor="end" class="axis">${fmtInt(v)}</text>`;
  }

  cut.forEach((r, i) => {
    const cx = PL + slot * (i + 0.5);
    const label = fmtBucketLabel(r.start, state.bucket);
    g += `<g><title>${label}: ${fmtInt(r.commits)} commit${r.commits === 1 ? '' : 's'}, +${fmtInt(r.added)} / −${fmtInt(r.removed)}</title>`;
    if (r.added > 0) {
      g += `<rect x="${(cx - barW - 1).toFixed(1)}" y="${y(r.added).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max((r.added / top) * ih, 1).toFixed(1)}" fill="#7c3aed" />`;
    }
    if (r.removed > 0) {
      g += `<rect x="${(cx + 1).toFixed(1)}" y="${y(r.removed).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max((r.removed / top) * ih, 1).toFixed(1)}" fill="#aab2e8" />`;
    }
    g += '</g>';
  });

  const maxLabels = Math.min(8, n);
  for (let k = 0; k < maxLabels; k++) {
    const i = Math.round((k / Math.max(1, maxLabels - 1)) * (n - 1));
    const x = PL + slot * (i + 0.5);
    g += `<text x="${x.toFixed(1)}" y="${H - PB + 22}" text-anchor="middle" class="axis">${fmtBucketLabel(cut[i].start, state.bucket)}</text>`;
  }

  g +=
    `<g transform="translate(${PL}, ${H - 10})">` +
    '<rect x="0" y="-8" width="10" height="10" fill="#7c3aed" /><text x="16" y="1" class="axis">added</text>' +
    '<rect x="90" y="-8" width="10" height="10" fill="#aab2e8" /><text x="106" y="1" class="axis">removed</text>' +
    '</g>';

  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="commit activity chart">${g}</svg>`;
  els['chart-hint'].textContent =
    cut.length < all.length
      ? `showing the most recent ${fmtInt(cut.length)} of ${fmtInt(all.length)} ${state.bucket} buckets`
      : `${fmtInt(all.length)} ${state.bucket} bucket${all.length === 1 ? '' : 's'} · ${fmtInt(all.reduce((s, r) => s + r.commits, 0))} commits`;
}

async function refetchTimeline() {
  if (!state.currentId) return;
  const qs = filterQS();
  const tq = qs ? `${qs}&bucket=${state.bucket}` : `?bucket=${state.bucket}`;
  try {
    const tl = await api(`/api/repos/${encodeURIComponent(state.currentId)}/timeline${tq}`);
    state.timeline = tl.rows || [];
    renderChart();
  } catch (err) {
    showToast(err.message, 'err');
  }
}

/* ------------------------------------------------------------- author merge */

function renderMergeBar() {
  const meta = metaById(state.currentId);
  const aliasCount = meta && meta.aliases ? Object.keys(meta.aliases).length : 0;
  const onAuthors = state.tab === 'authors';
  const checked = state.rows.authors.filter((a) => state.checkedEmails.has(a.email));

  const showHint = onAuthors && aliasCount > 0;
  const showControls = onAuthors && checked.length >= 2;
  els['merge-bar'].classList.toggle('hidden', !(showHint || showControls));
  els['merge-hint'].textContent = showHint
    ? `${aliasCount} email${aliasCount === 1 ? '' : 's'} merged manually`
    : '';
  els['btn-reset-merges'].classList.toggle('hidden', !showHint);
  els['merge-controls'].classList.toggle('hidden', !showControls);
  if (showControls) {
    const prev = els['merge-into'].value;
    const options = checked.slice().sort((x, y2) => y2.churn - x.churn);
    els['merge-into'].innerHTML = options
      .map((a) => `<option value="${escapeHtml(a.email)}">${escapeHtml(a.name)} — ${escapeHtml(a.email)}</option>`)
      .join('');
    if (prev && options.some((a) => a.email === prev)) els['merge-into'].value = prev;
  }
}

/** Refresh metadata, filter sources and metrics after an author merge/reset. */
async function reloadCurrentRepo() {
  if (!state.currentId) return;
  state.sourcesFor = null; // the author list changed: reload the filter dropdown too
  await refreshRepos();
  await loadFilterSources(state.currentId);
  if (state.filter.author && !state.authorOptions.some((a) => a.email === state.filter.author)) {
    state.filter.author = ''; // the filtered author was merged away
    els['filter-author'].value = '';
  }
  await loadRepoData(state.currentId);
}

async function doMerge() {
  const into = els['merge-into'].value;
  const from = [...state.checkedEmails].filter((e) => e !== into);
  if (!into || !from.length) {
    showToast('select at least two different authors', 'err');
    return;
  }
  await withBusy(els['btn-merge'], async () => {
    await api(`/api/repos/${encodeURIComponent(state.currentId)}/authors/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, into })
    });
    state.checkedEmails.clear();
    showToast(`merged ${from.length} email${from.length === 1 ? '' : 's'} into ${into}`);
    await reloadCurrentRepo();
  });
}

async function doResetMerges() {
  if (!window.confirm('Remove all manual author merges for this repository?')) return;
  await withBusy(els['btn-reset-merges'], async () => {
    await api(`/api/repos/${encodeURIComponent(state.currentId)}/authors/reset`, { method: 'POST' });
    state.checkedEmails.clear();
    showToast('manual merges removed');
    await reloadCurrentRepo();
  });
}

/* ------------------------------------------------------------- tips (tutorial)
 *
 * One-time pop-up hints: the first time a control is used (clicked or
 * focused - hovered for the chart), a small popover explains what it does.
 * Seen tips live in localStorage, the header button mutes them and replays
 * the whole tour on the next click.
 */

const TIPS_KEY = 'rat.tips.v1';
const TIP_MS = 9000;

let tipsState = { enabled: true, seen: [] };
try {
  const raw = JSON.parse(localStorage.getItem(TIPS_KEY));
  if (raw && typeof raw === 'object') {
    tipsState = {
      enabled: raw.enabled !== false,
      seen: Array.isArray(raw.seen) ? raw.seen : []
    };
  }
} catch {
  /* private mode / storage disabled: tips stay per-visit */
}

function saveTips() {
  try {
    localStorage.setItem(TIPS_KEY, JSON.stringify(tipsState));
  } catch {
    /* ignore */
  }
}

let tipEl = null;
let tipTimer = null;

function hideTip() {
  clearTimeout(tipTimer);
  tipTimer = null;
  if (tipEl) {
    tipEl.remove();
    tipEl = null;
  }
}

/** Show a tip anchored to `target`; the message doubles as the shown-once key. */
function showTip(target, text) {
  const msg = text || target.getAttribute('data-tip');
  if (!msg || !target.isConnected) return;
  if (tipsState.seen.includes(msg)) return; // seen check first, so a click
  // immediately followed by focusin keeps the tip on screen instead of
  // hiding it again
  hideTip();

  tipsState.seen.push(msg);
  if (tipsState.seen.length > 300) tipsState.seen = tipsState.seen.slice(-300);
  saveTips();

  const pop = document.createElement('div');
  pop.className = 'tip-pop';
  pop.setAttribute('role', 'status');
  const tag = document.createElement('span');
  tag.className = 'tip-tag';
  tag.textContent = 'tip';
  const body = document.createElement('span');
  body.className = 'tip-text';
  body.textContent = msg;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'tip-close';
  close.setAttribute('aria-label', 'Dismiss tip');
  close.textContent = '✕';
  close.addEventListener('click', hideTip);
  pop.append(tag, body, close);
  document.body.appendChild(pop);
  tipEl = pop;

  // place below the target, flip above when there is no room
  const r = target.getBoundingClientRect();
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  const gap = 10;
  let left = r.left + r.width / 2 - pw / 2;
  left = Math.max(10, Math.min(left, window.innerWidth - pw - 10));
  let top = r.bottom + gap;
  if (top + ph > window.innerHeight - 10) {
    top = r.top - ph - gap;
    pop.classList.add('up');
  }
  if (top < 10) {
    top = Math.max(10, r.bottom + gap);
    pop.classList.remove('up');
  }
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
  const ax = Math.max(14, Math.min(r.left + r.width / 2 - left, pw - 14));
  pop.style.setProperty('--ax', `${Math.round(ax)}px`);

  tipTimer = setTimeout(hideTip, TIP_MS);
}

function onTipInteraction(e) {
  if (!tipsState.enabled || !e.target.closest) return;
  const el = e.target.closest('[data-tip]');
  if (el) showTip(el);
}

function onTipHover(e) {
  if (!tipsState.enabled || !e.target.closest) return;
  const el = e.target.closest('[data-tip-hover]');
  if (el) showTip(el);
}

function updateTipsButton() {
  const btn = els['btn-tips'];
  btn.classList.toggle('off', !tipsState.enabled);
  btn.querySelector('.txt').textContent = tipsState.enabled ? 'tips on' : 'tips off';
  btn.setAttribute('aria-pressed', String(tipsState.enabled));
}

function toggleTips() {
  tipsState.enabled = !tipsState.enabled;
  if (tipsState.enabled) {
    tipsState.seen = []; // replay the whole tour from the start
    showToast('tips restored — the tour starts over');
    showTip(els['btn-tips'], 'Tips are on — touch any control to see what it does. Click me again to mute them.');
  } else {
    hideTip();
    showToast('tips muted — click again to restore them');
  }
  saveTips();
  updateTipsButton();
}

function maybeWelcomeTip() {
  if (!tipsState.enabled || tipsState.seen.length) return;
  showTip(
    els['btn-tips'],
    'Welcome to RAT! Short tips pop up the first time you touch a control — click me any time to mute them or replay the tour.'
  );
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

  els['bucket-switch'].addEventListener('click', (e) => {
    const btn = e.target.closest('.bucket');
    if (!btn || btn.dataset.bucket === state.bucket) return;
    state.bucket = btn.dataset.bucket;
    for (const b of els['bucket-switch'].querySelectorAll('.bucket')) {
      b.classList.toggle('active', b === btn);
    }
    refetchTimeline();
  });

  els['metric-table'].addEventListener('change', (e) => {
    const t = e.target;
    if (state.tab !== 'authors' || !t.matches('input[type="checkbox"]')) return;
    if (t.id === 'check-all') {
      const emails = state.rows.authors.map((a) => a.email);
      for (const em of emails) {
        if (t.checked) state.checkedEmails.add(em);
        else state.checkedEmails.delete(em);
      }
      renderTable();
    } else if (t.classList.contains('row-check')) {
      const em = t.dataset.email;
      if (t.checked) state.checkedEmails.add(em);
      else state.checkedEmails.delete(em);
      renderMergeBar();
    }
  });

  els['btn-merge'].addEventListener('click', doMerge);
  els['btn-merge-clear'].addEventListener('click', () => {
    state.checkedEmails.clear();
    renderTable();
  });
  els['btn-reset-merges'].addEventListener('click', doResetMerges);

  els['metric-tbody'].addEventListener('click', (e) => {
    if (e.target.closest('input')) return; // checkbox clicks are not drill-downs
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

  // tutorial tips: first click/focus on any tipped control (hover for the
  // chart). Capture phase: some handlers re-render their target mid-dispatch
  // (the sortable headers rebuild the thead), so the tip must read the
  // element before it is replaced.
  document.addEventListener('click', onTipInteraction, true);
  document.addEventListener('focusin', onTipInteraction, true);
  document.addEventListener('mouseover', onTipHover);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideTip();
  });
  window.addEventListener('scroll', hideTip, true);
  els['btn-tips'].addEventListener('click', toggleTips);
}

async function init() {
  wireEvents();
  updateTipsButton();
  checkHealth();
  try {
    await refreshRepos();
    const first = state.repos.find((r) => r.status === 'ready') || state.repos[state.repos.length - 1];
    if (first) await selectRepo(first.id);
    maybePoll();
  } catch (err) {
    showBanner(`Cannot reach the backend: ${escapeHtml(err.message)}`, 'err');
  }
  maybeWelcomeTip();
}

init();
