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
