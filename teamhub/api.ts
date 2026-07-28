import { Router } from "express";
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
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    // Keep intermediary proxies/load balancers from timing out an idle
    // connection; also doubles as a lightweight liveness signal client-side.
    const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 25000);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return router;
}
