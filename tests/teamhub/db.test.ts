import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
