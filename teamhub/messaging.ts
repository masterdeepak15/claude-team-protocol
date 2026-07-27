import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "./db.js";
import { setMemberStatus, touchMember } from "./members.js";

export interface Message {
  id: string;
  project_id: string;
  from_handle: string;
  to_handle: string;
  type: "task_assignment" | "message" | "status_update";
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
  setMemberStatus(from_handle, status);
  const master = db
    .prepare(`SELECT handle FROM members WHERE project_id = ? AND role = 'master' LIMIT 1`)
    .get(project_id) as { handle: string } | undefined;
  const msg: Message = {
    id: randomUUID(),
    project_id,
    from_handle,
    to_handle: master ? master.handle : "master",
    type: "status_update",
    text: `[${status}] ${note}`,
    task_ref,
    ts: now(),
    read: false,
  };
  insertMessage(msg);
  return msg;
}

export function checkInbox(handle: string): Message[] {
  const rows = db
    .prepare(`SELECT * FROM messages WHERE to_handle = ? AND read = 0 ORDER BY ts ASC`)
    .all(handle) as any[];
  db.prepare(`UPDATE messages SET read = 1 WHERE to_handle = ? AND read = 0`).run(handle);
  touchMember(handle);
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
    "Send a direct message to another team member's handle (master<->developer, either direction).",
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
}
