#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { openDb } from "../teamhub/db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface LegacyMessage {
  id: string;
  from: string;
  to: string;
  type: string;
  text: string;
  task_ref?: string;
  ts: string;
  read: boolean;
}

interface LegacyRelayDb {
  members: Record<string, { handle: string; role: string; team_id: string; lastSeen: string; status?: string }>;
  mailboxes: Record<string, LegacyMessage[]>;
}

export interface MigrationCounts {
  projects: number;
  members: number;
  messages: number;
  sprints: number;
  tasks: number;
  comments: number;
}

export function migrate(
  relayJsonPath: string,
  plannerSqlitePath: string,
  teamhubDbPath: string
): MigrationCounts {
  const teamhub = openDb(teamhubDbPath);
  const counts: MigrationCounts = { projects: 0, members: 0, messages: 0, sprints: 0, tasks: 0, comments: 0 };
  const seenProjects = new Set<string>();

  function ensureProject(team_id: string): void {
    if (seenProjects.has(team_id)) return;
    seenProjects.add(team_id);
    const existing = teamhub.prepare(`SELECT id FROM projects WHERE id = ?`).get(team_id);
    if (!existing) {
      const prefix = team_id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toUpperCase() || "TASK";
      teamhub
        .prepare(
          `INSERT INTO projects (id, name, key_prefix, status, created_at) VALUES (?, ?, ?, 'active', ?)`
        )
        .run(team_id, team_id, prefix, new Date().toISOString());
      counts.projects++;
    }
  }

  if (existsSync(relayJsonPath)) {
    const relay: LegacyRelayDb = JSON.parse(readFileSync(relayJsonPath, "utf-8"));
    for (const member of Object.values(relay.members)) {
      ensureProject(member.team_id);
      teamhub
        .prepare(
          `INSERT INTO members (handle, project_id, role, status, last_seen) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(handle) DO UPDATE SET project_id=excluded.project_id, role=excluded.role, status=excluded.status, last_seen=excluded.last_seen`
        )
        .run(member.handle, member.team_id, member.role, member.status ?? null, member.lastSeen);
      counts.members++;
    }
    for (const inbox of Object.values(relay.mailboxes)) {
      for (const msg of inbox) {
        const project_id = relay.members[msg.to]?.team_id ?? relay.members[msg.from]?.team_id ?? "unknown-project";
        ensureProject(project_id);
        teamhub
          .prepare(
            `INSERT OR IGNORE INTO messages (id, project_id, from_handle, to_handle, type, text, task_ref, ts, read) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(msg.id, project_id, msg.from, msg.to, msg.type, msg.text, msg.task_ref ?? null, msg.ts, msg.read ? 1 : 0);
        counts.messages++;
      }
    }
  }

  if (existsSync(plannerSqlitePath)) {
    const planner = new Database(plannerSqlitePath, { readonly: true });
    const sprintIdMap = new Map<number, number>();

    for (const sprint of planner.prepare(`SELECT * FROM sprints`).all() as any[]) {
      ensureProject(sprint.team_id);
      const info = teamhub
        .prepare(
          `INSERT INTO sprints (project_id, name, start_date, end_date, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(sprint.team_id, sprint.name, sprint.start_date, sprint.end_date, sprint.status, sprint.created_at);
      sprintIdMap.set(sprint.id, Number(info.lastInsertRowid));
      counts.sprints++;
    }

    for (const task of planner.prepare(`SELECT * FROM tasks`).all() as any[]) {
      ensureProject(task.team_id);
      const newSprintId = task.sprint_id ? sprintIdMap.get(task.sprint_id) ?? null : null;
      teamhub
        .prepare(
          `INSERT OR IGNORE INTO tasks (project_id, task_ref, sprint_id, title, description, status, priority, assignee_handle, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          task.team_id,
          task.task_ref,
          newSprintId,
          task.title,
          task.description,
          task.status,
          task.priority,
          task.assignee_handle,
          task.created_at,
          task.updated_at
        );
      counts.tasks++;
    }

    for (const comment of planner.prepare(`SELECT * FROM comments`).all() as any[]) {
      teamhub
        .prepare(`INSERT INTO comments (task_ref, author_handle, text, created_at) VALUES (?, ?, ?, ?)`)
        .run(comment.task_ref, comment.author_handle, comment.text, comment.created_at);
      counts.comments++;
    }

    planner.close();
  }

  teamhub.close();
  return counts;
}

function isMain(): boolean {
  if (!process.argv[1]) return false;
  const invoked = process.argv[1].replace(/\\/g, "/");
  const thisFile = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  return invoked.endsWith(thisFile) || thisFile.endsWith(invoked);
}

if (isMain()) {
  const relayJsonPath = process.argv[2] || join(__dirname, "../legacy/relay/team-relay.db.json");
  const plannerSqlitePath = process.argv[3] || join(__dirname, "../legacy/planner/planner.db.sqlite");
  const teamhubDbPath = process.argv[4] || join(__dirname, "../teamhub/teamhub.db.sqlite");
  const counts = migrate(relayJsonPath, plannerSqlitePath, teamhubDbPath);
  console.log("Migration complete:", counts);
}
