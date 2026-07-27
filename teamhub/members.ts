import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "./db.js";

export interface Member {
  handle: string;
  project_id: string;
  role: "master" | "developer";
  status: string | null;
  last_seen: string;
}

function now(): string {
  return new Date().toISOString();
}

export function registerMember(
  handle: string,
  project_id: string,
  role: "master" | "developer"
): Member {
  const ts = now();
  db.prepare(
    `INSERT INTO members (handle, project_id, role, status, last_seen)
     VALUES (?, ?, ?, NULL, ?)
     ON CONFLICT(handle) DO UPDATE SET
       project_id = excluded.project_id,
       role = excluded.role,
       last_seen = excluded.last_seen`
  ).run(handle, project_id, role, ts);
  return getMember(handle)!;
}

export function getMember(handle: string): Member | undefined {
  return db.prepare(`SELECT * FROM members WHERE handle = ?`).get(handle) as Member | undefined;
}

export function listTeam(project_id: string): Member[] {
  return db
    .prepare(`SELECT * FROM members WHERE project_id = ?`)
    .all(project_id) as Member[];
}

export function touchMember(handle: string): void {
  db.prepare(`UPDATE members SET last_seen = ? WHERE handle = ?`).run(now(), handle);
}

export function setMemberStatus(handle: string, status: string): void {
  db.prepare(`UPDATE members SET status = ?, last_seen = ? WHERE handle = ?`).run(
    status,
    now(),
    handle
  );
}

export function registerTools(server: McpServer): void {
  server.tool(
    "register",
    "Register this session under a handle (e.g. 'master-1', 'dev-A') and role for a project, so other team members can reach it by name. Call this once at the start of a session.",
    {
      handle: z.string().describe("Unique short name for this session, e.g. dev-A"),
      role: z.enum(["master", "developer"]),
      project_id: z.string().describe("Project identifier shared by the whole team"),
    },
    async ({ handle, role, project_id }) => {
      try {
        const member = registerMember(handle, project_id, role);
        return {
          content: [
            { type: "text", text: `Registered ${member.handle} as ${member.role} on project ${member.project_id}.` },
          ],
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );

  server.tool(
    "list_team",
    "List all registered members of a project and their last known status.",
    { project_id: z.string() },
    async ({ project_id }) => {
      try {
        return { content: [{ type: "text", text: JSON.stringify(listTeam(project_id), null, 2) }] };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );
}
