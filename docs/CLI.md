# TeamHub CLI Reference

Installed via:

```bash
npm install -g @masterdeepak15/teamhub-cli
```

Every command below is `teamhub <command> [options]`. Run `teamhub --help`
or `teamhub help` (or just `teamhub` with no arguments) for a shorter
version of this same reference.

---

## `install`

```bash
teamhub install [--skills] [--mcp] [--desktop] [--autostart] [--port <n>] [--db <path>] [--url <url>]
```

Sets up TeamHub in the **current directory** / on this machine.

- With **no flags**, prompts interactively (`y`/`N`) for each optional step below.
- With **any flag given**, runs non-interactively — only the steps you passed flags for happen, nothing is prompted.

| Flag | Effect |
|---|---|
| `--skills` | Copies `team-lead`, `team-developer`, `tester`, `project-planner` into `./.claude/skills/` |
| `--mcp` | Adds/updates a `teamhub` entry in `./.mcp.json` |
| `--desktop` | Adds/updates a `teamhub` entry in Claude Desktop's config (via the `mcp-remote` bridge, since Desktop only supports local `command`-based MCP servers) |
| `--autostart` | Registers TeamHub to start at login/boot — Windows Task Scheduler, macOS LaunchAgent, or Linux systemd `--user` service, whichever matches this OS |
| `--port <n>` | Port to use for the `.mcp.json`/Desktop entries and for `--autostart` (default `8787`) |
| `--db <path>` | Custom SQLite file path to bake into `--autostart`'s service definition |
| `--url <url>` | Full TeamHub URL to use in `.mcp.json`/Desktop instead of deriving it from `--port` (useful if TeamHub runs on a different machine than the one you're running `install` on) |

Examples:

```bash
# Interactive — asks about each step
teamhub install

# Non-interactive: just the skills and .mcp.json, nothing else
teamhub install --skills --mcp

# Non-interactive: everything, custom port
teamhub install --skills --mcp --desktop --autostart --port 9000
```

---

## `start`

```bash
teamhub start [--port <n>] [--db <path>]
```

Starts the TeamHub server as a detached background process.

- `--port` (default `8787`) — the port it listens on.
- `--db` (default: a file next to the installed package) — path to the SQLite file. Pass the same value every time you start it, or it'll create a fresh empty database.
- Records the pid to `~/.teamhub/teamhub.pid`, logs to `~/.teamhub/teamhub.log`, and remembers the port/db used in `~/.teamhub/teamhub.meta.json` (read by `upgrade` so it can restart with the same settings automatically).
- If TeamHub is already running, prints its existing pid and does nothing else.

---

## `stop`

```bash
teamhub stop
```

Stops the background TeamHub server (reads the pid file, sends a proper
kill — `taskkill /T /F` on Windows, `SIGTERM` elsewhere). Safe to run even
if it isn't currently running.

---

## `status`

```bash
teamhub status
```

Reports whether TeamHub is currently running and, if so, its pid and log
file path. This only checks the **local machine** — see the setup guide's
troubleshooting section for checking reachability from a different PC
(`curl http://<host-ip>:8787/health` or `Test-NetConnection`).

---

## `logs`

```bash
teamhub logs [--lines <n>] [--follow]
```

Prints the TeamHub server's log output.

- `--lines <n>` (default `50`) — how many lines from the end to print.
- `--follow` — after printing, keep the process alive and stream new lines as they're written (like `tail -f`).

---

## `agent`

```bash
teamhub agent --role <master|developer|tester> --project <id> --handle <name> [--master-handle <name>] [--mode auto|manual] [--cycle <seconds>] [--watchdog-interval <seconds>]
```

Runs a **headless, unattended** loop for one of the three roles — no repo
checkout needed, works directly from the globally-installed CLI.

**Important:** run this from the actual project directory you want worked
on. `process.cwd()` at the moment you run it is where the session-tracking
file lives, and — for `developer`/`tester` — where the spawned `claude -p`
process does its actual Read/Edit/Bash work.

| Flag | Meaning |
|---|---|
| `--role` | `master` (Lead), `developer`, or `tester` |
| `--project` | The TeamHub project id this handle registers under |
| `--handle` | This session's unique handle |
| `--master-handle` | Required for `developer`/`tester` — who they report to |
| `--mode` | `manual` (default) or `auto`. `auto` only changes real behavior for `developer`/`tester`: file edits auto-approve, and the Lead can genuinely interrupt and redirect in-flight work via `interrupt_developer`. Bash still requires confirmation either way — see `docs/architecture.md` for why `bypassPermissions` is deliberately never used. |
| `--cycle` | Seconds between check-inbox cycles (default `60` for master, `30` for developer/tester) |
| `--watchdog-interval` | Only relevant with `--mode auto` — how often (seconds, default `5`) the interrupt watchdog polls while a cycle is running |

`TEAMHUB_URL` env var (default `http://localhost:<TEAMHUB_PORT or 8787>/mcp`)
points the `--mode auto` watchdog at the TeamHub host — set this explicitly
whenever TeamHub runs on a different machine than the agent.

Examples:

```bash
cd /path/to/your/project

teamhub agent --role master --project bts-project --handle master-1

teamhub agent --role developer --project bts-project --handle dev-A --master-handle master-1

TEAMHUB_URL=http://192.168.1.20:8787/mcp \
  teamhub agent --role tester --project bts-project --handle tester-1 \
  --master-handle master-1 --mode auto --watchdog-interval 5
```

---

## `upgrade` (alias `update`)

```bash
teamhub upgrade [--port <n>] [--db <path>]
```

Self-updates: stops the running server (if any), runs
`npm install -g @masterdeepak15/teamhub-cli@latest`, then starts it back up.

- Without `--port`/`--db`, restarts with whatever it was **last** started
  with (read from `~/.teamhub/teamhub.meta.json`) — you don't need to
  remember or re-pass them.
- Safe to run even if TeamHub isn't currently running (skips the stop step).
- If the npm install itself fails (no internet, permissions, etc.), still
  starts the server back up with whichever version is currently installed,
  so a failed upgrade attempt doesn't leave the team without a server.

---

## `uninstall`

```bash
teamhub uninstall [--force]
```

Removes TeamHub from this machine.

1. Stops the running server (if any).
2. Removes any auto-start registration (same as `uninstall-autostart`).
3. Uninstalls `@masterdeepak15/teamhub-cli` via a **detached, backgrounded**
   `npm uninstall -g` call — this CLI process is itself a file inside the
   package being removed, so the actual removal finishes a moment after
   the command returns, not synchronously within it.

**Your data is kept by default** — the SQLite database, and the state
files under `~/.teamhub/` (pid, log, `teamhub.meta.json`). Pass `--force`
to also delete it:

- A custom `--db <path>` used by `start` (if any) is removed explicitly,
  since it lives outside the package directory and would otherwise survive
  the uninstall.
- The default database (created next to the package's own files, if you
  never passed `--db`) is removed automatically as part of removing the
  package — nothing extra to do for that case.
- The entire `~/.teamhub/` directory (pid/log/meta) is deleted.

```bash
teamhub uninstall            # keep the data, just remove the program
teamhub uninstall --force    # remove the program AND all its data
```

To reinstall later: `npm install -g @masterdeepak15/teamhub-cli@latest`.

---

## `uninstall-autostart`

```bash
teamhub uninstall-autostart
```

Removes whatever auto-start registration `install --autostart` created —
the Windows scheduled task, macOS LaunchAgent, or Linux systemd `--user`
service, matching this OS. Safe to run even if none was ever registered.

---

## `help` / `--help`

```bash
teamhub help
teamhub --help
teamhub          # same as `help` with no arguments
```

Prints the command reference (a shorter version of this file).

---

## Files this CLI reads/writes

| Path | What |
|---|---|
| `~/.teamhub/teamhub.pid` | pid of the currently running background server |
| `~/.teamhub/teamhub.log` | its stdout/stderr |
| `~/.teamhub/teamhub.meta.json` | last-used port/db, so `upgrade` can restart identically |
| `./.claude/skills/*` | skills copied in by `install --skills` (relative to wherever you ran `install`) |
| `./.mcp.json` | edited in place by `install --mcp` (merges in a `teamhub` entry, preserves everything else already there) |
| Claude Desktop's `claude_desktop_config.json` | edited in place by `install --desktop` |
