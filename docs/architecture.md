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
  work. Exposed three ways: `npm run agent --` from a repo checkout,
  `teamhub agent ...` from the globally-installed server CLI package, or
  `teamhub-client agent ...` from the client-only package (see below) — all
  three run the same underlying logic. Either way, `process.cwd()` at
  invocation time is where the session-tracking file lives **and** where
  the spawned `claude -p` process does its Read/Edit/Bash work — `cd` into
  the actual target project first. See `docs/setup-guide.md` for how to
  start any of these.

## Server package vs. client package

`@masterdeepak15/teamhub-cli` (this repo's root package) bundles the
server (`teamhub/*.ts`, needs `better-sqlite3` and `express`) *and* the
full CLI (`install`/`start`/`stop`/`status`/`logs`/`upgrade`/`uninstall`/
`agent`) for whichever one machine hosts TeamHub. Every other machine —
most Developer and Tester PCs — never runs the server or touches SQLite;
they only need to spawn `claude` and talk to TeamHub over HTTP.

`@masterdeepak15/teamhub-client` (`teamhub-client/` in this repo, its own
independent `package.json`/`tsconfig.json`, published separately) covers
exactly that case: `connect` (save a server URL), `status`, `install`
(skills + `.mcp.json`, pointed at the connected server), and `agent` — the
same runner logic (`teamhub-client/src/runner.ts`, ported from
`agents/runner.ts`) but resolving its TeamHub URL from the saved
connection instead of defaulting to `localhost`. It deliberately does
**not** depend on `teamhub-cli`, so it never pulls in `better-sqlite3` —
the actual source of the Windows native-module build failures this
project has run into (missing prebuilds for new Node versions, V8 API
mismatches, `node-gyp` requiring Visual Studio Build Tools). One
unavoidable trade-off: `@modelcontextprotocol/sdk` itself bundles both
client and server transport code, so `express`/`cors` still come along
transitively — pure JS with no compilation step, so it doesn't cause the
same class of problem, just some unused bundle weight.

The two packages' skill copies (`skills/` at repo root vs.
`teamhub-client/skills/`) are currently maintained as duplicates, kept in
sync by hand — a shared skills-only package they both depend on would
remove that duplication, but hasn't been built yet.

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
is no remote-kill capability, by design, whenever Owner (or another human)
is (or might be) directly supervising that session.

Auto mode is not "fully unattended forever" mode, and it's worth being
precise about what it does and doesn't change:

- It changes whether the Lead can interrupt a cycle mid-flight (above).
- It does **not** change whether cycles run at all — both modes loop
  forever on the same `--cycle` interval once started via
  `agents/runner.ts`. See "The idle gate" below for what actually decides
  whether a given cycle does anything.
- It does **not** relax the reply requirement in "Always reply to the
  sender" below — a message from the Lead or from Owner still needs an
  answer regardless of mode.

## The idle gate — cheap enough to poll forever, not just on messages

Every headless cycle (`agents/runner.ts` / `teamhub-client/src/runner.ts`,
both packages, identical logic) is gated by `has_pending_work` — a plain DB
read exposed as an MCP tool (`teamhub/gate.ts`), called directly over MCP
with **no `claude` process spawned and no tokens spent**:

- Master: pending if there's any unread message, **or** any backlog/todo
  task with no assignee yet.
- Developer/Tester: pending if there's any unread message, **or** any task
  already assigned to that handle whose status isn't `done`/`blocked`.

That second condition for Developer/Tester matters more than it looks: a
developer who picked up a task in one cycle but didn't finish it, with no
*new* message arriving on a later cycle, still needs to keep working on it.
Gating purely on unread messages (an earlier version of this) meant that
once the original `task_assignment` message had been read, the gate would
report "idle" forever regardless of the task's actual status — the
developer would never resume it on its own. Checking their own active work
alongside messages closes that gap.

When the gate reports nothing pending, the runner logs `idle, nothing
pending — skipping this cycle (no tokens used)` and goes straight back to
sleep — no `claude -p` spawned, no AI cost, for as long as it stays quiet.
The moment either condition becomes true, the very next poll spawns a real
cycle.

## Live console output during a cycle

Cycles run with `--output-format stream-json --verbose` (not plain `json`)
specifically so a headless/auto-mode session's console shows what it's
actually doing turn by turn — each tool call and each assistant message —
instead of only a single summary line once the whole cycle finishes.
`agents/runner.ts`'s `logStreamEvent` reads the resulting NDJSON stream one
line at a time as it arrives and prints:

- `[handle] → calling <tool_name>(<truncated args>)` for every tool call
- `[handle] <truncated assistant text>` for every piece of reasoning/reply
  text the model produces
