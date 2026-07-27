#!/usr/bin/env node
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as projects from "./projects.js";
import * as members from "./members.js";
import * as messaging from "./messaging.js";
import * as sprints from "./sprints.js";
import * as tasks from "./tasks.js";

// The single MCP server every claude CLI session (Master + every Developer)
// connects to over HTTP. Run this once, on one machine (e.g. PC1), then
// point every other machine's .mcp.json at http://<PC1-LAN-IP>:PORT/mcp.
// It replaces the old separate relay + planner servers.

export function buildServer(): McpServer {
  const server = new McpServer({ name: "teamhub", version: "1.0.0" });
  projects.registerTools(server);
  members.registerTools(server);
  messaging.registerTools(server);
  sprints.registerTools(server);
  tasks.registerTools(server);
  return server;
}

function isMain(): boolean {
  if (!process.argv[1]) return false;
  const invoked = process.argv[1].replace(/\\/g, "/");
  const thisFile = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  return invoked.endsWith(thisFile) || thisFile.endsWith(invoked);
}

if (isMain()) {
  const PORT = Number(process.env.TEAMHUB_PORT || 8787);
  const app = express();
  app.use(express.json());

  app.post("/mcp", async (req, res) => {
    try {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("teamhub request failed:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal teamhub error" });
      }
    }
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`teamhub listening on http://0.0.0.0:${PORT}/mcp`);
    console.log(`Point other machines at http://<this-PC-LAN-IP>:${PORT}/mcp`);
  });
}
