import type { ChildProcess } from "node:child_process";
import crossSpawn from "cross-spawn";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readConfig } from "./config.js";

export interface RunnerArgs {
  role: "master" | "developer" | "tester" | "analyst";
  project: string;
  handle: string;
  masterHandle?: string;
  cycle: number;
  mode: "auto" | "manual";
  watchdogInterval: number;
}

export function parseArgs(argv: string[]): RunnerArgs {
  const raw: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      raw[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  if (raw.role !== "master" && raw.role !== "developer" && raw.role !== "tester" && raw.role !== "analyst") {
    throw new Error(`--role must be "master", "developer", or "tester", got "${raw.role}"`);
  }
  if (!raw.project) throw new Error("--project is required");
  if (!raw.handle) throw new Error("--handle is required");
  if (raw.mode !== undefined && raw.mode !== "auto" && raw.mode !== "manual") {
    throw new Error(`--mode must be "auto" or "manual", got "${raw.mode}"`);
  }
  if ((raw.role === "developer" || raw.role === "tester" || raw.role === "analyst") && !raw["master-handle"]) {
    throw new Error(`--master-handle is required when --role is "${raw.role}"`);
  }
  const cycle = Number(raw.cycle ?? (raw.role === "master" ? 60 : 30));
  if (!Number.isFinite(cycle) || cycle <= 0) {
    throw new Error(`--cycle must be a positive number of seconds, got "${raw.cycle}"`);
  }
  const watchdogInterval = Number(raw["watchdog-interval"] ?? 5);
  if (!Number.isFinite(watchdogInterval) || watchdogInterval <= 0) {
    throw new Error(`--watchdog-interval must be a positive number of seconds, got "${raw["watchdog-interval"]}"`);
  }
  return {
    role: raw.role,
    project: raw.project,
    handle: raw.handle,
    masterHandle: raw["master-handle"],
    cycle,
    mode: (raw.mode as "auto" | "manual" | undefined) ?? "manual",
    watchdogInterval,
  };
}

// Bare command name on every platform — cross-spawn resolves it through the
// OS's normal PATH/PATHEXT lookup, whatever the actual file turns out to be
// (.exe, .cmd, .bat, or no extension at all on POSIX).
export function claudeCommand(): string {
  return "claude";
}

// Always acceptEdits, deliberately never bypassPermissions: TeamHub has no
// authentication, so anyone reaching its HTTP port could otherwise inject
// text (e.g. via interrupt_developer's `reason`) that gets fed verbatim as
// the next instruction to a fully unconfirmed session — a real
// prompt-injection-to-RCE path if Bash execution were auto-approved too.
export function permissionModeFor(_args: RunnerArgs): "acceptEdits" {
  return "acceptEdits";
}

function sessionFile(handle: string): string {
  return join(process.cwd(), `.${handle}-session-id`);
}

const ALLOWED_TOOLS_MASTER =
  "mcp__teamhub__register,mcp__teamhub__notify_assignment,mcp__teamhub__send_message," +
  "mcp__teamhub__check_inbox,mcp__teamhub__list_team,mcp__teamhub__create_project," +
  "mcp__teamhub__list_projects,mcp__teamhub__get_project,mcp__teamhub__create_sprint," +
  "mcp__teamhub__list_sprints,mcp__teamhub__create_task,mcp__teamhub__list_tasks," +
  "mcp__teamhub__get_task,mcp__teamhub__update_task_status,mcp__teamhub__assign_task," +
  "mcp__teamhub__add_comment,mcp__teamhub__interrupt_developer,mcp__teamhub__set_mode," +
  "mcp__github__*";

// Shared by developer and tester roles — both need Read/Edit/Bash plus the
// same reporting tools; only their prompts and skill guidance differ.
const ALLOWED_TOOLS_WORKER =
  "mcp__teamhub__register,mcp__teamhub__send_message,mcp__teamhub__check_inbox," +
  "mcp__teamhub__report_status,mcp__teamhub__get_task,mcp__teamhub__update_task_status," +
  "mcp__teamhub__add_comment,mcp__teamhub__set_mode,mcp__github__*,Read,Edit,Bash";

// Analyst deliberately has no Edit/Bash — see agents/runner.ts (the server
// package's copy) for the full rationale.
const ALLOWED_TOOLS_ANALYST =
  "mcp__teamhub__register,mcp__teamhub__send_message,mcp__teamhub__check_inbox," +
  "mcp__teamhub__report_status,mcp__teamhub__get_task,mcp__teamhub__list_tasks," +
  "mcp__teamhub__list_team,mcp__teamhub__add_comment,mcp__teamhub__set_mode," +
  "mcp__github__*,Read,WebSearch,WebFetch";

export function allowedToolsFor(role: RunnerArgs["role"]): string {
  if (role === "master") return ALLOWED_TOOLS_MASTER;
  if (role === "analyst") return ALLOWED_TOOLS_ANALYST;
  return ALLOWED_TOOLS_WORKER;
}

// Registration itself no longer happens inside these prompts — see
// registerViaMcp(), called directly over MCP before Claude is ever
// spawned (main()). Matches agents/runner.ts (the server package's copy).
export function kickoffPrompt(args: RunnerArgs): string {
  if (args.role === "master") {
    return `You are the Team Lead for project "${args.project}". Your handle is "${args.handle}" (role="master") — already registered with TeamHub, no action needed for that. Check your task tracker for open backlog items in this project and summarize them.`;
  }
  if (args.role === "tester") {
    return `You are a Tester on project "${args.project}". Your handle is "${args.handle}" (role="tester", mode="${args.mode}"), your Team Lead's handle is "${args.masterHandle}" — you're already registered with TeamHub, no action needed for that. Check your inbox for an assigned test task.`;
  }
  if (args.role === "analyst") {
    return `You are an Analyst on project "${args.project}". Your handle is "${args.handle}" (role="analyst", mode="${args.mode}"), your Team Lead's handle is "${args.masterHandle}" — you're already registered with TeamHub, no action needed for that. Check your inbox for a research/clarification request, and skim the project's open tasks for anything ambiguous the Lead should know about before assigning it.`;
  }
  return `You are a Developer on project "${args.project}". Your handle is "${args.handle}" (role="developer", mode="${args.mode}"), your Team Lead's handle is "${args.masterHandle}" — you're already registered with TeamHub, no action needed for that. Check your inbox for an assigned task.`;
}

export function cyclePrompt(args: RunnerArgs): string {
  if (args.role === "master") {
    return (
      `Check your teamhub inbox (handle="${args.handle}"). For EVERY unread message you find — ` +
      `from a developer, a tester, or from "owner" (the human operator) — you MUST send a reply ` +
      `back to that exact sender with send_message before you finish this turn, even if the reply ` +
      `is short (e.g. "Reviewed BTS-4, looks good" or "Checked with dev-A, still in progress"). ` +
      `Never leave a message read-but-unanswered. Reflect any status updates in your task tracker. ` +
      `If a developer or tester has no active task and there is ready work for them, assign it ` +
      `with assign_task and notify_assignment.`
    );
  }
  if (args.role === "tester") {
    return (
      `Check your teamhub inbox (handle="${args.handle}"). For EVERY unread message — a new test ` +
      `task, a question, or anything from "owner" (the human operator) — you MUST reply to that ` +
      `exact sender with send_message or report_status before finishing this turn, confirming what ` +
      `you did or your current status. Never leave a message read-but-unanswered. If you have a new ` +
      `test task, pull the full details from your task tracker, run or write the tests, and file any ` +
      `bugs you find as comments or new tasks. Update the task status as you go, and call ` +
      `report_status with your test results so "${args.masterHandle}" is notified. If you're stuck, ` +
      `send_message to "${args.masterHandle}" and check back next cycle for a reply.`
    );
  }
  if (args.role === "analyst") {
    return (
      `Check your teamhub inbox (handle="${args.handle}"). For EVERY unread message — a research ` +
      `or clarification request, a question, or anything from "owner" (the human operator) — you ` +
      `MUST reply to that exact sender with send_message before finishing this turn, even a short ` +
      `acknowledgment. Never leave a message read-but-unanswered. When asked to clarify requirements, ` +
      `don't guess or invent details — read the relevant tasks/comments, do any research needed ` +
      `(WebSearch/WebFetch), and give a clear, specific answer or a short list of open questions back ` +
      `to whoever asked, especially "${args.masterHandle}". When reviewing outcomes, look across ` +
      `multiple related tasks (list_tasks) for patterns — e.g. several bugs sharing a root cause — ` +
      `rather than one task in isolation, and add_comment with what you found. You don't write or ` +
      `edit code; if something needs a code fix, say so in your reply instead of attempting it.`
    );
  }
  return (
    `Check your teamhub inbox (handle="${args.handle}"). For EVERY unread message — a new task ` +
    `assignment, a question, or anything from "owner" (the human operator) — you MUST reply to ` +
    `that exact sender with send_message or report_status before finishing this turn, confirming ` +
    `what you did or your current status (done, in progress, blocked, etc). Never leave a message ` +
    `read-but-unanswered — reading it without replying looks identical to ignoring it entirely. If ` +
    `you have a new task assignment, pull the full details from your task tracker, work the code, ` +
    `and push to GitHub. Update the task status as you go, and call report_status so ` +
    `"${args.masterHandle}" is notified. If you're stuck, send_message to "${args.masterHandle}" ` +
    `and check back next cycle for a reply.`
  );
}

export function redirectPrompt(interruptText: string): string {
  return `Your Team Lead has interrupted your current work with this instruction: "${interruptText}". Stop what you were doing and follow this new instruction immediately.`;
}

interface SpawnHandle {
  child: Pick<ChildProcess, "kill">;
  result: Promise<{ stdout: string }>;
}

// cross-spawn, not node:child_process's execFile directly: on Windows,
// `claude` may resolve to claude.exe, claude.cmd, or claude.bat depending
// on how it was installed — execFile/spawnSync can fail with EINVAL trying
// to invoke a .cmd/.bat file directly, and the naive fix (`shell: true`)
// reopens exactly the prompt-injection risk noted above, since Node loses
// its argument-array injection protection on Windows once shell:true is
// set. cross-spawn resolves the real executable via normal PATH/PATHEXT
// lookup without shell interpretation.
// Extracted as a pure function purely so this exact assembly — assistant
// text first, stderr second — is directly testable without spawning a
// real `claude` process end-to-end. Matches agents/runner.ts.
export function exitErrorMessage(code: number | null, lastAssistantText: string, stderr: string): string {
  const detail = [lastAssistantText, stderr.trim()].filter(Boolean).join(" — ");
  return `claude exited with code ${code}: ${detail || "(no output captured)"}`;
}

function spawnClaude(
  prompt: string,
  handle: string,
  allowedTools: string,
  permissionMode: string
): SpawnHandle {
  const file = sessionFile(handle);
  const resumeArgs = existsSync(file) ? ["--resume", readFileSync(file, "utf-8").trim()] : [];
  const child: ChildProcess = crossSpawn(
    claudeCommand(),
    [
      "-p", prompt, ...resumeArgs,
      "--allowedTools", allowedTools,
      "--permission-mode", permissionMode,
      // stream-json (message-level, not --include-partial-messages'
      // token-level) + --verbose (required for stream-json to emit
      // anything beyond a bare init line) gives one JSON event per
      // assistant message / tool call as the cycle runs, instead of a
      // single blob only available once the whole turn finishes. Printed
      // live below so an auto-mode session actually shows what it's
      // doing, not just its final summary.
      "--output-format", "stream-json", "--verbose",
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  let lineBuffer = "";
  let stderr = "";
  let finalResult: unknown;
  // Claude Code's own "you've hit your weekly limit · resets ..." notice
  // arrives as a normal assistant text block over stdout, not stderr — see
  // agents/runner.ts (the server package's copy) for the full rationale.
  let lastAssistantText = "";

  child.stdout?.on("data", (chunk) => {
    lineBuffer += chunk;
    let newlineAt: number;
    while ((newlineAt = lineBuffer.indexOf("\n")) !== -1) {
      const line = lineBuffer.slice(0, newlineAt).trim();
      lineBuffer = lineBuffer.slice(newlineAt + 1);
      if (!line) continue;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue; // a malformed/partial line should never crash the runner
      }
      const text = logStreamEvent(handle, event);
      if (text) lastAssistantText = text;
      if (event?.type === "result") finalResult = event;
    }
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });

  const result = new Promise<{ stdout: string }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(exitErrorMessage(code, lastAssistantText, stderr)));
      } else if (finalResult === undefined) {
        reject(new Error(`claude exited 0 but no "result" event was seen in its stream-json output: ${stderr}`));
      } else {
        resolve({ stdout: JSON.stringify(finalResult) });
      }
    });
  });

  return { child, result };
}

