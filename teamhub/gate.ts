import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "./db.js";
import { listTasks } from "./tasks.js";
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
export function hasReadyUnassignedWork(project_id: string): boolean {
  const backlog = listTasks(project_id, { status: "backlog" });
  const todo = listTasks(project_id, { status: "todo" });
  return [...backlog, ...todo].some((t) => !t.assignee_handle);
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
