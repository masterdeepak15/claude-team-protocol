#!/usr/bin/env bash
set -euo pipefail

# DEVELOPER loop. Run one of these per developer, each on its own PC if you
# like — each uses the local `claude` CLI login (Team plan), so PC2, PC3,
# etc. are fully independent of each other.
#
# Requires: jq, `claude` CLI logged in on this machine, and this project's
#           .mcp.json wired to team-relay (http://<PC1-LAN-IP>:8787/mcp)
#           plus a task tracker (Jira or the built-in Planner) and GitHub MCP entries.
#
# Usage:
#   TEAM_ID=bts-project HANDLE=dev-A MASTER_HANDLE=master-1 ./agents/developer-agent.sh

TEAM_ID="${TEAM_ID:-default-team}"
HANDLE="${HANDLE:-dev-A}"
MASTER_HANDLE="${MASTER_HANDLE:-master-1}"
CYCLE_SECONDS="${CYCLE_SECONDS:-30}"
SESSION_FILE=".${HANDLE}-session-id"

ALLOWED_TOOLS="mcp__team-relay__register,mcp__team-relay__send_message,mcp__team-relay__check_inbox,mcp__team-relay__report_status,mcp__jira__*,mcp__planner__*,mcp__github__*,Read,Edit,Bash"

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

echo "Starting Developer ($HANDLE) on team $TEAM_ID, reporting to $MASTER_HANDLE..."

run_cycle "You are a Developer on project \"$TEAM_ID\". Your handle is \"$HANDLE\", your Team Lead's handle is \"$MASTER_HANDLE\". First, call the team-relay register tool with handle=\"$HANDLE\", role=\"developer\", team_id=\"$TEAM_ID\". Then check your inbox for an assigned task."

while true; do
  sleep "$CYCLE_SECONDS"
  run_cycle "Check your team-relay inbox (handle=\"$HANDLE\"). If you have a new task assignment, pull the full details from your task tracker (Jira or Planner), work the code, and push to GitHub. Update the task status in your tracker as you go, and call report_status so \"$MASTER_HANDLE\" is notified. If you're stuck or need a decision, send_message to \"$MASTER_HANDLE\" and check back next cycle for a reply."
done