// Best-effort, defensive console progress for stream-json events. See
// agents/runner.ts (the server package's copy) for the full rationale —
// kept identical here so both packages behave the same way. Returns the
// last assistant text block it printed (or undefined) so spawnClaude can
// fold it into the exit error above without duplicating this walk.
export function logStreamEvent(handle: string, event: any): string | undefined {
  try {
    if (event?.type === "assistant" && Array.isArray(event.message?.content)) {
      let lastText: string | undefined;
      for (const block of event.message.content) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
          console.log(`[${handle}] ${truncateForLog(block.text.trim())}`);
          lastText = block.text.trim();
        } else if (block?.type === "tool_use" && typeof block.name === "string") {
          console.log(`[${handle}] → calling ${block.name}(${truncateForLog(JSON.stringify(block.input ?? {}), 150)})`);
        }
      }
      return lastText;
    } else if (event?.type === "system" && event.subtype === "init") {
      console.log(`[${handle}] session started${event.model ? ` (model: ${event.model})` : ""}.`);
    }
  } catch {
    // A logging hiccup must never break the actual cycle.
  }
  return undefined;
}

function truncateForLog(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// Best-effort POST of the stream-json "result" event's own cost/usage
// fields to /api/usage (plain bearer HTTP, same as wait-for-work — never
// MCP). Fire-and-forget: a reporting hiccup must never fail or block a
// cycle that otherwise succeeded, and the caller doesn't await this.
// Matches agents/runner.ts (the server package's copy).
async function reportUsage(
  parsed: any,
  handle: string,
  teamhubBaseUrl: string | undefined,
  project: string | undefined,
  token: string | undefined
): Promise<void> {
  if (!teamhubBaseUrl || !project || !token) return;
  const usage = parsed?.usage ?? {};
  try {
    await fetch(`${teamhubBaseUrl}/api/usage`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        project_id: project,
        handle,
        session_id: parsed?.session_id,
        cost_usd: parsed?.total_cost_usd ?? 0,
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        cache_read_tokens: usage.cache_read_input_tokens ?? 0,
        cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
        duration_ms: parsed?.duration_ms,
        num_turns: parsed?.num_turns,
      }),
    });
  } catch {
    // Usage reporting is best-effort bookkeeping — never surfaced as a
    // cycle failure.
  }
}

