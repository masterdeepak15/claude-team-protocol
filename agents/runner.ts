#!/usr/bin/env node
import type { ChildProcess } from "node:child_process";
import crossSpawn from "cross-spawn";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

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
    // Without this, args.masterHandle is undefined and every prompt this
    // runner sends ends up literally containing the text "undefined" where
    // the Lead's handle should be — a confusing, silent failure mode.
    throw new Error(`--master-handle is required when --role is "${raw.role}"`);
  }
  const cycle = Number(raw.cycle ?? (raw.role === "master" ? 60 : 30));
  if (!Number.isFinite(cycle) || cycle <= 0) {
    throw new Error(`--cycle must be a positive number of seconds, got "${raw.cycle}"`);
  }
  const watchdogInterval = Number(raw["watchdog-interval"] ?? 5);
  if (!Number.isFinite(watchdogInterval) || watchdogInterval <= 0) {
    // A typo here (e.g. a non-numeric value) would otherwise silently
    // become NaN, which setTimeout treats as ~0ms — a tight, silent,
    // token-burning loop rather than a clear error at startup.
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
// (.exe, .cmd, .bat, or no extension at all on POSIX). Don't hardcode a
// specific extension here: which one a real Claude Code install produces
// on Windows varies by install method, and guessing wrong just trades one
// spawn failure for another.
export function claudeCommand(): string {
  return "claude";
}

// Always acceptEdits, deliberately never bypassPermissions: TeamHub has no
// authentication, so anyone reaching its HTTP port could otherwise inject
// text (e.g. via interrupt_developer's `reason`) that gets fed verbatim as
// the next instruction to a fully unconfirmed session — a real
// prompt-injection-to-RCE path if Bash execution were auto-approved too.
// 'auto' mode's real feature is auto-approved edits + interruptibility
// (see runInterruptibleCycle), not removing Bash's confirmation gate.
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

// Analyst deliberately has no Edit/Bash — it clarifies requirements,
// researches open questions, and reviews task/test outcomes for patterns,
// but doesn't write code. Read (to actually look at code/test output when
// reviewing) and WebSearch/WebFetch (for research) stand in for Edit/Bash.
const ALLOWED_TOOLS_ANALYST =
  "mcp__teamhub__register,mcp__teamhub__send_message,mcp__teamhub__check_inbox," +
  "mcp__teamhub__report_status,mcp__teamhub__get_task,mcp__teamhub__list_tasks," +
  "mcp__teamhub__list_team,mcp__teamhub__add_comment,mcp__teamhub__set_mode," +
  "mcp__github__*,Read,WebSearch,WebFetch";

export function kickoffPrompt(args: RunnerArgs): string {
  if (args.role === "master") {
    return `You are the Team Lead for project "${args.project}". Your handle is "${args.handle}". First, call the teamhub register tool with handle="${args.handle}", role="master", project_id="${args.project}". Then check your task tracker for open backlog items in this project and summarize them.`;
  }
  if (args.role === "tester") {
    return `You are a Tester on project "${args.project}". Your handle is "${args.handle}", your Team Lead's handle is "${args.masterHandle}". First, call the teamhub register tool with handle="${args.handle}", role="tester", project_id="${args.project}", mode="${args.mode}". Then check your inbox for an assigned test task.`;
  }
  if (args.role === "analyst") {
    return `You are an Analyst on project "${args.project}". Your handle is "${args.handle}", your Team Lead's handle is "${args.masterHandle}". First, call the teamhub register tool with handle="${args.handle}", role="analyst", project_id="${args.project}", mode="${args.mode}". Then check your inbox for a research/clarification request, and skim the project's open tasks for anything ambiguous the Lead should know about before assigning it.`;
  }
  return `You are a Developer on project "${args.project}". Your handle is "${args.handle}", your Team Lead's handle is "${args.masterHandle}". First, call the teamhub register tool with handle="${args.handle}", role="developer", project_id="${args.project}", mode="${args.mode}". Then check your inbox for an assigned task.`;
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

// Uses cross-spawn rather than node:child_process's execFile directly:
// on Windows, `claude` resolves to `claude.cmd`, and Windows can only
// execute .cmd/.bat files through cmd.exe — execFile/spawnSync fail with
// EINVAL trying to invoke one directly. The naive fix (`shell: true`)
// reopens exactly the prompt-injection risk fixed elsewhere in this file:
// Node explicitly loses its argument-array injection protection on
// Windows once `shell: true` is set, since the whole command line gets
// concatenated and re-interpreted by cmd.exe. cross-spawn solves the
// .cmd-invocation problem without that trade-off — it does its own
// careful argument escaping so each array element still reaches the
// child process as a literal value, not something cmd.exe re-parses.
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
    // stdin explicitly closed ("ignore"), not left as the default open pipe.
    // This is headless/unattended — nobody is ever going to type a response.
    // If any code path inside `claude` ever tries to read a confirmation
    // from stdin, an open-but-silent pipe means it blocks forever with no
    // error at all: exactly a silent hang, indistinguishable from "still
    // working". Closing it means that read fails immediately instead.
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  let lineBuffer = "";
  let stderr = "";
  let finalResult: unknown;

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
      logStreamEvent(handle, event);
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
        reject(new Error(`claude exited with code ${code}: ${stderr}`));
      } else if (finalResult === undefined) {
        reject(new Error(`claude exited 0 but no "result" event was seen in its stream-json output: ${stderr}`));
      } else {
        // Re-serialized so finishCycle (JSON.parse(stdout)) sees the exact
        // same shape it always has — this only changes how the final
        // result gets assembled, not the contract around it.
        resolve({ stdout: JSON.stringify(finalResult) });
      }
    });
  });

  return { child, result };
}

