# TeamHub Setup Guide

> Looking for a concrete, worked example instead of abstract steps? See
> **`docs/example-walkthrough.md`** — it walks through this entire guide
> with a real project, real commands, and real conversation snippets.

## Fastest path: install the CLI from npm

If you don't need a repo checkout (contributing, migrating legacy data),
this is the quickest way to get TeamHub running — no `git clone` needed:

```bash
npm install -g @masterdeepak15/teamhub-cli
teamhub install
```

`teamhub install` with no flags prompts you interactively for each optional
step — install the skills into `./.claude/skills`, add a `teamhub` entry to
`./.mcp.json`, wire up Claude Desktop too, and/or register TeamHub to
auto-start at login/boot. Answer `y`/`N` to whichever you want.

For scripted/non-interactive setup, pass the flags you want directly (any
flag switches to non-interactive mode — only what you pass happens):

```bash
teamhub install --skills --mcp --autostart --port 8787
```

Then:

```bash
teamhub start           # start the server in the background
teamhub status          # is it running?
teamhub logs            # see its output (--follow to tail continuously)
teamhub stop            # stop it
teamhub upgrade         # stop it, npm-install the latest teamhub-cli, start it back up
teamhub uninstall       # stop it, remove autostart, npm-uninstall — keeps your data
teamhub uninstall-autostart   # just remove the auto-start registration
teamhub --help           # full command reference
```

See **`docs/CLI.md`** for the complete reference with every flag and example.

`teamhub upgrade` (alias `update`) restarts with whatever port/db it was
last running with — no need to remember or re-pass them. Safe to run even
if TeamHub isn't currently running.

`teamhub uninstall` keeps your data (the SQLite database) by default —
pass `--force` to also delete it.

`--autostart` registers TeamHub with Windows Task Scheduler, a macOS
LaunchAgent, or a Linux systemd `--user` service, matching your OS —
verified end-to-end on Windows; the macOS/Linux paths use well-established
patterns but haven't been run on those OSes in this project's testing yet.

The rest of this guide (Steps 1–6) walks through the equivalent manual
setup from a repo checkout — useful if you're contributing to TeamHub
itself, or prefer not to install a global CLI.

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

### Verifying it's actually reachable from another PC

TeamHub also exposes a plain `GET /health` endpoint, separate from the MCP
protocol itself — open it directly in a browser, or:

```bash
curl http://192.168.1.20:8787/health
```

A working response looks like `{"status":"ok","service":"teamhub","uptimeSeconds":12}`.
This is the easiest way to confirm the server is reachable from a *different*
machine before wiring up `.mcp.json` — no MCP request formatting needed, and
no confusing 404 (that only happens on `/mcp`, since it's a POST-only route;
`/health` is GET, so a browser or plain `curl` works directly).

If this times out or refuses to connect from another PC, it's a networking
problem (firewall, wrong IP, wrong network profile) — see the troubleshooting
notes at the bottom of this guide. If it works, TeamHub itself is fine.

### Step 2b — Open the monitoring dashboard

Once TeamHub is running, open `http://<teamhub-host-ip>:8787/` (same host
and port as everything else) in any browser — no separate setup, no login.
You get:

- **Dashboard** — task-status counts, active sprint, full team roster.
- **Board** — a Jira-like Kanban across backlog/todo/in_progress/in_review/done/blocked, updating live as tasks move.
- **Sprints** — every sprint with its tasks.
- **Team** — every registered member, their role/mode, and a "Message" button.
- **Messages** — pick any member, see your full conversation history with
  them (not just what's unread), and reply — choose which registered
  handle to send as via the "Acting as" picker in the top bar.

This is a convenience for humans, not a new access-control layer — same
no-auth trust model as the rest of TeamHub. Anyone who can reach the port
can open the dashboard and reply as any handle, same as they already could
via `send_message`.

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

Put `skills/team-lead`, `skills/team-developer`, `skills/tester`, and
(optionally) `skills/project-planner` into each relevant machine's
`.claude/skills/` folder:
- The Lead's machine gets `team-lead` (and `project-planner` if that human
  will also be setting up new projects).
