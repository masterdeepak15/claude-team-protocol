import { db } from "./db.js";

// Business logic behind POST /api/usage and GET /api/projects/:id/usage —
// see teamhub/api.ts. Deliberately NOT exposed as an MCP tool: recording or
// reading usage from inside a live Claude session would itself burn the
// context/tokens this table exists to help account for and reduce. Both
// endpoints are plain bearer/session-gated REST, same pattern as
// /api/wait-for-work.

export interface UsageEvent {
  project_id: string;
  handle: string;
  session_id?: string;
  task_ref?: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  duration_ms?: number;
  num_turns?: number;
}

function now(): string {
  return new Date().toISOString();
}

export function recordUsage(ev: UsageEvent): void {
  db.prepare(
    `INSERT INTO usage_events
       (project_id, handle, session_id, task_ref, cost_usd, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, duration_ms, num_turns, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    ev.project_id,
    ev.handle,
    ev.session_id ?? null,
    ev.task_ref ?? null,
    ev.cost_usd,
    ev.input_tokens,
    ev.output_tokens,
    ev.cache_read_tokens,
    ev.cache_write_tokens,
    ev.duration_ms ?? null,
    ev.num_turns ?? null,
    now()
  );
}

export interface DeveloperUsageSummary {
  handle: string;
  cycles: number;
  sessions: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface SessionUsageSummary {
  session_id: string;
  handle: string;
  cycles: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  first_ts: string;
  last_ts: string;
}

export interface UsageReportOptions {
  since?: string; // ISO date/timestamp, inclusive
  until?: string; // ISO date/timestamp, exclusive
  handle?: string;
}

function dateFilterSql(opts: UsageReportOptions): { clause: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (opts.since) {
    parts.push("ts >= ?");
    params.push(opts.since);
  }
  if (opts.until) {
    parts.push("ts < ?");
    params.push(opts.until);
  }
  if (opts.handle) {
    parts.push("handle = ?");
    params.push(opts.handle);
  }
  return { clause: parts.length ? `AND ${parts.join(" AND ")}` : "", params };
}

// Per-developer rollup: "who is spending the tokens", across all their
// sessions in this project.
export function byDeveloper(project_id: string, opts: UsageReportOptions = {}): DeveloperUsageSummary[] {
  const { clause, params } = dateFilterSql(opts);
  return db
    .prepare(
      `SELECT
         handle,
         COUNT(*) AS cycles,
         COUNT(DISTINCT session_id) AS sessions,
         SUM(cost_usd) AS cost_usd,
         SUM(input_tokens) AS input_tokens,
         SUM(output_tokens) AS output_tokens,
         SUM(cache_read_tokens) AS cache_read_tokens,
         SUM(cache_write_tokens) AS cache_write_tokens
       FROM usage_events
       WHERE project_id = ? ${clause}
       GROUP BY handle
       ORDER BY cost_usd DESC`
    )
    .all(project_id, ...params) as DeveloperUsageSummary[];
}

// Per-session rollup: "which sessions are expensive" — the thing to look at
// when deciding whether a developer's single running session has grown too
// large and should be /compact'd or handed off to a fresh one instead.
export function bySession(project_id: string, opts: UsageReportOptions = {}): SessionUsageSummary[] {
  const { clause, params } = dateFilterSql(opts);
  return db
    .prepare(
      `SELECT
         session_id,
         handle,
         COUNT(*) AS cycles,
         SUM(cost_usd) AS cost_usd,
         SUM(input_tokens) AS input_tokens,
         SUM(output_tokens) AS output_tokens,
         SUM(cache_read_tokens) AS cache_read_tokens,
         SUM(cache_write_tokens) AS cache_write_tokens,
         MIN(ts) AS first_ts,
         MAX(ts) AS last_ts
       FROM usage_events
       WHERE project_id = ? AND session_id IS NOT NULL ${clause}
       GROUP BY session_id
       ORDER BY cost_usd DESC`
    )
    .all(project_id, ...params) as SessionUsageSummary[];
}
