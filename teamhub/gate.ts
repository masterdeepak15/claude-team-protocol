import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "./db.js";
import { listTasks } from "./tasks.js";
import { listTeam } from "./members.js";
import type { Role } from "./members.js";

// Pure DB reads only — no Claude call, no tokens spent. Called directly over
// MCP by the headless runner's idle gate (see agents/runner.ts) before it
// decides whether a real `claude -p` cycle is worth spawning at all.

export function hasUnreadMessages(handle: string): boolean {
  const row = db
    .prepare(`SELECT COUNT(*) as n FROM messages WHERE to_handle = ? AND read = 0`)
    .get(handle) as { n: number };
  return row.n > 0;
}

// Only meaningful for the master role — developers/testers never need to
// look at unassigned backlog themselves, they only ever act on what's
// assigned to their own handle.
//
// Two things matter here, both learned the hard way from a real session
// that racked up 17 cycles / ~9M cache-read tokens with nothing to show
// for it, purely from this gate firing on every single long-poll
// reconnect:
//
//   1. Only `todo` counts as "ready". `backlog` is every task's default
//      status at creation (see tasks.ts) and explicitly means "not yet
//      groomed/ready" — a normal project almost always has *something*
//      sitting in backlog, so counting it here meant this gate was true
//      almost permanently, not just when something actually needed the
//      master's attention.
//   2. Even a genuinely ready `todo` task shouldn't count as "pending" if
//      nobody has capacity to take it — this exactly mirrors the
//      condition the master's own cyclePrompt already uses ("if a
//      developer or tester has no active task and there is ready work for
//      them, assign it"). Without this, an unassigned todo task with both
//      developers already busy would re-trigger a full paid cycle on
//      every reconnect forever, even though the master's own judgment —
//      correctly — is "nothing to assign, everyone's occupied".
export function hasReadyUnassignedWork(project_id: string): boolean {
  const ready = listTasks(project_id, { status: "todo" }).some((t) => !t.assignee_handle);
  if (!ready) return false;
  return listTeam(project_id).some((m) => (m.role === "developer" || m.role === "tester") && !hasOwnActiveWork(m.handle));
}

// The other half of "does this handle have work to do": a task already
// assigned to them that isn't finished. Without this, a developer who
// picked up a task in one cycle but didn't finish it would sit forever
// idle-gated out on every later cycle as long as no NEW message arrived —
// the gate only ever looked at unread messages, so in-progress work the
// developer already knows about but hasn't completed was invisible to it.
export function hasOwnActiveWork(handle: string): boolean {
  const rows = db
    .prepare(
      `SELECT COUNT(*) as n FROM tasks WHERE assignee_handle = ? AND status NOT IN ('done', 'blocked')`
    )
    .get(handle) as { n: number };
  return rows.n > 0;
}

export function hasPendingWork(role: Role, handle: string, project_id: string): boolean {
  if (hasUnreadMessages(handle)) return true;
  if (role === "master" && hasReadyUnassignedWork(project_id)) return true;
  if (role !== "master" && hasOwnActiveWork(handle)) return true;
  return false;
}

export function registerTools(server: McpServer): void {
  server.tool(
    "has_pending_work",
    "Cheap, non-AI check for whether this handle has anything to react to right now (unread messages, or for master, unassigned ready backlog). Intended for the headless runner's idle gate, not for normal turn use.",
    {
      role: z.enum(["master", "developer", "tester", "analyst"]),
      handle: z.string(),
      project_id: z.string(),
    },
    async ({ role, handle, project_id }) => {
      try {
        const pending = hasPendingWork(role, handle, project_id);
        return { content: [{ type: "text", text: pending ? "pending" : "idle" }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );
}