- Each Developer's machine gets `team-developer`.
- Each Tester's machine gets `tester` — pulls test tasks, runs/writes
  tests, files bugs, and reports results back to the Lead. Same setup as a
  Developer otherwise (register with `role="tester"` instead).

## Step 5 — Kick off a new project (human-driven, interactive)

This is the primary way to start real work — a human drives it, sees
everything live in their own terminal.

**Important:** the Lead is not a gatekeeper. Both the Lead session and every
Developer session are plain, interactive `claude` sessions — the skill is
just a default playbook, not a restriction. Any human, on either side, can
directly ask their session to call any TeamHub tool at any time (e.g. a
developer's human can say "create a task for this bug and assign it to
yourself" without the Lead being involved). See
`docs/example-walkthrough.md` for this in action.

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

## Step 5b — (Optional) Connect from Claude Desktop instead of Claude Code

Everything above assumes the Claude Code CLI (`claude`). If someone on the
team prefers the Claude Desktop app, it can talk to the same TeamHub server
— but unlike `.mcp.json`, Desktop's config only supports **local stdio
servers** (a `command` it spawns), not a `"type": "http"` remote entry.
Since TeamHub only exposes HTTP, Desktop needs a small stdio↔HTTP bridge —
the standard tool for that is the
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) npm package,
spawned via `npx`. Requires Node.js installed on the Desktop machine (same
requirement TeamHub itself already has).

1. Open Claude Desktop → **Settings → Developer → Edit Config** (or open
   the config file directly):
   - **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
   - **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Linux:** `~/.config/Claude/claude_desktop_config.json`
2. Add a `command`-based entry that bridges to TeamHub's HTTP endpoint:

   ```json
   {
     "mcpServers": {
       "teamhub": {
         "command": "npx",
         "args": ["-y", "mcp-remote", "http://192.168.1.20:8787/mcp"]
       }
     }
   }
   ```
3. Restart Claude Desktop. Open a new chat — the `teamhub` tools
   (`register`, `check_inbox`, `create_task`, etc.) now appear in that
   chat's tool list, same as in Claude Code. The first launch may take a
   few seconds while `npx` fetches `mcp-remote`.

**One real limitation:** Claude Desktop has no skills system, so
`team-lead` / `team-developer` won't auto-load there. To get the same
behavior, either paste the relevant `skills/*/SKILL.md` file's contents
into the conversation once (it's plain Markdown instructions — Desktop
follows them fine as pasted-in context), or just tell it directly what
role it's playing, e.g.: *"You're the Team Lead for project bts-project,
handle master-1. Register yourself, then check the backlog and assign
ready work to registered developers."* Everything else in this guide
(kicking off a project, assigning tasks, reporting status) works
identically once that's set up — it's the same `teamhub` tools either way.

## Step 6 — (Optional) Run unattended with the headless runner

For overnight or unattended operation instead of an interactive session.
If you installed via `npm install -g @masterdeepak15/teamhub-cli`, use
`teamhub agent` — no repo checkout needed:

```bash
# Run these FROM the actual project directory you want worked on — cwd is
# where the session-tracking file lives AND where the spawned claude -p
# process does its Read/Edit/Bash work.
cd /path/to/your/project

# Lead / Master, any OS:
teamhub agent --role master --project bts-project --handle master-1

# Developer, any OS (manual mode — default, same as before):
teamhub agent --role developer --project bts-project --handle dev-A --master-handle master-1

# Tester, any OS:
teamhub agent --role tester --project bts-project --handle tester-1 --master-handle master-1
```

(From a repo checkout instead, the equivalent is `npm run agent -- --role ...` —
same underlying code, same cwd behavior, just invoked via npm scripts.)

This requires `claude` on your `PATH` (same requirement as any Claude Code
usage) and replaces the old bash + `jq` scripts — no extra dependencies are
needed on Windows.

### Auto mode: auto-approved edits + the Lead can interrupt it