// Best-effort, defensive console progress for stream-json events. Anthropic
// hasn't published a full type reference for these event shapes (tracked in
// anthropics/claude-code#24596 as of mid-2026), so this deliberately reads
// everything through optional chaining and silently drops anything it
// doesn't recognize rather than risk crashing a real cycle over a logging
// line.
export function logStreamEvent(handle: string, event: any): void {
  try {
    if (event?.type === "assistant" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
          console.log(`[${handle}] ${truncateForLog(block.text.trim())}`);
        } else if (block?.type === "tool_use" && typeof block.name === "string") {
          console.log(`[${handle}] → calling ${block.name}(${truncateForLog(JSON.stringify(block.input ?? {}), 150)})`);
        }
      }
    } else if (event?.type === "system" && event.subtype === "init") {
      console.log(`[${handle}] session started${event.model ? ` (model: ${event.model})` : ""}.`);
    }
    // tool_result ("user"-role) events and other system subtypes are
    // intentionally not printed — the tool_use line above already shows
    // what was called; the assistant's next text block usually summarizes
    // the outcome anyway, so this stays a readable progress log rather
    // than a full raw transcript dump.
  } catch {
    // A logging hiccup must never break the actual cycle.
  }
}

function truncateForLog(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function finishCycle(stdout: string, handle: string): void {
  const parsed = JSON.parse(stdout);
  if (parsed.result) {
    console.log(parsed.result);
  } else {
    console.log(`[${handle}] cycle finished (no summary text returned by this turn).`);
  }
  if (parsed.session_id) writeFileSync(sessionFile(handle), parsed.session_id);
}

export async function runCycle(
  prompt: string,
  handle: string,
  allowedTools: string,
  permissionMode: string
): Promise<void> {
  const { result } = spawnClaude(prompt, handle, allowedTools, permissionMode);
  const { stdout } = await result;
  finishCycle(stdout, handle);
}

export interface InterruptOutcome {
  interrupted: boolean;
  interruptText?: string;
}

// Runs one cycle while concurrently polling for an interrupt from the Lead.
// If one arrives before the cycle finishes on its own, the in-flight
// `claude -p` process is killed immediately rather than waiting for it to
// finish — that's the actual interrupt. `spawn` and `pollInterrupt` are
// injected so this is testable without a real `claude` binary or network.
export async function runInterruptibleCycle(
  prompt: string,
  handle: string,
  allowedTools: string,
  permissionMode: string,
  pollInterrupt: () => Promise<string | undefined>,
  watchdogIntervalMs: number,
  spawn: typeof spawnClaude = spawnClaude
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
    finishCycle(stdout, handle);
  } catch (err) {
    if (!outcome.interrupted) throw err;
  } finally {
    stopped = true;
    await watchdog;
  }

  return outcome;
}

