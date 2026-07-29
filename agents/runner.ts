#!/usr/bin/env node
import type { ChildProcess } from "node:child_process";
import crossSpawn from "cross-spawn";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface RunnerArgs {
  role: "master" | "developer" | "tester";
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
  if (raw.role !== "master" && raw.role !== "developer" && raw.role !== "tester") {
    throw new Error(`--role must be "master", "developer", or "tester", got "${raw.role}"`);
  }
  if (!raw.project) throw new Error("--project is required");
  if (!raw.handle) throw new Error("--handle is required");
  if (raw.mode !== undefined && raw.mode !== "auto" && raw.mode !== "manual") {
    throw new Error(`--mode must be "auto" or "manual", got "${raw.mode}"`);
  }
  return {
    role: raw.role,
    project: raw.project,
    handle: raw.handle,
    masterHandle: raw["master-handle"],
    cycle: Number(raw.cycle ?? (raw.role === "master" ? 60 : 30)),
    mode: (raw.mode as "auto" | "manual" | undefined) ?? "manual",
    watchdogInterval: Number(raw["watchdog-interval"] ?? 5),
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

export function kickoffPrompt(args: RunnerArgs): string {
  if (args.role === "master") {
    return `You are the Team Lead for project "${args.project}". Your handle is "${args.handle}". First, call the teamhub register tool with handle="${args.handle}", role="master", project_id="${args.project}". Then check your task tracker for open backlog items in this project and summarize them.`;
  }
  if (args.role === "tester") {
    return `You are a Tester on project "${args.project}". Your handle is "${args.handle}", your Team Lead's handle is "${args.masterHandle}". First, call the teamhub register tool with handle="${args.handle}", role="tester", project_id="${args.project}", mode="${args.mode}". Then check your inbox for an assigned test task.`;
  }
  return `You are a Developer on project "${args.project}". Your handle is "${args.handle}", your Team Lead's handle is "${args.masterHandle}". First, call the teamhub register tool with handle="${args.handle}", role="developer", project_id="${args.project}", mode="${args.mode}". Then check your inbox for an assigned task.`;
}

export function cyclePrompt(args: RunnerArgs): string {
  if (args.role === "master") {
    return `Check your teamhub inbox (handle="${args.handle}"). Answer any developer or tester questions with send_message. Reflect any status updates in your task tracker. If a developer or tester has no active task and there is ready work for them, assign it with assign_task and notify_assignment.`;
  }
  if (args.role === "tester") {
    return `Check your teamhub inbox (handle="${args.handle}"). If you have a new test task, pull the full details from your task tracker, run or write the tests, and file any bugs you find as comments or new tasks. Update the task status as you go, and call report_status with your test results so "${args.masterHandle}" is notified. If you're stuck, send_message to "${args.masterHandle}" and check back next cycle for a reply.`;
  }
  return `Check your teamhub inbox (handle="${args.handle}"). If you have a new task assignment, pull the full details from your task tracker, work the code, and push to GitHub. Update the task status as you go, and call report_status so "${args.masterHandle}" is notified. If you're stuck, send_message to "${args.masterHandle}" and check back next cycle for a reply.`;
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
    ["-p", prompt, ...resumeArgs, "--allowedTools", allowedTools, "--permission-mode", permissionMode, "--output-format", "json"]
  );

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });

  const result = new Promise<{ stdout: string }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`claude exited with code ${code}: ${stderr}`));
      } else {
        resolve({ stdout });
      }
    });
  });

  return { child, result };
}

function finishCycle(stdout: string, handle: string): void {
  const parsed = JSON.parse(stdout);
  if (parsed.result) console.log(parsed.result);
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
export async function pollForInterrupt(teamhubUrl: string, handle: string): Promise<string | undefined> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "teamhub-runner-watchdog", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(teamhubUrl));
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

// Same idea as pollForInterrupt: talks to TeamHub directly over MCP, no
// Claude spawn, no tokens. Called once per sleep interval in the main loop
// to decide whether a real (token-costing) cycle is worth running at all.
export async function pollForPendingWork(
  teamhubUrl: string,
  role: "master" | "developer" | "tester",
  handle: string,
  project: string
): Promise<boolean> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "teamhub-runner-gate", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(teamhubUrl));
  await client.connect(transport);
  try {
    const result = await client.callTool({
      name: "has_pending_work",
      arguments: { role, handle, project_id: project },
    });
    const content = (result.content as Array<{ type: string; text?: string }> | undefined)?.[0];
    return content?.text === "pending";
  } finally {
    await client.close();
  }
}

function teamhubUrlFromEnv(): string {
  return process.env.TEAMHUB_URL || `http://localhost:${process.env.TEAMHUB_PORT || 8787}/mcp`;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const allowedTools = args.role === "master" ? ALLOWED_TOOLS_MASTER : ALLOWED_TOOLS_WORKER;
  const permissionMode = permissionModeFor(args);
  const teamhubUrl = teamhubUrlFromEnv();
  const watchdogEnabled = args.role !== "master" && args.mode === "auto";

  console.log(
    `Starting ${args.role} (${args.handle}) on project ${args.project}` +
      (args.role !== "master" ? ` [mode=${args.mode}]` : "") +
      "..."
  );
  await runCycle(kickoffPrompt(args), args.handle, allowedTools, permissionMode);

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, args.cycle * 1000));
    try {
      const pending = await pollForPendingWork(teamhubUrl, args.role, args.handle, args.project);
      if (!pending) {
        console.log(`${args.handle}: idle, nothing pending — skipping this cycle (no tokens used).`);
        continue;
      }
      if (watchdogEnabled) {
        const outcome = await runInterruptibleCycle(
          cyclePrompt(args),
          args.handle,
          allowedTools,
          permissionMode,
          () => pollForInterrupt(teamhubUrl, args.handle),
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
      console.error("Cycle failed, will retry next cycle:", err);
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
