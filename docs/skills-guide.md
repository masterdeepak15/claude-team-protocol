# Writing and Using Claude Code Skills

A skill is a folder containing a `SKILL.md` file that teaches a Claude Code
session how to behave for a specific role or task. This project ships three:
`skills/team-lead`, `skills/team-developer`, and `skills/project-planner`.

## Anatomy of a SKILL.md

Every SKILL.md starts with YAML frontmatter, then Markdown instructions:

```markdown
---
name: my-skill-name
description: "One or two sentences: when to use this skill, and what it covers. This is the ONLY text used to decide whether the skill triggers, so be specific about triggering phrases and scenarios."
---

# Role / Task Title

Instructions in plain Markdown: what the session's job is, what NOT to do,
step-by-step loops, tool names it should call, and any rules specific to
this project.
```

- `name` must match the containing folder name and use kebab-case.
- `description` is the single most important field — it's matched against
  the user's request and the conversation context to decide whether this
  skill should trigger. Write it the way you'd explain to a colleague when
  to reach for this exact skill, including concrete trigger phrases (e.g.
  "Use when acting as the Team Lead...").
- Everything after the frontmatter is free-form Markdown read by the model
  when the skill is invoked — write it like an onboarding doc for a new
  team member who knows nothing about this specific project.

## Where skills live

- **Project-level:** `.claude/skills/<name>/SKILL.md` inside a specific
  repo — only available in that project. This project's `skills/` folder
  is the *source*; copy each subfolder into the target machine's
  `.claude/skills/` as described in `docs/setup-guide.md`.
- **User-level:** `~/.claude/skills/<name>/SKILL.md` — available in every
  project on that machine.
- **Plugin skills:** ship inside a Claude Code plugin and are namespaced as
  `plugin-name:skill-name`.

## Authoring checklist

1. Pick one clear job for the skill. If you're describing two different
   roles ("plans AND assigns AND writes code"), split it — see how
   `team-lead` (planning/assigning) and `team-developer` (coding) are kept
   separate even though they collaborate.
2. Write the `description` last, after the body — it's easier to summarize
   accurately once the instructions are written.
3. Name every tool you expect the session to call, using its exact MCP
   tool name (e.g. `mcp__teamhub__create_task`), not a paraphrase.
4. Include an explicit "What you should NOT do" section for any boundary
   that matters (see all three skills in this repo for the pattern) —
   models default to being helpful, so scope limits need to be stated, not
   implied.
5. Prefer turn-based language ("at the start of each of your turns...")
   over cycle/timing language, so the same skill works whether a human is
   driving the session interactively or it's running unattended via
   `agents/runner.ts`.

## Testing a skill before shipping it

1. Copy the skill folder into a scratch project's `.claude/skills/`.
2. Start `claude` there and describe a scenario the `description` should
   match — confirm the skill actually triggers.
3. Walk through the skill's instructions manually as if you were the model:
   does every referenced tool exist and have the name you wrote? Does every
   step have enough detail to act on without guessing?
4. Only then copy it to the real target project/machine.
