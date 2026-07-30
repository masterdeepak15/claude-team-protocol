import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import type { Server } from "node:http";

process.env.TEAMHUB_DB = ":memory:";

async function startTestServer(): Promise<{ port: number; server: Server }> {
  const { buildApiRouter } = await import("../../teamhub/api.js");
  const app = express();
  app.use(express.json());
  app.use("/api", buildApiRouter());
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as any).port;
  return { port, server };
}

describe("teamhub API router", () => {
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("GET /api/projects lists created projects", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    createProject("proj-api-a", "API Project A", "APA");
    const started = await startTestServer();
    server = started.server;

    const res = await fetch(`http://127.0.0.1:${started.port}/api/projects`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.some((p: any) => p.id === "proj-api-a")).toBe(true);
  });

  it("GET /api/projects/:id returns 404 for an unknown project", async () => {
    const started = await startTestServer();
    server = started.server;
    const res = await fetch(`http://127.0.0.1:${started.port}/api/projects/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it("GET /api/projects/:id/members, /sprints, /tasks scope to that project", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { registerMember } = await import("../../teamhub/members.js");
    const { createSprint } = await import("../../teamhub/sprints.js");
    const { createTask } = await import("../../teamhub/tasks.js");
    createProject("proj-api-b", "API Project B", "APB");
    registerMember("dev-api-b", "proj-api-b", "developer");
    createSprint("proj-api-b", "Sprint 1");
    createTask("proj-api-b", "Some task");

    const started = await startTestServer();
    server = started.server;

    const members = await (await fetch(`http://127.0.0.1:${started.port}/api/projects/proj-api-b/members`)).json();
    expect(members).toHaveLength(1);
    expect(members[0].handle).toBe("dev-api-b");

    const sprintsRes = await (await fetch(`http://127.0.0.1:${started.port}/api/projects/proj-api-b/sprints`)).json();
    expect(sprintsRes).toHaveLength(1);

    const tasksRes = await (await fetch(`http://127.0.0.1:${started.port}/api/projects/proj-api-b/tasks`)).json();
    expect(tasksRes).toHaveLength(1);
    expect(tasksRes[0].task_ref).toBe("APB-1");
  });

  it("GET /api/tasks/:taskRef includes comments, and 404s for an unknown ref", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { createTask, addComment } = await import("../../teamhub/tasks.js");
    createProject("proj-api-c", "API Project C", "APC");
    const task = createTask("proj-api-c", "Commented task");
    addComment(task.task_ref, "dev-api-c", "a note");

    const started = await startTestServer();
    server = started.server;

    const res = await fetch(`http://127.0.0.1:${started.port}/api/tasks/${task.task_ref}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0].text).toBe("a note");

    const missing = await fetch(`http://127.0.0.1:${started.port}/api/tasks/NOPE-1`);
    expect(missing.status).toBe(404);
  });

  it("GET /api/projects/:id/messages returns the full history, optionally filtered by handle", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { sendMessage } = await import("../../teamhub/messaging.js");
    createProject("proj-api-d", "API Project D", "APD");
    sendMessage("proj-api-d", "master-1", "dev-api-d", "hi dev-api-d");
    sendMessage("proj-api-d", "master-1", "dev-api-e", "hi dev-api-e");

    const started = await startTestServer();
    server = started.server;

    const all = await (await fetch(`http://127.0.0.1:${started.port}/api/projects/proj-api-d/messages`)).json();
    expect(all).toHaveLength(2);

    const filtered = await (
      await fetch(`http://127.0.0.1:${started.port}/api/projects/proj-api-d/messages?handle=dev-api-d`)
    ).json();
    expect(filtered).toHaveLength(1);
    expect(filtered[0].to_handle).toBe("dev-api-d");
  });

  it("POST /api/messages sends a message and 400s when a field is missing", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    createProject("proj-api-e", "API Project E", "APE");
    const started = await startTestServer();
    server = started.server;

    const res = await fetch(`http://127.0.0.1:${started.port}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "proj-api-e",
        from_handle: "master-1",
        to_handle: "dev-api-f",
        text: "hello from the UI",
      }),
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.text).toBe("hello from the UI");

    const badRes = await fetch(`http://127.0.0.1:${started.port}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: "proj-api-e", from_handle: "master-1" }),
    });
    expect(badRes.status).toBe(400);

    const selfRes = await fetch(`http://127.0.0.1:${started.port}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: "proj-api-e",
        from_handle: "master-1",
        to_handle: "master-1",
        text: "talking to myself",
      }),
    });
    expect(selfRes.status).toBe(400);
  });

  it("GET /api/events streams a change as an SSE data line", async () => {
    const { createProject } = await import("../../teamhub/projects.js");
    const { sendMessage } = await import("../../teamhub/messaging.js");
    createProject("proj-api-f", "API Project F", "APF");

    const started = await startTestServer();
    server = started.server;

    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${started.port}/api/events?project_id=proj-api-f`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Trigger a change after the stream is open.
    setTimeout(() => sendMessage("proj-api-f", "master-1", "dev-api-g", "trigger"), 50);

    let received = "";
    const deadline = Date.now() + 3000;
    while (!received.includes('"kind":"message"') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }
    controller.abort();

    expect(received).toContain('"kind":"message"');
    expect(received).toContain("proj-api-f");
  });
});
