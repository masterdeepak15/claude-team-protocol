# Claude Team Protocol — TeamHub

A multi-agent team workflow for Claude Code: one Team Lead session plans and
assigns work (asking clarifying questions before it does), Developer
sessions write the code, Tester sessions verify it and report bugs, Analyst
sessions clarify requirements and research without writing code, and
everyone talks through **TeamHub** — a single, self-hosted, token-authenticated
MCP server that replaces Jira/relay/planner-style juggling with one free,
SQLite-backed service.

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

## Install

**On the one machine that hosts TeamHub:**

```bash
npm install -g @masterdeepak15/teamhub-cli
teamhub install   # interactive: skills / .mcp.json / Claude Desktop / autostart
teamhub start
teamhub token     # print the shared auth token — everything below needs it
```

**On every other machine** (most Developer/Tester PCs — they only connect
to TeamHub, never host it) — a separate, much lighter package with no
server code and no native dependencies:

```bash
npm install -g @masterdeepak15/teamhub-client
# <token> is whatever `teamhub token` printed on the host machine above
teamhub-client connect <teamhub-host-ip>:8787 <token>
teamhub-client install --skills --mcp
```

See **`docs/CLI.md`** for the full server-side command reference
(`install`/`start`/`stop`/`status`/`logs`/`agent`/`upgrade`/`uninstall`/
`uninstall-autostart`/`--help`), `teamhub-client/README.md` for the client
package, or `docs/setup-guide.md`'s "Fastest path" / "Client-only machines"
sections for a quicker overview of both.

## What's in this project

```
teamhub/
  db.ts, projects.ts, members.ts, messaging.ts, sprints.ts, tasks.ts, server.ts
    — the single MCP server (see docs/architecture.md)
cli/
  teamhub-cli.ts  — the `teamhub` command (install/start/stop/status/logs/upgrade/autostart)
agents/
  runner.ts       — cross-platform (Windows/Mac/Linux) headless agent loop
teamhub-client/
  independent package (own package.json) — connect/status/install/agent
  for machines that only connect to TeamHub, never host it; no server
  code, no native dependencies (see docs/architecture.md)
skills/
  team-lead/SKILL.md        — Team Lead behavior
  team-developer/SKILL.md   — Developer behavior
  tester/SKILL.md           — Tester behavior (run/write tests, file bugs)
  project-planner/SKILL.md  — project setup/health-check admin skill
scripts/
  migrate-legacy-to-teamhub.ts — one-time import from the old relay+planner setup
docs/
  CLI.md, architecture.md, setup-guide.md, skills-guide.md, migration.md,
  example-walkthrough.md, adopt-into-existing-project.md
templates/
  CLAUDE.md — drop-in session conventions for a project adopting TeamHub
              (git CLI for version control, Gortex MCP when available, skills)
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
- Running unattended via `teamhub agent` (or `agents/runner.ts` from a repo
  checkout), if you want headless operation for a Developer, Tester, or
  the Lead
- **The monitoring dashboard** — open `http://<teamhub-host>:8787/` in a
  browser for a live view of every project's tasks, sprints, and team, plus
  a Messages tab where any human can pick a team member and reply to them
  directly

Already have a project and want to bolt TeamHub onto it (rather than start
fresh)? See **`docs/adopt-into-existing-project.md`** — no changes to your
existing codebase, just an `.mcp.json` entry, the skills, and onboarding
one teammate at a time.

New to this? Start with **`docs/example-walkthrough.md`** instead — a full
concrete run (two machines, one small project, real commands and real
conversation snippets) that also explains who can actually give tasks
(short answer: any human, on either side, at any time — the Lead isn't a
gatekeeper).

See **`docs/architecture.md`** for how TeamHub is put together (or
**`docs/agent-spawning.html`** — open it in a browser — for the same thing
as a diagrammed one-pager, good for sharing outside the repo), and
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
- Everything requires the shared token `teamhub token` prints (dashboard
  login, `.mcp.json`'s Authorization header, `TEAMHUB_TOKEN` for `agent`
  when it runs on a different machine than the server — same-machine
  agents pick it up automatically from `~/.teamhub/teamhub.token`) — one
  shared secret for the whole team, not per-person accounts, matching
  TeamHub's "one office LAN, not a multi-tenant service" scope. See
  `docs/architecture.md`'s "Auth" section for how it's wired.

## License

MIT — see `LICENSE`.
