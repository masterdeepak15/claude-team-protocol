import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "./db.js";

export type Role = "master" | "developer" | "tester";

export interface Member {
  handle: string;
  project_id: string;
  role: Role;
  status: string | null;
  last_seen: string;
  mode: "auto" | "manual";
}

function now(): string {
  return new Date().toISOString();
}

export function registerMember(
  handle: string,
  project_id: string,
  role: Role,
  mode?: "auto" | "manual"
): Member {
  const ts = now();
  db.prepare(
    `INSERT INTO members (handle, project_id, role, status, last_seen, mode)
     VALUES (@handle, @project_id, @role, NULL, @ts, COALESCE(@mode, 'manual'))
     ON CONFLICT(handle) DO UPDATE SET
       project_id = excluded.project_id,
       role = excluded.role,
       last_seen = excluded.last_seen,
       mode = COALESCE(@mode, members.mode)`
  ).run({ handle, project_id, role, ts, mode: mode ?? null });
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

export function setMemberMode(handle: string, mode: "auto" | "manual"): void {
  db.prepare(`UPDATE members SET mode = ?, last_seen = ? WHERE handle = ?`).run(
    mode,
    now(),
    handle
  );
}

export function registerTools(server: McpServer): void {
  server.tool(
    "register",
    "Register this session under a handle (e.g. 'master-1', 'dev-A', 'tester-1') and role for a project, so other team members can reach it by name. Call this once at the start of a session. Roles: 'master' (Team Lead), 'developer' (writes code), 'tester' (pulls test tasks, runs/writes tests, reports bugs and results back to master). Optionally set mode: 'auto' (full auto-approval; the Lead can remotely interrupt and redirect this session's in-flight work — only meaningful when running headless via agents/runner.ts) or 'manual' (default; human-supervised, cannot be remotely interrupted). Omit mode to keep whatever was set previously (defaults to 'manual' on first registration).",
    {
      handle: z.string().describe("Unique short name for this session, e.g. dev-A"),
      role: z.enum(["master", "developer", "tester"]),
      project_id: z.string().describe("Project identifier shared by the whole team"),
      mode: z.enum(["auto", "manual"]).optional(),
    },
    async ({ handle, role, project_id, mode }) => {
      try {
        const member = registerMember(handle, project_id, role, mode);
        return {
          content: [
            {
              type: "text",
              text: `Registered ${member.handle} as ${member.role} on project ${member.project_id} (mode: ${member.mode}).`,
            },
          ],
        };
      } catch (err) {
        return { isError: true, content: [{ type: "text", text: String(err) }] };
      }
    }
  );

  server.tool(
    "set_mode",
    "Change a registered member's operating mode at any time — 'auto' (full auto-approval, the Lead can remotely interrupt and redirect this session's in-flight work; only takes effect when running headless via agents/runner.ts) or 'manual' (human-supervised, default, cannot be remotely interrupted).",
    { handle: z.string(), mode: z.enum(["auto", "manual"]) },
    async ({ handle, mode }) => {
      try {
        setMemberMode(handle, mode);
        const member = getMember(handle);
        if (!member) {
          return { isError: true, content: [{ type: "text", text: `No member found for handle ${handle}` }] };
        }
        return { content: [{ type: "text", text: `${handle} is now in ${member.mode} mode.` }] };
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