// Polls TeamHub directly over MCP (not by shelling out to `claude`) so the
// watchdog can check for an interrupt every few seconds without spawning a
// whole extra `claude -p` process per tick.
export async function pollForInterrupt(teamhubUrl: string, handle: string, token: string): Promise<string | undefined> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "teamhub-runner-watchdog", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(teamhubUrl), {
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

// Long-polls TeamHub's /api/wait-for-work over plain HTTP — not MCP, and
// deliberately not a fixed sleep-then-ask interval either. The request
// itself blocks server-side (see teamhub/api.ts) until either this handle
// actually has something pending, or `timeoutMs` elapses, whichever comes
// first. That means: no Claude spawned and no tokens spent while idle
// (same as before), but now also no wasted round trips at all when quiet,
// and reaction time is bounded by the event arriving, not by whatever the
// polling interval happened to be.
export async function waitForPendingWork(
  teamhubBaseUrl: string,
  role: "master" | "developer" | "tester" | "analyst",
  handle: string,
  project: string,
  token: string,
  timeoutMs: number
): Promise<boolean> {
  const url = new URL("/api/wait-for-work", teamhubBaseUrl);
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

function teamhubUrlFromEnv(): string {
  return process.env.TEAMHUB_URL || `http://localhost:${process.env.TEAMHUB_PORT || 8787}/mcp`;
}

// /mcp and /api/wait-for-work live on the same TeamHub server; TEAMHUB_URL
// is documented (and used in .mcp.json) as the /mcp endpoint specifically,
// so the base URL for other HTTP routes is that with /mcp stripped off.
function teamhubBaseUrlFromEnv(): string {
  return teamhubUrlFromEnv().replace(/\/mcp\/?$/, "");
}

function teamhubTokenFromEnv(): string {
  const token = process.env.TEAMHUB_TOKEN;
  if (!token) {
    throw new Error(
      "TEAMHUB_TOKEN environment variable is required — the shared token TeamHub printed at startup " +
        "(also saved to ~/.teamhub/teamhub.token on the machine running the server). Set it before " +
        "running the agent, e.g. TEAMHUB_TOKEN=... teamhub agent --role master ..."
    );
  }
  return token;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const allowedTools =
    args.role === "master" ? ALLOWED_TOOLS_MASTER : args.role === "analyst" ? ALLOWED_TOOLS_ANALYST : ALLOWED_TOOLS_WORKER;
  const permissionMode = permissionModeFor(args);
  const teamhubUrl = teamhubUrlFromEnv();
  const teamhubBaseUrl = teamhubBaseUrlFromEnv();
  const token = teamhubTokenFromEnv();
  const watchdogEnabled = args.role !== "master" && args.mode === "auto";

  console.log(
    `Starting ${args.role} (${args.handle}) on project ${args.project}` +
      (args.role !== "master" ? ` [mode=${args.mode}]` : "") +
      "..."
  );

  // The single most common reason a headless agent looks "stuck doing
  // nothing": claude Code discovers .mcp.json from the CURRENT WORKING
  // DIRECTORY, and nothing here passes an explicit --mcp-config path. If
  // you run `teamhub agent ...` from the wrong folder, none of the
  // mcp__teamhub__* / mcp__github__* tools this prompt asks Claude to call
  // actually exist — Claude doesn't hang, but it can spend a long time
  // confused, or finish having done nothing useful, which looks the same
  // from the outside. This is just a warning, not a hard stop, since some
  // setups use a global/user-scope MCP config instead of a project one.
  if (!existsSync(join(process.cwd(), ".mcp.json"))) {
    console.warn(
      `Warning: no .mcp.json found in ${process.cwd()}. ` +
        `Claude Code discovers MCP servers from the current directory — ` +
        `if teamhub/jira/github aren't configured globally, cd into the ` +
        `project directory that has .mcp.json before running this command.`
    );
  }

  console.log(`Waiting for the first response from Claude — this can take a little while...`);
  try {
    await runCycle(kickoffPrompt(args), args.handle, allowedTools, permissionMode);
  } catch (err) {
    console.error(
      `Initial registration cycle failed for ${args.handle}. Common causes: ` +
        `"claude" not on PATH, not logged in (run "claude /login"), or the ` +
        `MCP servers this needs (see the .mcp.json warning above, if any) ` +
        `aren't reachable. Underlying error:`,
      err
    );
    throw err;
  }

  for (;;) {
    try {
      // Blocks here — no sleep, no fixed interval — until TeamHub reports
      // this handle actually has something pending, or args.cycle (now a
      // long-poll timeout/reconnect ceiling, not a literal sleep duration)
      // elapses. Either way this call itself costs nothing: no claude
      // process, no tokens, whether it returns in 50ms or the full timeout.
      const pending = await waitForPendingWork(
        teamhubBaseUrl,
        args.role,
        args.handle,
        args.project,
        token,
        args.cycle * 1000
      );
      if (!pending) {
        console.log(`${args.handle}: still idle after waiting — reconnecting to wait again (no tokens used).`);
        continue;
      }
      if (watchdogEnabled) {
        const outcome = await runInterruptibleCycle(
          cyclePrompt(args),
          args.handle,
          allowedTools,
          permissionMode,
          () => pollForInterrupt(teamhubUrl, args.handle, token),
          args.watchdogInterval * 1000
        );
        if (outcome.interrupted && outcome.interruptText) {
          console.log(`Interrupted by Lead: ${outcome.interruptText}`);
          await runCycle(redirectPrompt(outcome.interruptText), args.handle, allowedTools, permissionMode);
        }
      } else {
        await runCycle(cyclePrompt(args), args.handle, allowedTools, permissionMode);
      }
    } catch (err) {
      // Most likely a transient network hiccup talking to TeamHub (not a
      // cycle failure — those are caught separately inside runCycle's
      // callers above). A short fixed backoff keeps this from becoming a
      // tight, silent, CPU-spinning retry loop if TeamHub is down for a
      // while.
      console.error(`${args.handle}: wait-for-work failed, retrying in 5s:`, err);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

function isMain(): boolean {
  if (!process.argv[1]) return false;
  const invoked = process.argv[1].replace(/\\/g, "/");
  const thisFile = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  return invoked.endsWith(thisFile) || thisFile.endsWith(invoked);
}

if (isMain()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
