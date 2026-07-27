import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "./db.js";
import { getProject } from "./projects.js";

export type TaskStatus = "backlog" | "todo" | "in_progress" | "in_review" | "done" | "blocked";

export interface Task {
  id: number;
  project_id: string;
  task_ref: string;
  sprint_id: number | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: string;
  assignee_handle: string | null;
  created_at: string;
  updated_at: string;
}

function now(): string {
  return new Date().toISOString();
}

function nextTaskRef(project_id: string): string {
  const project = getProject(project_id);
  const prefix = project?.key_prefix ?? "TASK";
  const row = db
    .prepare(`SELECT COUNT(*) as n FROM tasks WHERE project_id = ?`)
    .get(project_id) as { n: number };
  return `${prefix}-${row.n + 1}`;
}

export function createTask(
  project_id: string,
  title: string,
  description?: string,
  sprint_id?: number,
  priority: string = "medium"
): Task {
  const task_ref = nextTaskRef(project_id);
  const ts = now();
  db.prepare(
    `INSERT INTO tasks (project_id, task_ref, sprint_id, title, description, status, priority, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'backlog', ?, ?, ?)`
  ).run(project_id, task_ref, sprint_id ?? null, title, description ?? null, priority, ts, ts);
  return getTaskByRef(task_ref)!;
}

export function getTaskByRef(task_ref: string): Task | undefined {
  return db.prepare(`SELECT * FROM tasks WHERE task_ref = ?`).get(task_ref) as Task | undefined;
}

export function listTasks(
  project_id: string,
  filters: { status?: string; assignee_handle?: string; sprint_id?: number } = {}
): Task[] {
  let sql = `SELECT * FROM tasks WHERE project_id = ?`;
  const params: unknown[] = [project_id];
  if (filters.status) {
    sql += ` AND status = ?`;
    params.push(filters.status);
  }
  if (filters.assignee_handle) {
    sql += ` AND assignee_handle = ?`;
    params.push(filters.assignee_handle);
  }
  if (filters.sprint_id !== undefined) {
    sql += ` AND sprint_id = ?`;
    params.push(filters.sprint_id);
  }
  sql += ` ORDER BY id ASC`;
  return db.prepare(sql).all(...params) as Task[];
}

export function updateTaskStatus(
  task_ref: string,
  status: TaskStatus,
  assignee_handle?: string
): Task | undefined {
  const existing = getTaskByRef(task_ref);
  if (!existing) return undefined;
  db.prepare(
    `UPDATE tasks SET status = ?, assignee_handle = COALESCE(?, assignee_handle), updated_at = ? WHERE task_ref = ?`
  ).run(status, assignee_handle ?? null, now(), task_ref);
  return getTaskByRef(task_ref);
}

export function assignTask(task_ref: string, assignee_handle: string): Task | undefined {
  const existing = getTaskByRef(task_ref);
  if (!existing) return undefined;
  db.prepare(`UPDATE tasks SET assignee_handle = ?, updated_at = ? WHERE task_ref = ?`).run(
    assignee_handle,
    now(),
    task_ref
  );
  return getTaskByRef(task_ref);
}

export function addComment(task_ref: string, author_handle: string, text: string): void {
  db.prepare(
    `INSERT INTO comments (task_ref, author_handle, text, created_at) VALUES (?, ?, ?, ?)`
  ).run(task_ref, author_handle, text, now());
}

export function listComments(task_ref: string) {
  return db
    .prepare(`SELECT * FROM comments WHERE task_ref = ? ORDER BY id ASC`)
    .all(task_ref) as Array<{ id: number; task_ref: string; author_handle: string; text: string; created_at: string }>;
}

export function registerTools(server: McpServer): void {
  server.tool(
    "create_task",
    "Create a new task/ticket. Returns a task_ref (e.g. 'BTS-14') to use everywhere else — in notify_assignment, report_status, etc.",
    {
      project_id: z.string(),
      title: z.string(),
      description: z.string().optional(),
      sprint_id: z.number().optional(),
      priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
    },
    async ({ project_id, title, description, sprint_id, priority }) => {
      try {
        const task = createTask(project_id, title, description, sprint_id, priority);
        return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );

  server.tool(
    "list_tasks",
    "List tasks for a project, optionally filtered by status, assignee handle, or sprint.",
    {
      project_id: z.string(),
      status: z.enum(["backlog", "todo", "in_progress", "in_review", "done", "blocked"]).optional(),
      assignee_handle: z.string().optional(),
      sprint_id: z.number().optional(),
    },
    async ({ project_id, status, assignee_handle, sprint_id }) => {
      try {
        const tasks = listTasks(project_id, { status, assignee_handle, sprint_id });
        return { content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );

  server.tool(
    "get_task",
    "Get full details for one task by its task_ref, including comments.",
    { task_ref: z.string() },
    async ({ task_ref }) => {
      try {
        const task = getTaskByRef(task_ref);
        if (!task) {
          return { isError: true, content: [{ type: "text", text: `No task found for ${task_ref}` }] };
        }
        const comments = listComments(task_ref);
        return { content: [{ type: "text", text: JSON.stringify({ ...task, comments }, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );

  server.tool(
    "update_task_status",
    "Move a task to a new status (backlog, todo, in_progress, in_review, done, blocked). Optionally set/change the assignee at the same time.",
    {
      task_ref: z.string(),
      status: z.enum(["backlog", "todo", "in_progress", "in_review", "done", "blocked"]),
      assignee_handle: z.string().optional(),
    },
    async ({ task_ref, status, assignee_handle }) => {
      try {
        const task = updateTaskStatus(task_ref, status, assignee_handle);
        if (!task) {
          return { isError: true, content: [{ type: "text", text: `No task found for ${task_ref}` }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );

  server.tool(
    "assign_task",
    "Assign (or reassign) a task to a developer handle.",
    { task_ref: z.string(), assignee_handle: z.string() },
    async ({ task_ref, assignee_handle }) => {
      try {
        const task = assignTask(task_ref, assignee_handle);
        if (!task) {
          return { isError: true, content: [{ type: "text", text: `No task found for ${task_ref}` }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );

  server.tool(
    "add_comment",
    "Add a comment/note to a task — for progress notes, blockers, or review feedback.",
    { task_ref: z.string(), author_handle: z.string(), text: z.string() },
    async ({ task_ref, author_handle, text }) => {
      try {
        addComment(task_ref, author_handle, text);
        return { content: [{ type: "text", text: `Comment added to ${task_ref}.` }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );
}
