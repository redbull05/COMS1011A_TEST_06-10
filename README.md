# RAT - Repo Analysis Tool

Web dashboard that ingests Git repositories and computes software-evolution metrics
for **files, directories, the repository, commit sets and authors**, as specified by
the COMS3011A brief.

## Stack

| Layer     | Choice                                                                 |
| --------- | ---------------------------------------------------------------------- |
| Backend   | JavaScript - Node.js, **zero npm dependencies** (built-in `http` only) |
| Frontend  | JavaScript + CSS (vanilla, no build step) - purple/blue dark theme     |
| Storage   | JSON snapshot per repository under `data/`, indexed in memory at boot  |
| Git       | Shells out to the system `git` binary (rename detection `-M50%`, mailmap, binary detection) |

Node 18+ and `git` are the only requirements.

## Run

```bash
node server/index.js          # or: npm start
# open http://localhost:3000
```

Environment overrides: `PORT` (default `3000`), `HOST` (default `0.0.0.0`).

## Roadmap (sprint by sprint)

| Sprint | Scope                                                        | Status |
| ------ | ------------------------------------------------------------ | ------ |
| S0     | Scaffold: server serving themed shell, README, .gitignore    | done   |
| S1     | Metric engine (git-log parse) + URL clone ingestion + core API | -    |
| S2     | Zip upload ingestion + multi-repo selector                   | -      |
| S3     | Filtering: time windows, manual commit sets, author, path    | -      |
| S4     | Author merge (.mailmap + manual UI)                          | -      |
| S5     | Polish: charts, loading/error/empty states, final push       | -      |

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

## Project layout

```
server/          Node backend (zero deps)
public/          Frontend (index.html, styles.css, app.js)
data/            Runtime snapshots & cloned repos (git-ignored)
```