function finishCycle(
  stdout: string,
  handle: string,
  usageCtx?: { teamhubBaseUrl?: string; project?: string; token?: string }
): void {
  const parsed = JSON.parse(stdout);
  if (parsed.result) {
    console.log(parsed.result);
  } else {
    console.log(`[${handle}] cycle finished (no summary text returned by this turn).`);
  }
  if (parsed.session_id) writeFileSync(sessionFile(handle), parsed.session_id);
  void reportUsage(parsed, handle, usageCtx?.teamhubBaseUrl, usageCtx?.project, usageCtx?.token);
}

export async function runCycle(
  prompt: string,
  handle: string,
  allowedTools: string,
  permissionMode: string,
  usageCtx?: { teamhubBaseUrl?: string; project?: string; token?: string }
): Promise<void> {
  const { result } = spawnClaude(prompt, handle, allowedTools, permissionMode);
  const { stdout } = await result;
  finishCycle(stdout, handle, usageCtx);
}

export interface InterruptOutcome {
  interrupted: boolean;
  interruptText?: string;
}

// Runs one cycle while concurrently polling for an interrupt from the Lead.
// If one arrives before the cycle finishes on its own, the in-flight
// `claude -p` process is killed immediately rather than waiting for it to
// finish. `spawn` and `pollInterrupt` are injected so this is testable
// without a real `claude` binary or network.
export async function runInterruptibleCycle(
  prompt: string,
  handle: string,
  allowedTools: string,
  permissionMode: string,
  pollInterrupt: () => Promise<string | undefined>,
  watchdogIntervalMs: number,
  spawn: typeof spawnClaude = spawnClaude,
  usageCtx?: { teamhubBaseUrl?: string; project?: string; token?: string }
): Promise<InterruptOutcome> {
  const { child, result } = spawn(prompt, handle, allowedTools, permissionMode);
  let stopped = false;
  let outcome: InterruptOutcome = { interrupted: false };

  const watchdog = (async () => {
    while (!stopped) {
      await new Promise((resolve) => setTimeout(resolve, watchdogIntervalMs));
      if (stopped) return;
      let text: string | undefined;
      try {
        text = await pollInterrupt();
      } catch {
        continue; // transient poll failure — try again next tick
      }
      if (text) {
        outcome = { interrupted: true, interruptText: text };
        child.kill();
        return;
      }
    }
  })();

  try {
    const { stdout } = await result;
    finishCycle(stdout, handle, usageCtx);
  } catch (err) {
    if (!outcome.interrupted) throw err;
  } finally {
    stopped = true;
    await watchdog;
  }

  return outcome;
}

