# Team Protocol — Session Instructions

This project is coordinated through **TeamHub** (a self-hosted MCP server)
plus role skills (`team-lead`, `team-developer`, `project-planner`). Every
session working in this repo — Lead or Developer, interactive or headless —
should follow the rules below. Copy this file to your project's own
`CLAUDE.md` (merge it in if one already exists) after adopting TeamHub —
see `docs/adopt-into-existing-project.md` in the
[claude-team-protocol](https://github.com/masterdeepak15/claude-team-protocol)
repo for the full setup.

## Your role

- **Team Lead:** use the `team-lead` skill (or `project-planner` for
  setup-only work — creating a project, seeding a sprint, or a health
  summary). Register your handle once per session before anything else.
- **Developer:** use the `team-developer` skill. Register your handle once
  per session, then check your inbox before starting work each turn.
- Both roles are plain, interactive `claude` sessions — nothing stops you
  from calling any TeamHub tool directly, whether or not the skill's
  default flow covers what you're doing right now.

## TeamHub tools (`mcp__teamhub__*`)

- Projects: `create_project`, `list_projects`, `get_project`
- Team/presence: `register`, `list_team`
- Messaging: `check_inbox`, `send_message`, `notify_assignment`, `report_status`
- Sprints: `create_sprint`, `list_sprints`
- Tasks: `create_task`, `list_tasks`, `get_task`, `update_task_status`, `assign_task`, `add_comment`

TeamHub only tracks project/sprint/task/message state — it never touches
your code or git history. That's handled entirely by the tools below.

## Version control — use the `git` CLI directly

- Do all version control with plain `git` — status, diff, add, commit,
  push, branch, merge. Don't look for a TeamHub tool for this; there isn't
  one, by design.
- Run `git status` before committing; stage only files relevant to the
  task you're working.
- Reference the `task_ref` you're working in every commit message so
  history ties back to the TeamHub task, e.g.:

  ```
  git commit -m "APP-14: fix flaky checkout test

  Root cause was a shared fixture leaking state between test runs."
  ```
- Confirm with your human partner before force-pushing, rewriting history,
  or pushing directly to a shared branch like `main`/`master` — same rule
  as any other Claude Code session, TeamHub doesn't change that.
- After pushing, call `update_task_status` (e.g. to `in_review` or `done`)
  and `report_status` so the Lead sees it without having to ask.

## Code search & navigation — prefer Gortex MCP when available

- Check whether this repo is Gortex-indexed: look for `mcp__gortex__*`
  tools in your tool list, or run `gortex daemon status`.
- If Gortex is available and covers this repo, prefer its graph queries
  over raw file reads for anything beyond a one-line lookup:
  `search_symbols` instead of grepping for a name, `find_usages` /
  `get_callers` instead of grepping for references, `get_symbol_source`
  instead of reading a whole file for one function, `get_call_chain` /
  `get_dependents` before changing a shared function's signature (safety
  check on what else it'll break).
- If Gortex isn't running, isn't indexing this repo, or a query comes back
  empty, fall back to normal `Read`/`Grep`/`Glob` — don't block on Gortex
  being present.

## Skills reference

- `team-lead`, `team-developer`, `project-planner` — install from
  `.claude/skills/` (copied in) or via the Spyder marketplace:
  `/plugin marketplace add masterdeepak15/Spyder` then
  `/plugin install teamhub-team@spyder`.
- Full worked examples: `docs/example-walkthrough.md` and
  `docs/adopt-into-existing-project.md` in the claude-team-protocol repo.
