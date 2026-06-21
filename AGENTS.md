# Project Instructions

- This is a prototype. Do not write catalog/database migrations unless explicitly requested.
- For catalog/schema changes, prefer dropping/resetting prototype data and starting from scratch.
- Catalog deletes are hard deletes. Do not add `deleted_at`/`deletedAt` soft-delete fields or tombstone logic.
- Catalog import speed matters. Do not add catalog secondary indexes unless a measured query path needs them and the import cost is accepted.
