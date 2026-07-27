# Unified TeamHub MCP, Multi-Project Planner, Windows Support & Skills Integration

Status: Approved (design stage) — 2026-07-27

## Problem

The current project (`claude-team-protocol`) has:

1. No project-wise planner — `team_id` is a free-text string with no registry, metadata, or listing; one "team" implicitly means one project.
2. No Windows support — `agents/master-agent.sh` / `developer-agent.sh` require bash + `jq`.
3. No step-by-step setup/usage documentation beyond the README.
4. No documentation on how to author, register, or use Claude Code skills, and only two example skills.
5. Two separate MCP servers (`relay/`, JSON-file-backed; `planner/`, SQLite-backed) that must be run and configured independently, with overlapping concepts (`assign_task` exists in both, with different meanings).

## Goals

- Consolidate `relay` + `planner` into one MCP server (`teamhub`) with one SQLite store.
- Make "project" a first-class, listable entity so one TeamHub instance can host multiple projects.
- Support Windows (and Mac/Linux) agent operation with one cross-platform codebase, no `jq`/bash dependency.
- Support both an unattended headless loop and a human-driven interactive session, with a documented kickoff flow from "human hands the Lead a project brief" through to developers picking up assigned tasks.
- Document skill authoring/registration/usage, and ship one new example skill demonstrating the pattern.
- Provide a migration path from the existing `relay`/`planner` data.

## Non-goals

- Building any git/tooling automation for developers — Claude Code's existing Read/Edit/Bash tools and each PC's pre-installed git/toolchain are used as-is. Nothing new is built here.
- Multi-tenant auth/access control — TeamHub remains unauthenticated, LAN/office-trust-model software, same as today.
- Postgres or any non-SQLite backend — explicitly deferred; SQLite is the storage layer.

## Architecture

### One MCP server, one SQLite file

`relay/` and `planner/` are replaced by one package, `teamhub/`, exposing a single `McpServer` on one HTTP port (default 8787), backed by one SQLite file (`teamhub.db.sqlite`, WAL mode + `busy_timeout` pragma). Internally organized by domain so no file grows unbounded:

```
teamhub/
  db.ts          # connection + schema/migrations
  projects.ts    # project CRUD + tools
  members.ts     # registration/presence + tools
  messaging.ts   # mailboxes: notify_assignment, send_message, check_inbox, report_status
  sprints.ts     # sprint CRUD + tools
  tasks.ts       # task CRUD, comments + tools
  server.ts      # wires every module's registerTools(server) onto one McpServer, starts express
```

Each module exports plain, unit-testable functions plus a `registerTools(server: McpServer)` function. `server.ts` imports and calls all of them, then listens on one port. This is the "single centralized MCP" externally while staying modular internally.

