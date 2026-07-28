# Adding TeamHub to a Project You're Already Working On

This is for the common case: you already have a real codebase, you've been
working on it solo (or ad hoc) without any of this, and now you want a
Team Lead + several Developers coordinating on it through TeamHub.

**Key idea: you don't modify your existing project's source at all.**
TeamHub is a separate, small MCP server that runs alongside your project —
your existing repo only gains one `.mcp.json` entry and a `.claude/skills/`
folder. Nothing about your codebase changes.

## Part A — Run the TeamHub server once (any one machine)

Pick one machine to host TeamHub (yours is fine to start). It doesn't need
to live inside your existing project's repo — keep it as its own folder:

```bash
git clone <this claude-team-protocol repo, or copy the teamhub/ folder>
cd claude-team-protocol
npm install
npm run build
TEAMHUB_PORT=8787 npm run teamhub
```

Leave this running. Find this machine's LAN IP (`ipconfig` / `ifconfig`) —
say it's `192.168.1.20`.

## Part B — Wire your EXISTING project to it

In your existing project's root, add or edit `.mcp.json`:

```json
{
  "mcpServers": {
    "teamhub": { "type": "http", "url": "http://192.168.1.20:8787/mcp" },
    "github":  { "...": "your existing GitHub MCP config, unchanged" }
  }
}
```

## Part C — Install the skills into your existing project

The three role skills (`team-lead`, `team-developer`, `project-planner`)
are published as one Claude Code plugin, `teamhub-team`, on the Spyder
marketplace. From inside your existing project's `claude` session:

```
/plugin marketplace add masterdeepak15/Spyder
/plugin install teamhub-team@spyder
```

(Alternative, no marketplace step: `/plugin install
https://github.com/masterdeepak15/Spyder/raw/main/dist/teamhub-team.plugin`)

Whichever human is acting as Lead uses `team-lead` (or `project-planner`
for just the initial setup); every Developer uses `team-developer`.

## Part D — Register your existing backlog as a TeamHub project

You almost certainly already have a mental (or written) backlog. Turn it
into a TeamHub project — as the Lead, type:

> Set up a TeamHub project for this codebase: id "my-existing-app", name
> "My Existing App", prefix "APP". Then create tasks for: fixing the
> flaky checkout test, adding rate limiting to the login endpoint, and
> upgrading the Postgres driver.

This calls `create_project` once, then `create_task` for each item — your
existing backlog is now visible via `list_tasks` to everyone on the team,
without you having touched the codebase itself.

## Part E — Onboard your team, one teammate at a time

This is the "many users" part, and it's just repetition — TeamHub doesn't
have a fixed number of seats or any config to change per additional
teammate. Each new person does exactly this, on their own machine, once:

1. They get the same `.mcp.json` (Part B) and install `teamhub-team`
   (Part C) in their own checkout of your existing project.
2. They open `claude` and type:

   > I'm dev-B on my-existing-app, reporting to master-1. Register me and
   > check my inbox.

   (swap `dev-B` for whatever unique handle you assign them —
   `dev-frontend`, `dev-alice`, anything unique works)

3. Tell the Lead they're online:

   > dev-B just registered. What's ready to assign?

   The Lead calls `list_team` (now shows dev-B alongside anyone else),
   checks the backlog, and assigns accordingly.

Repeat step by step for a 3rd, 4th, 10th teammate — same two prompts each
time, no server restart, no config change, no code change. `list_team` and
`list_tasks` scale to however many handles are registered on the project.

## Part F — Day-to-day, with several developers running at once

The Lead's core loop doesn't change with team size — it's still just:

> Check your inbox, then check the backlog. Assign any ready task to
> whichever registered developer doesn't currently have an active one.

Each developer's loop is the same regardless of how many other developers
exist — they only ever see their own inbox and their own assigned tasks
(`check_inbox`, `get_task`, `report_status` are all scoped to their own
handle). Adding teammates never makes an individual developer's session do
more work or see more noise.

## Reminder: any human can act directly

As covered in `docs/example-walkthrough.md`, none of this requires going
through the Lead. Any teammate can type "create a task for this bug and
assign it to yourself" directly, at any time — the skills describe sane
defaults, they don't gate who's allowed to call which tool.
