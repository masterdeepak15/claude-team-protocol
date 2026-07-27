#!/usr/bin/env node
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import * as db from "./db.js";

// Planner: a small self-hosted sprint/task tracker, backed by SQLite.
// This is an OPTIONAL, free stand-in for Jira. Use whichever you want —
// the Master/Developer skills talk about "your task tracker" generically,
// so you can point them at Jira, at this Planner, or swap between projects.
//
// Run this once, on one machine (PC1 alongside the relay is simplest),
// then every other machine's .mcp.json points at
// http://<PC1-LAN-IP>:<PLANNER_PORT>/mcp

function buildServer(): McpServer {
  const server = new McpServer({
    name: "planner",
    version: "1.0.0",
  });

  server.tool(
    "create_sprint",
    "Create a new sprint for a team/project.",
    {
      team_id: z.string(),
      name: z.string(),
      start_date: z.string().optional().describe("YYYY-MM-DD"),
      end_date: z.string().optional().describe("YYYY-MM-DD"),
    },
    async ({ team_id, name, start_date, end_date }) => {
      const sprint = db.createSprint(team_id, name, start_date, end_date);
      return { content: [{ type: "text", text: JSON.stringify(sprint, null, 2) }] };
    }
  );

  server.tool(
    "list_sprints",
    "List all sprints for a team/project.",
    { team_id: z.string() },
    async ({ team_id }) => {
      const sprints = db.listSprints(team_id);
      return { content: [{ type: "text", text: JSON.stringify(sprints, null, 2) }] };
    }
  );

  server.tool(
    "create_task",
    "Create a new task/ticket. Returns a task_ref (e.g. 'BTS-14') to use everywhere else — in team-relay assign_task, report_status, etc.",
    {
      team_id: z.string(),
      title: z.string(),
      description: z.string().optional(),
      sprint_id: z.number().optional(),
      priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
    },
    async ({ team_id, title, description, sprint_id, priority }) => {
      const task = db.createTask(team_id, title, description, sprint_id, priority);
      return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }] };
    }
  );

  server.tool(
    "list_tasks",
    "List tasks for a team/project, optionally filtered by status, assignee handle, or sprint.",
    {
      team_id: z.string(),
      status: z
        .enum(["backlog", "todo", "in_progress", "in_review", "done", "blocked"])
        .optional(),
      assignee_handle: z.string().optional(),
      sprint_id: z.number().optional(),
    },
    async ({ team_id, status, assignee_handle, sprint_id }) => {
      const tasks = db.listTasks(team_id, { status, assignee_handle, sprint_id });
      return { content: [{ type: "text", text: JSON.stringify(tasks, null, 2) }] };
    }
  );

  server.tool(
    "get_task",
    "Get full details for one task by its task_ref.",
    { task_ref: z.string() },
    async ({ task_ref }) => {
      const task = db.getTaskByRef(task_ref);
      const comments = task ? db.listComments(task_ref) : [];
      if (!task) {
        return { content: [{ type: "text", text: `No task found for ${task_ref}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ ...task, comments }, null, 2) }],
      };
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
      const task = db.updateTaskStatus(task_ref, status, assignee_handle);
      if (!task) {
        return { content: [{ type: "text", text: `No task found for ${task_ref}` }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }] };
    }
  );

  server.tool(
    "assign_task",
    "Assign (or reassign) a task to a developer handle.",
    { task_ref: z.string(), assignee_handle: z.string() },
    async ({ task_ref, assignee_handle }) => {
      const task = db.assignTask(task_ref, assignee_handle);
      if (!task) {
        return { content: [{ type: "text", text: `No task found for ${task_ref}` }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }] };
    }
  );

  server.tool(
    "add_comment",
    "Add a comment/note to a task — for progress notes, blockers, or review feedback.",
    { task_ref: z.string(), author_handle: z.string(), text: z.string() },
    async ({ task_ref, author_handle, text }) => {
      db.addComment(task_ref, author_handle, text);
      return { content: [{ type: "text", text: `Comment added to ${task_ref}.` }] };
    }
  );

  return server;
}

const PORT = Number(process.env.PLANNER_PORT || 8788);
const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Planner request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal planner error" });
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`planner listening on http://0.0.0.0:${PORT}/mcp`);
  console.log(`Point other machines at http://<this-PC-LAN-IP>:${PORT}/mcp`);
});