- `[handle] session started (model: ...)` once, from the stream's `init`
  event

`tool_result` events and other `system` subtypes are deliberately not
printed — the tool-call line already shows what was invoked, and the
model's next text block usually summarizes the outcome, so this stays a
readable progress log rather than a full raw transcript dump. The final
`result` event (same shape `--output-format json` used to return directly)
is still what gets parsed for the summary text and the `session_id` used to
`--resume` the next cycle — this is a change to *how much you see while a
cycle runs*, not to the session/resume mechanics themselves.

## Always reply to the sender

Every role's cycle prompt (`kickoffPrompt`/`cyclePrompt` in both runner
packages, and the matching `SKILL.md` files) is explicit: any unread
message — from the Lead, a Developer, a Tester, or **Owner** directly —
must get an actual `send_message`/`report_status` reply before the turn
ends, even a short one. This exists because of a real failure mode: a
session can read a message, act on it, and still never tell the sender
anything happened — from the sender's side, that's indistinguishable from
the message having been ignored entirely. It's most likely to bite Owner
specifically, since in auto mode there's often no one watching the console
in the moment to notice a question went unanswered.

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

## Monitoring UI

`GET /` on the same Express app (same port as `/mcp` and `/health`, no new
process or firewall rule) serves a browser dashboard — sidebar + topbar
layout with six views:

- **Dashboard** — task-status stat cards, active sprint, full team roster.
- **Board** — a Jira-like Kanban across all six task statuses.
- **Sprints** — every sprint with its tasks.
- **Team** — member cards (role/mode badges), click through to message them.
- **Messages** — pick a member, see the full conversation thread with them
  (not just unread — see below), reply as the fixed **Owner** identity (see
  below — this replaced an earlier "Acting as" picker that let you send as
  any registered handle, including the same one you were replying to).
- **Chat Room** — every message in the project, from every member pair, in
  one combined feed (each sender color-coded), instead of picking a single
  1:1 thread. Reuses the exact same data (`listMessages` with no handle
  filter) and the exact same SSE stream as every other view — no WebSocket,
  no new port, no new plumbing at all, just a different way of rendering
  what was already being pushed to the browser.

**Architecture:**

- `teamhub/api.ts` — plain REST/JSON endpoints (`GET /api/projects`,
  `.../members`, `.../sprints`, `.../tasks`, `GET /api/tasks/:taskRef`,
  `GET /api/projects/:id/messages`, `POST /api/messages`) that call the same
  `teamhub/*.ts` functions the MCP tools use directly — no MCP round-trip
  for same-process UI reads/writes, no second data model to keep in sync.
- `messaging.listMessages(project_id, handle?)` — a **non-mutating** query
  (unlike `check_inbox`, which acks-on-read) so the UI can show full
  history, already-read messages included, without disturbing what a
  developer's own `check_inbox` call would still see as unread.
- `teamhub/events.ts` — a single in-process `EventEmitter`. Every mutation
  in `projects.ts`/`members.ts`/`messaging.ts`/`sprints.ts`/`tasks.ts` calls
  `emitChange(kind, project_id)` after writing. `GET /api/events` is a
  Server-Sent Events stream subscribed to that bus (optionally filtered by
  `?project_id=`) — the browser refetches on any change, giving live task
  movement/message delivery without polling.
- `teamhub/public/` — plain HTML/CSS/JS, no build step or frontend
  framework (keeps the npm package's dependency footprint unchanged).
  Served via `express.static()`; `scripts/copy-public-assets.mjs` copies it
  into `dist/teamhub/public/` as a build step, since `tsc` only compiles
  `.ts` files and won't touch static assets on its own.
- **The Owner identity, and why self-messaging was a bug** — every message
  composed from the dashboard (Messages or Chat Room) is sent from the
  reserved handle `owner` (`teamhub/members.ts` rejects registering it as a
  real agent, so it can never collide with one). Earlier, the "from" field
  was just another dropdown of real handles, so nothing stopped picking the
  same handle for "from" and "to" — a message from a member to itself.
  `messaging.sendMessage` now rejects `from_handle === to_handle` outright
  (used by both the REST route and the `send_message` MCP tool), and the UI
  no longer offers a "from" choice at all — you're always Owner, talking to
  a real member.
- **No auth, same as everything else here** — the Owner identity is a
  dashboard convenience, not a real auth system. Any dynamic value from the
  database (message text, task titles, comments — fields an unauthenticated
  MCP caller could set) is escaped
  before being inserted into the page, since XSS is otherwise possible in
  this no-auth model.
