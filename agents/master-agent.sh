#!/usr/bin/env bash
set -euo pipefail

# MASTER / TEAM LEAD loop. Runs on its own PC, uses the `claude` CLI you're
# already logged into (Team plan) — no API key, no extra billing.
#
# Requires: jq, and the `claude` CLI logged in (claude /login) on this machine.
# Requires: this machine's .mcp.json includes "team-relay" pointing at
#           http://<PC1-LAN-IP>:8787/mcp, plus your task tracker (Jira or the built-in Planner) and GitHub MCP entries.
#
# Usage:
#   TEAM_ID=bts-project HANDLE=master-1 CYCLE_SECONDS=60 ./agents/master-agent.sh

TEAM_ID="${TEAM_ID:-default-team}"
HANDLE="${HANDLE:-master-1}"
CYCLE_SECONDS="${CYCLE_SECONDS:-60}"
SESSION_FILE=".master-session-id"

ALLOWED_TOOLS="mcp__team-relay__register,mcp__team-relay__assign_task,mcp__team-relay__send_message,mcp__team-relay__check_inbox,mcp__team-relay__list_team,mcp__jira__*,mcp__planner__*,mcp__github__*"

run_cycle () {
  local prompt="$1"
  local resume_args=()
  if [[ -f "$SESSION_FILE" ]]; then
    resume_args=(--resume "$(cat "$SESSION_FILE")")
  fi

  local result
  result=$(claude -p "$prompt" \
    "${resume_args[@]}" \
    --allowedTools "$ALLOWED_TOOLS" \
    --permission-mode acceptEdits \
    --output-format json)

  echo "$result" | jq -r '.result // empty'
  echo "$result" | jq -r '.session_id // empty' > "$SESSION_FILE"
}

echo "Starting Master ($HANDLE) on team $TEAM_ID..."

run_cycle "You are the Team Lead for project \"$TEAM_ID\". Your handle is \"$HANDLE\". First, call the team-relay register tool with handle=\"$HANDLE\", role=\"master\", team_id=\"$TEAM_ID\". Then check your task tracker (Jira, or the built-in Planner via list_tasks) for open backlog items in this project and summarize them."

while true; do
  sleep "$CYCLE_SECONDS"
  run_cycle "Check your team-relay inbox (handle=\"$HANDLE\"). Answer any developer questions with send_message. Reflect any status updates in your task tracker. If a developer has no active task and there is ready backlog work, assign it with assign_task."
done
