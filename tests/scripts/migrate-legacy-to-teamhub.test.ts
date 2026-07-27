import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../../scripts/migrate-legacy-to-teamhub.js";
import { openDb } from "../../teamhub/db.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "migrate-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("migrate", () => {
  it("imports members/messages from the legacy relay JSON and sprints/tasks/comments from the legacy planner SQLite", () => {
    const relayJsonPath = join(dir, "relay.json");
    writeFileSync(
      relayJsonPath,
      JSON.stringify({
        members: {
          "master-1": { handle: "master-1", role: "master", team_id: "legacy-proj", lastSeen: "2026-01-01T00:00:00.000Z" },
          "dev-A": { handle: "dev-A", role: "developer", team_id: "legacy-proj", lastSeen: "2026-01-01T00:00:00.000Z" },
        },
        mailboxes: {
          "dev-A": [
            { id: "m1", from: "master-1", to: "dev-A", type: "task_assignment", text: "Fix bug", task_ref: "LEGACY-1", ts: "2026-01-01T00:00:00.000Z", read: false },
          ],
        },
      })
    );

    const plannerSqlitePath = join(dir, "planner.sqlite");
    const plannerDb = new Database(plannerSqlitePath);
    plannerDb.exec(`
      CREATE TABLE sprints (id INTEGER PRIMARY KEY, team_id TEXT, name TEXT, start_date TEXT, end_date TEXT, status TEXT, created_at TEXT);
      CREATE TABLE tasks (id INTEGER PRIMARY KEY, team_id TEXT, task_ref TEXT, sprint_id INTEGER, title TEXT, description TEXT, status TEXT, priority TEXT, assignee_handle TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE comments (id INTEGER PRIMARY KEY, task_ref TEXT, author_handle TEXT, text TEXT, created_at TEXT);
    `);
    plannerDb
      .prepare(`INSERT INTO sprints VALUES (1, 'legacy-proj', 'Sprint 1', NULL, NULL, 'active', '2026-01-01T00:00:00.000Z')`)
      .run();
    plannerDb
      .prepare(
        `INSERT INTO tasks VALUES (1, 'legacy-proj', 'LEGACY-1', 1, 'Fix bug', 'desc', 'todo', 'medium', 'dev-A', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      )
      .run();
    plannerDb.prepare(`INSERT INTO comments VALUES (1, 'LEGACY-1', 'master-1', 'Please prioritize', '2026-01-01T00:00:00.000Z')`).run();
    plannerDb.close();

    const teamhubDbPath = join(dir, "teamhub.sqlite");
    const counts = migrate(relayJsonPath, plannerSqlitePath, teamhubDbPath);

    expect(counts).toEqual({ projects: 1, members: 2, messages: 1, sprints: 1, tasks: 1, comments: 1 });

    const teamhub = openDb(teamhubDbPath);
    expect(teamhub.prepare(`SELECT * FROM projects WHERE id = 'legacy-proj'`).get()).toBeTruthy();
    expect(teamhub.prepare(`SELECT * FROM tasks WHERE task_ref = 'LEGACY-1'`).get()).toBeTruthy();
    teamhub.close();
  });
});
