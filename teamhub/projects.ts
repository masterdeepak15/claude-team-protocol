import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "./db.js";
import { emitChange } from "./events.js";

export interface Project {
  id: string;
  name: string;
  key_prefix: string;
  repo_url: string | null;
  status: string;
  created_at: string;
}

function now(): string {
  return new Date().toISOString();
}

export function createProject(
  id: string,
  name: string,
  key_prefix: string,
  repo_url?: string
): Project {
  db.prepare(
    `INSERT INTO projects (id, name, key_prefix, repo_url, status, created_at)
     VALUES (?, ?, ?, ?, 'active', ?)`
  ).run(id, name, key_prefix, repo_url ?? null, now());
  emitChange("project", id);
  return getProject(id)!;
}

export function getProject(id: string): Project | undefined {
  return db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as Project | undefined;
}

export function listProjects(): Project[] {
  return db.prepare(`SELECT * FROM projects ORDER BY created_at DESC`).all() as Project[];
}

export function registerTools(server: McpServer): void {
  server.tool(
    "create_project",
    "Create a new project (or return the existing one if the id is already taken). Every other tool scopes its data by project_id.",
    {
      id: z.string().describe("Unique project slug, e.g. 'bts-project'"),
      name: z.string(),
      key_prefix: z.string().describe("Short prefix used for task refs, e.g. 'BTS'"),
      repo_url: z.string().optional(),
    },
    async ({ id, name, key_prefix, repo_url }) => {
      try {
        const existing = getProject(id);
        const project = existing ?? createProject(id, name, key_prefix, repo_url);
        return { content: [{ type: "text", text: JSON.stringify(project, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );

  server.tool("list_projects", "List all known projects.", {}, async () => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(listProjects(), null, 2) }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: String(err) }] };
    }
  });

  server.tool(
    "get_project",
    "Get a single project's details by id.",
    { id: z.string() },
    async ({ id }) => {
      try {
        const project = getProject(id);
        if (!project) {
          return { isError: true, content: [{ type: "text", text: `No project found for ${id}` }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(project, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );
}
