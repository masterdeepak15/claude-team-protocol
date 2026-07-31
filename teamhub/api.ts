import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import * as projects from "./projects.js";
import * as members from "./members.js";
import * as sprints from "./sprints.js";
import * as tasks from "./tasks.js";
import * as messaging from "./messaging.js";
import { onChange } from "./events.js";

// Plain REST/JSON endpoints backing the monitoring UI. These call the same
// teamhub/*.ts functions the MCP tools use — no MCP round-trip needed for
// same-process UI reads/writes, and no separate data model to keep in sync.
export function buildApiRouter(): Router {
  const router = Router();

  router.get("/projects", (_req, res) => {
    res.json(projects.listProjects());
  });

  router.get("/projects/:id", (req, res) => {
    const project = projects.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: `No project found for ${req.params.id}` });
      return;
    }
    res.json(project);
  });

  router.get("/projects/:id/members", (req, res) => {
    res.json(members.listTeam(req.params.id));
  });

  router.get("/projects/:id/sprints", (req, res) => {
    res.json(sprints.listSprints(req.params.id));
  });

  router.get("/projects/:id/tasks", (req, res) => {
    const { status, assignee_handle, sprint_id } = req.query;
    res.json(
      tasks.listTasks(req.params.id, {
        status: typeof status === "string" ? status : undefined,
        assignee_handle: typeof assignee_handle === "string" ? assignee_handle : undefined,
        sprint_id: typeof sprint_id === "string" ? Number(sprint_id) : undefined,
      })
    );
  });

  router.get("/tasks/:taskRef", (req, res) => {
    const task = tasks.getTaskByRef(req.params.taskRef);
    if (!task) {
      res.status(404).json({ error: `No task found for ${req.params.taskRef}` });
      return;
    }
    const comments = tasks.listComments(req.params.taskRef);
    res.json({ ...task, comments });
  });

  router.get("/projects/:id/messages", (req, res) => {
    const handle = typeof req.query.handle === "string" ? req.query.handle : undefined;
    res.json(messaging.listMessages(req.params.id, handle));
  });

  router.post("/messages", (req, res) => {
    const { project_id, from_handle, to_handle, text } = req.body ?? {};
    if (!project_id || !from_handle || !to_handle || !text) {
      res.status(400).json({ error: "project_id, from_handle, to_handle, and text are all required" });
      return;
    }
    if (from_handle === to_handle) {
      res.status(400).json({ error: "from_handle and to_handle can't be the same — a member can't message itself." });
      return;
    }
    const message = messaging.sendMessage(project_id, from_handle, to_handle, text);
    res.status(201).json(message);
  });

  // Server-Sent Events: one long-lived connection per open dashboard tab.
  // Optional ?project_id= narrows delivery to just that project's changes.
  router.get("/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");

    const projectFilter = typeof req.query.project_id === "string" ? req.query.project_id : undefined;
    const unsubscribe = onChange((event) => {
      if (projectFilter && event.project_id !== projectFilter) return;
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Client likely disconnected in the instant before the 'close'
        // handler below fired. res.write() on a dead socket can throw
        // synchronously, and EventEmitter.emit() re-throws listener
        // exceptions synchronously — left unguarded, one stale dashboard
        // tab could break emitChange() for every other in-flight caller
        // (an unrelated MCP tool call happening at the same moment).
      }
    });

    // Keep intermediary proxies/load balancers from timing out an idle
    // connection; also doubles as a lightweight liveness signal client-side.
    const heartbeat = setInterval(() => {
      try {
        res.write(": heartbeat\n\n");
      } catch {
        // Same reasoning as above — an uncaught throw inside a setInterval
        // callback becomes an uncaught process-level exception in Node,
        // which (with no global handler installed) would crash the whole
        // TeamHub server over one dead browser tab.
        clearInterval(heartbeat);
      }
    }, 25000);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // Every business-logic function this router calls (sendMessage,
  // reportStatus, etc.) throws a plain Error for validation-style failures
  // rather than returning a result code. Without this, an uncaught throw
  // from a synchronous Express route handler falls through to Express's
  // default error page — HTML, not JSON — which breaks every dashboard
  // fetch().then(r => r.json()) call with a confusing secondary parse
  // error instead of the actual message. Must be registered after all
  // other routes/middleware (Express error handlers are order-dependent).
  router.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error("API request failed:", err);
    res.status(400).json({ error: err.message || "Request failed" });
  });

  return router;
}