Add `--mode auto` on a headless Developer or Tester to auto-approve file
edits (`--permission-mode acceptEdits` — same as manual mode, no change
there) **and** let the Lead remotely stop and redirect its in-flight work
via `interrupt_developer`, instead of waiting for the next cycle. Bash
commands still require confirmation in both modes — auto mode is
deliberately never `bypassPermissions`, since TeamHub has no authentication
and a crafted `interrupt_developer` reason would otherwise be a real
prompt-injection path straight to unconfirmed shell execution:

```bash
# Run from the project directory — TEAMHUB_URL points the watchdog at the
# TeamHub host directly (separately from whatever .mcp.json has, since the
# watchdog talks to TeamHub without spawning `claude` at all):
TEAMHUB_URL=http://192.168.1.20:8787/mcp \
  teamhub agent --role developer --project bts-project --handle dev-A \
  --master-handle master-1 --mode auto --watchdog-interval 5
```

- `--watchdog-interval` (seconds, default 5) controls how often the
  watchdog checks for an interrupt while a cycle is running — lower means
  faster reaction, at the cost of slightly more frequent network calls to
  TeamHub.
- `TEAMHUB_URL` defaults to `http://localhost:<TEAMHUB_PORT or 8787>/mcp` if
  unset, which only works when the Developer and TeamHub happen to run on
  the same machine. In the normal cross-machine setup, set it explicitly.
- This mode choice is per-registration and can be changed anytime — either
  restart the runner with a different `--mode`, or have any session call
  `set_mode(handle, "auto" | "manual")` directly.
- `--mode auto` only changes behavior for a **headless** Developer or
  Tester. Setting
  it while running interactively just records the intent in TeamHub —
  Claude Code's own permission prompts in an interactive session aren't
  affected, and nothing can remotely kill a turn a human is watching. See
  `docs/architecture.md` for the full mechanism (the watchdog polls
  `check_interrupt` directly over MCP and kills the in-flight `claude -p`
  process the moment the Lead calls `interrupt_developer`).

## Troubleshooting: "it works on the TeamHub host but not from another PC"

This is almost always networking, not TeamHub itself — work through these in
order, on the **TeamHub host machine**:

1. **Wrong IP, not a real block.** Confirm the host's actual LAN IP with
   `ipconfig` (Windows) / `ifconfig` / `ip addr` (Mac/Linux) — don't use
   `localhost` in another machine's config, that always means "itself."
2. **Same-machine tests aren't proof.** `curl`/opening `/health` *from the
   TeamHub host itself*, even using its own LAN IP, can succeed via loopback
   even when a different machine would be blocked by the firewall. Always
   test from the *other* machine.
3. **Confirm it's listening on all interfaces:**
   ```powershell
   netstat -ano | findstr 8787
   ```
   Look for `0.0.0.0:8787` in `LISTENING` state (TeamHub binds this way by
   default).
4. **Windows Firewall — the most common blocker.** A connection that times
   out (not "refused") from another machine usually means packets are being
   silently dropped. Add an inbound rule, as Administrator:
   ```powershell
   New-NetFirewallRule -DisplayName "TeamHub" -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow -Profile Any
   ```
   Verify it actually exists:
   ```powershell
   Get-NetFirewallRule -DisplayName "TeamHub" | Format-List DisplayName, Enabled, Direction, Action, Profile
   ```
5. **Network profile.** `Get-NetConnectionProfile` — if `NetworkCategory` is
   `Public`, Windows Firewall blocks most inbound traffic regardless of
   app-specific rules unless the rule above used `-Profile Any`.
6. **Third-party antivirus/firewall software** (Norton, McAfee, Kaspersky,
   etc.) runs its own separate firewall Windows Firewall commands can't see
   — check its settings too if the above doesn't fix it.

Once fixed, retest from the *other* machine with the plain TCP check:
```powershell
Test-NetConnection -ComputerName 192.168.1.20 -Port 8787
```
or hit `http://192.168.1.20:8787/health` directly in a browser — both should
work without needing to speak the MCP protocol at all.

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