// Registers this handle directly over MCP — no `claude -p` process, no
// tokens, same as pollForInterrupt below. See agents/runner.ts (the
// server package's copy) for the full rationale. Idempotent (registerMember
// is an upsert), so safe to call every time the runner starts.
export async function registerViaMcp(
  teamhubMcpUrl: string,
  handle: string,
  role: "master" | "developer" | "tester" | "analyst",
  project: string,
  mode: "auto" | "manual",
  token: string
): Promise<void> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "teamhub-client-register", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(teamhubMcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: "register",
      arguments: { handle, role, project_id: project, mode },
    });
    if (result.isError) {
      const content = (result.content as Array<{ type: string; text?: string }> | undefined)?.[0];
      throw new Error(content?.text ?? "register tool returned an error");
    }
  } finally {
    await client.close();
  }
}

// Polls TeamHub directly over MCP (not by shelling out to `claude`) so the
// watchdog can check for an interrupt every few seconds without spawning a
// whole extra `claude -p` process per tick.
export async function pollForInterrupt(teamhubMcpUrl: string, handle: string, token: string): Promise<string | undefined> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "teamhub-client-watchdog", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(teamhubMcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: "check_interrupt", arguments: { handle } });
    const content = (result.content as Array<{ type: string; text?: string }> | undefined)?.[0];
    if (!content?.text || content.text === "No interrupt.") return undefined;
    const message = JSON.parse(content.text) as { text: string };
    return message.text;
  } finally {
    await client.close();
  }
}

