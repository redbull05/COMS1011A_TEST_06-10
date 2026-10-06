# RAT - Repo Analysis Tool

Web dashboard that ingests Git repositories and computes software-evolution metrics
for **files, directories, the repository, commit sets and authors**, as specified by
the COMS3011A brief.

## Stack

| Layer     | Choice                                                                 |
| --------- | ---------------------------------------------------------------------- |
| Backend   | JavaScript - Node.js, **zero npm dependencies** (built-in `http` only) |
| Frontend  | JavaScript + CSS (vanilla, no build step) - flat purple/dark-blue theme; Silkscreen headings + Cantarell body (bundled OFL fonts) |
| Storage   | JSON snapshot per repository under `data/`, snapshots cached in memory |
| Git       | Shells out to the system `git` binary (rename detection `-M50%`, mailmap, binary detection) |

Node 18+ and `git` are the only requirements.

## Run

```bash
node server/index.js          # or: npm start
# open http://localhost:3000
```

Environment overrides: `PORT` (default `3000`), `HOST` (default `0.0.0.0`).

Tests:

```bash
npm run verify                # offline: metric correctness suite (hand-computed fixture)
npm run crosscheck            # network: clones cJSON and cross-checks vs raw git
```

## Roadmap (sprint by sprint)

| Sprint | Scope                                                          | Status |
| ------ | -------------------------------------------------------------- | ------ |
| S0     | Scaffold: server serving themed shell, README, .gitignore      | done   |
| S1     | Metric engine (git-log parse) + URL clone ingestion + core API | done   |
| S2     | Zip upload ingestion + multi-repo dashboard (flat purple UI)   | done   |
| S3     | Filtering UI: author, time window, commit set, path drill-down | done   |
| S4     | Author merge: .mailmap done; manual alias UI pending           | partial |
| S5     | Polish: charts, loading/error/empty states, final push         | planned |

## Metric model (from the brief)

- A commit has one (post-mailmap) author, a parent (empty for the initial commit),
  a **committer date**, a file set (binary excluded) and a directory set.
- Objects are identified by path; rename detection at 50% similarity is on:
  a pure rename changes no metrics; a rename+edit is attributed to the new path;
  deletions record removed lines on the old path.
- File: `l+`, `l-`, `growth = l+ - l-`, `churn = l+ + l-`.
- Directory: the same four, summed recursively over immediate children
  (implemented as a prefix rollup, which is equivalent).
- Repository: directory metrics on the root.
- Commit set `H`: sums of the four, plus modifications (commits with churn > 0),
  modification frequency `n/|H|` and churn rate `churn/|H|`.
- Author: modifications, churn and ownership (`author churn / total churn`).

### How it is computed (section C)

- One pass per repository: `git log --no-merges -M50% --use-mailmap --numstat -z`
  with a custom `--pretty=format:` capturing hash, parents, **committer date** and
  both raw and mailmap-mapped author identity, NUL-delimited so paths are exact.
- Binary rows (`-\t-`) are excluded; pure renames (`0/0`) are metric-neutral;
  a rename+edit is attributed to the new path; deletions count removed lines on
  the old path.
- `H` is any commit set (time window, manual list, author, path - S3), a subset
  of `H-bar`, the non-merge commits reachable from HEAD. Manual author aliases
  chain on top of `.mailmap`.

## Ingestion (section B)

Two paths, one pipeline:

1. **Clone from URL** - full (deep) `git clone`, no depth limit.
2. **Zip upload** - extracted after a zip-slip check (absolute / `..` entries are
   rejected), then the nested `.git` root is located automatically (the zip may
   wrap the repo in a folder).

Both then run the same engine pass and record `.mailmap` presence. Ingestion is
asynchronous: the API returns immediately with status `queued`, and the status
moves through `cloning`/`extracting` -> `parsing` -> `ready` | `error` while the
dashboard polls. Repos interrupted by a server restart are flagged as `error`.

## Filtering (S3)

