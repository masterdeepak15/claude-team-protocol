# Claude Team Protocol — Master + Developer across PCs

Master runs on PC1. Developers run on PC2, PC3, etc. Each machine uses its
own `claude` CLI login (Team plan) — no API key, no extra billing, fully
independent per machine.

Task tracking is **your choice**: use Jira as normal, or use the built-in
**Planner** — a free, self-hosted sprint/task tracker backed by SQLite, so
you're not stuck paying for Jira seats just to run this. Pick one; both
speak the same `task_ref` language to the rest of the system.

```
PC1: Master + Relay + Planner    PC2: Developer A         PC3: Developer B
  claude -p --resume                claude -p --resume       claude -p --resume
       |                                  |                        |
       +---- http://PC1-IP:8787/mcp (team-relay) --------------------+
       +---- http://PC1-IP:8788/mcp (planner, optional) --------------+
       |                                  |                        |
       +------------------- GitHub MCP (+ Jira MCP if you use it instead) --+
```

Master never touches code. Developers never assign their own tasks. The
team-relay is the only channel they use to reach each other directly.

## What's in this project

```
relay/
  store.ts     shared registry + mailboxes (JSON file, lives on PC1)
  server.ts    HTTP MCP server: register, assign_task, send_message,
               check_inbox, report_status, list_team
planner/
  db.ts        SQLite schema + queries (sprints, tasks, comments)
  server.ts    HTTP MCP server: create_sprint, list_sprints, create_task,
               list_tasks, get_task, update_task_status, assign_task,
               add_comment — a free, optional stand-in for Jira
agents/
  master-agent.sh      loop script for PC1 (uses `claude -p --resume`)
  developer-agent.sh   loop script for PC2/PC3/... (one per developer)
skills/
  team-lead/SKILL.md       behaviour rules for the Master
  team-developer/SKILL.md  behaviour rules for each Developer
```

## Step 1 — Install and build (on PC1)

```bash
npm install
npm run build
```

`better-sqlite3` is a native module — `npm install` compiles it against your
Node version automatically, as long as this machine has normal internet
access. No manual steps needed on a real PC.

## Step 2 — Start the relay (always) and Planner (only if you're using it)

```bash
RELAY_PORT=8787 npm run relay
```
```bash
# separate terminal, only if you're NOT using Jira
PLANNER_PORT=8788 npm run planner
```

Both print the LAN address to use, e.g.:
```
team-relay listening on http://0.0.0.0:8787/mcp
planner listening on http://0.0.0.0:8788/mcp
```

Find PC1's LAN IP with `ipconfig`. Open inbound TCP for whichever ports
you're using (8787, and 8788 if using Planner) on Windows Firewall for
your office network profile.

## Step 3 — Point every machine's `.mcp.json` at PC1

On **PC1 (Master)**, **PC2 (dev-A)**, **PC3 (dev-B)**, etc.:

**If using the built-in Planner (no Jira cost):**
```json
{
  "mcpServers": {
    "team-relay": { "type": "http", "url": "http://192.168.1.20:8787/mcp" },
    "planner":    { "type": "http", "url": "http://192.168.1.20:8788/mcp" },
    "github":     { "...": "your existing GitHub MCP config" }
  }
}
```

**If using Jira instead:**
```json
{
  "mcpServers": {
    "team-relay": { "type": "http", "url": "http://192.168.1.20:8787/mcp" },
    "jira":       { "...": "your existing Jira MCP config" },
    "github":     { "...": "your existing GitHub MCP config" }
  }
}
```

Replace `192.168.1.20` with PC1's real LAN IP. All machines point at the
**same** addresses — that's what makes them one team.

You can even run both `jira` and `planner` entries side by side if you want
to migrate gradually — the skills and agent prompts already treat both as
"your task tracker" and use whichever tools are actually present.

## Step 4 — Copy the skills

Put `skills/team-lead` and `skills/team-developer` into each machine's
`.claude/skills/` folder (Master gets `team-lead`, each Developer gets
`team-developer`).

## Step 5 — (Planner only) Seed a sprint and a first task

From any machine connected to the planner, ask Claude something like:
> "Using the planner tool, create a sprint called 'Sprint 1' for team_id
> bts-project, then create a task 'Fix login bug' in it."

Or let the Master agent do this itself in its first cycle — it already
checks the tracker for backlog items and can create tasks via
`create_task` if none exist yet.

## Step 6 — Run

On **PC1**:
```bash
TEAM_ID=bts-project HANDLE=master-1 ./agents/master-agent.sh
```

On **PC2**:
```bash
TEAM_ID=bts-project HANDLE=dev-A MASTER_HANDLE=master-1 ./agents/developer-agent.sh
```

On **PC3**:
```bash
TEAM_ID=bts-project HANDLE=dev-B MASTER_HANDLE=master-1 ./agents/developer-agent.sh
```

Each script loops forever: run a `claude -p` turn, save the returned
`session_id`, sleep, `--resume` that same session next time. That's how
each machine keeps full memory of its own work across cycles, using only
its own Team-plan login — nothing routes through PC1 except the small
relay and planner calls.

## Why handles instead of session IDs

Claude's internal session IDs are only meaningful on the machine that
created them — PC2 has no way to "dial" a session ID that only exists on
PC1's disk. Handles (`master-1`, `dev-A`, `dev-B`) solve this: they're
just names in the shared relay, so any machine can address any other
machine's agent by name, regardless of whose session ID is whose.

## Notes

- `relay/team-relay.db.json` and `planner/planner.db.sqlite` (created next
  to their respective `server.js` on PC1) hold the whole team's shared
  state. Back them up if they matter to you.
- If PC1 goes offline, the relay (and Planner, if used) go down with it —
  Master and Developers can still do local GitHub work, they just can't
  message each other or see tasks until PC1 is back. If that's a problem,
  run relay/planner on a small always-on box instead of Master's own PC.
- Planner is intentionally simple (no auth, no UI) — it's meant to remove
  Jira's licensing cost for this workflow, not replace Jira for your whole
  org. If you later want a UI to browse Planner's tasks, the SQLite file
  is a plain, portable format — any SQLite browser can open it directly.