// Long-polls TeamHub's /api/wait-for-work over plain HTTP — see
// agents/runner.ts (the server package's copy) for the full rationale.
// Blocks server-side until this handle actually has something pending, or
// timeoutMs elapses; either way costs nothing (no claude spawned).
export async function waitForPendingWork(
  teamhubBaseUrlValue: string,
  role: "master" | "developer" | "tester" | "analyst",
  handle: string,
  project: string,
  token: string,
  timeoutMs: number
): Promise<boolean> {
  const url = new URL("/api/wait-for-work", teamhubBaseUrlValue);
  url.searchParams.set("role", role);
  url.searchParams.set("handle", handle);
  url.searchParams.set("project_id", project);
  url.searchParams.set("timeoutMs", String(timeoutMs));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`wait-for-work request failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { pending: boolean };
  return Boolean(body.pending);
}

// Resolution order: explicit TEAMHUB_URL env var, then the server
// `teamhub-client connect` stored — unlike the server package's own
// runner (which can safely default to localhost, since server and agent
// are often the same machine there), a pure client has no local server to
// fall back to, so this throws a clear, actionable error instead of
// silently trying localhost.
export function teamhubMcpUrl(): string {
  if (process.env.TEAMHUB_URL) return process.env.TEAMHUB_URL;
  const config = readConfig();
  if (config) return `${config.serverUrl}/mcp`;
  throw new Error(
    "Not connected to a TeamHub server. Run `teamhub-client connect <host:port>` first, or set TEAMHUB_URL."
  );
}

// Same resolution as teamhubMcpUrl(), but the base (no /mcp suffix) — used
// for the plain HTTP /api/wait-for-work long-poll rather than an MCP call.
export function teamhubBaseUrl(): string {
  if (process.env.TEAMHUB_URL) return process.env.TEAMHUB_URL.replace(/\/mcp\/?$/, "");
  const config = readConfig();
  if (config) return config.serverUrl;
  throw new Error(
    "Not connected to a TeamHub server. Run `teamhub-client connect <host:port>` first, or set TEAMHUB_URL."
  );
}

// Claude Code's own "you've hit your weekly/usage limit · resets <time> " +
// "(<zone>)" notice — see agents/runner.ts (the server package's copy) for
// the full rationale.
const USAGE_LIMIT_PATTERN = /\b(?:hit\s+your|usage|weekly|daily|monthly)\s+(?:[a-z]+\s+)?limit\b/i;
const DEFAULT_LIMIT_BACKOFF_MS = 15 * 60 * 1000;
const MIN_BACKOFF_MS = 30 * 1000;

// Best-effort parse of "resets 2:30pm (Asia/Calcutta)" into a millisecond
// delay from now. See agents/runner.ts (the server package's copy) for the
// full rationale — kept identical here.
export function parseResetDelayMs(message: string, now: Date = new Date()): number | undefined {
  const match = message.match(/resets?\s+(\d{1,2}):(\d{2})\s*([ap]m)\s*\(([^)]+)\)/i);
  if (!match) return undefined;
  const [, hStr, mStr, ampm, tz] = match;
  let hour = Number(hStr) % 12;
  if (ampm.toLowerCase() === "pm") hour += 12;
  const minute = Number(mStr);
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(now);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const zoneNow = new Date(Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")));
    const offsetMs = zoneNow.getTime() - now.getTime();
    let resetUtc = new Date(Date.UTC(get("year"), get("month") - 1, get("day"), hour, minute, 0) - offsetMs);
    if (resetUtc.getTime() <= now.getTime()) resetUtc = new Date(resetUtc.getTime() + 24 * 60 * 60 * 1000);
    const delay = resetUtc.getTime() - now.getTime();
    return Number.isFinite(delay) && delay > 0 ? delay : undefined;
  } catch {
    return undefined; // unrecognized/invalid IANA zone name
  }
}

// Returns a backoff duration if `err` looks like Claude's usage-limit
// notice, or undefined if it's some other failure that should keep
// propagating as a real error instead of being silently retried forever.
export function usageLimitBackoffMs(err: unknown, now: Date = new Date()): number | undefined {
  const message = err instanceof Error ? err.message : String(err);
  if (!USAGE_LIMIT_PATTERN.test(message)) return undefined;
  const parsed = parseResetDelayMs(message, now);
  return Math.max(parsed ?? DEFAULT_LIMIT_BACKOFF_MS, MIN_BACKOFF_MS);
}

// Waits out a usage-limit backoff in short chunks via the existing
// zero-token long-poll (waitForPendingWork) instead of a flat sleep, so
// this handle's last_seen keeps getting touched during the whole backoff.
async function sleepWithHeartbeat(
  ms: number,
  baseUrl: string,
  role: RunnerArgs["role"],
  handle: string,
  project: string,
  token: string
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const chunk = Math.min(deadline - Date.now(), 60_000);
    try {
      await waitForPendingWork(baseUrl, role, handle, project, token, chunk);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, Math.min(chunk, 5000)));
    }
  }
}

function describeLimitError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\n")[0];
}

function teamhubTokenFromEnv(): string {
  const token = process.env.TEAMHUB_TOKEN;
  if (!token) {
    throw new Error(
      "TEAMHUB_TOKEN environment variable is required — the shared token TeamHub printed at startup " +
        "on the server machine (also in ~/.teamhub/teamhub.token there). Set it before running the " +
        "agent, e.g. TEAMHUB_TOKEN=... teamhub-client agent --role developer ..."
    );
  }
  return token;
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const allowedTools = allowedToolsFor(args.role);
  const permissionMode = permissionModeFor(args);
  const url = teamhubMcpUrl();
  const baseUrl = teamhubBaseUrl();
  const token = teamhubTokenFromEnv();
  const watchdogEnabled = args.role !== "master" && args.mode === "auto";
  const heartbeat = (ms: number) => sleepWithHeartbeat(ms, baseUrl, args.role, args.handle, args.project, token);
  const usageCtx = { teamhubBaseUrl: baseUrl, project: args.project, token };

  console.log(
    `Starting ${args.role} (${args.handle}) on project ${args.project}` +
      (args.role !== "master" ? ` [mode=${args.mode}]` : "") +
      ` via ${url} ...`
  );

  // Same preflight as the server package's runner: Claude Code discovers
  // .mcp.json from the current working directory, and nothing here passes
  // an explicit --mcp-config. Wrong cwd is the most common reason a
  // headless agent looks stuck doing nothing.
  if (!existsSync(join(process.cwd(), ".mcp.json"))) {
    console.warn(
      `Warning: no .mcp.json found in ${process.cwd()}. ` +
        `Claude Code discovers MCP servers from the current directory — ` +
        `if teamhub/github aren't configured globally, cd into the ` +
        `project directory that has .mcp.json before running this command.`
    );
  }

  // Comes online immediately, over MCP, with zero Claude tokens spent —
  // does not wait on (or get blocked by) any usage limit below.
  console.log(`Registering ${args.handle} with TeamHub (no Claude tokens used for this)...`);
  try {
    await registerViaMcp(url, args.handle, args.role, args.project, args.mode, token);
  } catch (err) {
    console.error(
      `Could not register ${args.handle} with TeamHub. Common causes: TeamHub isn't running, ` +
        `TEAMHUB_URL/TEAMHUB_TOKEN are wrong, or the server is unreachable. Underlying error:`,
      err
    );
    throw err;
  }

  console.log(`Waiting for the first response from Claude — this can take a little while...`);
  for (;;) {
    try {
      await runCycle(kickoffPrompt(args), args.handle, allowedTools, permissionMode, usageCtx);
      break;
    } catch (err) {
      const backoffMs = usageLimitBackoffMs(err);
      if (backoffMs === undefined) {
        console.error(
          `Initial discovery cycle failed for ${args.handle}. Common causes: ` +
            `"claude" not on PATH, not logged in (run "claude /login"), or the ` +
            `MCP servers this needs (see the .mcp.json warning above, if any) ` +
            `aren't reachable. Underlying error:`,
          err
        );
        throw err;
      }
      console.warn(
        `${args.handle}: hit Claude's usage limit on the first cycle (${describeLimitError(err)}). ` +
          `Backing off ~${Math.round(backoffMs / 60000)} min before retrying — already registered ` +
          `and online with TeamHub, no further tokens spent until then.`
      );
      await heartbeat(backoffMs);
    }
  }

  for (;;) {
    let pending: boolean;
    try {
      // Blocks here — no sleep, no fixed interval — until TeamHub reports
      // this handle actually has something pending, or args.cycle (now a
      // long-poll timeout/reconnect ceiling, not a literal sleep duration)
      // elapses. Costs nothing either way — no claude process, no tokens.
      pending = await waitForPendingWork(baseUrl, args.role, args.handle, args.project, token, args.cycle * 1000);
    } catch (err) {
      console.error(`${args.handle}: wait-for-work failed, retrying in 5s:`, err);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      continue;
    }
    if (!pending) {
      console.log(`${args.handle}: still idle after waiting — reconnecting to wait again (no tokens used).`);
      continue;
    }
    try {
      if (watchdogEnabled) {
        const outcome = await runInterruptibleCycle(
          cyclePrompt(args),
          args.handle,
          allowedTools,
          permissionMode,
          () => pollForInterrupt(url, args.handle, token),
          args.watchdogInterval * 1000,
          spawnClaude,
          usageCtx
        );
        if (outcome.interrupted && outcome.interruptText) {
          console.log(`Interrupted by Lead: ${outcome.interruptText}`);
          await runCycle(redirectPrompt(outcome.interruptText), args.handle, allowedTools, permissionMode, usageCtx);
        }
      } else {
        await runCycle(cyclePrompt(args), args.handle, allowedTools, permissionMode, usageCtx);
      }
    } catch (err) {
      const backoffMs = usageLimitBackoffMs(err);
      if (backoffMs === undefined) {
        console.error(`${args.handle}: cycle failed, retrying in 5s:`, err);
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }
      console.warn(
        `${args.handle}: hit Claude's usage limit (${describeLimitError(err)}). Backing off ` +
          `~${Math.round(backoffMs / 60000)} min before retrying — still registered and online with ` +
          `TeamHub, no further tokens spent until then.`
      );
      await heartbeat(backoffMs);
    }
  }
}
