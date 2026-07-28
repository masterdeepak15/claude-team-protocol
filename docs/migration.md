# Migrating from the old relay + planner setup

If you were running the earlier two-MCP-server version of this project
(`relay/` + `planner/`), follow these steps to move to the unified
`teamhub` server without losing data.

## 1. Locate your existing data files

- `relay/team-relay.db.json` (or wherever `TEAM_RELAY_DB` pointed)
- `planner/planner.db.sqlite` (or wherever `PLANNER_DB` pointed)

Copy both into this repo's `legacy/relay/` and `legacy/planner/` folders
respectively (create them if the source-code archive step hasn't already).

## 2. Run the migration script

`npm run migrate` runs the compiled `dist/scripts/migrate-legacy-to-teamhub.js`
(source: `scripts/migrate-legacy-to-teamhub.ts`):

```bash
npm run build
npm run migrate -- legacy/relay/team-relay.db.json legacy/planner/planner.db.sqlite teamhub/teamhub.db.sqlite
```

This prints a summary like:

```
Migration complete: { projects: 1, members: 3, messages: 12, sprints: 2, tasks: 9, comments: 4 }
```

Each old `team_id` becomes a new `projects.id` with the same value — you can
rename the project's display `name` afterwards (a `get_project`/manual
`UPDATE` for now; a rename tool can be added later if needed) but the id
itself stays stable so existing `task_ref`s keep working.

## 3. Update every machine's `.mcp.json`

Replace the old `team-relay` and `planner` (or `jira`) entries with the
single `teamhub` entry described in `docs/setup-guide.md` Step 3.

## 4. Update env vars in any launch scripts

`TEAM_ID` becomes `PROJECT_ID`; `RELAY_PORT`/`PLANNER_PORT` become
`TEAMHUB_PORT` (one port instead of two). If you were using the old bash
`agents/*.sh` scripts, switch to `npm run agent -- --role ... --project ...`
(see `docs/setup-guide.md` Step 6) — the old scripts have been archived to
`legacy/agents/`.

## 5. Verify

Run `list_projects` from any connected `claude` session (or
`sqlite3 teamhub/teamhub.db.sqlite "select * from projects;"` directly) and
confirm your project(s) and their task counts look right before decommissioning
the old `relay`/`planner` processes.
