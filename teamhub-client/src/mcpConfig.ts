export function mergeMcpConfig(existing: any, teamhubUrl: string): any {
  const base = existing && typeof existing === "object" ? existing : {};
  const mcpServers = { ...(base.mcpServers ?? {}) };
  mcpServers.teamhub = { type: "http", url: teamhubUrl };
  return { ...base, mcpServers };
}

export function mergeDesktopMcpConfig(existing: any, teamhubUrl: string): any {
  const base = existing && typeof existing === "object" ? existing : {};
  const mcpServers = { ...(base.mcpServers ?? {}) };
  mcpServers.teamhub = { command: "npx", args: ["-y", "mcp-remote", teamhubUrl] };
  return { ...base, mcpServers };
}
