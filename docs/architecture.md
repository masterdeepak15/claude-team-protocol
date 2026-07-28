# TeamHub Architecture

## Overview

One MCP server (`teamhub`), one SQLite file, multiple projects. Every
`claude` session — Master, Developer, or Tester, on any PC — connects to the
same `teamhub` HTTP endpoint. `role` is one of `master` | `developer` |
`tester` on the `members` table; only `master` gets Lead-specific tools
(`assign_task`, `create_task`, etc.) via the skills/allowed-tools lists —
`developer` and `tester` share the same underlying tool surface and differ
only in what their skill instructs them to do with it (write code vs.
verify it).

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
4. Developer works the code locally (outside TeamHub entirely — this is
   just Claude Code's normal Read/Edit/Bash + the machine's own git).
5. Developer calls `update_task_status` (writes `tasks.status`) and
   `report_status` (writes a row to `messages` addressed to whichever
   handle has `role = 'master'` in that project).
6. Lead's next `check_inbox` call picks up the status update.

## Operating modes

- **Interactive (default):** a human runs plain `claude` with the relevant
  skill installed, sees every tool call live, and can steer each turn.
- **Headless (optional):** `agents/runner.ts` drives the same tool calls in
  an unattended loop via `claude -p --resume`, for overnight/unattended
  work. Exposed two ways: `npm run agent --` from a repo checkout, or
  `teamhub agent ...` from the globally-installed CLI package (no checkout
  needed — see `cli/teamhub-cli.ts`, which dynamically imports the compiled
  `dist/agents/runner.js` and forwards argv to its `main()`). Either way,
  `process.cwd()` at invocation time is where the session-tracking file
  lives **and** where the spawned `claude -p` process does its Read/Edit/
  Bash work — `cd` into the actual target project first. See
  `docs/setup-guide.md` for how to start either mode.

## Developer mode and interrupts

Every registered member has a `mode` on the `members` row: `manual`
(default) or `auto`. It's set via `register`'s optional `mode` param or
changed anytime with `set_mode` — always at the human's explicit choice,
never something a session decides for itself.

`mode` only changes real runtime behavior for a **headless** Developer
(`agents/runner.ts --role developer --mode auto`):

- Its `claude -p` cycles still run with `--permission-mode acceptEdits` —
  **deliberately never `bypassPermissions`**. TeamHub has no authentication
  (see Non-goals in the design spec), so anyone who can reach its HTTP port
  could otherwise call `interrupt_developer` (or `notify_assignment` /
  `send_message`) with a crafted `reason`/`summary` string, which gets fed
  verbatim as the next instruction. With `bypassPermissions`, that would be
  a real prompt-injection-to-RCE path — Bash execution with zero
  confirmation. `acceptEdits` keeps file edits auto-approved (the actual
  value of "auto" mode) while leaving Bash gated.
- The runner keeps a second, lightweight loop running concurrently with
  each cycle: `pollForInterrupt` connects directly to TeamHub over MCP
  (`@modelcontextprotocol/sdk`'s `Client` + `StreamableHTTPClientTransport`,
  no `claude` process spawned) and calls `check_interrupt` every
  `--watchdog-interval` seconds (default 5). `check_interrupt` reads only
  `interrupt`-type messages — a dedicated, non-consuming query so the
  watchdog never steals a `task_assignment`/`message`/`status_update` row
  that the main cycle's own `check_inbox` call is meant to see.
- If the Lead calls `interrupt_developer`, the next watchdog tick sees it,
  kills the in-flight `claude -p` child process (`child.kill()` on the
  `ChildProcess` Node's promisified `execFile` attaches to the returned
  promise), and immediately starts a fresh cycle using the interrupt's
  reason as the prompt (`redirectPrompt`).

For a `manual`-mode Developer, or any interactive session regardless of its
recorded `mode`, `interrupt_developer` just inserts a normal `interrupt`-type
row that shows up in that handle's next ordinary `check_inbox` call — there
is no remote-kill capability, by design, whenever a human is (or might be)
directly supervising that session.

## HTTP surface

`teamhub`'s Express app exposes two routes:

- `POST /mcp` — the actual MCP protocol endpoint. A plain browser/`curl` GET
  against it always 404s (`Cannot GET /mcp`) — that's expected, not an error;
  it just means you used the wrong HTTP method, not that the server is down.
- `GET /health` — a plain, unauthenticated status route (`{"status":"ok","service":"teamhub","uptimeSeconds":N}`),
  deliberately separate from the MCP protocol so "is TeamHub reachable from
  this machine" can be checked with a browser tab or plain `curl`, without
  needing to speak MCP at all. See `docs/setup-guide.md`'s troubleshooting
  section for how this fits into diagnosing cross-machine connectivity
  issues (firewall vs. wrong IP vs. genuinely down).

## Storage

Single SQLite file, WAL mode + `busy_timeout` pragma for concurrent access
from multiple agent processes. No Postgres, no second storage engine — see
the design spec's "Non-goals" for why this was chosen over a repository
abstraction.

## Roadmap: a monitoring UI (not yet built)

A web dashboard — projects, team roster with roles/modes, task/sprint
status, live message feed — served from the **same port** as `/mcp` and
`/health` (e.g. `GET /` or `GET /dashboard` on the existing Express app, no
new process or port to open/firewall) is planned but not implemented yet.
When built, it would be read-only against the same SQLite file the MCP
tools already use — no new state, no auth added (same trust model as
everything else here) — just a browsable view of what `list_projects` /
`list_team` / `list_tasks` already expose through tool calls.
