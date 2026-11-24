// SPDX-License-Identifier: MIT
// SQLite access (Node's built-in node:sqlite) and schema migrations.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const MIGRATIONS: string[] = [
  // 1: initial schema
  `
  CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    config_json TEXT NOT NULL,
    config_hash TEXT NOT NULL,
    paused INTEGER NOT NULL DEFAULT 0,
    pause_reason TEXT,
    last_planned_at INTEGER,
    feedback_cursor INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE policy_versions (
    project_id TEXT NOT NULL,
    hash TEXT NOT NULL,
    config_json TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (project_id, hash)
  );

  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    title TEXT NOT NULL,
    objective TEXT NOT NULL,
    non_goals TEXT NOT NULL DEFAULT '[]',
    acceptance TEXT NOT NULL DEFAULT '[]',
    role TEXT NOT NULL DEFAULT 'full-stack',
    kind TEXT NOT NULL DEFAULT 'build',
    priority INTEGER NOT NULL DEFAULT 3,
    risk TEXT NOT NULL DEFAULT 'unknown',
    owned_paths TEXT NOT NULL DEFAULT '[]',
    depends_on TEXT NOT NULL DEFAULT '[]',
    state TEXT NOT NULL,
    state_reason TEXT,
    origin TEXT NOT NULL,
    hypothesis TEXT,
    branch TEXT,
    worktree TEXT,
    base_commit TEXT,
    head_commit TEXT,
    pr_number INTEGER,
    pr_url TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    repair_cycles INTEGER NOT NULL DEFAULT 0,
    last_session_id TEXT,
    lease_owner TEXT,
    lease_expires_at INTEGER,
    lease_generation INTEGER NOT NULL DEFAULT 0,
    notes TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX tasks_project_state ON tasks(project_id, state);

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    task_id TEXT,
    role TEXT NOT NULL,
    status TEXT NOT NULL,
    generation INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    session_id TEXT,
    resumed_session_id TEXT,
    pid INTEGER,
    cwd TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    heartbeat_at INTEGER NOT NULL,
    ended_at INTEGER,
    result_json TEXT,
    result_text TEXT,
    error TEXT,
    cost_usd REAL,
    num_turns INTEGER,
    log_path TEXT
  );
  CREATE INDEX runs_status ON runs(status);
  CREATE INDEX runs_task ON runs(task_id);

  CREATE TABLE decisions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    task_id TEXT,
    blocked_task_ids TEXT NOT NULL DEFAULT '[]',
    kind TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    question TEXT NOT NULL,
    why TEXT NOT NULL DEFAULT '',
    options TEXT NOT NULL DEFAULT '[]',
    recommendation TEXT,
    recommendation_reason TEXT NOT NULL DEFAULT '',
    allow_comment INTEGER NOT NULL DEFAULT 1,
    blocking INTEGER NOT NULL DEFAULT 1,
    priority TEXT NOT NULL DEFAULT 'normal',
    blocked_summary TEXT NOT NULL DEFAULT '',
    continues_summary TEXT NOT NULL DEFAULT '',
    links TEXT NOT NULL DEFAULT '[]',
    artifact_ref TEXT,
    created_by TEXT NOT NULL,
    created_by_run TEXT,
    dedupe_key TEXT,
    deferred_until INTEGER,
    answer_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    answered_at INTEGER
  );
  CREATE INDEX decisions_project_status ON decisions(project_id, status);
  CREATE UNIQUE INDEX decisions_open_dedupe ON decisions(project_id, dedupe_key)
    WHERE status = 'pending' AND dedupe_key IS NOT NULL;

  CREATE TABLE decision_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    decision_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    option_id TEXT,
    comment TEXT,
    actor TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    processed_at INTEGER,
    last_error TEXT
  );
  CREATE INDEX outbox_pending ON outbox(processed_at, id);

  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT,
    task_id TEXT,
    run_id TEXT,
    decision_id TEXT,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    data TEXT,
    at INTEGER NOT NULL
  );
  CREATE INDEX events_project_at ON events(project_id, at);
  CREATE INDEX events_task ON events(task_id);

  CREATE TABLE checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    head_commit TEXT NOT NULL,
    scope TEXT NOT NULL,
    name TEXT NOT NULL,
    command TEXT NOT NULL,
    status TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    output_tail TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX checks_task_head ON checks(task_id, head_commit, scope);

  CREATE TABLE reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    run_id TEXT,
    head_commit TEXT NOT NULL,
    verdict TEXT NOT NULL,
    risk TEXT NOT NULL,
    summary TEXT NOT NULL,
    findings TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX reviews_task_head ON reviews(task_id, head_commit);

  CREATE TABLE feedback (
    external_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    task_id TEXT,
    source TEXT NOT NULL,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    kind TEXT NOT NULL,
    url TEXT,
    created_at INTEGER NOT NULL,
    processed_at INTEGER
  );

  CREATE TABLE inbox_sessions (
    token_hash TEXT PRIMARY KEY,
    csrf TEXT NOT NULL,
    user_agent TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE pairing_codes (
    code_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  `,
  // 2: Web Push subscriptions for the inbox PWA
  `
  CREATE TABLE push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT,
    created_at INTEGER NOT NULL,
    last_ok_at INTEGER,
    failures INTEGER NOT NULL DEFAULT 0
  );
  `,
];

export type DB = DatabaseSync;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

/**
 * Apply pending migrations. Each step re-reads the version inside a write
 * transaction, so two processes opening the database at the same time (the
 * supervisor and a CLI command) never apply the same migration twice.
 */
function migrate(db: DB): void {
  for (;;) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
      const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
      if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
      const version = row?.version ?? 0;
      if (version >= MIGRATIONS.length) {
        db.exec('COMMIT');
        return;
      }
      db.exec(MIGRATIONS[version]);
      db.prepare('UPDATE schema_version SET version = ?').run(version + 1);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