Every metric view can be scoped by any combination of filters (ANDed). The
filters card drives them and all four metric fetches carry the same params, so
responses are cached per filter (one aggregation pass shared by tiles + table):

- **Author** - dropdown of mailmap-merged authors, loaded from the unfiltered
  `/authors` response, plus an "all authors" option. Clicking a row on the
  Authors tab sets it too.
- **Time window** - two date inputs; `from` is inclusive, `to` exclusive
  (Ht / Hi,j semantics), compared against committer dates.
- **Commit set** - multi-select list from `/commits` (hash, date, author) with
  hash/author search; selected hashes are sent csv-encoded.
- **Path** - click any Files / Directories row to drill down (`pathIsDir`
  distinguishes a directory prefix from an exact file); a breadcrumb chip with
  ✕ shows and clears the current path.

A "filters active" indicator lights up while any filter is set, and **Clear
all** resets every control. Object filters do not shrink `|H|` (frequency and
rate stay relative to the full filtered commit set).

## API

| Method | Path                          | Purpose                                  |
| ------ | ----------------------------- | ---------------------------------------- |
| GET    | `/api/health`                 | liveness                                 |
| GET    | `/api/repos`                  | list repositories + ingestion status     |
| POST   | `/api/repos/clone`            | `{ "url": "..." }` -> 202, ingest async  |
| POST   | `/api/repos/upload`           | multipart `.zip` upload -> 202           |
| GET    | `/api/repos/:id`              | one repository's metadata                |
| GET    | `/api/repos/:id/commits`      | commit list for pickers (`h`, `t`, `an`, `ae`, `me`, `a`, `r`) |
| DELETE | `/api/repos/:id`              | remove repo + data                       |
| GET    | `/api/repos/:id/metrics`      | repository totals                        |
| GET    | `/api/repos/:id/files`        | file rows                                |
| GET    | `/api/repos/:id/dirs`         | directory rows                           |
| GET    | `/api/repos/:id/authors`      | author rows                              |

Metric endpoints accept optional filters: `from`, `to`, `commits` (csv hashes),
`path`, `pathIsDir=1`, `author`.

## Testing

- `npm run verify` - 51 offline checks against `tools/make-scratch-repo.sh`, a
  deterministic 10-commit history whose metrics are hand-computed in the test:
  per-commit parse, rename purity, binary exclusion, `.mailmap` merge, all five
  metric categories, the filter semantics (Ht / Hi,j windows, manual commit
  sets, author, path), an independent text-mode re-parse, and proof that the
  zip and clone ingestion paths produce **byte-identical** snapshots to the
  work-tree parse.
- `npm run crosscheck` - network test: deep-clones `DaveGamble/cJSON`, then
  compares totals and the full per-file map against an independent parse and
  the textbook awk one-liner (955 non-merge commits, 46 377 added / 11 211
  removed, 240 files).

## Fonts

Bundled in `public/fonts/` and served locally (no CDN):

- **Silkscreen** (headings, labels, tabs) - SIL Open Font License 1.1,
  `OFL-Silkscreen.txt`.
- **Cantarell** (body text) - SIL Open Font License 1.1, `OFL-Cantarell.txt`.

## Project layout

```
server/          Node backend (zero deps)
  index.js         HTTP server + static files
  api.js           REST endpoints (see above)
  ingest.js        clone / zip ingestion pipeline (section B)
  engine.js        git-log parse -> snapshot (section C)
  metrics.js       five-category aggregation over a commit set
  store.js         repo metadata + snapshot cache on disk
  gitio.js         spawn wrapper for git/unzip (argv arrays, no shell)
  util.js          small helpers (slugify, shortId, round)
public/          Frontend (index.html, styles.css, app.js, fonts/)
tests/           verify.js (offline) + crosscheck-cjson.js (network)
tools/           make-scratch-repo.sh (deterministic test fixture)
data/            Runtime snapshots, cloned repos, temp (git-ignored)
```
