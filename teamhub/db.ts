import Database from "better-sqlite3";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  repo_url TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  handle TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  role TEXT NOT NULL,
  status TEXT,
  last_seen TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'manual'
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  from_handle TEXT NOT NULL,
  to_handle TEXT NOT NULL,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  task_ref TEXT,
  ts TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sprints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  start_date TEXT,
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_ref TEXT UNIQUE NOT NULL,
  sprint_id INTEGER REFERENCES sprints(id),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'backlog',
  priority TEXT NOT NULL DEFAULT 'medium',
  assignee_handle TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_ref TEXT NOT NULL,
  author_handle TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- One row per finished 'claude -p' cycle (see agents/runner.ts finishCycle).
-- Reported over plain bearer-gated HTTP (POST /api/usage), never over MCP —
-- an MCP tool call here would just add more teamhub context weight to the
-- very sessions this table exists to help shrink.
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  handle TEXT NOT NULL,
  session_id TEXT,
  task_ref TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  num_turns INTEGER,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_events_project ON usage_events(project_id, ts);
CREATE INDEX IF NOT EXISTS idx_usage_events_handle ON usage_events(handle, ts);
CREATE INDEX IF NOT EXISTS idx_usage_events_session ON usage_events(session_id);
`;

function migrate(db: Database.Database): void {
  const memberColumns = db.prepare(`PRAGMA table_info(members)`).all() as Array<{ name: string }>;
  if (!memberColumns.some((c) => c.name === "mode")) {
    db.exec(`ALTER TABLE members ADD COLUMN mode TEXT NOT NULL DEFAULT 'manual'`);
  }
}

// Same convention as stateDir() in cli/teamhub-cli.ts — lives in the user's
// home folder, NOT inside the installed package's dist/ folder. Storing it
// under __dirname was the bug: that path sits inside node_modules for a
// globally-installed package, and npm wipes/recreates that folder on every
// reinstall or upgrade, deleting the database along with it.
function defaultDbPath(): string {
  const dataDir = join(homedir(), ".teamhub");
  mkdirSync(dataDir, { recursive: true });
  return join(dataDir, "teamhub.db.sqlite");
}

export function openDb(path?: string): Database.Database {
  const dbPath = path ?? process.env.TEAMHUB_DB ?? defaultDbPath();
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export const db = openDb();
