import { describe, it, expect } from "vitest";
import { mergeMcpConfig, mergeDesktopMcpConfig } from "../src/mcpConfig.js";

describe("mergeMcpConfig", () => {
  it("adds a teamhub entry to an empty config, including the auth header", () => {
    const merged = mergeMcpConfig(undefined, "http://172.16.10.32:8787/mcp", "shh-token");
    expect(merged).toEqual({
      mcpServers: {
        teamhub: { type: "http", url: "http://172.16.10.32:8787/mcp", headers: { Authorization: "Bearer shh-token" } },
      },
    });
  });

  it("preserves existing mcpServers entries", () => {
    const existing = { mcpServers: { github: { type: "http", url: "http://example.com/mcp" } } };
    const merged = mergeMcpConfig(existing, "http://172.16.10.32:8787/mcp", "shh-token");
    expect(merged.mcpServers.github).toEqual({ type: "http", url: "http://example.com/mcp" });
    expect(merged.mcpServers.teamhub.url).toBe("http://172.16.10.32:8787/mcp");
    expect(merged.mcpServers.teamhub.headers.Authorization).toBe("Bearer shh-token");
  });
});

describe("mergeDesktopMcpConfig", () => {
  it("adds a command-based teamhub entry using mcp-remote with the auth header", () => {
    const merged = mergeDesktopMcpConfig(undefined, "http://172.16.10.32:8787/mcp", "shh-token");
    expect(merged.mcpServers.teamhub).toEqual({
      command: "npx",
      args: ["-y", "mcp-remote", "http://172.16.10.32:8787/mcp", "--header", "Authorization: Bearer shh-token"],
    });
  });

  it("preserves other existing entries", () => {
    const existing = { mcpServers: { other: { command: "node", args: ["x.js"] } } };
    const merged = mergeDesktopMcpConfig(existing, "http://172.16.10.32:8787/mcp", "shh-token");
    expect(merged.mcpServers.other).toEqual({ command: "node", args: ["x.js"] });
  });
});
