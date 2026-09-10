---
description: Send additional instructions to an active Codex task in this Claude session
argument-hint: "<job-id> <additional instructions>"
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

Invoke the runtime's `steer` command with the explicit job ID and instructions below.
Use proper shell single-quoting; never interpolate raw instructions in double quotes.
The runtime requires the existing broker and expected active turn. Do not start a replacement task on failure.
Report acceptance or the exact error; acceptance does not mean task completion.

$ARGUMENTS
