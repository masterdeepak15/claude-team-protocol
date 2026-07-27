#!/usr/bin/env node
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import * as store from "./store.js";

// This is the "intercom" every claude CLI session (Master + every Developer)
// connects to over HTTP. Run this ONCE, on one machine (e.g. PC1), then
// point every other machine's .mcp.json at http://<PC1-LAN-IP>:PORT/mcp.
//
// It does NOT talk to your task tracker (Jira or Planner) or GitHub itself —
// those stay as separate MCP connectors, configured per-machine as normal.

function buildServer(): McpServer {
  const server = new McpServer({
    name: "team-relay",
    version: "1.0.0",
  });

  server.tool(
    "register",
    "Register this session under a handle (e.g. 'master-1', 'dev-A') and role, so other team members can reach it by name. Call this once at the start of a session.",
    {
      handle: z.string().describe("Unique short name for this session, e.g. dev-A"),
      role: z.enum(["master", "developer"]),
      team_id: z.string().describe("Team/project identifier shared by the whole team"),
    },
    async ({ handle, role, team_id }) => {
      const member = store.register(handle, role, team_id);
      return {
        content: [
          { type: "text", text: `Registered ${handle} as ${role} on team ${team_id}.` },
        ],
      };
    }
  );

  server.tool(
    "assign_task",
    "Master only: assign a task to a developer's inbox. Create the actual task first in your tracker (Jira, or the built-in Planner) to get a task_ref, then call this to notify the developer.",
    {
      team_id: z.string(),
      from_handle: z.string(),
      to_handle: z.string(),
      task_ref: z.string().describe("Task reference from your tracker — a Jira key like PROJ-123, or a Planner task_ref like BTS-14"),
      summary: z.string().describe("Short human-readable task summary"),
    },
    async ({ team_id, from_handle, to_handle, task_ref, summary }) => {
      store.assignTask(team_id, from_handle, to_handle, task_ref, summary);
      return {
        content: [
          { type: "text", text: `Task ${task_ref} assigned to ${to_handle}.` },
        ],
      };
    }
  );

  server.tool(
    "send_message",
    "Send a direct message to another team member's handle (master<->developer, either direction).",
    {
      from_handle: z.string(),
      to_handle: z.string(),
      text: z.string(),
    },
    async ({ from_handle, to_handle, text }) => {
      store.sendMessage(from_handle, to_handle, text);
      return {
        content: [{ type: "text", text: `Message sent to ${to_handle}.` }],
      };
    }
  );

  server.tool(
    "report_status",
    "Developer only: report progress/status on a task. Automatically notifies the team's master.",
    {
      team_id: z.string(),
      from_handle: z.string(),
      task_ref: z.string(),
      status: z.enum(["started", "in_progress", "blocked", "done", "failed"]),
      note: z.string(),
    },
    async ({ team_id, from_handle, task_ref, status, note }) => {
      store.reportStatus(team_id, from_handle, task_ref, status, note);
      return {
        content: [{ type: "text", text: `Status reported: ${status}.` }],
      };
    }
  );

  server.tool(
    "check_inbox",
    "Check for new unread messages/task assignments addressed to this handle. Call this at the start of every work cycle.",
    {
      handle: z.string(),
    },
    async ({ handle }) => {
      const messages = store.checkInbox(handle);
      if (messages.length === 0) {
        return { content: [{ type: "text", text: "No new messages." }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(messages, null, 2) }],
      };
    }
  );

  server.tool(
    "list_team",
    "Master only: list all registered team members and their last known status.",
    {
      team_id: z.string(),
    },
    async ({ team_id }) => {
      const members = store.listTeam(team_id);
      return {
        content: [{ type: "text", text: JSON.stringify(members, null, 2) }],
      };
    }
  );

  return server;
}

const PORT = Number(process.env.RELAY_PORT || 8787);
const app = express();
app.use(express.json());

// Stateless mode: each request gets a fresh server+transport pair.
// Our real state lives in store.ts (the JSON file), not in the transport,
// so there's nothing lost by not keeping a long-lived MCP session here.
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
    console.error("Relay request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal relay error" });
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`team-relay listening on http://0.0.0.0:${PORT}/mcp`);
  console.log(`Point other machines at http://<this-PC-LAN-IP>:${PORT}/mcp`);
});
