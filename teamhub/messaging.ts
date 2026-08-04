import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "./db.js";
import { setMemberStatus, touchMember } from "./members.js";
import { emitChange } from "./events.js";
import { getTaskByRef } from "./tasks.js";

export interface Message {
  id: string;
  project_id: string;
  from_handle: string;
  to_handle: string;
  type: "task_assignment" | "message" | "status_update" | "interrupt";
  text: string;
  task_ref?: string;
  ts: string;
  read: boolean;
}

function now(): string {
  return new Date().toISOString();
}

function insertMessage(msg: Message): void {
  db.prepare(
    `INSERT INTO messages (id, project_id, from_handle, to_handle, type, text, task_ref, ts, read)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).run(msg.id, msg.project_id, msg.from_handle, msg.to_handle, msg.type, msg.text, msg.task_ref ?? null, msg.ts);
  emitChange("message", msg.project_id);
}

function rowToMessage(row: any): Message {
  return { ...row, read: Boolean(row.read), task_ref: row.task_ref ?? undefined };
}

export function notifyAssignment(
  project_id: string,
  from_handle: string,
  to_handle: string,
  task_ref: string,
  summary: string
): Message {
  // Enforced here, not just documented, because the documentation alone
  // wasn't stopping it: a Lead under time pressure would hand out work by
  // describing it in a plain send_message instead of running it through
  // create_task first, and that work would then never show up in
  // list_tasks / the board — exactly the "not actually in our task list"
  // problem this check exists to make impossible rather than just discouraged.
  if (!getTaskByRef(task_ref)) {
    throw new Error(
      `No task "${task_ref}" exists yet. Call create_task first to get a real task_ref, ` +
        `then notify_assignment with that ref — don't hand out work as a plain message.`
    );
  }
  const msg: Message = {
    id: randomUUID(),
    project_id,
    from_handle,
    to_handle,
    type: "task_assignment",
    text: summary,
    task_ref,
    ts: now(),
    read: false,
  };
  insertMessage(msg);
  return msg;
}

export function sendMessage(
  project_id: string,
  from_handle: string,
  to_handle: string,
  text: string
): Message {
  if (from_handle === to_handle) {
    throw new Error(
      `from_handle and to_handle can't both be "${from_handle}" — a member can't message itself.`
    );
  }
  const msg: Message = {
    id: randomUUID(),
    project_id,
    from_handle,
    to_handle,
    type: "message",
    text,
    ts: now(),
    read: false,
  };
  insertMessage(msg);
  return msg;
}

export function reportStatus(
  project_id: string,
  from_handle: string,
  task_ref: string,
  status: string,
  note: string
): Message {
  // Same enforcement as notifyAssignment: a status update against a
  // task_ref that was never actually created would otherwise still "work"
  // (the message sends fine) while leaving no trace in the task list at
  // all — silently invisible on the board even though it looks reported.
  if (!getTaskByRef(task_ref)) {
    throw new Error(
      `No task "${task_ref}" exists — report_status needs a real task_ref from create_task. ` +
        `If this work was never turned into a task, create one first.`
    );
  }
  setMemberStatus(from_handle, status);
  const master = db
    .prepare(`SELECT handle FROM members WHERE project_id = ? AND role = 'master' LIMIT 1`)
    .get(project_id) as { handle: string } | undefined;
  if (!master) {
    // Previously fell back to a literal "master" handle that belongs to no
    // one, so the status update just sat there undelivered with no error
    // and no way to notice. Fail loudly instead — the caller (a developer
    // mid-cycle) gets a clear reason rather than a silent no-op.
    throw new Error(
      `No master is registered yet for project "${project_id}" — there's no one to deliver this status update to.`
    );
  }
  const msg: Message = {
    id: randomUUID(),
    project_id,
    from_handle,
    to_handle: master.handle,
    type: "status_update",
    text: `[${status}] ${note}`,
    task_ref,
    ts: now(),
    read: false,
  };
  insertMessage(msg);
  return msg;
}

export function interruptDeveloper(
  project_id: string,
  from_handle: string,
  to_handle: string,
  reason: string
): Message {
  const msg: Message = {
    id: randomUUID(),
    project_id,
    from_handle,
    to_handle,
    type: "interrupt",
    text: reason,
    ts: now(),
    read: false,
  };
  insertMessage(msg);
  return msg;
}

// Unlike checkInbox, this only reads and consumes 'interrupt'-type rows —
// used by the headless runner's watchdog so it doesn't steal ordinary
// task_assignment/message/status_update rows meant for the main turn.
export function peekInterrupt(handle: string): Message | undefined {
  const row = db
    .prepare(
      `SELECT * FROM messages WHERE to_handle = ? AND type = 'interrupt' AND read = 0 ORDER BY ts ASC LIMIT 1`
    )
    .get(handle) as any;
  if (!row) return undefined;
  db.prepare(`UPDATE messages SET read = 1 WHERE id = ?`).run(row.id);
  return rowToMessage(row);
}

