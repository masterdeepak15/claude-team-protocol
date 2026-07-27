import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// One SQLite file, lives on whichever PC runs the planner (same PC as the
// relay is the simplest choice). Everyone else reaches it only through the
// MCP tools below — never opens the file directly.
const DB_PATH = process.env.PLANNER_DB || join(__dirname, "planner.db.sqlite");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS sprints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id TEXT NOT NULL,
    name TEXT NOT NULL,
    start_date TEXT,
    end_date TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id TEXT NOT NULL,
    task_ref TEXT UNIQUE NOT NULL,
    sprint_id INTEGER,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'backlog',
    priority TEXT NOT NULL DEFAULT 'medium',
    assignee_handle TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (sprint_id) REFERENCES sprints(id)
  );

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_ref TEXT NOT NULL,
    author_handle TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

export type TaskStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "blocked";

export interface Task {
  id: number;
  team_id: string;
  task_ref: string;
  sprint_id: number | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: string;
  assignee_handle: string | null;
  created_at: string;
  updated_at: string;
}

export interface Sprint {
  id: number;
  team_id: string;
  name: string;
  start_date: string | null;
  end_date: string | null;
  status: string;
  created_at: string;
}

function now() {
  return new Date().toISOString();
}

function nextTaskRef(team_id: string): string {
  const row = db
    .prepare(
      `SELECT COUNT(*) as n FROM tasks WHERE team_id = ?`
    )
    .get(team_id) as { n: number };
  // Simple, readable, Jira-style ref without needing Jira: TEAM-<n>
  const prefix = team_id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toUpperCase() || "TASK";
  return `${prefix}-${row.n + 1}`;
}

export function createSprint(
  team_id: string,
  name: string,
  start_date?: string,
  end_date?: string
): Sprint {
  const info = db
    .prepare(
      `INSERT INTO sprints (team_id, name, start_date, end_date, status, created_at)
       VALUES (?, ?, ?, ?, 'active', ?)`
    )
    .run(team_id, name, start_date ?? null, end_date ?? null, now());
  return getSprint(info.lastInsertRowid as number)!;
}

export function getSprint(id: number): Sprint | undefined {
  return db.prepare(`SELECT * FROM sprints WHERE id = ?`).get(id) as Sprint | undefined;
}

export function listSprints(team_id: string): Sprint[] {
  return db.prepare(`SELECT * FROM sprints WHERE team_id = ? ORDER BY id DESC`).all(team_id) as Sprint[];
}

export function createTask(
  team_id: string,
  title: string,
  description?: string,
  sprint_id?: number,
  priority: string = "medium"
): Task {
  const task_ref = nextTaskRef(team_id);
  const ts = now();
  db.prepare(
    `INSERT INTO tasks (team_id, task_ref, sprint_id, title, description, status, priority, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'backlog', ?, ?, ?)`
  ).run(team_id, task_ref, sprint_id ?? null, title, description ?? null, priority, ts, ts);
  return getTaskByRef(task_ref)!;
}

export function getTaskByRef(task_ref: string): Task | undefined {
  return db.prepare(`SELECT * FROM tasks WHERE task_ref = ?`).get(task_ref) as Task | undefined;
}

export function listTasks(
  team_id: string,
  filters: { status?: string; assignee_handle?: string; sprint_id?: number } = {}
): Task[] {
  let sql = `SELECT * FROM tasks WHERE team_id = ?`;
  const params: unknown[] = [team_id];
  if (filters.status) {
    sql += ` AND status = ?`;
    params.push(filters.status);
  }
  if (filters.assignee_handle) {
    sql += ` AND assignee_handle = ?`;
    params.push(filters.assignee_handle);
  }
  if (filters.sprint_id !== undefined) {
    sql += ` AND sprint_id = ?`;
    params.push(filters.sprint_id);
  }
  sql += ` ORDER BY id ASC`;
  return db.prepare(sql).all(...params) as Task[];
}

export function updateTaskStatus(
  task_ref: string,
  status: TaskStatus,
  assignee_handle?: string
): Task | undefined {
  const existing = getTaskByRef(task_ref);
  if (!existing) return undefined;
  db.prepare(
    `UPDATE tasks SET status = ?, assignee_handle = COALESCE(?, assignee_handle), updated_at = ? WHERE task_ref = ?`
  ).run(status, assignee_handle ?? null, now(), task_ref);
  return getTaskByRef(task_ref);
}

export function assignTask(task_ref: string, assignee_handle: string): Task | undefined {
  const existing = getTaskByRef(task_ref);
  if (!existing) return undefined;
  db.prepare(
    `UPDATE tasks SET assignee_handle = ?, updated_at = ? WHERE task_ref = ?`
  ).run(assignee_handle, now(), task_ref);
  return getTaskByRef(task_ref);
}

export function addComment(task_ref: string, author_handle: string, text: string) {
  db.prepare(
    `INSERT INTO comments (task_ref, author_handle, text, created_at) VALUES (?, ?, ?, ?)`
  ).run(task_ref, author_handle, text, now());
}

export function listComments(task_ref: string) {
  return db
    .prepare(`SELECT * FROM comments WHERE task_ref = ? ORDER BY id ASC`)
    .all(task_ref);
}
