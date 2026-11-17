# Project Instructions

- This is a prototype. Do not write catalog/database migrations unless explicitly requested.
- For catalog/schema changes, prefer dropping/resetting prototype data and starting from scratch.
- Catalog deletes are hard deletes. Do not add `deleted_at`/`deletedAt` soft-delete fields or tombstone logic.
- Catalog import speed matters. Do not add catalog secondary indexes unless a measured query path needs them and the import cost is accepted.
- Smoke/dev logs belong under `tmp/smoke-logs/`, which is gitignored. Do not write temporary log files at the repository root.

## Dev Deployment

- Commit completed project changes and push them to `origin/dev`.
- Build the pushed commit with `npm run build` and deploy `dist/` to `dev.zeitfaden.de` using the existing service on `213.133.99.169`.
- Stage the release under `/srv/zeitfaden-dev/site/releases/`, update the `site/current` symlink atomically, and verify the served build over HTTPS.

## Resume After Context Compaction

- Treat the post-compaction summary as the current working state. Do not restart broad environment discovery unless the summary is missing a specific fact needed for the next action.
- Before continuing, run only narrow checks that directly validate the newest request, such as `git status --short`, the named file, or the exact failing test. Avoid rereading large unrelated files or reauditing the whole repo.
- Preserve momentum from the summary: continue from the last described edits, blockers, and verification status instead of reconstructing the entire session history.
- If the summary says a command already passed, do not rerun it just to rediscover the environment. Rerun only when new edits affect that command or when the result is needed for a final answer.
- If unsure whether a detail survived compaction, ask one focused local question with a targeted command or file read rather than doing a full project scan.