export function checkInbox(handle: string): Message[] {
  // UPDATE...RETURNING in one statement, not a SELECT followed by a
  // separate UPDATE WHERE read = 0. The old two-step version had a real
  // gap: if a new message arrived between the SELECT and the UPDATE (e.g.
  // the dashboard sends one while a cycle is mid-check), the UPDATE's own
  // `read = 0` condition would silently mark that new, never-returned
  // message as read too — lost without the caller ever seeing it. Doing
  // both in one statement means exactly the rows that transition are the
  // rows handed back.
  const rows = db
    .prepare(`UPDATE messages SET read = 1 WHERE to_handle = ? AND read = 0 RETURNING *`)
    .all(handle) as any[];
  rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  touchMember(handle);
  return rows.map(rowToMessage);
}

// Non-mutating — doesn't touch `read` at all. Used by the monitoring UI to
// show full conversation history (including already-read messages), which
// checkInbox deliberately can't do since it's an ack-on-read operation.
export function listMessages(project_id: string, handle?: string): Message[] {
  let sql = `SELECT * FROM messages WHERE project_id = ?`;
  const params: unknown[] = [project_id];
  if (handle) {
    sql += ` AND (from_handle = ? OR to_handle = ?)`;
    params.push(handle, handle);
  }
  sql += ` ORDER BY ts ASC`;
  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map(rowToMessage);
}

export function registerTools(server: McpServer): void {
  server.tool(
    "notify_assignment",
    "Master only: notify a developer's inbox that a task has been assigned to them. Create the actual task first via create_task to get a task_ref, then call this.",
    {
      project_id: z.string(),
      from_handle: z.string(),
      to_handle: z.string(),
      task_ref: z.string(),
      summary: z.string().describe("Short human-readable task summary"),
    },
    async ({ project_id, from_handle, to_handle, task_ref, summary }) => {
      try {
        notifyAssignment(project_id, from_handle, to_handle, task_ref, summary);
        return { content: [{ type: "text", text: `Task ${task_ref} assignment notified to ${to_handle}.` }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );

  server.tool(
    "send_message",
    "Send a direct message to another team member's handle (master<->developer, either direction). " +
      "For general chat, questions, and check-ins only — NOT for handing out work (use create_task + " +
      "notify_assignment, which now require a real task_ref) and NOT for progress/status updates on a " +
      "task (use report_status, which links back to the task and updates the board). Anything sent as a " +
      "plain message never appears in list_tasks or the dashboard board.",
    { project_id: z.string(), from_handle: z.string(), to_handle: z.string(), text: z.string() },
    async ({ project_id, from_handle, to_handle, text }) => {
      try {
        sendMessage(project_id, from_handle, to_handle, text);
        return { content: [{ type: "text", text: `Message sent to ${to_handle}.` }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );

  server.tool(
    "report_status",
    "Developer only: report progress/status on a task. Automatically notifies the project's registered master.",
    {
      project_id: z.string(),
      from_handle: z.string(),
      task_ref: z.string(),
      status: z.enum(["started", "in_progress", "blocked", "done", "failed"]),
      note: z.string(),
    },
    async ({ project_id, from_handle, task_ref, status, note }) => {
      try {
        reportStatus(project_id, from_handle, task_ref, status, note);
        return { content: [{ type: "text", text: `Status reported: ${status}.` }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );

  server.tool(
    "check_inbox",
    "Check for new unread messages/task assignments addressed to this handle. Call this at the start of every turn/cycle.",
    { handle: z.string() },
    async ({ handle }) => {
      try {
        const messages = checkInbox(handle);
        if (messages.length === 0) {
          return { content: [{ type: "text", text: "No new messages." }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(messages, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );

  server.tool(
    "interrupt_developer",
    "Master only: interrupt a developer's in-flight work with a new instruction. Only takes effect if that developer is registered in 'auto' mode and running headless via agents/runner.ts — its watchdog polls for this and kills + redirects the current turn. For a developer in 'manual' mode (or running interactively), this just arrives as a normal inbox item they'll see on their own next check.",
    {
      project_id: z.string(),
      from_handle: z.string(),
      to_handle: z.string(),
      reason: z.string().describe("What to stop and what to do instead"),
    },
    async ({ project_id, from_handle, to_handle, reason }) => {
      try {
        interruptDeveloper(project_id, from_handle, to_handle, reason);
        return { content: [{ type: "text", text: `Interrupt sent to ${to_handle}.` }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );

  server.tool(
    "check_interrupt",
    "Check whether an interrupt has been sent to this handle, without consuming any other unread messages. Intended for the headless runner's watchdog, not for normal turn-start use — use check_inbox for that.",
    { handle: z.string() },
    async ({ handle }) => {
      try {
        const interrupt = peekInterrupt(handle);
        if (!interrupt) {
          return { content: [{ type: "text", text: "No interrupt." }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(interrupt, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );
}
