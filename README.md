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

Already have a project and want to bolt TeamHub onto it (rather than start
fresh)? See **`docs/adopt-into-existing-project.md`** — no changes to your
existing codebase, just an `.mcp.json` entry, the skills, and onboarding
one teammate at a time.

New to this? Start with **`docs/example-walkthrough.md`** instead — a full
concrete run (two machines, one small project, real commands and real
conversation snippets) that also explains who can actually give tasks
(short answer: any human, on either side, at any time — the Lead isn't a
gatekeeper).

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

## License

MIT — see `LICENSE`.
