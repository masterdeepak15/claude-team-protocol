import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Single shared file. All agent processes (master + every developer) point at this.
// For real multi-machine use, swap this for a tiny SQLite file on a shared network path,
// or a REST call to a small always-on service. JSON file is enough for one office LAN.
const DB_PATH = process.env.TEAM_RELAY_DB || join(__dirname, "team-relay.db.json");

export type Role = "master" | "developer";

export interface Member {
  handle: string;
  role: Role;
  team_id: string;
  lastSeen: string;
  status?: string;
}

export interface Message {
  id: string;
  from: string;
  to: string;
  type: "task_assignment" | "message" | "status_update";
  text: string;
  task_ref?: string;
  ts: string;
  read: boolean;
}

interface DB {
  members: Record<string, Member>;
  mailboxes: Record<string, Message[]>;
}

function load(): DB {
  if (!existsSync(DB_PATH)) {
    return { members: {}, mailboxes: {} };
  }
  return JSON.parse(readFileSync(DB_PATH, "utf-8"));
}

function save(db: DB) {
  writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function register(handle: string, role: Role, team_id: string): Member {
  const db = load();
  const member: Member = { handle, role, team_id, lastSeen: new Date().toISOString() };
  db.members[handle] = member;
  if (!db.mailboxes[handle]) db.mailboxes[handle] = [];
  save(db);
  return member;
}

export function findMaster(team_id: string): Member | undefined {
  const db = load();
  return Object.values(db.members).find(
    (m) => m.team_id === team_id && m.role === "master"
  );
}

function pushMessage(db: DB, msg: Message) {
  if (!db.mailboxes[msg.to]) db.mailboxes[msg.to] = [];
  db.mailboxes[msg.to].push(msg);
}

export function assignTask(
  team_id: string,
  from: string,
  to: string,
  task_ref: string,
  summary: string
): Message {
  const db = load();
  const msg: Message = {
    id: newId(),
    from,
    to,
    type: "task_assignment",
    text: summary,
    task_ref,
    ts: new Date().toISOString(),
    read: false,
  };
  pushMessage(db, msg);
  save(db);
  return msg;
}

export function sendMessage(from: string, to: string, text: string): Message {
  const db = load();
  const msg: Message = {
    id: newId(),
    from,
    to,
    type: "message",
    text,
    ts: new Date().toISOString(),
    read: false,
  };
  pushMessage(db, msg);
  save(db);
  return msg;
}

export function reportStatus(
  team_id: string,
  from: string,
  task_ref: string,
  status: string,
  note: string
): Message {
  const db = load();
  if (db.members[from]) {
    db.members[from].status = status;
    db.members[from].lastSeen = new Date().toISOString();
  }
  const master = Object.values(db.members).find(
    (m) => m.team_id === team_id && m.role === "master"
  );
  const msg: Message = {
    id: newId(),
    from,
    to: master ? master.handle : "master",
    type: "status_update",
    text: `[${status}] ${note}`,
    task_ref,
    ts: new Date().toISOString(),
    read: false,
  };
  pushMessage(db, msg);
  save(db);
  return msg;
}

export function checkInbox(handle: string): Message[] {
  const db = load();
  const inbox = db.mailboxes[handle] || [];
  const unread = inbox.filter((m) => !m.read);
  inbox.forEach((m) => (m.read = true));
  if (db.members[handle]) db.members[handle].lastSeen = new Date().toISOString();
  save(db);
  return unread;
}

export function listTeam(team_id: string): Member[] {
  const db = load();
  return Object.values(db.members).filter((m) => m.team_id === team_id);
}
