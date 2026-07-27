#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

export interface RunnerArgs {
  role: "master" | "developer";
  project: string;
  handle: string;
  masterHandle?: string;
  cycle: number;
}

export function parseArgs(argv: string[]): RunnerArgs {
  const raw: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      raw[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  if (raw.role !== "master" && raw.role !== "developer") {
    throw new Error(`--role must be "master" or "developer", got "${raw.role}"`);
  }
  if (!raw.project) throw new Error("--project is required");
  if (!raw.handle) throw new Error("--handle is required");
  return {
    role: raw.role,
    project: raw.project,
    handle: raw.handle,
    masterHandle: raw["master-handle"],
    cycle: Number(raw.cycle ?? (raw.role === "master" ? 60 : 30)),
  };
}

export function claudeCommand(): string {
  return process.platform === "win32" ? "claude.cmd" : "claude";
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
  "mcp__teamhub__add_comment,mcp__github__*";

const ALLOWED_TOOLS_DEVELOPER =
  "mcp__teamhub__register,mcp__teamhub__send_message,mcp__teamhub__check_inbox," +
  "mcp__teamhub__report_status,mcp__teamhub__get_task,mcp__teamhub__update_task_status," +
  "mcp__teamhub__add_comment,mcp__github__*,Read,Edit,Bash";

export function kickoffPrompt(args: RunnerArgs): string {
  if (args.role === "master") {
    return `You are the Team Lead for project "${args.project}". Your handle is "${args.handle}". First, call the teamhub register tool with handle="${args.handle}", role="master", project_id="${args.project}". Then check your task tracker for open backlog items in this project and summarize them.`;
  }
  return `You are a Developer on project "${args.project}". Your handle is "${args.handle}", your Team Lead's handle is "${args.masterHandle}". First, call the teamhub register tool with handle="${args.handle}", role="developer", project_id="${args.project}". Then check your inbox for an assigned task.`;
}

export function cyclePrompt(args: RunnerArgs): string {
  if (args.role === "master") {
    return `Check your teamhub inbox (handle="${args.handle}"). Answer any developer questions with send_message. Reflect any status updates in your task tracker. If a developer has no active task and there is ready backlog work, assign it with assign_task and notify_assignment.`;
  }
  return `Check your teamhub inbox (handle="${args.handle}"). If you have a new task assignment, pull the full details from your task tracker, work the code, and push to GitHub. Update the task status as you go, and call report_status so "${args.masterHandle}" is notified. If you're stuck, send_message to "${args.masterHandle}" and check back next cycle for a reply.`;
}

async function runCycle(prompt: string, handle: string, allowedTools: string): Promise<void> {
  const file = sessionFile(handle);
  const resumeArgs = existsSync(file) ? ["--resume", readFileSync(file, "utf-8").trim()] : [];
  const { stdout } = await execFileAsync(
    claudeCommand(),
    ["-p", prompt, ...resumeArgs, "--allowedTools", allowedTools, "--permission-mode", "acceptEdits", "--output-format", "json"],
    { maxBuffer: 10 * 1024 * 1024 }
  );
  const result = JSON.parse(stdout);
  if (result.result) console.log(result.result);
  if (result.session_id) writeFileSync(file, result.session_id);
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const allowedTools = args.role === "master" ? ALLOWED_TOOLS_MASTER : ALLOWED_TOOLS_DEVELOPER;
  console.log(`Starting ${args.role} (${args.handle}) on project ${args.project}...`);
  await runCycle(kickoffPrompt(args), args.handle, allowedTools);

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, args.cycle * 1000));
    try {
      await runCycle(cyclePrompt(args), args.handle, allowedTools);
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
