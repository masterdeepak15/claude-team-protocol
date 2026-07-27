import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "./db.js";

export interface Sprint {
  id: number;
  project_id: string;
  name: string;
  start_date: string | null;
  end_date: string | null;
  status: string;
  created_at: string;
}

function now(): string {
  return new Date().toISOString();
}

export function createSprint(
  project_id: string,
  name: string,
  start_date?: string,
  end_date?: string
): Sprint {
  const info = db
    .prepare(
      `INSERT INTO sprints (project_id, name, start_date, end_date, status, created_at)
       VALUES (?, ?, ?, ?, 'active', ?)`
    )
    .run(project_id, name, start_date ?? null, end_date ?? null, now());
  return getSprint(info.lastInsertRowid as number)!;
}

export function getSprint(id: number): Sprint | undefined {
  return db.prepare(`SELECT * FROM sprints WHERE id = ?`).get(id) as Sprint | undefined;
}

export function listSprints(project_id: string): Sprint[] {
  return db
    .prepare(`SELECT * FROM sprints WHERE project_id = ? ORDER BY id DESC`)
    .all(project_id) as Sprint[];
}

export function registerTools(server: McpServer): void {
  server.tool(
    "create_sprint",
    "Create a new sprint for a project.",
    {
      project_id: z.string(),
      name: z.string(),
      start_date: z.string().optional().describe("YYYY-MM-DD"),
      end_date: z.string().optional().describe("YYYY-MM-DD"),
    },
    async ({ project_id, name, start_date, end_date }) => {
      try {
        const sprint = createSprint(project_id, name, start_date, end_date);
        return { content: [{ type: "text", text: JSON.stringify(sprint, null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );

  server.tool(
    "list_sprints",
    "List all sprints for a project.",
    { project_id: z.string() },
    async ({ project_id }) => {
      try {
        return { content: [{ type: "text", text: JSON.stringify(listSprints(project_id), null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );
}