**Naming collision fix:** old `relay.assign_task` (notify a handle of an assignment) and old `planner.assign_task` (set a task's assignee field) collide. Resolved as:
- `messaging.notify_assignment(project_id, from_handle, to_handle, task_ref, summary)` — replaces relay's `assign_task`.
- `tasks.assign_task(task_ref, assignee_handle)` — unchanged from planner.

### Tool surface (final names, all under one MCP connection `teamhub`)

- Projects: `create_project`, `list_projects`, `get_project`
- Members/presence: `register`, `list_team`
- Messaging: `notify_assignment`, `send_message`, `check_inbox`, `report_status`
- Sprints: `create_sprint`, `list_sprints`
- Tasks: `create_task`, `list_tasks`, `get_task`, `update_task_status`, `assign_task`, `add_comment`

### Schema (SQLite, one file)

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,          -- slug, e.g. "bts-project"
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,      -- used for task_ref generation, e.g. "BTS"
  repo_url TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE members (
  handle TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  role TEXT NOT NULL,           -- 'master' | 'developer'
  status TEXT,
  last_seen TEXT NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  from_handle TEXT NOT NULL,
  to_handle TEXT NOT NULL,
  type TEXT NOT NULL,           -- 'task_assignment' | 'message' | 'status_update'
  text TEXT NOT NULL,
  task_ref TEXT,
  ts TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE sprints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  start_date TEXT,
  end_date TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE tasks (
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

CREATE TABLE comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_ref TEXT NOT NULL,
  author_handle TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

`team_id` is renamed to `project_id` everywhere (env vars, tool params, skill text) — a clean rename, not an alias, since this is a refactor.

### Cross-platform agent runner (Windows support)

`agents/master-agent.sh` / `developer-agent.sh` (bash + `jq`) are replaced by one `agents/runner.ts` (compiled to `dist/agents/runner.js`), used identically on Windows, macOS, and Linux:

```
node dist/agents/runner.js --role master --project bts-project --handle master-1 [--cycle 60]
node dist/agents/runner.js --role developer --project bts-project --handle dev-A --master-handle master-1 [--cycle 30]
```

- Spawns `claude` (or `claude.cmd` when `process.platform === 'win32'`) via `child_process.execFile`, with `--output-format json` parsed directly via `JSON.parse` — no `jq` dependency on any platform.
- Same register-once-then-poll model as today, implemented as an async loop (`setTimeout`-based), not a bash `sleep`.
- Session ID persisted to a `.{handle}-session-id` file next to the runner's cwd, using `node:path` for platform-correct paths.
- A failed cycle (relay unreachable, transient LAN blip) is logged and retried next cycle rather than crashing the process.
- npm scripts: `npm run agent -- --role master ...` / `npm run agent -- --role developer ...` are the one documented way to start an agent on any OS.
- This is the **headless/unattended** mode — see below for the human-driven default.

### Human-in-the-loop operation (primary mode)

Both Master and Developer support two run modes:

**Interactive mode (default)** — a human runs plain `claude` (no `-p`) in the project directory with the relevant skill installed in `.claude/skills/`. This is stock Claude Code — every tool call and response is visible live in the human's own terminal; nothing new is built for visibility. Kickoff flow:

1. Human opens `claude` where `team-lead` is installed and pastes/attaches the project brief or requirement docs into the conversation.
2. The (rewritten) `team-lead` skill instructs the Lead to: register itself once, `create_project` if it doesn't already exist, break the brief into sprints/tasks (`create_sprint` / `create_task`) grounded in what the human gave it, then `notify_assignment` + `assign_task` to whichever developer handles are registered — asking the human which handles exist if `list_team` is empty.
3. Each developer's human opens their own `claude` where `team-developer` is installed, registers, and asks it to check its inbox. It pulls the assigned `task_ref` via `get_task`, works the code using that PC's own pre-installed git/tools/IDE through Claude Code's normal Read/Edit/Bash tools (out of scope to automate further), and reports status back through `teamhub`.
4. Because a human is present, the skills are rewritten from cycle-based language ("each cycle, sleep N seconds") to turn-based language ("at the start of each of your turns, check your inbox first") — the same skill text works whether a human drives every turn or lets several turns run unattended.

**Headless mode (optional, unattended)** — the `agents/runner.ts` loop above, for overnight/unattended runs. Not the default; documented as an alternative for when nobody is watching a terminal.

### Skills

- `skills/team-lead/SKILL.md` and `skills/team-developer/SKILL.md` rewritten: tool names → `mcp__teamhub__*`, `team_id` → `project_id`, cycle language → turn language, and an explicit "Kickoff a new project from a brief" section added to `team-lead`.
- New `docs/skills-guide.md`: SKILL.md anatomy (frontmatter `name`/`description`, how the description drives triggering), install locations (project `.claude/skills/` vs user `~/.claude/skills/` vs plugin skills), an authoring checklist, and how to test a skill before shipping it.
- New example skill `skills/project-planner/SKILL.md`: a project-admin skill (create a project, seed a first sprint, summarize project health via `list_projects`/`list_tasks`) — the worked example referenced from the guide.

### Documentation set

```
docs/
  architecture.md    # unified MCP diagram, data flow, schema
  setup-guide.md      # step-by-step install/run, Windows + Mac/Linux side by side,
                       # including the human kickoff walkthrough
  skills-guide.md
  migration.md        # moving off the old relay+planner setup
```
Root `README.md` rewritten to point at these as the primary path, replacing the current relay/planner-centric instructions.

### Migration

`scripts/migrate-legacy-to-teamhub.ts` reads the old `relay/team-relay.db.json` and `planner/planner.db.sqlite`, and imports members/messages/sprints/tasks/comments into the new `teamhub.db.sqlite` schema, mapping each old `team_id` 1:1 to a new `projects.id` (with a generated `name`/`key_prefix` derived from the old id, editable after import via a project-update tool if needed). Old `relay/` and `planner/` source moves to `legacy/` for reference and is deleted in a later cleanup milestone once migration is verified.

## Error handling

- Zod validation on every tool input (unchanged from today).
- Tool handlers catch DB/logic errors and return `{ isError: true, content: [...] }` instead of throwing raw errors to the MCP client.
- SQLite: WAL mode + `busy_timeout` pragma for concurrent access from multiple agent processes hitting one file.
- Runner: a failed cycle logs and retries next cycle instead of crashing the loop.

## Testing

- Add `vitest` (no test setup exists today).
- Unit tests per `teamhub/*.ts` module (projects, members, messaging, sprints, tasks) against a temp SQLite file.
- One integration test exercising the full flow in-process: register → create_project → create_task → assign_task → notify_assignment → check_inbox → report_status.
- Recommend a GitHub Actions matrix (`ubuntu-latest`, `windows-latest`) running `npm test` so the cross-platform runner claim is verified, not assumed.

## Roadmap (milestones — implementation plan follows this spec)

- M1: `teamhub` MCP server (schema + all modules) + unit tests
- M2: Multi-project tools (`create_project`/`list_projects`/`get_project`) wired through every existing module
- M3: Cross-platform `agents/runner.ts` replacing the bash scripts
- M4: `scripts/migrate-legacy-to-teamhub.ts` + `legacy/` archive
- M5: Skills refresh (`team-lead`, `team-developer`) + new `project-planner` skill + `docs/skills-guide.md`
- M6: Full documentation set (`architecture.md`, `setup-guide.md`, `migration.md`) + README rewrite, including the human kickoff walkthrough
- M7: Tests/CI (vitest, GitHub Actions matrix) + polish
