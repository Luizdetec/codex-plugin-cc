---
description: Delegate implementation, investigation or research to Astra through Codex
argument-hint: "[--background|--wait] [--resume|--fresh] [--model <model>] [--effort <effort>] [task]"
allowed-tools: Agent
---

Invoke Agent with `subagent_type: "codex:codex-rescue"` in the foreground, forwarding the request below. Do not invoke Skill or this command recursively.
The subagent forwards to the tracked Codex runtime, defaulting to Astra. Preserve explicit controls. Add --resume for clear continuation unless --fresh was supplied; use a fresh task otherwise.
Return the runtime output unchanged, including errors. Background receipts mean launched, not completed.

$ARGUMENTS
