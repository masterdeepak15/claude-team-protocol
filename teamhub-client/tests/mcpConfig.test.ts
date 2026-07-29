import { describe, it, expect } from "vitest";
import { mergeMcpConfig, mergeDesktopMcpConfig } from "../src/mcpConfig.js";

describe("mergeMcpConfig", () => {
  it("adds a teamhub entry to an empty config", () => {
    const merged = mergeMcpConfig(undefined, "http://172.16.10.32:8787/mcp");
    expect(merged).toEqual({
      mcpServers: { teamhub: { type: "http", url: "http://172.16.10.32:8787/mcp" } },
    });
  });

  it("preserves existing mcpServers entries", () => {
    const existing = { mcpServers: { github: { type: "http", url: "http://example.com/mcp" } } };
    const merged = mergeMcpConfig(existing, "http://172.16.10.32:8787/mcp");
    expect(merged.mcpServers.github).toEqual({ type: "http", url: "http://example.com/mcp" });
    expect(merged.mcpServers.teamhub).toEqual({ type: "http", url: "http://172.16.10.32:8787/mcp" });
  });
});

describe("mergeDesktopMcpConfig", () => {
  it("adds a command-based teamhub entry using mcp-remote", () => {
    const merged = mergeDesktopMcpConfig(undefined, "http://172.16.10.32:8787/mcp");
    expect(merged.mcpServers.teamhub).toEqual({
      command: "npx",
      args: ["-y", "mcp-remote", "http://172.16.10.32:8787/mcp"],
    });
  });

  it("preserves other existing entries", () => {
    const existing = { mcpServers: { other: { command: "node", args: ["x.js"] } } };
    const merged = mergeDesktopMcpConfig(existing, "http://172.16.10.32:8787/mcp");
    expect(merged.mcpServers.other).toEqual({ command: "node", args: ["x.js"] });
  });
});
