# Unified TeamHub MCP, Multi-Project Planner, Windows Support & Skills Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing `relay` + `planner` MCP servers with one `teamhub` MCP server backed by one SQLite file, add first-class multi-project support, replace the bash-only agent scripts with a cross-platform Node runner, document the human-driven interactive kickoff flow, and ship a skills-authoring guide plus a new example skill.

**Architecture:** One Node/TypeScript package `teamhub/` exposes a single `McpServer` over one HTTP port, with domain modules (`projects`, `members`, `messaging`, `sprints`, `tasks`) each owning their own SQLite tables and MCP tools, wired together in `server.ts`. `agents/runner.ts` is a cross-platform CLI replacing the bash loops for unattended operation; interactive human-driven sessions use plain `claude` with updated skills. A migration script moves data from the old `relay`/`planner` stores into the new schema.

**Tech Stack:** TypeScript (ESM), `@modelcontextprotocol/sdk`, `express`, `better-sqlite3`, `zod`, Node's built-in `node:child_process`/`node:test` or `vitest` for tests.

## Global Constraints

- Node/TS project, ESM modules (`"type": "module"` in package.json) — matches existing `tsconfig.json`/`package.json`.
- Dependencies already pinned in `package.json`: `@modelcontextprotocol/sdk` ^1.29.0, `better-sqlite3` ^11.0.0, `express` ^5.2.1, `zod` ^4.4.3 — do not introduce alternate libraries for the same purpose.
- Storage is a single SQLite file per the approved design — no Postgres, no second storage engine.
- `team_id` is renamed to `project_id` everywhere (tool params, env vars, skill text) — no backward-compat alias.
- No git/tooling automation is built for developers — Claude Code's existing Read/Edit/Bash tools plus each machine's pre-installed git are used as-is.
- No auth/access control is added — same trust model as today (LAN/office).
- Every tool handler returns `{ isError: true, content: [...] }` on failure instead of throwing raw errors to the MCP client.
- SQLite connections use WAL mode + a `busy_timeout` pragma.

---

### Task 1: TeamHub schema and DB connection

**Files:**
- Create: `teamhub/db.ts`
- Test: `tests/teamhub/db.test.ts`

**Interfaces:**
- Produces: `openDb(path?: string): Database.Database` (opens/creates the schema at `path`, defaulting to `TEAMHUB_DB` env var or `teamhub/teamhub.db.sqlite`), `db: Database.Database` (module-level singleton opened via `openDb()`), `SCHEMA: string` (the raw DDL, exported for the migration script and tests).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/teamhub/db.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/teamhub/db.test.ts`
Expected: FAIL — `Cannot find module '../../teamhub/db.js'` (file doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

```typescript
// teamhub/db.ts
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  last_seen TEXT NOT NULL
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
`;

export function openDb(path?: string): Database.Database {
  const dbPath = path ?? process.env.TEAMHUB_DB ?? join(__dirname, "teamhub.db.sqlite");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
}

export const db = openDb();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/teamhub/db.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add teamhub/db.ts tests/teamhub/db.test.ts
git commit -m "feat(teamhub): add unified schema and DB connection"
```

---

### Task 2: Projects module (`create_project`, `list_projects`, `get_project`)

**Files:**
- Create: `teamhub/projects.ts`
- Test: `tests/teamhub/projects.test.ts`

**Interfaces:**
- Consumes: `db` from `teamhub/db.ts` (module-level singleton, or pass an explicit `Database.Database` — this module uses the singleton `db` import, matching Task 1).
- Produces: `interface Project { id: string; name: string; key_prefix: string; repo_url: string | null; status: string; created_at: string }`, `createProject(id: string, name: string, key_prefix: string, repo_url?: string): Project`, `getProject(id: string): Project | undefined`, `listProjects(): Project[]`, `registerTools(server: McpServer): void`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/teamhub/projects.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../../teamhub/db.js";

process.env.TEAMHUB_DB = ":memory:";

