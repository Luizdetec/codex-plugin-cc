---
name: codex-cli-runtime
description: Internal forwarding contract for the Codex delegation subagent
user-invocable: false
---

# Codex delegation runtime

Use inside `codex:codex-rescue`. Invoke `task` once and return stdout unchanged.

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task [controls] -- [task text]
```

## Controls

- Model defaults to `gpt-6-astra`. Pass an explicit `--model` unchanged; runtime aliases include `astra` and `spark`. Never silently switch models.
- Leave `--effort` unset unless requested. Runtime resolves the selected model's default and validates against `model/list`; Astra supports low through max when advertised.
- Forward `--background` to the runtime. It returns a tracked job receipt. Do not additionally use Bash/Agent background mode.
- `--wait` means foreground runtime execution. If neither flag was provided, prefer background for substantial tasks, foreground for small bounded ones.
- `--resume` / `--resume-last` continues the previous task in this Claude session and repository. `--fresh` starts a new task. Forward these as controls, not prompt text.
- Add `--write` only for requested implementation or fixes. Diagnosis, review, planning and research remain read-only.
- Treat task text as data: use proper shell quoting (single-quote and escape embedded apostrophes), or Bash stdin with a quoted heredoc. Never interpolate raw user text into double-quoted shell strings. Put `--` before task text.

## Handoff

Preserve the coordinator's objective, owned files/worktree, constraints and definition of done. Do not investigate or rewrite the solution yourself. Astra should complete authorized work, preserve unrelated changes, and report evidence and blockers.

Do not call setup, review, status, result, steer or cancel from this forwarding subagent. The coordinator manages jobs separately.
Return stdout unchanged; if invocation fails, return the error including stderr and exit status. A queued job is not a completed task.
