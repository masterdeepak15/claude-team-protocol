import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openDb } from "../../teamhub/db.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "teamhub-db-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("openDb", () => {
  it("creates all expected tables", () => {
    const dbPath = join(dir, "test.sqlite");
    const db = openDb(dbPath);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all()
      .map((r: any) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining(["comments", "members", "messages", "projects", "sprints", "tasks"])
    );
    db.close();
  });

  it("enables WAL journal mode", () => {
    const dbPath = join(dir, "test2.sqlite");
    const db = openDb(dbPath);
    const mode = db.pragma("journal_mode", { simple: true });
    expect(mode).toBe("wal");
    db.close();
  });

  it("migrates a pre-existing members table without a mode column", () => {
    const dbPath = join(dir, "legacy.sqlite");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, key_prefix TEXT NOT NULL, repo_url TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL);
      CREATE TABLE members (handle TEXT PRIMARY KEY, project_id TEXT NOT NULL, role TEXT NOT NULL, status TEXT, last_seen TEXT NOT NULL);
    `);
    legacy.prepare(`INSERT INTO projects VALUES ('p1', 'P1', 'P1', NULL, 'active', '2026-01-01T00:00:00.000Z')`).run();
    legacy.prepare(`INSERT INTO members VALUES ('dev-x', 'p1', 'developer', NULL, '2026-01-01T00:00:00.000Z')`).run();
    legacy.close();

    const migrated = openDb(dbPath);
    const columns = migrated.prepare(`PRAGMA table_info(members)`).all() as Array<{ name: string }>;
    expect(columns.some((c) => c.name === "mode")).toBe(true);
    const row = migrated.prepare(`SELECT mode FROM members WHERE handle = 'dev-x'`).get() as { mode: string };
    expect(row.mode).toBe("manual");
    migrated.close();
  });
});