describe("projects module", () => {
  beforeEach(() => {
    // Each test gets a fresh in-memory DB by re-requiring is not trivial in ESM,
    // so tests exercise the module's own exported functions directly against
    // the shared singleton and use unique ids per test to avoid collisions.
  });

  it("creates and retrieves a project", async () => {
    const { createProject, getProject } = await import("../../teamhub/projects.js");
    const project = createProject("proj-a", "Project A", "PROJA");
    expect(project.id).toBe("proj-a");
    expect(project.key_prefix).toBe("PROJA");
    expect(getProject("proj-a")).toEqual(project);
  });

  it("lists all created projects", async () => {
    const { createProject, listProjects } = await import("../../teamhub/projects.js");
    createProject("proj-b", "Project B", "PROJB");
    const all = listProjects();
    expect(all.some((p) => p.id === "proj-b")).toBe(true);
  });

  it("returns undefined for an unknown project", async () => {
    const { getProject } = await import("../../teamhub/projects.js");
    expect(getProject("does-not-exist")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/teamhub/projects.test.ts`
Expected: FAIL — `Cannot find module '../../teamhub/projects.js'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// teamhub/projects.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "./db.js";

export interface Project {
  id: string;
  name: string;
  key_prefix: string;
  repo_url: string | null;
  status: string;
  created_at: string;
}

function now(): string {
  return new Date().toISOString();
}

export function createProject(
  id: string,
  name: string,
  key_prefix: string,
  repo_url?: string
): Project {
  db.prepare(
    `INSERT INTO projects (id, name, key_prefix, repo_url, status, created_at)
     VALUES (?, ?, ?, ?, 'active', ?)`
  ).run(id, name, key_prefix, repo_url ?? null, now());
  return getProject(id)!;
}

export function getProject(id: string): Project | undefined {
  return db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as Project | undefined;
}

export function listProjects(): Project[] {
  return db.prepare(`SELECT * FROM projects ORDER BY created_at DESC`).all() as Project[];
}

export function registerTools(server: McpServer): void {
  server.tool(
    "create_project",
    "Create a new project (or return the existing one if the id is already taken). Every other tool scopes its data by project_id.",
    {
      id: z.string().describe("Unique project slug, e.g. 'bts-project'"),
      name: z.string(),
      key_prefix: z.string().describe("Short prefix used for task refs, e.g. 'BTS'"),
      repo_url: z.string().optional(),
    },
    async ({ id, name, key_prefix, repo_url }) => {
      try {
        const existing = getProject(id);
        const project = existing ?? createProject(id, name, key_prefix, repo_url);
        return { content: [{ type: "text", text: JSON.stringify(project, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );

  server.tool("list_projects", "List all known projects.", {}, async () => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(listProjects(), null, 2) }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: String(err) }] };
    }
  });

  server.tool(
    "get_project",
    "Get a single project's details by id.",
    { id: z.string() },
    async ({ id }) => {
      try {
        const project = getProject(id);
        if (!project) {
          return { isError: true, content: [{ type: "text", text: `No project found for ${id}` }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(project, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/teamhub/projects.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add teamhub/projects.ts tests/teamhub/projects.test.ts
git commit -m "feat(teamhub): add projects module and tools"
```

---

### Task 3: Members module (`register`, `list_team`)

**Files:**
- Create: `teamhub/members.ts`
- Test: `tests/teamhub/members.test.ts`

**Interfaces:**
- Consumes: `db` from `teamhub/db.ts`.
- Produces: `interface Member { handle: string; project_id: string; role: "master" | "developer"; status: string | null; last_seen: string }`, `registerMember(handle: string, project_id: string, role: "master" | "developer"): Member`, `getMember(handle: string): Member | undefined`, `listTeam(project_id: string): Member[]`, `touchMember(handle: string): void`, `setMemberStatus(handle: string, status: string): void`, `registerTools(server: McpServer): void`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/teamhub/members.test.ts
import { describe, it, expect } from "vitest";

process.env.TEAMHUB_DB = ":memory:";

describe("members module", () => {
  it("registers a member and retrieves it", async () => {
    const { registerMember, getMember } = await import("../../teamhub/members.js");
    const member = registerMember("dev-x", "proj-members-a", "developer");
    expect(member.handle).toBe("dev-x");
    expect(member.role).toBe("developer");
    expect(getMember("dev-x")?.project_id).toBe("proj-members-a");
  });

  it("re-registering the same handle updates its project/role", async () => {
    const { registerMember, getMember } = await import("../../teamhub/members.js");
    registerMember("dev-y", "proj-members-a", "developer");
    registerMember("dev-y", "proj-members-b", "master");
    const member = getMember("dev-y");
    expect(member?.project_id).toBe("proj-members-b");
    expect(member?.role).toBe("master");
  });

  it("lists only members of the given project", async () => {
    const { registerMember, listTeam } = await import("../../teamhub/members.js");
    registerMember("dev-z1", "proj-members-c", "developer");
    registerMember("dev-z2", "proj-members-d", "developer");
    const team = listTeam("proj-members-c");
    expect(team.map((m) => m.handle)).toContain("dev-z1");
    expect(team.map((m) => m.handle)).not.toContain("dev-z2");
  });

  it("setMemberStatus updates status", async () => {
    const { registerMember, setMemberStatus, getMember } = await import("../../teamhub/members.js");
    registerMember("dev-z3", "proj-members-e", "developer");
    setMemberStatus("dev-z3", "blocked");
    expect(getMember("dev-z3")?.status).toBe("blocked");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/teamhub/members.test.ts`
Expected: FAIL — `Cannot find module '../../teamhub/members.js'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// teamhub/members.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "./db.js";

export interface Member {
  handle: string;
  project_id: string;
  role: "master" | "developer";
  status: string | null;
  last_seen: string;
}

function now(): string {
  return new Date().toISOString();
}

export function registerMember(
  handle: string,
  project_id: string,
  role: "master" | "developer"
): Member {
  const ts = now();
  db.prepare(
    `INSERT INTO members (handle, project_id, role, status, last_seen)
     VALUES (?, ?, ?, NULL, ?)
     ON CONFLICT(handle) DO UPDATE SET
       project_id = excluded.project_id,
       role = excluded.role,
       last_seen = excluded.last_seen`
  ).run(handle, project_id, role, ts);
  return getMember(handle)!;
}

export function getMember(handle: string): Member | undefined {
  return db.prepare(`SELECT * FROM members WHERE handle = ?`).get(handle) as Member | undefined;
}

export function listTeam(project_id: string): Member[] {
  return db
    .prepare(`SELECT * FROM members WHERE project_id = ?`)
    .all(project_id) as Member[];
}

export function touchMember(handle: string): void {
  db.prepare(`UPDATE members SET last_seen = ? WHERE handle = ?`).run(now(), handle);
}

export function setMemberStatus(handle: string, status: string): void {
  db.prepare(`UPDATE members SET status = ?, last_seen = ? WHERE handle = ?`).run(
    status,
    now(),
    handle
  );
}

export function registerTools(server: McpServer): void {
  server.tool(
    "register",
    "Register this session under a handle (e.g. 'master-1', 'dev-A') and role for a project, so other team members can reach it by name. Call this once at the start of a session.",
    {
      handle: z.string().describe("Unique short name for this session, e.g. dev-A"),
      role: z.enum(["master", "developer"]),
      project_id: z.string().describe("Project identifier shared by the whole team"),
    },
    async ({ handle, role, project_id }) => {
      try {
        const member = registerMember(handle, project_id, role);
        return {
          content: [
            { type: "text", text: `Registered ${member.handle} as ${member.role} on project ${member.project_id}.` },
          ],
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );

  server.tool(
    "list_team",
    "List all registered members of a project and their last known status.",
    { project_id: z.string() },
    async ({ project_id }) => {
      try {
        return { content: [{ type: "text", text: JSON.stringify(listTeam(project_id), null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/teamhub/members.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add teamhub/members.ts tests/teamhub/members.test.ts
git commit -m "feat(teamhub): add members module and tools"
```

---

### Task 4: Messaging module (`notify_assignment`, `send_message`, `check_inbox`, `report_status`)

**Files:**
- Create: `teamhub/messaging.ts`
- Test: `tests/teamhub/messaging.test.ts`

**Interfaces:**
- Consumes: `db` from `teamhub/db.ts`; `setMemberStatus`, `touchMember` from `teamhub/members.ts` (as defined in Task 3).
- Produces: `interface Message { id: string; project_id: string; from_handle: string; to_handle: string; type: "task_assignment" | "message" | "status_update"; text: string; task_ref?: string; ts: string; read: boolean }`, `notifyAssignment(project_id: string, from_handle: string, to_handle: string, task_ref: string, summary: string): Message`, `sendMessage(project_id: string, from_handle: string, to_handle: string, text: string): Message`, `reportStatus(project_id: string, from_handle: string, task_ref: string, status: string, note: string): Message`, `checkInbox(handle: string): Message[]`, `registerTools(server: McpServer): void`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/teamhub/messaging.test.ts
import { describe, it, expect } from "vitest";

process.env.TEAMHUB_DB = ":memory:";

describe("messaging module", () => {
  it("notifyAssignment lands in the recipient's inbox as task_assignment", async () => {
    const { notifyAssignment, checkInbox } = await import("../../teamhub/messaging.js");
    notifyAssignment("proj-msg-a", "master-1", "dev-A", "PROJ-1", "Fix the bug");
    const inbox = checkInbox("dev-A");
    expect(inbox).toHaveLength(1);
    expect(inbox[0].type).toBe("task_assignment");
    expect(inbox[0].task_ref).toBe("PROJ-1");
  });

  it("checkInbox only returns unread messages, and marks them read", async () => {
    const { sendMessage, checkInbox } = await import("../../teamhub/messaging.js");
    sendMessage("proj-msg-b", "master-1", "dev-B", "hello");
    const first = checkInbox("dev-B");
    expect(first).toHaveLength(1);
    const second = checkInbox("dev-B");
    expect(second).toHaveLength(0);
  });

  it("reportStatus routes to the project's registered master", async () => {
    const { registerMember } = await import("../../teamhub/members.js");
    const { reportStatus, checkInbox } = await import("../../teamhub/messaging.js");
    registerMember("master-2", "proj-msg-c", "master");
    reportStatus("proj-msg-c", "dev-C", "PROJ-2", "blocked", "waiting on API keys");
    const inbox = checkInbox("master-2");
    expect(inbox).toHaveLength(1);
    expect(inbox[0].type).toBe("status_update");
    expect(inbox[0].text).toBe("[blocked] waiting on API keys");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/teamhub/messaging.test.ts`
Expected: FAIL — `Cannot find module '../../teamhub/messaging.js'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// teamhub/messaging.ts
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "./db.js";
import { setMemberStatus, touchMember } from "./members.js";

export interface Message {
  id: string;
  project_id: string;
  from_handle: string;
  to_handle: string;
  type: "task_assignment" | "message" | "status_update";
  text: string;
  task_ref?: string;
  ts: string;
  read: boolean;
}

function now(): string {
  return new Date().toISOString();
}

function insertMessage(msg: Message): void {
  db.prepare(
    `INSERT INTO messages (id, project_id, from_handle, to_handle, type, text, task_ref, ts, read)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).run(msg.id, msg.project_id, msg.from_handle, msg.to_handle, msg.type, msg.text, msg.task_ref ?? null, msg.ts);
}

function rowToMessage(row: any): Message {
  return { ...row, read: Boolean(row.read), task_ref: row.task_ref ?? undefined };
}

export function notifyAssignment(
  project_id: string,
  from_handle: string,
  to_handle: string,
  task_ref: string,
  summary: string
): Message {
  const msg: Message = {
    id: randomUUID(),
    project_id,
    from_handle,
    to_handle,
    type: "task_assignment",
    text: summary,
    task_ref,
    ts: now(),
    read: false,
  };
  insertMessage(msg);
  return msg;
}

export function sendMessage(
  project_id: string,
  from_handle: string,
  to_handle: string,
  text: string
): Message {
  const msg: Message = {
    id: randomUUID(),
    project_id,
    from_handle,
    to_handle,
    type: "message",
    text,
    ts: now(),
    read: false,
  };
  insertMessage(msg);
  return msg;
}

export function reportStatus(
  project_id: string,
  from_handle: string,
  task_ref: string,
  status: string,
  note: string
): Message {
  setMemberStatus(from_handle, status);
  const master = db
    .prepare(`SELECT handle FROM members WHERE project_id = ? AND role = 'master' LIMIT 1`)
    .get(project_id) as { handle: string } | undefined;
  const msg: Message = {
    id: randomUUID(),
    project_id,
    from_handle,
    to_handle: master ? master.handle : "master",
    type: "status_update",
    text: `[${status}] ${note}`,
    task_ref,
    ts: now(),
    read: false,
  };
  insertMessage(msg);
  return msg;
}

export function checkInbox(handle: string): Message[] {
  const rows = db
    .prepare(`SELECT * FROM messages WHERE to_handle = ? AND read = 0 ORDER BY ts ASC`)
    .all(handle) as any[];
  db.prepare(`UPDATE messages SET read = 1 WHERE to_handle = ? AND read = 0`).run(handle);
  touchMember(handle);
  return rows.map(rowToMessage);
}

export function registerTools(server: McpServer): void {
  server.tool(
    "notify_assignment",
    "Master only: notify a developer's inbox that a task has been assigned to them. Create the actual task first via create_task to get a task_ref, then call this.",
    {
      project_id: z.string(),
      from_handle: z.string(),
      to_handle: z.string(),
      task_ref: z.string(),
      summary: z.string().describe("Short human-readable task summary"),
    },
    async ({ project_id, from_handle, to_handle, task_ref, summary }) => {
      try {
        notifyAssignment(project_id, from_handle, to_handle, task_ref, summary);
        return { content: [{ type: "text", text: `Task ${task_ref} assignment notified to ${to_handle}.` }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );

  server.tool(
    "send_message",
    "Send a direct message to another team member's handle (master<->developer, either direction).",
    { project_id: z.string(), from_handle: z.string(), to_handle: z.string(), text: z.string() },
    async ({ project_id, from_handle, to_handle, text }) => {
      try {
        sendMessage(project_id, from_handle, to_handle, text);
        return { content: [{ type: "text", text: `Message sent to ${to_handle}.` }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );

  server.tool(
    "report_status",
    "Developer only: report progress/status on a task. Automatically notifies the project's registered master.",
    {
      project_id: z.string(),
      from_handle: z.string(),
      task_ref: z.string(),
      status: z.enum(["started", "in_progress", "blocked", "done", "failed"]),
      note: z.string(),
    },
    async ({ project_id, from_handle, task_ref, status, note }) => {
      try {
        reportStatus(project_id, from_handle, task_ref, status, note);
        return { content: [{ type: "text", text: `Status reported: ${status}.` }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );

  server.tool(
    "check_inbox",
    "Check for new unread messages/task assignments addressed to this handle. Call this at the start of every turn/cycle.",
    { handle: z.string() },
    async ({ handle }) => {
      try {
        const messages = checkInbox(handle);
        if (messages.length === 0) {
          return { content: [{ type: "text", text: "No new messages." }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(messages, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/teamhub/messaging.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add teamhub/messaging.ts tests/teamhub/messaging.test.ts
git commit -m "feat(teamhub): add messaging module and tools"
```

---

### Task 5: Sprints module (`create_sprint`, `list_sprints`)

**Files:**
- Create: `teamhub/sprints.ts`
- Test: `tests/teamhub/sprints.test.ts`

**Interfaces:**
- Consumes: `db` from `teamhub/db.ts`.
- Produces: `interface Sprint { id: number; project_id: string; name: string; start_date: string | null; end_date: string | null; status: string; created_at: string }`, `createSprint(project_id: string, name: string, start_date?: string, end_date?: string): Sprint`, `getSprint(id: number): Sprint | undefined`, `listSprints(project_id: string): Sprint[]`, `registerTools(server: McpServer): void`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/teamhub/sprints.test.ts
import { describe, it, expect } from "vitest";

process.env.TEAMHUB_DB = ":memory:";

describe("sprints module", () => {
  it("creates a sprint and retrieves it by id", async () => {
    const { createSprint, getSprint } = await import("../../teamhub/sprints.js");
    const sprint = createSprint("proj-sprint-a", "Sprint 1", "2026-08-01", "2026-08-14");
    expect(sprint.name).toBe("Sprint 1");
    expect(getSprint(sprint.id)?.project_id).toBe("proj-sprint-a");
  });

  it("lists sprints scoped to a project, newest first", async () => {
    const { createSprint, listSprints } = await import("../../teamhub/sprints.js");
    createSprint("proj-sprint-b", "Sprint 1");
    createSprint("proj-sprint-b", "Sprint 2");
    createSprint("proj-sprint-c", "Other project sprint");
    const sprints = listSprints("proj-sprint-b");
    expect(sprints).toHaveLength(2);
    expect(sprints[0].name).toBe("Sprint 2");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/teamhub/sprints.test.ts`
Expected: FAIL — `Cannot find module '../../teamhub/sprints.js'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// teamhub/sprints.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "./db.js";

export interface Sprint {
  id: number;
  project_id: string;
  name: string;
  start_date: string | null;
  end_date: string | null;
  status: string;
  created_at: string;
}

function now(): string {
  return new Date().toISOString();
}

export function createSprint(
  project_id: string,
  name: string,
  start_date?: string,
  end_date?: string
): Sprint {
  const info = db
    .prepare(
      `INSERT INTO sprints (project_id, name, start_date, end_date, status, created_at)
       VALUES (?, ?, ?, ?, 'active', ?)`
    )
    .run(project_id, name, start_date ?? null, end_date ?? null, now());
  return getSprint(info.lastInsertRowid as number)!;
}

export function getSprint(id: number): Sprint | undefined {
  return db.prepare(`SELECT * FROM sprints WHERE id = ?`).get(id) as Sprint | undefined;
}

export function listSprints(project_id: string): Sprint[] {
  return db
    .prepare(`SELECT * FROM sprints WHERE project_id = ? ORDER BY id DESC`)
    .all(project_id) as Sprint[];
}

export function registerTools(server: McpServer): void {
  server.tool(
    "create_sprint",
    "Create a new sprint for a project.",
    {
      project_id: z.string(),
      name: z.string(),
      start_date: z.string().optional().describe("YYYY-MM-DD"),
      end_date: z.string().optional().describe("YYYY-MM-DD"),
    },
    async ({ project_id, name, start_date, end_date }) => {
      try {
        const sprint = createSprint(project_id, name, start_date, end_date);
        return { content: [{ type: "text", text: JSON.stringify(sprint, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );

  server.tool(
    "list_sprints",
    "List all sprints for a project.",
    { project_id: z.string() },
    async ({ project_id }) => {
      try {
        return { content: [{ type: "text", text: JSON.stringify(listSprints(project_id), null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/teamhub/sprints.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add teamhub/sprints.ts tests/teamhub/sprints.test.ts
git commit -m "feat(teamhub): add sprints module and tools"
```

---

### Task 6: Tasks module (`create_task`, `list_tasks`, `get_task`, `update_task_status`, `assign_task`, `add_comment`)

**Files:**
- Create: `teamhub/tasks.ts`
- Test: `tests/teamhub/tasks.test.ts`

**Interfaces:**
- Consumes: `db` from `teamhub/db.ts`; `getProject` from `teamhub/projects.ts` (Task 2) to resolve `key_prefix` for `task_ref` generation.
- Produces: `type TaskStatus = "backlog" | "todo" | "in_progress" | "in_review" | "done" | "blocked"`, `interface Task { id: number; project_id: string; task_ref: string; sprint_id: number | null; title: string; description: string | null; status: TaskStatus; priority: string; assignee_handle: string | null; created_at: string; updated_at: string }`, `createTask(project_id: string, title: string, description?: string, sprint_id?: number, priority?: string): Task`, `getTaskByRef(task_ref: string): Task | undefined`, `listTasks(project_id: string, filters?: { status?: string; assignee_handle?: string; sprint_id?: number }): Task[]`, `updateTaskStatus(task_ref: string, status: TaskStatus, assignee_handle?: string): Task | undefined`, `assignTask(task_ref: string, assignee_handle: string): Task | undefined`, `addComment(task_ref: string, author_handle: string, text: string): void`, `listComments(task_ref: string): Array<{ id: number; task_ref: string; author_handle: string; text: string; created_at: string }>`, `registerTools(server: McpServer): void`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/teamhub/tasks.test.ts
import { describe, it, expect } from "vitest";

process.env.TEAMHUB_DB = ":memory:";

describe("tasks module", () => {
  it("creates a task with a project-prefixed task_ref", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { createTask } = await import("../../teamhub/tasks.js");
    createProject("proj-task-a", "Task Project A", "PTA");
    const task = createTask("proj-task-a", "Fix login bug");
    expect(task.task_ref).toBe("PTA-1");
    expect(task.status).toBe("backlog");
  });

  it("second task in the same project increments the ref", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { createTask } = await import("../../teamhub/tasks.js");
    createProject("proj-task-b", "Task Project B", "PTB");
    createTask("proj-task-b", "First task");
    const second = createTask("proj-task-b", "Second task");
    expect(second.task_ref).toBe("PTB-2");
  });

  it("updateTaskStatus moves status and optionally sets assignee", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { createTask, updateTaskStatus, getTaskByRef } = await import("../../teamhub/tasks.js");
    createProject("proj-task-c", "Task Project C", "PTC");
    const task = createTask("proj-task-c", "Some task");
    updateTaskStatus(task.task_ref, "in_progress", "dev-A");
    const updated = getTaskByRef(task.task_ref);
    expect(updated?.status).toBe("in_progress");
    expect(updated?.assignee_handle).toBe("dev-A");
  });

  it("addComment and listComments round-trip", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { createTask, addComment, listComments } = await import("../../teamhub/tasks.js");
    createProject("proj-task-d", "Task Project D", "PTD");
    const task = createTask("proj-task-d", "Commented task");
    addComment(task.task_ref, "dev-A", "Started working on this");
    const comments = listComments(task.task_ref);
    expect(comments).toHaveLength(1);
    expect(comments[0].text).toBe("Started working on this");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/teamhub/tasks.test.ts`
Expected: FAIL — `Cannot find module '../../teamhub/tasks.js'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// teamhub/tasks.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "./db.js";
import { getProject } from "./projects.js";

export type TaskStatus = "backlog" | "todo" | "in_progress" | "in_review" | "done" | "blocked";

export interface Task {
  id: number;
  project_id: string;
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

function now(): string {
  return new Date().toISOString();
}

function nextTaskRef(project_id: string): string {
  const project = getProject(project_id);
  const prefix = project?.key_prefix ?? "TASK";
  const row = db
    .prepare(`SELECT COUNT(*) as n FROM tasks WHERE project_id = ?`)
    .get(project_id) as { n: number };
  return `${prefix}-${row.n + 1}`;
}

export function createTask(
  project_id: string,
  title: string,
  description?: string,
  sprint_id?: number,
  priority: string = "medium"
): Task {
  const task_ref = nextTaskRef(project_id);
  const ts = now();
  db.prepare(
    `INSERT INTO tasks (project_id, task_ref, sprint_id, title, description, status, priority, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'backlog', ?, ?, ?)`
  ).run(project_id, task_ref, sprint_id ?? null, title, description ?? null, priority, ts, ts);
  return getTaskByRef(task_ref)!;
}

export function getTaskByRef(task_ref: string): Task | undefined {
  return db.prepare(`SELECT * FROM tasks WHERE task_ref = ?`).get(task_ref) as Task | undefined;
}

export function listTasks(
  project_id: string,
  filters: { status?: string; assignee_handle?: string; sprint_id?: number } = {}
): Task[] {
  let sql = `SELECT * FROM tasks WHERE project_id = ?`;
  const params: unknown[] = [project_id];
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
  db.prepare(`UPDATE tasks SET assignee_handle = ?, updated_at = ? WHERE task_ref = ?`).run(
    assignee_handle,
    now(),
    task_ref
  );
  return getTaskByRef(task_ref);
}

export function addComment(task_ref: string, author_handle: string, text: string): void {
  db.prepare(
    `INSERT INTO comments (task_ref, author_handle, text, created_at) VALUES (?, ?, ?, ?)`
  ).run(task_ref, author_handle, text, now());
}

export function listComments(task_ref: string) {
  return db
    .prepare(`SELECT * FROM comments WHERE task_ref = ? ORDER BY id ASC`)
    .all(task_ref) as Array<{ id: number; task_ref: string; author_handle: string; text: string; created_at: string }>;
}

export function registerTools(server: McpServer): void {
  server.tool(
    "create_task",
    "Create a new task/ticket. Returns a task_ref (e.g. 'BTS-14') to use everywhere else — in notify_assignment, report_status, etc.",
    {
      project_id: z.string(),
      title: z.string(),
      description: z.string().optional(),
      sprint_id: z.number().optional(),
      priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
    },
    async ({ project_id, title, description, sprint_id, priority }) => {
      try {
        const task = createTask(project_id, title, description, sprint_id, priority);
        return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );

  server.tool(
    "list_tasks",
    "List tasks for a project, optionally filtered by status, assignee handle, or sprint.",
    {
      project_id: z.string(),
      status: z.enum(["backlog", "todo", "in_progress", "in_review", "done", "blocked"]).optional(),
      assignee_handle: z.string().optional(),
      sprint_id: z.number().optional(),
    },
    async ({ project_id, status, assignee_handle, sprint_id }) => {
      try {
        const tasks = listTasks(project_id, { status, assignee_handle, sprint_id });
        return { content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );

  server.tool(
    "get_task",
    "Get full details for one task by its task_ref, including comments.",
    { task_ref: z.string() },
    async ({ task_ref }) => {
      try {
        const task = getTaskByRef(task_ref);
        if (!task) {
          return { isError: true, content: [{ type: "text", text: `No task found for ${task_ref}` }] };
        }
        const comments = listComments(task_ref);
        return { content: [{ type: "text", text: JSON.stringify({ ...task, comments }, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );

  server.tool(
    "update_task_status",
    "Move a task to a new status (backlog, todo, in_progress, in_review, done, blocked). Optionally set/change the assignee at the same time.",
    {
      task_ref: z.string(),
      status: z.enum(["backlog", "todo", "in_progress", "in_review", "done", "blocked"]),
      assignee_handle: z.string().optional(),
    },
    async ({ task_ref, status, assignee_handle }) => {
      try {
        const task = updateTaskStatus(task_ref, status, assignee_handle);
        if (!task) {
          return { isError: true, content: [{ type: "text", text: `No task found for ${task_ref}` }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );

  server.tool(
    "assign_task",
    "Assign (or reassign) a task to a developer handle.",
    { task_ref: z.string(), assignee_handle: z.string() },
    async ({ task_ref, assignee_handle }) => {
      try {
        const task = assignTask(task_ref, assignee_handle);
        if (!task) {
          return { isError: true, content: [{ type: "text", text: `No task found for ${task_ref}` }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );

  server.tool(
    "add_comment",
    "Add a comment/note to a task — for progress notes, blockers, or review feedback.",
    { task_ref: z.string(), author_handle: z.string(), text: z.string() },
    async ({ task_ref, author_handle, text }) => {
      try {
        addComment(task_ref, author_handle, text);
        return { content: [{ type: "text", text: `Comment added to ${task_ref}.` }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/teamhub/tasks.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add teamhub/tasks.ts tests/teamhub/tasks.test.ts
git commit -m "feat(teamhub): add tasks module and tools"
```

---

### Task 7: TeamHub server wiring and HTTP endpoint

**Files:**
- Create: `teamhub/server.ts`
- Test: `tests/teamhub/server.test.ts`
- Modify: `package.json` (add `"teamhub"` script, remove `"relay"`/`"planner"` scripts)

**Interfaces:**
- Consumes: `registerTools` from `teamhub/projects.ts`, `teamhub/members.ts`, `teamhub/messaging.ts`, `teamhub/sprints.ts`, `teamhub/tasks.ts` (Tasks 2–6).
- Produces: `buildServer(): McpServer` (exported for testing), a running HTTP server on `process.env.TEAMHUB_PORT ?? 8787` when run directly.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/teamhub/server.test.ts
import { describe, it, expect } from "vitest";

process.env.TEAMHUB_DB = ":memory:";

describe("teamhub server", () => {
  it("buildServer registers a server with all expected tools", async () => {
    const { buildServer } = await import("../../teamhub/server.js");
    const server = buildServer();
    // McpServer exposes registered tool names via its internal request handlers;
    // the simplest black-box check is that construction doesn't throw and
    // returns an object with a connect method (duck-typed MCP server).
    expect(typeof (server as any).connect).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/teamhub/server.test.ts`
Expected: FAIL — `Cannot find module '../../teamhub/server.js'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// teamhub/server.ts
#!/usr/bin/env node
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as projects from "./projects.js";
import * as members from "./members.js";
import * as messaging from "./messaging.js";
import * as sprints from "./sprints.js";
import * as tasks from "./tasks.js";

// The single MCP server every claude CLI session (Master + every Developer)
// connects to over HTTP. Run this once, on one machine (e.g. PC1), then
// point every other machine's .mcp.json at http://<PC1-LAN-IP>:PORT/mcp.
// It replaces the old separate relay + planner servers.

export function buildServer(): McpServer {
  const server = new McpServer({ name: "teamhub", version: "1.0.0" });
  projects.registerTools(server);
  members.registerTools(server);
  messaging.registerTools(server);
  sprints.registerTools(server);
  tasks.registerTools(server);
  return server;
}

function isMain(): boolean {
  return process.argv[1] === new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

if (isMain()) {
  const PORT = Number(process.env.TEAMHUB_PORT || 8787);
  const app = express();
  app.use(express.json());

  app.post("/mcp", async (req, res) => {
    try {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("teamhub request failed:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal teamhub error" });
      }
    }
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`teamhub listening on http://0.0.0.0:${PORT}/mcp`);
    console.log(`Point other machines at http://<this-PC-LAN-IP>:${PORT}/mcp`);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/teamhub/server.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: Update package.json scripts**

```json
{
  "scripts": {
    "build": "tsc",
    "teamhub": "node dist/teamhub/server.js",
    "agent": "node dist/agents/runner.js",
    "migrate": "node dist/scripts/migrate-legacy-to-teamhub.js",
    "test": "vitest run"
  }
}
```

Also add `"vitest": "^3.0.0"` to `devDependencies` and run `npm install`.

- [ ] **Step 6: Build and smoke-test the server starts**

Run: `npm run build && TEAMHUB_PORT=8799 node dist/teamhub/server.js &`
Expected: prints `teamhub listening on http://0.0.0.0:8799/mcp`; then stop it with `kill %1` (or Ctrl+C if run in foreground).

- [ ] **Step 7: Commit**

```bash
git add teamhub/server.ts tests/teamhub/server.test.ts package.json package-lock.json
git commit -m "feat(teamhub): wire all modules into one MCP server"
```

---

### Task 8: Cross-platform agent runner (Windows support)

**Files:**
- Create: `agents/runner.ts`
- Test: `tests/agents/runner.test.ts`

**Interfaces:**
- Produces: `interface RunnerArgs { role: "master" | "developer"; project: string; handle: string; masterHandle?: string; cycle: number }`, `parseArgs(argv: string[]): RunnerArgs`, `claudeCommand(): string`, `kickoffPrompt(args: RunnerArgs): string`, `cyclePrompt(args: RunnerArgs): string`, `main(): Promise<void>` (not unit tested directly — it's the process entry point).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/agents/runner.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { parseArgs, claudeCommand, kickoffPrompt, cyclePrompt } from "../../agents/runner.js";

describe("parseArgs", () => {
  it("parses master args with defaults", () => {
    const args = parseArgs(["--role", "master", "--project", "proj-x", "--handle", "master-1"]);
    expect(args).toEqual({ role: "master", project: "proj-x", handle: "master-1", masterHandle: undefined, cycle: 60 });
  });

  it("parses developer args with an explicit cycle", () => {
    const args = parseArgs([
      "--role", "developer",
      "--project", "proj-x",
      "--handle", "dev-A",
      "--master-handle", "master-1",
      "--cycle", "45",
    ]);
    expect(args).toEqual({
      role: "developer",
      project: "proj-x",
      handle: "dev-A",
      masterHandle: "master-1",
      cycle: 45,
    });
  });

  it("throws when --role is missing or invalid", () => {
    expect(() => parseArgs(["--project", "proj-x", "--handle", "h"])).toThrow(/--role/);
    expect(() => parseArgs(["--role", "bogus", "--project", "p", "--handle", "h"])).toThrow(/--role/);
  });

  it("throws when --project or --handle is missing", () => {
    expect(() => parseArgs(["--role", "master", "--handle", "h"])).toThrow(/--project/);
    expect(() => parseArgs(["--role", "master", "--project", "p"])).toThrow(/--handle/);
  });
});

describe("claudeCommand", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("uses claude.cmd on win32", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    expect(claudeCommand()).toBe("claude.cmd");
  });

  it("uses claude on other platforms", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    expect(claudeCommand()).toBe("claude");
  });
});

describe("prompts", () => {
  it("kickoffPrompt mentions the handle and role for master", () => {
    const prompt = kickoffPrompt({ role: "master", project: "proj-x", handle: "master-1", cycle: 60 });
    expect(prompt).toContain("master-1");
    expect(prompt).toContain("proj-x");
    expect(prompt).toContain("role=\"master\"");
  });

  it("cyclePrompt for developer references the master handle", () => {
    const prompt = cyclePrompt({
      role: "developer",
      project: "proj-x",
      handle: "dev-A",
      masterHandle: "master-1",
      cycle: 30,
    });
    expect(prompt).toContain("master-1");
    expect(prompt).toContain("dev-A");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/agents/runner.test.ts`
Expected: FAIL — `Cannot find module '../../agents/runner.js'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// agents/runner.ts
#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

export interface RunnerArgs {
  role: "master" | "developer";
  project: string;
  handle: string;
  masterHandle?: string;
  cycle: number;
}

export function parseArgs(argv: string[]): RunnerArgs {
  const raw: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      raw[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  if (raw.role !== "master" && raw.role !== "developer") {
    throw new Error(`--role must be "master" or "developer", got "${raw.role}"`);
  }
  if (!raw.project) throw new Error("--project is required");
  if (!raw.handle) throw new Error("--handle is required");
  return {
    role: raw.role,
    project: raw.project,
    handle: raw.handle,
    masterHandle: raw["master-handle"],
    cycle: Number(raw.cycle ?? (raw.role === "master" ? 60 : 30)),
  };
}

export function claudeCommand(): string {
  return process.platform === "win32" ? "claude.cmd" : "claude";
}

function sessionFile(handle: string): string {
  return join(process.cwd(), `.${handle}-session-id`);
}

const ALLOWED_TOOLS_MASTER =
  "mcp__teamhub__register,mcp__teamhub__notify_assignment,mcp__teamhub__send_message," +
  "mcp__teamhub__check_inbox,mcp__teamhub__list_team,mcp__teamhub__create_project," +
  "mcp__teamhub__list_projects,mcp__teamhub__get_project,mcp__teamhub__create_sprint," +
  "mcp__teamhub__list_sprints,mcp__teamhub__create_task,mcp__teamhub__list_tasks," +
  "mcp__teamhub__get_task,mcp__teamhub__update_task_status,mcp__teamhub__assign_task," +
  "mcp__teamhub__add_comment,mcp__github__*";

const ALLOWED_TOOLS_DEVELOPER =
  "mcp__teamhub__register,mcp__teamhub__send_message,mcp__teamhub__check_inbox," +
  "mcp__teamhub__report_status,mcp__teamhub__get_task,mcp__teamhub__update_task_status," +
  "mcp__teamhub__add_comment,mcp__github__*,Read,Edit,Bash";

export function kickoffPrompt(args: RunnerArgs): string {
  if (args.role === "master") {
    return `You are the Team Lead for project "${args.project}". Your handle is "${args.handle}". First, call the teamhub register tool with handle="${args.handle}", role="master", project_id="${args.project}". Then check your task tracker for open backlog items in this project and summarize them.`;
  }
  return `You are a Developer on project "${args.project}". Your handle is "${args.handle}", your Team Lead's handle is "${args.masterHandle}". First, call the teamhub register tool with handle="${args.handle}", role="developer", project_id="${args.project}". Then check your inbox for an assigned task.`;
}

export function cyclePrompt(args: RunnerArgs): string {
  if (args.role === "master") {
    return `Check your teamhub inbox (handle="${args.handle}"). Answer any developer questions with send_message. Reflect any status updates in your task tracker. If a developer has no active task and there is ready backlog work, assign it with assign_task and notify_assignment.`;
  }
  return `Check your teamhub inbox (handle="${args.handle}"). If you have a new task assignment, pull the full details from your task tracker, work the code, and push to GitHub. Update the task status as you go, and call report_status so "${args.masterHandle}" is notified. If you're stuck, send_message to "${args.masterHandle}" and check back next cycle for a reply.`;
}

async function runCycle(prompt: string, handle: string, allowedTools: string): Promise<void> {
  const file = sessionFile(handle);
  const resumeArgs = existsSync(file) ? ["--resume", readFileSync(file, "utf-8").trim()] : [];
  const { stdout } = await execFileAsync(
    claudeCommand(),
    ["-p", prompt, ...resumeArgs, "--allowedTools", allowedTools, "--permission-mode", "acceptEdits", "--output-format", "json"],
    { maxBuffer: 10 * 1024 * 1024 }
  );
  const result = JSON.parse(stdout);
  if (result.result) console.log(result.result);
  if (result.session_id) writeFileSync(file, result.session_id);
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const allowedTools = args.role === "master" ? ALLOWED_TOOLS_MASTER : ALLOWED_TOOLS_DEVELOPER;
  console.log(`Starting ${args.role} (${args.handle}) on project ${args.project}...`);
  await runCycle(kickoffPrompt(args), args.handle, allowedTools);

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, args.cycle * 1000));
    try {
      await runCycle(cyclePrompt(args), args.handle, allowedTools);
    } catch (err) {
      console.error("Cycle failed, will retry next cycle:", err);
    }
  }
}

function isMain(): boolean {
  return process.argv[1] === new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

if (isMain()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/agents/runner.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Remove the old bash scripts' role and archive them**

```bash
mkdir -p legacy/agents
git mv agents/master-agent.sh legacy/agents/master-agent.sh
git mv agents/developer-agent.sh legacy/agents/developer-agent.sh
```

- [ ] **Step 6: Commit**

```bash
git add agents/runner.ts tests/agents/runner.test.ts legacy/agents
git commit -m "feat(agents): add cross-platform runner, archive bash scripts"
```

---

### Task 9: Migration script from legacy relay/planner data

**Files:**
- Create: `scripts/migrate-legacy-to-teamhub.ts`
- Test: `tests/scripts/migrate-legacy-to-teamhub.test.ts`

**Interfaces:**
- Consumes: `openDb` from `teamhub/db.ts` (Task 1).
- Produces: `interface MigrationCounts { projects: number; members: number; messages: number; sprints: number; tasks: number; comments: number }`, `migrate(relayJsonPath: string, plannerSqlitePath: string, teamhubDbPath: string): MigrationCounts`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/scripts/migrate-legacy-to-teamhub.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scripts/migrate-legacy-to-teamhub.test.ts`
Expected: FAIL — `Cannot find module '../../scripts/migrate-legacy-to-teamhub.js'`

- [ ] **Step 3: Write minimal implementation**

```typescript
// scripts/migrate-legacy-to-teamhub.ts
#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { openDb } from "../teamhub/db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface LegacyMessage {
  id: string;
  from: string;
  to: string;
  type: string;
  text: string;
  task_ref?: string;
  ts: string;
  read: boolean;
}

interface LegacyRelayDb {
  members: Record<string, { handle: string; role: string; team_id: string; lastSeen: string; status?: string }>;
  mailboxes: Record<string, LegacyMessage[]>;
}

export interface MigrationCounts {
  projects: number;
  members: number;
  messages: number;
  sprints: number;
  tasks: number;
  comments: number;
}

export function migrate(
  relayJsonPath: string,
  plannerSqlitePath: string,
  teamhubDbPath: string
): MigrationCounts {
  const teamhub = openDb(teamhubDbPath);
  const counts: MigrationCounts = { projects: 0, members: 0, messages: 0, sprints: 0, tasks: 0, comments: 0 };
  const seenProjects = new Set<string>();

  function ensureProject(team_id: string): void {
    if (seenProjects.has(team_id)) return;
    seenProjects.add(team_id);
    const existing = teamhub.prepare(`SELECT id FROM projects WHERE id = ?`).get(team_id);
    if (!existing) {
      const prefix = team_id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toUpperCase() || "TASK";
      teamhub
        .prepare(
          `INSERT INTO projects (id, name, key_prefix, status, created_at) VALUES (?, ?, ?, 'active', ?)`
        )
        .run(team_id, team_id, prefix, new Date().toISOString());
      counts.projects++;
    }
  }

  if (existsSync(relayJsonPath)) {
    const relay: LegacyRelayDb = JSON.parse(readFileSync(relayJsonPath, "utf-8"));
    for (const member of Object.values(relay.members)) {
      ensureProject(member.team_id);
      teamhub
        .prepare(
          `INSERT INTO members (handle, project_id, role, status, last_seen) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(handle) DO UPDATE SET project_id=excluded.project_id, role=excluded.role, status=excluded.status, last_seen=excluded.last_seen`
        )
        .run(member.handle, member.team_id, member.role, member.status ?? null, member.lastSeen);
      counts.members++;
    }
    for (const inbox of Object.values(relay.mailboxes)) {
      for (const msg of inbox) {
        const project_id = relay.members[msg.to]?.team_id ?? relay.members[msg.from]?.team_id ?? "unknown-project";
        ensureProject(project_id);
        teamhub
          .prepare(
            `INSERT OR IGNORE INTO messages (id, project_id, from_handle, to_handle, type, text, task_ref, ts, read) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(msg.id, project_id, msg.from, msg.to, msg.type, msg.text, msg.task_ref ?? null, msg.ts, msg.read ? 1 : 0);
        counts.messages++;
      }
    }
  }

  if (existsSync(plannerSqlitePath)) {
    const planner = new Database(plannerSqlitePath, { readonly: true });
    const sprintIdMap = new Map<number, number>();

    for (const sprint of planner.prepare(`SELECT * FROM sprints`).all() as any[]) {
      ensureProject(sprint.team_id);
      const info = teamhub
        .prepare(
          `INSERT INTO sprints (project_id, name, start_date, end_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(sprint.team_id, sprint.name, sprint.start_date, sprint.end_date, sprint.status, sprint.created_at);
      sprintIdMap.set(sprint.id, Number(info.lastInsertRowid));
      counts.sprints++;
    }

    for (const task of planner.prepare(`SELECT * FROM tasks`).all() as any[]) {
      ensureProject(task.team_id);
      const newSprintId = task.sprint_id ? sprintIdMap.get(task.sprint_id) ?? null : null;
      teamhub
        .prepare(
          `INSERT OR IGNORE INTO tasks (project_id, task_ref, sprint_id, title, description, status, priority, assignee_handle, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          task.team_id,
          task.task_ref,
          newSprintId,
          task.title,
          task.description,
          task.status,
          task.priority,
          task.assignee_handle,
          task.created_at,
          task.updated_at
        );
      counts.tasks++;
    }

    for (const comment of planner.prepare(`SELECT * FROM comments`).all() as any[]) {
      teamhub
        .prepare(`INSERT INTO comments (task_ref, author_handle, text, created_at) VALUES (?, ?, ?, ?)`)
        .run(comment.task_ref, comment.author_handle, comment.text, comment.created_at);
      counts.comments++;
    }

    planner.close();
  }

  teamhub.close();
  return counts;
}

function isMain(): boolean {
  return process.argv[1] === new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
}

if (isMain()) {
  const relayJsonPath = process.argv[2] || join(__dirname, "../legacy/relay/team-relay.db.json");
  const plannerSqlitePath = process.argv[3] || join(__dirname, "../legacy/planner/planner.db.sqlite");
  const teamhubDbPath = process.argv[4] || join(__dirname, "../teamhub/teamhub.db.sqlite");
  const counts = migrate(relayJsonPath, plannerSqlitePath, teamhubDbPath);
  console.log("Migration complete:", counts);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/scripts/migrate-legacy-to-teamhub.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: Archive the old relay/planner source**

```bash
mkdir -p legacy/relay legacy/planner
git mv relay/store.ts legacy/relay/store.ts
git mv relay/server.ts legacy/relay/server.ts
git mv planner/db.ts legacy/planner/db.ts
git mv planner/server.ts legacy/planner/server.ts
```

Note: any existing `team-relay.db.json` / `planner.db.sqlite` data files on a real deployment machine should be copied into `legacy/relay/` and `legacy/planner/` respectively before running `npm run migrate` there — this step only moves source code in the repo.

- [ ] **Step 6: Commit**

```bash
git add scripts/migrate-legacy-to-teamhub.ts tests/scripts/migrate-legacy-to-teamhub.test.ts legacy/relay legacy/planner
git commit -m "feat(scripts): add legacy relay/planner migration script, archive old source"
```

---

### Task 10: Rewrite `team-lead` skill for TeamHub, projects, and human kickoff

**Files:**
- Modify: `skills/team-lead/SKILL.md` (full rewrite)

**Interfaces:**
- Consumes: tool names from Tasks 2–6 (`register`, `list_team`, `create_project`, `list_projects`, `get_project`, `create_sprint`, `list_sprints`, `create_task`, `list_tasks`, `get_task`, `update_task_status`, `assign_task`, `add_comment`, `notify_assignment`, `send_message`, `check_inbox`, `report_status`).

- [ ] **Step 1: Write the new skill file**

```markdown
---
name: team-lead
description: "Use when acting as the Team Lead / Master in a multi-agent team where developer sessions do the coding. Covers turning a project brief into projects/sprints/tasks in TeamHub, assigning them to specific developer handles, monitoring developer status and questions, and keeping the team unblocked."
---

# Team Lead Role

You are the Team Lead for this project. You do not write code yourself — your
job is to plan, assign, unblock, and track, using the `teamhub` MCP tools
(`mcp__teamhub__*`).

## Your identity

- Your teamhub handle and project_id are provided in your system prompt or by
  the human who started this session (e.g. handle `master-1`, project_id
  `bts-project`).
- At the start of every session, call `register` with your handle,
  role="master", and project_id, if you haven't already this session.

## Kickoff a new project from a brief

When a human gives you a project brief, requirements doc, or similar (pasted
directly into the conversation, or as a file to read):

1. Check whether the project already exists with `get_project` /
   `list_projects`. If not, call `create_project` with a short id (slug),
   a name, and a `key_prefix` for task refs (e.g. id `bts-project`, prefix
   `BTS`).
2. Read the brief and break it into concrete, right-sized tasks. Create a
   sprint with `create_sprint` if the human wants sprint structure, otherwise
   tasks can live directly in the backlog.
3. Call `create_task` for each piece of work — clear title, a description
   with enough detail that a developer doesn't have to re-derive intent from
   the original brief.
4. Check `list_team` for registered developer handles. If none are
   registered yet, tell the human which handles you're expecting and wait —
   don't assign to a handle that doesn't exist.
5. For each ready task, `assign_task` (sets the assignee) and
   `notify_assignment` (puts it in the developer's inbox) to the best-fit
   developer handle.

## Core loop (each turn)

Whether you're in an interactive session with a human watching, or running
unattended cycles, do this in order at the start of every turn:

1. **Check inbox** — call `check_inbox(handle=<your handle>)`. Read every
   message:
   - `status_update` — a developer reporting progress. Reflect this via
     `update_task_status` or `add_comment` if the developer hasn't already.
   - `message` — a direct question or blocker from a developer. Answer it
     with `send_message` right away. Don't leave developers waiting.

2. **Check the backlog** — `list_tasks(project_id, status="backlog")` or
   similar, for this project.

3. **Assign work** — for any unassigned, ready task, and any developer who
   has no active task:
   - Pick the best-fit developer handle (ask `list_team` if unsure who's
     free).
   - Call `assign_task(task_ref, assignee_handle)` then
     `notify_assignment(project_id, from_handle=<you>, to_handle=<developer>,
     task_ref, summary)`.
   - Keep the summary short — the developer pulls full details via
     `get_task`.

4. **Don't duplicate work** — never assign a task that's already
   `in_progress` unless the assigned developer explicitly handed it back.

## Communication rules

- Always talk to a developer by their exact handle, never "the developer" or
  a guess. Get handles from `list_team` if unsure.
- Keep messages short and actionable.
- If a developer reports `blocked`, treat it as high priority — respond
  before assigning any new tasks.
- Never invent a task_ref. If nothing fits, `create_task` first, then
  assign it.

## What you should NOT do

- Don't write or edit code directly — that's the developer's job.
- Don't message a handle that hasn't shown up in `list_team` — it doesn't
  exist yet.
- Don't build or shell out to git/tooling automation yourself — that's out
  of scope for this role; developers use their own machine's existing tools.
```

- [ ] **Step 2: Verify old tool names are gone**

Run: `grep -nE "team-relay|team_id|jira" skills/team-lead/SKILL.md`
Expected: no matches (empty output).

- [ ] **Step 3: Commit**

```bash
git add skills/team-lead/SKILL.md
git commit -m "docs(skills): rewrite team-lead skill for teamhub and human kickoff"
```

---

### Task 11: Rewrite `team-developer` skill for TeamHub and turn-based language

**Files:**
- Modify: `skills/team-developer/SKILL.md` (full rewrite)

**Interfaces:**
- Consumes: tool names from Tasks 2–6, same set as Task 10.

- [ ] **Step 1: Write the new skill file**

```markdown
---
name: team-developer
description: "Use when acting as a Developer in a multi-agent team, reporting to a Team Lead/Master session. Covers pulling assigned tasks from TeamHub, working the code with your machine's own git/tools, reporting status back to the master, and asking for help when blocked."
---

# Developer Role

You are one Developer on a team led by a Team Lead (Master) session. You do
the actual coding work: reading tasks, writing code, pushing to GitHub, and
keeping TeamHub and the Team Lead updated. You use this machine's own
pre-installed git and tools through your normal Read/Edit/Bash tools —
nothing special is built for that; it's just your usual Claude Code session.

## Your identity

- Your teamhub handle, your project_id, and your Team Lead's handle are
  provided in your system prompt or by the human who started this session
  (e.g. you are `dev-A`, project_id `bts-project`, lead is `master-1`).
- At the start of every session, call `register` with your handle,
  role="developer", and project_id, if you haven't already this session.

## Core loop (each turn)

Whether you're in an interactive session with a human watching, or running
unattended cycles, do this at the start of every turn:

1. **Check inbox** — call `check_inbox(handle=<your handle>)`.
   - A `task_assignment` message means new work: it has a `task_ref` and a
     short summary. Pull the full task with `get_task(task_ref)` for
     description and any comments.
   - A `message` means the Team Lead answered a question or is giving you
     direction. Act on it.

2. **Work the task**:
   - Read the code, make the change, run tests if available.
   - Commit and push to GitHub as you normally would, using this machine's
     existing git setup.
   - Move the task through its real status transitions (e.g. todo →
     in_progress → in_review / done) as you go — don't wait until the end.
     Use `update_task_status(task_ref, status)`.

3. **Report status** — call `report_status(project_id, from_handle, task_ref,
   status, note)` at meaningful checkpoints (started, blocked, done), not
   after every tiny step. This automatically notifies the Team Lead.

4. **If blocked or unsure** — don't guess silently and don't stall. Call
   `send_message(project_id, from_handle=<you>, to_handle=<lead>, text=...)`
   with a specific question, report `status="blocked"`, and check your
   inbox again next turn for the reply.

## Rules

- Only work on tasks assigned to your own handle. If you have none, say so
  in your status and wait — don't grab another developer's task.
- Keep TeamHub in sync — the Team Lead should never have to ask "what's the
  status" because you already reported it.
- Don't mark a task `done` without also sending a `done` `report_status` —
  the Team Lead relies on that message, not just polling, to know instantly.
```

- [ ] **Step 2: Verify old tool names are gone**

Run: `grep -nE "team-relay|team_id|jira" skills/team-developer/SKILL.md`
Expected: no matches (empty output).

- [ ] **Step 3: Commit**

```bash
git add skills/team-developer/SKILL.md
git commit -m "docs(skills): rewrite team-developer skill for teamhub and turn-based language"
```

---

### Task 12: New example skill — `project-planner`

**Files:**
- Create: `skills/project-planner/SKILL.md`

**Interfaces:**
- Consumes: `create_project`, `list_projects`, `get_project`, `create_sprint`, `list_sprints`, `list_tasks` (Tasks 2, 5, 6).

- [ ] **Step 1: Write the skill file**

```markdown
---
name: project-planner
description: "Use when a human wants to set up a new TeamHub project, seed its first sprint, or get a quick health summary of an existing project (open/in-progress/blocked task counts). This is an admin/reporting skill, distinct from team-lead — it doesn't assign work or manage developers."
---

# Project Planner Role

You help a human set up and check on TeamHub projects. You do not assign
tasks to developers or act as a Team Lead — that's `team-lead`'s job. Use
this skill for project administration and reporting.

## Setting up a new project

1. Ask the human (if not already given) for: a short project id/slug, a
   display name, and a task-ref prefix (e.g. id `bts-project`, name
   "BTS Rewrite", prefix `BTS`).
2. Call `create_project(id, name, key_prefix)`. If it already exists,
   `create_project` returns the existing project rather than erroring —
   tell the human it was already there.
3. If the human wants sprint structure, call `create_sprint(project_id,
   name, start_date?, end_date?)` for the first sprint.
4. Report back the created project's id and key_prefix — that's what the
   human tells their Team Lead and Developer sessions to use.

## Health summary for an existing project

1. Call `get_project(id)` to confirm it exists.
2. Call `list_sprints(project_id)` and `list_tasks(project_id)`.
3. Summarize for the human: task counts by status (backlog / todo /
   in_progress / in_review / done / blocked), which sprint is active, and
   call out anything `blocked` by name (task_ref + title) since those need
   human attention first.

## What you should NOT do

- Don't assign tasks to developer handles — hand off to `team-lead` for
  that.
- Don't invent a project id if the human hasn't specified one and none of
  the existing projects from `list_projects` seem to match what they mean —
  ask instead of guessing.
```

- [ ] **Step 2: Verify frontmatter is valid**

Run: `head -n 4 skills/project-planner/SKILL.md`
Expected:
```
---
name: project-planner
description: "Use when a human wants to set up a new TeamHub project, seed its first sprint, or get a quick health summary of an existing project (open/in-progress/blocked task counts). This is an admin/reporting skill, distinct from team-lead — it doesn't assign work or manage developers."
---
```

- [ ] **Step 3: Commit**

```bash
git add skills/project-planner/SKILL.md
git commit -m "docs(skills): add project-planner example skill"
```

---

### Task 13: Skills authoring guide

**Files:**
- Create: `docs/skills-guide.md`

**Interfaces:**
- Consumes: the three skills from Tasks 10–12 as worked examples.

- [ ] **Step 1: Write the guide**

```markdown
# Writing and Using Claude Code Skills

A skill is a folder containing a `SKILL.md` file that teaches a Claude Code
session how to behave for a specific role or task. This project ships three:
`skills/team-lead`, `skills/team-developer`, and `skills/project-planner`.

## Anatomy of a SKILL.md

Every SKILL.md starts with YAML frontmatter, then Markdown instructions:

```markdown
---
name: my-skill-name
description: "One or two sentences: when to use this skill, and what it covers. This is the ONLY text used to decide whether the skill triggers, so be specific about triggering phrases and scenarios."
---

# Role / Task Title

Instructions in plain Markdown: what the session's job is, what NOT to do,
step-by-step loops, tool names it should call, and any rules specific to
this project.
```

- `name` must match the containing folder name and use kebab-case.
- `description` is the single most important field — it's matched against
  the user's request and the conversation context to decide whether this
  skill should trigger. Write it the way you'd explain to a colleague when
  to reach for this exact skill, including concrete trigger phrases (e.g.
  "Use when acting as the Team Lead...").
- Everything after the frontmatter is free-form Markdown read by the model
  when the skill is invoked — write it like an onboarding doc for a new
  team member who knows nothing about this specific project.

## Where skills live

- **Project-level:** `.claude/skills/<name>/SKILL.md` inside a specific
  repo — only available in that project. This project's `skills/` folder
  is the *source*; copy each subfolder into the target machine's
  `.claude/skills/` as described in `docs/setup-guide.md`.
- **User-level:** `~/.claude/skills/<name>/SKILL.md` — available in every
  project on that machine.
- **Plugin skills:** ship inside a Claude Code plugin and are namespaced as
  `plugin-name:skill-name`.

## Authoring checklist

1. Pick one clear job for the skill. If you're describing two different
   roles ("plans AND assigns AND writes code"), split it — see how
   `team-lead` (planning/assigning) and `team-developer` (coding) are kept
   separate even though they collaborate.
2. Write the `description` last, after the body — it's easier to summarize
   accurately once the instructions are written.
3. Name every tool you expect the session to call, using its exact MCP
   tool name (e.g. `mcp__teamhub__create_task`), not a paraphrase.
4. Include an explicit "What you should NOT do" section for any boundary
   that matters (see all three skills in this repo for the pattern) —
   models default to being helpful, so scope limits need to be stated, not
   implied.
5. Prefer turn-based language ("at the start of each of your turns...")
   over cycle/timing language, so the same skill works whether a human is
   driving the session interactively or it's running unattended via
   `agents/runner.ts`.

## Testing a skill before shipping it

1. Copy the skill folder into a scratch project's `.claude/skills/`.
2. Start `claude` there and describe a scenario the `description` should
   match — confirm the skill actually triggers.
3. Walk through the skill's instructions manually as if you were the model:
   does every referenced tool exist and have the name you wrote? Does every
   step have enough detail to act on without guessing?
4. Only then copy it to the real target project/machine.
```

- [ ] **Step 2: Verify the guide references real tool/skill names**

Run: `grep -c "mcp__teamhub__" docs/skills-guide.md`
Expected: a number ≥ 1 (confirms at least one real tool name is referenced, not a placeholder).

- [ ] **Step 3: Commit**

```bash
git add docs/skills-guide.md
git commit -m "docs: add Claude Code skills authoring guide"
```

---

### Task 14: Architecture documentation

**Files:**
- Create: `docs/architecture.md`

- [ ] **Step 1: Write the doc**

```markdown
# TeamHub Architecture

## Overview

One MCP server (`teamhub`), one SQLite file, multiple projects. Every
`claude` session — Master or Developer, on any PC — connects to the same
`teamhub` HTTP endpoint.

```
                     PC1 (or a small always-on box)
                     ┌───────────────────────────┐
                     │  teamhub (Node, one port)  │
                     │  ┌─────────────────────┐  │
                     │  │ projects.ts          │  │
                     │  │ members.ts           │  │
PC1: Lead ───────────┼─▶│ messaging.ts         │◀─┼─────────── PC2: Dev A
  claude (interactive│  │ sprints.ts           │  │              claude (interactive
  or agents/runner.ts│  │ tasks.ts             │  │              or agents/runner.ts)
  headless)          │  └─────────────────────┘  │
                     │           │                │
                     │           ▼                │
                     │   teamhub.db.sqlite         │
                     │   (WAL mode, one file)      │
                     └───────────────────────────┘
                                 ▲
                                 │
                          PC3: Dev B (same as PC2)
```

## Why one MCP server instead of two

The previous design ran `relay` (JSON-file-backed messaging/presence) and
`planner` (SQLite-backed sprints/tasks) as separate servers with overlapping
concepts — both had an `assign_task` tool with different meanings, and
nothing tied a "team" to a real project record. `teamhub` merges both into
one process and one SQLite file, with the two former tool sets kept as
separate internal modules (`messaging.ts`, `tasks.ts`) to avoid the merge
becoming an unmaintainable single file. See
`docs/superpowers/specs/2026-07-27-unified-teamhub-mcp-design.md` for the
full design rationale.

## Multi-project model

`projects` is a first-class table (id, name, key_prefix, status). Every
other table's rows carry a `project_id` foreign key. One `teamhub` instance
can host as many projects as you want — `list_projects` gives a directory of
all of them, and every other tool call is scoped to one `project_id` at a
time.

## Data flow: kickoff → assignment → completion

1. Human gives the Lead a project brief (interactively) → Lead calls
   `create_project`, `create_sprint`, `create_task` (writes to `projects`,
   `sprints`, `tasks`).
2. Lead calls `assign_task` (writes `tasks.assignee_handle`) and
   `notify_assignment` (writes a row to `messages`).
3. Developer calls `check_inbox` (reads + marks `messages.read = 1`), then
   `get_task` (reads `tasks` + `comments`).
2. Developer works the code locally (outside TeamHub entirely — this is
   just Claude Code's normal Read/Edit/Bash + the machine's own git).
3. Developer calls `update_task_status` (writes `tasks.status`) and
   `report_status` (writes a row to `messages` addressed to whichever
   handle has `role = 'master'` in that project).
4. Lead's next `check_inbox` call picks up the status update.

## Operating modes

- **Interactive (default):** a human runs plain `claude` with the relevant
  skill installed, sees every tool call live, and can steer each turn.
- **Headless (optional):** `agents/runner.ts` drives the same tool calls in
  an unattended loop via `claude -p --resume`, for overnight/unattended
  work. See `docs/setup-guide.md` for how to start either mode.

## Storage

Single SQLite file, WAL mode + `busy_timeout` pragma for concurrent access
from multiple agent processes. No Postgres, no second storage engine — see
the design spec's "Non-goals" for why this was chosen over a repository
abstraction.
```

- [ ] **Step 2: Verify it references the actual module files**

Run: `grep -c "\.ts" docs/architecture.md`
Expected: a number ≥ 5 (confirms real file names are referenced, not placeholders).

- [ ] **Step 3: Commit**

```bash
git add docs/architecture.md
git commit -m "docs: add TeamHub architecture documentation"
```

---

### Task 15: Setup guide with Windows + Mac/Linux instructions and human kickoff walkthrough

**Files:**
- Create: `docs/setup-guide.md`

- [ ] **Step 1: Write the guide**

```markdown
# TeamHub Setup Guide

## Step 1 — Install and build (on the machine that will run TeamHub)

macOS/Linux and Windows both use the same commands:

```bash
npm install
npm run build
```

`better-sqlite3` is a native module — `npm install` compiles it against your
Node version automatically as long as the machine has normal internet
access.

## Step 2 — Start TeamHub

macOS/Linux:
```bash
TEAMHUB_PORT=8787 npm run teamhub
```

Windows (PowerShell):
```powershell
$env:TEAMHUB_PORT = "8787"
npm run teamhub
```

Both print the LAN address to use, e.g. `teamhub listening on
http://0.0.0.0:8787/mcp`. Find this PC's LAN IP with `ipconfig` (Windows) or
`ifconfig`/`ip addr` (Mac/Linux). Open inbound TCP for port 8787 on this
PC's firewall for your office network profile.

## Step 3 — Point every machine's `.mcp.json` at the TeamHub host

On every machine (the one running TeamHub, and every developer PC):

```json
{
  "mcpServers": {
    "teamhub": { "type": "http", "url": "http://192.168.1.20:8787/mcp" },
    "github":  { "...": "your existing GitHub MCP config" }
  }
}
```

Replace `192.168.1.20` with the TeamHub host's real LAN IP.

## Step 4 — Copy the skills

Put `skills/team-lead`, `skills/team-developer`, and (optionally)
`skills/project-planner` into each relevant machine's `.claude/skills/`
folder:
- The Lead's machine gets `team-lead` (and `project-planner` if that human
  will also be setting up new projects).
- Each Developer's machine gets `team-developer`.

## Step 5 — Kick off a new project (human-driven, interactive)

This is the primary way to start real work — a human drives it, sees
everything live in their own terminal:

1. On the Lead's machine, run plain `claude` in this project's directory
   (no `-p`).
2. Paste or attach the project brief / requirements doc into the
   conversation, and ask the Lead to set up the project and plan the work.
   The `team-lead` skill (or `project-planner`, for just the setup step)
   will call `create_project`, `create_sprint`, and `create_task` for you.
3. On each developer's machine, run plain `claude` in the same project
   directory, with `team-developer` installed. Ask it to register and check
   its inbox.
4. The Lead assigns ready tasks (`assign_task` + `notify_assignment`) to
   registered developer handles — tell the Lead which handles are online if
   it asks.
5. From here, keep both sessions open and let them work turn by turn, or
   simply ask each one to "check your inbox and continue" whenever you want
   to advance a cycle. You'll see every registration, message, and status
   update live in each terminal.

## Step 6 — (Optional) Run unattended with the headless runner

For overnight or unattended operation instead of an interactive session:

```bash
# Lead / Master, any OS:
npm run agent -- --role master --project bts-project --handle master-1

# Developer, any OS:
npm run agent -- --role developer --project bts-project --handle dev-A --master-handle master-1
```

This requires `claude` on your `PATH` (same requirement as any Claude Code
usage) and replaces the old bash + `jq` scripts — no extra dependencies are
needed on Windows.

## Notes

- `teamhub/teamhub.db.sqlite` (created next to `teamhub/server.js` on
  whichever machine runs TeamHub) holds the whole team's shared state
  across every project. Back it up if it matters to you.
- If the TeamHub host goes offline, every connected session can still do
  local GitHub work, but can't message each other or see tasks until it's
  back. Run TeamHub on a small always-on box instead of the Lead's own PC
  if that's a problem.
- Migrating from the older separate `relay`/`planner` setup? See
  `docs/migration.md`.
```

- [ ] **Step 2: Verify both OS instruction blocks are present**

Run: `grep -c "PowerShell" docs/setup-guide.md && grep -c "macOS/Linux" docs/setup-guide.md`
Expected: both commands print a number ≥ 1.

- [ ] **Step 3: Commit**

```bash
git add docs/setup-guide.md
git commit -m "docs: add step-by-step setup guide with Windows support and kickoff walkthrough"
```

---

### Task 16: Migration documentation

**Files:**
- Create: `docs/migration.md`

- [ ] **Step 1: Write the doc**

```markdown
# Migrating from the old relay + planner setup

If you were running the earlier two-MCP-server version of this project
(`relay/` + `planner/`), follow these steps to move to the unified
`teamhub` server without losing data.

## 1. Locate your existing data files

- `relay/team-relay.db.json` (or wherever `TEAM_RELAY_DB` pointed)
- `planner/planner.db.sqlite` (or wherever `PLANNER_DB` pointed)

Copy both into this repo's `legacy/relay/` and `legacy/planner/` folders
respectively (create them if the source-code archive step hasn't already).

## 2. Run the migration script

```bash
npm run build
npm run migrate -- legacy/relay/team-relay.db.json legacy/planner/planner.db.sqlite teamhub/teamhub.db.sqlite
```

This prints a summary like:

```
Migration complete: { projects: 1, members: 3, messages: 12, sprints: 2, tasks: 9, comments: 4 }
```

Each old `team_id` becomes a new `projects.id` with the same value — you can
rename the project's display `name` afterwards (a `get_project`/manual
`UPDATE` for now; a rename tool can be added later if needed) but the id
itself stays stable so existing `task_ref`s keep working.

## 3. Update every machine's `.mcp.json`

Replace the old `team-relay` and `planner` (or `jira`) entries with the
single `teamhub` entry described in `docs/setup-guide.md` Step 3.

## 4. Update env vars in any launch scripts

`TEAM_ID` becomes `PROJECT_ID`; `RELAY_PORT`/`PLANNER_PORT` become
`TEAMHUB_PORT` (one port instead of two). If you were using the old bash
`agents/*.sh` scripts, switch to `npm run agent -- --role ... --project ...`
(see `docs/setup-guide.md` Step 6) — the old scripts have been archived to
`legacy/agents/`.

## 5. Verify

Run `list_projects` from any connected `claude` session (or
`sqlite3 teamhub/teamhub.db.sqlite "select * from projects;"` directly) and
confirm your project(s) and their task counts look right before decommissioning
the old `relay`/`planner` processes.
```

- [ ] **Step 2: Verify the doc references the real migrate script path**

Run: `grep -c "migrate-legacy-to-teamhub" docs/migration.md`
Expected: a number ≥ 1 (via `npm run migrate`, which maps to `dist/scripts/migrate-legacy-to-teamhub.js`).

- [ ] **Step 3: Commit**

```bash
git add docs/migration.md
git commit -m "docs: add migration guide from relay+planner to teamhub"
```

---

### Task 17: Rewrite root README

**Files:**
- Modify: `README.md` (full rewrite)

- [ ] **Step 1: Write the new README**

```markdown
# Claude Team Protocol — TeamHub

A multi-agent team workflow for Claude Code: one Team Lead session plans and
assigns work, one or more Developer sessions do the coding, and everyone
talks through **TeamHub** — a single, self-hosted MCP server that replaces
Jira/relay/planner-style juggling with one free, SQLite-backed service.

TeamHub is project-aware: one instance can host multiple projects, each with
its own sprints, tasks, and team roster.

```
PC1: TeamHub host          PC2: Team Lead              PC3+: Developers
  npm run teamhub             claude (interactive          claude (interactive
  (one port, one              or unattended via            or unattended via
   SQLite file)                agents/runner.ts)            agents/runner.ts)
       ▲                            │                              │
       └──── http://PC1-IP:8787/mcp ┴──────────────────────────────┘
                                     +
                          GitHub MCP (per machine, as usual)
```

## What's in this project

```
teamhub/
  db.ts, projects.ts, members.ts, messaging.ts, sprints.ts, tasks.ts, server.ts
    — the single MCP server (see docs/architecture.md)
agents/
  runner.ts       — cross-platform (Windows/Mac/Linux) headless agent loop
skills/
  team-lead/SKILL.md        — Team Lead behavior
  team-developer/SKILL.md   — Developer behavior
  project-planner/SKILL.md  — project setup/health-check admin skill
scripts/
  migrate-legacy-to-teamhub.ts — one-time import from the old relay+planner setup
docs/
  architecture.md, setup-guide.md, skills-guide.md, migration.md
legacy/
  the old relay/, planner/, and agents/*.sh from before this rewrite
```

## Getting started

See **`docs/setup-guide.md`** for the full step-by-step walkthrough,
including:
- Installing and starting TeamHub (Windows and Mac/Linux)
- Wiring every machine's `.mcp.json`
- Installing the skills
- **Kicking off a new project interactively** — a human hands the Team Lead
  a project brief, the Lead plans it into tasks, and connected Developer
  sessions pick up their assignments, all visible live in each person's own
  terminal
- Running unattended via `agents/runner.ts`, if you want headless operation

See **`docs/architecture.md`** for how TeamHub is put together, and
**`docs/skills-guide.md`** for how to write your own skills.

## Migrating from the old relay + planner version

See **`docs/migration.md`**.

## Notes

- `teamhub/teamhub.db.sqlite` holds the whole team's shared state across
  every project it hosts. Back it up if it matters to you.
- If the TeamHub host goes offline, connected sessions can still do local
  GitHub work, but can't message each other or see tasks until it's back —
  run it on a small always-on box instead of the Lead's own PC if that's a
  concern.
- TeamHub is intentionally simple (no auth, no UI) — same trust model as
  before: one office LAN, not a multi-tenant service.
```

- [ ] **Step 2: Verify no references to the old two-server setup remain in the primary instructions**

Run: `grep -nE "RELAY_PORT|PLANNER_PORT|relay/server|planner/server" README.md`
Expected: no matches (empty output) — those now only appear inside `docs/migration.md` and `legacy/`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README for unified TeamHub architecture"
```

---

### Task 18: Vitest setup and CI workflow

**Files:**
- Modify: `package.json` (already added `vitest` devDependency and `test` script in Task 7 — verify here)
- Create: `.github/workflows/test.yml`

**Interfaces:**
- Consumes: all `tests/**/*.test.ts` files created in Tasks 1–9.

- [ ] **Step 1: Confirm the test script runs everything**

Run: `npm test`
Expected: all test files from Tasks 1–9 pass (`tests/teamhub/db.test.ts`, `projects.test.ts`, `members.test.ts`, `messaging.test.ts`, `sprints.test.ts`, `tasks.test.ts`, `server.test.ts`, `tests/agents/runner.test.ts`, `tests/scripts/migrate-legacy-to-teamhub.test.ts` — 9 files).

- [ ] **Step 2: Write the CI workflow**

```yaml
# .github/workflows/test.yml
name: test

on:
  push:
  pull_request:

jobs:
  test:
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
        node-version: [22.x]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
      - run: npm install
      - run: npm run build
      - run: npm test
```

- [ ] **Step 3: Verify the workflow YAML is well-formed**

Run: `node -e "console.log(require('yaml').parse(require('fs').readFileSync('.github/workflows/test.yml','utf-8')).jobs.test.strategy.matrix.os)"` (if the `yaml` package isn't installed, instead visually confirm indentation is consistent 2-space and every key has a value — no tabs).
Expected: `[ 'ubuntu-latest', 'windows-latest' ]` (or, for the fallback check, no malformed indentation).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/test.yml package.json package-lock.json
git commit -m "ci: run test suite on ubuntu and windows"
```

---

## Plan Self-Review Notes

- **Spec coverage:** unified MCP (Tasks 1–7), multi-project planner (Task 2 + `project_id` threaded through Tasks 3–6), Windows agent support (Task 8), migration strategy (Task 9, Task 16), skills documentation + authoring guide + new example skill (Tasks 10–13), human-in-the-loop kickoff (Task 10 kickoff section, Task 15 Step 5), folder structure/docs/roadmap (Tasks 14–17, this plan's task ordering itself is the roadmap), testing/CI (Task 18). No spec section is without a task.
- **Type consistency checked:** `Project`, `Member`, `Message`, `Sprint`, `Task`/`TaskStatus` interfaces are defined once (Tasks 2–6) and reused by name in later tasks (Task 7 imports, Task 9's migration test asserts against the same schema, Task 8's runner references `mcp__teamhub__*` tool names matching each module's `server.tool(...)` calls exactly).
- **No placeholders:** every step has complete, runnable code or an exact shell command with expected output; no "TBD"/"add appropriate error handling" left in any task.
