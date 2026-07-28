# TeamHub Worked Example (start to finish)

This walks through one complete, concrete run: two machines, one small
project, real commands, and real conversation snippets — so "how do I
actually use this" has a literal answer instead of an abstract one.

**Machines used in this example:**
- **PC1** (`192.168.1.20`) — runs TeamHub, and is also where the human
  Lead works.
- **PC2** — where the human Developer ("dev-A") works.

You can run PC1 and PC2 roles on the *same* machine too (two terminal tabs)
— TeamHub doesn't care where a session physically runs, only that it can
reach the TeamHub HTTP endpoint.

## Who can actually give tasks? (read this first)

**Both the Lead session and every Developer session are just plain,
interactive `claude` sessions.** The `team-lead` / `team-developer` skill
is only a *default playbook* loaded into that session — it is not a
restriction. That means:

- The human running the Lead session can tell it to do anything a normal
  Claude Code session can do, including calling `create_task`,
  `assign_task`, or `notify_assignment` directly and manually — they don't
  have to hand over a full "project brief" and wait for the Lead to derive
  tasks from it. E.g. simply typing *"create a task called 'Add password
  reset' in bts-project and assign it to dev-A"* works immediately.
- The human running a Developer session can do the same thing on their
  side — check their own inbox, report their own status, or even create a
  task for themselves (`create_task` + `assign_task` to their own handle)
  without the Lead being involved at all, if that's how your team prefers
  to work.
- Nothing in TeamHub enforces that only the Lead assigns work. That's a
  *convention* the skills describe (so agents default to sensible behavior
  when running unattended), not a permission the server checks. Any
  registered handle can call any tool.

In short: every human, on every side, has a full interface into TeamHub —
the skills just make the *default* behavior sensible so you don't have to
spell out "create a project, then a sprint, then a task" every time.

## Step 0 — Install and start TeamHub (PC1)

```bash
cd claude-team-protocol
npm install
npm run build
TEAMHUB_PORT=8787 npm run teamhub
```

You should see:

```
teamhub listening on http://0.0.0.0:8787/mcp
Point other machines at http://<this-PC-LAN-IP>:8787/mcp
```

Leave this running in its own terminal — it's the shared server both PC1
and PC2 will talk to. Find PC1's LAN IP with `ipconfig` (Windows) or
`ifconfig` (Mac/Linux) — this example uses `192.168.1.20`.

## Step 1 — Wire `.mcp.json` on both PC1 and PC2

Same file, same content, on **both** machines:

```json
{
  "mcpServers": {
    "teamhub": { "type": "http", "url": "http://192.168.1.20:8787/mcp" },
    "github":  { "...": "your existing GitHub MCP config" }
  }
}
```

## Step 2 — Install the skills

- **PC1** (Lead): copy `skills/team-lead/` into PC1's `.claude/skills/team-lead/`.
- **PC2** (Developer): copy `skills/team-developer/` into PC2's
  `.claude/skills/team-developer/`.

## Step 3 — PC1: start the Lead session and kick off a project

In a new terminal on PC1, in the project directory:

```bash
claude
```

Type this directly into the conversation (this is the human giving the
brief — a real message, not a command):

> I'm the lead on this. We're building a small internal tool: a CLI that
> takes a CSV of employee names and emails and sends each of them a
> templated welcome email via SMTP. Needs: (1) parse the CSV, (2) render a
> template with their name, (3) send via SMTP with retries on failure, (4)
> a dry-run mode that only prints what would be sent. Set this up as
> project "welcome-mailer" with prefix WM, and break it into tasks.

Because `team-lead` is installed, the session knows to register itself,
then create the project and break the brief into tasks. You'll see it call
tools live in your terminal, roughly:

```
→ register(handle="master-1", role="master", project_id="welcome-mailer")
→ create_project(id="welcome-mailer", name="Welcome Mailer", key_prefix="WM")
→ create_task(project_id="welcome-mailer", title="Parse CSV of name/email pairs")
→ create_task(project_id="welcome-mailer", title="Render welcome email template")
→ create_task(project_id="welcome-mailer", title="Send via SMTP with retry on failure")
→ create_task(project_id="welcome-mailer", title="Add --dry-run flag")
```

