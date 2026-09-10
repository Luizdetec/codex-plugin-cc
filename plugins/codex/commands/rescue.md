---
description: Delegate a bounded task to Codex (Astra by default); compatible rescue entrypoint
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <model|astra|spark>] [--effort <effort>] [task]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `codex:codex-rescue` subagent via the `Agent` tool (`subagent_type: "codex:codex-rescue"`).
This is a subagent, not a skill: do not call `Skill(codex:codex-rescue)` or re-enter this command. Stay inline so Agent remains available.

Raw user request:
$ARGUMENTS

- Preserve explicit model, effort, scope, permissions and execution flags.
- Run the forwarding subagent in the foreground. The runtime's `task --background` creates the tracked background job; do not nest Claude background execution around it.
- If no execution flag was supplied, prefer background for substantial tasks; use `--wait` for a small bounded task.
- For an explicit continuation ("continue", "resume", "apply the top fix"), add `--resume` without asking. An explicit `--fresh` wins over contextual continuation.
- For a clearly new task, add `--fresh`.
- Only if continuation is genuinely ambiguous, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task-resume-candidate --json`. If available, ask whether to continue or start fresh; otherwise use fresh.
- The forwarding subagent must not investigate the repo or implement the task.
- The final user-visible response must be Codex's output verbatim. For background launch, report the job receipt as a launch, not completion.
- On failure, return the runtime error. Never hide stderr or substitute an invented result.
- Use `/codex:status`, `/codex:result`, `/codex:steer`, and `/codex:cancel` for subsequent job management.
