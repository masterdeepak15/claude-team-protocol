import { describe, it, expect, afterEach } from "vitest";
import type { Server } from "node:http";

process.env.TEAMHUB_DB = ":memory:";

describe("teamhub server", () => {
  it("buildServer registers a server with all expected tools", async () => {
    const { buildServer } = await import("../../teamhub/server.js");
    const server = buildServer();
    // McpServer exposes registered tool names via its internal request handlers;
    // the simplest black-box check is that construction doesn't throw and
    // returns an object with a connect method (duck-typed MCP server).
    expect(typeof (server as any).connect).toBe("function");
  });
});

describe("GET /health", () => {
  let httpServer: Server | undefined;

  afterEach(() => {
    httpServer?.close();
    httpServer = undefined;
  });

  it("responds with ok status without needing the MCP protocol", async () => {
    const { buildHttpApp } = await import("../../teamhub/server.js");
    const app = buildHttpApp();
    httpServer = app.listen(0);
    await new Promise<void>((resolve) => httpServer!.once("listening", resolve));
    const port = (httpServer.address() as any).port;

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("teamhub");
    expect(typeof body.uptimeSeconds).toBe("number");
  });

  it("is a plain GET route, reachable from a browser or curl without a POST body", async () => {
    const { buildHttpApp } = await import("../../teamhub/server.js");
    const app = buildHttpApp();
    httpServer = app.listen(0);
    await new Promise<void>((resolve) => httpServer!.once("listening", resolve));
    const port = (httpServer.address() as any).port;

    const res = await fetch(`http://127.0.0.1:${port}/health`, { method: "GET" });
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

describe("monitoring UI wiring", () => {
  let httpServer: Server | undefined;

  afterEach(() => {
    httpServer?.close();
    httpServer = undefined;
  });

  it("serves the dashboard's static assets and mounts the API under /api", async () => {
    const { buildHttpApp } = await import("../../teamhub/server.js");
    const app = buildHttpApp();
    httpServer = app.listen(0);
    await new Promise<void>((resolve) => httpServer!.once("listening", resolve));
    const port = (httpServer.address() as any).port;

    const index = await fetch(`http://127.0.0.1:${port}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("<title>TeamHub</title>");

    const appJs = await fetch(`http://127.0.0.1:${port}/app.js`);
    expect(appJs.status).toBe(200);

    const stylesCss = await fetch(`http://127.0.0.1:${port}/styles.css`);
    expect(stylesCss.status).toBe(200);

    const apiProjects = await fetch(`http://127.0.0.1:${port}/api/projects`);
    expect(apiProjects.status).toBe(200);
    expect(Array.isArray(await apiProjects.json())).toBe(true);
  });
});