It'll report back something like: *"Created project welcome-mailer (WM)
with 4 tasks: WM-1 Parse CSV..., WM-2 Render template..., WM-3 SMTP
send+retry..., WM-4 --dry-run flag. No developers registered yet — let me
know handles once someone's online."*

**You could instead have skipped the brief entirely** and just said:
*"Create project welcome-mailer with prefix WM, then create a task called
'Parse CSV of name/email pairs'."* — same result for that one task, no
brief-parsing needed. Use whichever fits what you're doing.

## Step 4 — PC2: start the Developer session and register

In a new terminal on PC2, in the same project directory:

```bash
claude
```

Type:

> I'm dev-A on the welcome-mailer project, reporting to master-1. Register
> me and check my inbox.

`team-developer` handles this:

```
→ register(handle="dev-A", role="developer", project_id="welcome-mailer")
→ check_inbox(handle="dev-A")
```

Since nothing's assigned yet, it reports: *"Registered as dev-A. No new
messages."*

## Step 5 — PC1: assign work now that dev-A exists

Back in the Lead's terminal:

> dev-A just registered. Assign them WM-1 and WM-2 to start.

```
→ list_team(project_id="welcome-mailer")          # confirms dev-A is there
→ assign_task(task_ref="WM-1", assignee_handle="dev-A")
→ notify_assignment(project_id="welcome-mailer", from_handle="master-1", to_handle="dev-A", task_ref="WM-1", summary="Parse CSV of name/email pairs")
→ assign_task(task_ref="WM-2", assignee_handle="dev-A")
→ notify_assignment(..., task_ref="WM-2", summary="Render welcome email template")
```

## Step 6 — PC2: pick up the assignment and work it

Back in the Developer's terminal:

> Check my inbox and start on whatever's there.

```
→ check_inbox(handle="dev-A")
   → [task_assignment WM-1, task_assignment WM-2]
→ get_task(task_ref="WM-1")
```

It reads the full task, then works it exactly like any normal Claude Code
session — reading/writing files, running the CSV parser, committing with
this machine's own git. As it makes progress:

```
→ update_task_status(task_ref="WM-1", status="in_progress")
   ...codes the CSV parser, writes a test, runs it, commits...
→ update_task_status(task_ref="WM-1", status="done")
→ report_status(project_id="welcome-mailer", from_handle="dev-A", task_ref="WM-1", status="done", note="CSV parser done, handles missing email column with a clear error")
```

That `report_status` call is what lands in the Lead's inbox — so on PC1,
next time you (or the Lead session) checks:

> Check your inbox.

```
→ check_inbox(handle="master-1")
   → [status_update from dev-A: "[done] CSV parser done, handles missing email column with a clear error"]
```

## Step 7 — If dev-A gets stuck

On PC2:

> I'm blocked on WM-3 — not sure if we should use smtplib directly or a
> queue-backed sender for retries. Ask master-1.

```
→ report_status(..., task_ref="WM-3", status="blocked", note="smtplib direct-retry vs queue-backed sender?")
→ send_message(project_id="welcome-mailer", from_handle="dev-A", to_handle="master-1", text="Direct smtplib retry, or a queue-backed sender for WM-3?")
```

On PC1, the human sees the message next inbox check and answers directly
— no special tool needed, just:

> Tell dev-A: direct smtplib with exponential backoff is fine for this
> scale, no queue needed.

```
→ send_message(project_id="welcome-mailer", from_handle="master-1", to_handle="dev-A", text="Direct smtplib with exponential backoff is fine, no queue needed.")
```

## Checking overall project health at any point

Either human, on either machine, can ask for a status roll-up at any time
— this doesn't require the Lead or a special role:

> List all tasks in welcome-mailer and their statuses.

```
→ list_tasks(project_id="welcome-mailer")
```

## Running unattended instead (optional)

Everything above was interactive (a human typing each instruction). If you
instead want this to run on its own for a while, replace the `claude`
session with the headless runner (see `docs/setup-guide.md` Step 6):

```bash
# PC1:
npm run agent -- --role master --project welcome-mailer --handle master-1

# PC2:
npm run agent -- --role developer --project welcome-mailer --handle dev-A --master-handle master-1
```

It calls the exact same tools, on a timer, instead of you typing each
instruction — you can mix modes too (Lead interactive, Developer headless,
or vice versa), since they're all just talking to the same TeamHub server.
