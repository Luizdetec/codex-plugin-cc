# Codex Astra — fork for Claude Code

Use Codex from inside Claude Code for code reviews or to delegate tasks to Codex.

This plugin is for Claude Code users who want an easy way to start using Codex from the workflow
they already have.

This is an independent VanguardIA fork of OpenAI's plugin, not an official OpenAI release. License and upstream notices are preserved.
Do not enable this and the official `codex` plugin together: both intentionally preserve the `/codex:` command namespace. No global configuration changes are required.

## Astra delegation

```text
/codex:models
/codex:delegate --background --model astra --effort high implement the scoped task and verify it
/codex:status
/codex:steer task-ID focus on the failing test first
/codex:result task-ID
/codex:cancel task-ID
```

`/codex:rescue` remains compatible. Background is managed by the runtime, not nested Claude background agents.
Explicit continuation resumes the current Claude session's last task without a redundant confirmation.
Failures remain visible. No silent model fallback or replay of a possibly accepted task occurs.

One active write task per checkout is enforced across sessions. Use separate worktrees for parallel edits.
Cancellation waits for the worker to exit and release its write lock, including during initialization.
After abrupt termination a write lock may remain: verify the task and its Codex processes have exited before removing the exact lock reported by the error.
Steering requires a running job in the same Claude session and its live broker.
The broker handles one active task at a time; a busy response is an explicit failure, not a hidden second execution.
Native reviews keep their original Codex model behavior; the Astra default applies to delegated tasks.

## What You Get

- `/codex:review` for a normal read-only Codex review
- `/codex:adversarial-review` for a steerable challenge review
- `/codex:rescue`, `/codex:transfer`, `/codex:status`, `/codex:result`, and `/codex:cancel` to delegate work, hand off sessions, and manage background jobs

## Requirements

- **ChatGPT subscription (incl. Free) or OpenAI API key.**
  - Usage will contribute to your Codex usage limits. [Learn more](https://developers.openai.com/codex/pricing).
- **Node.js 18.18 or later**

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add Luizdetec/codex-plugin-cc
```

Install the plugin:

```bash
/plugin install codex@vanguardia-codex
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/codex:setup
```

`/codex:setup` will tell you whether Codex is ready. If Codex is missing and npm is available, it can offer to install Codex for you.

If you prefer to install Codex yourself, use:

```bash
npm install -g @openai/codex
```

If Codex is installed but not logged in yet, run:

```bash
!codex login
```

After install, you should see:

- the slash commands listed below
- the `codex:codex-rescue` subagent in `/agents`

One simple first run is:

```bash
/codex:review --background
/codex:status
/codex:result
```

## Usage

### `/codex:review`

Runs a normal Codex review on your current work. It gives you the same quality of code review as running `/review` inside Codex directly.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/codex:adversarial-review`](#codexadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/codex:review
/codex:review --base main
/codex:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/codex:status`](#codexstatus) to check on the progress and [`/codex:cancel`](#codexcancel) to cancel the ongoing task.

### `/codex:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/codex:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/codex:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/codex:adversarial-review
/codex:adversarial-review --base main challenge whether this was the right caching and retry design
/codex:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/codex:rescue`

Hands a task to Codex through the `codex:codex-rescue` subagent.

Use it when you want Codex to:

- investigate a bug
- try a fix
- continue a previous Codex task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue thread for this repo.

Examples:

```bash
/codex:rescue investigate why the tests started failing
/codex:rescue fix the failing test with the smallest safe patch
/codex:rescue --resume apply the top fix from the last run
/codex:rescue --model gpt-5.6-luna --effort medium investigate the flaky integration test
/codex:rescue --model spark fix the issue quickly
/codex:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Codex:

```text
Ask Codex to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model`, tasks use `gpt-6-astra`; omitted `--effort` uses that model's advertised default. Both are validated against the current Codex catalog.
- if you say `spark`, the plugin maps that to `gpt-5.3-codex-spark`
- follow-up rescue requests can continue the latest Codex task in the repo

### `/codex:transfer`

Creates a persistent Codex thread from the current Claude Code session and prints a `codex resume <session-id>` command.

Use it when you started a debugging or implementation conversation in Claude Code and want to continue that same context directly in Codex.

Examples:

```bash
/codex:transfer
/codex:transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
```

The plugin's existing `SessionStart` hook supplies the current transcript path automatically; `--source` is available as a manual override. The transfer uses Codex's external-agent session importer, so it follows the same conversion rules as importing Claude history in the Codex App and creates visible turns that can be continued in the App or TUI. The source must be under `~/.claude/projects`, and older Codex versions that do not expose session import must be upgraded before using this command.

### `/codex:status`

Shows running and recent Codex jobs for the current repository.

Examples:

```bash
/codex:status
/codex:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/codex:result`

Shows the final stored Codex output for a finished job.
When available, it also includes the Codex session ID so you can reopen that run directly in Codex with `codex resume <session-id>`.

Examples:

```bash
/codex:result
/codex:result task-abc123
```

### `/codex:cancel`

Cancels an active background Codex job.

Examples:

```bash
/codex:cancel
/codex:cancel task-abc123
```

### `/codex:setup`

Checks whether Codex is installed and authenticated.
If Codex is missing and npm is available, it can offer to install Codex for you.

You can also use `/codex:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/codex:setup --enable-review-gate
/codex:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Codex review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Codex loop and may drain usage limits quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/codex:review
```

### Hand A Problem To Codex

```bash
/codex:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/codex:adversarial-review --background
/codex:rescue --background investigate the flaky test
```

Then check in with:

```bash
/codex:status
/codex:result
```

## Codex Integration

The Codex plugin wraps the [Codex app server](https://developers.openai.com/codex/app-server). It uses the global `codex` binary installed in your environment and [applies the same configuration](https://developers.openai.com/codex/config-basic).

### Common Configurations

Delegated tasks (`delegate` and `rescue`) use this precedence:

| Setting | Selection |
| --- | --- |
| Model | Explicit `--model`, otherwise `gpt-6-astra` |
| Reasoning effort | Explicit `--effort`, otherwise the selected model's advertised default |
| Other Codex configuration | Your normal user/project configuration, subject to the plugin's read-only or workspace-write sandbox and noninteractive approval policy |

The delegated model and effort are passed explicitly to Codex, so `model` and
`model_reasoning_effort` in `config.toml` do not change these delegation defaults.
Use `/codex:models` to inspect the catalog, then pass the desired flags.
Native reviews keep Codex's normal review configuration; their default is not forced to Astra.

Your configuration will be picked up based on:

- user-level config in `~/.codex/config.toml`
- project-level overrides in `.codex/config.toml`
- project-level overrides only load when the [project is trusted](https://developers.openai.com/codex/config-advanced#project-config-files-codexconfigtoml)

Check out the Codex docs for more [configuration options](https://developers.openai.com/codex/config-reference).

### Moving The Work Over To Codex

Delegated tasks and any [stop gate](#what-does-the-review-gate-do) run can also be directly resumed inside Codex by running `codex resume` either with the specific session ID you received from running `/codex:result` or `/codex:status` or by selecting it from the list.

This way you can review the Codex work or continue the work there.

## FAQ

### Do I need a separate Codex account for this plugin?

If you are already signed into Codex on this machine, that account should work immediately here too. This plugin uses your local Codex CLI authentication.

If you only use Claude Code today and have not used Codex yet, you will also need to sign in to Codex with either a ChatGPT account or an API key. [Codex is available with your ChatGPT subscription](https://developers.openai.com/codex/pricing/), and [`codex login`](https://developers.openai.com/codex/cli/reference/#codex-login) supports both ChatGPT and API key sign-in. Run `/codex:setup` to check whether Codex is ready, and use `!codex login` if it is not.

### Does the plugin use a separate Codex runtime?

No. This plugin delegates through your local [Codex CLI](https://developers.openai.com/codex/cli/) and [Codex app server](https://developers.openai.com/codex/app-server/) on the same machine.

That means:

- it uses the same Codex install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Codex config I already have?

Yes. If you already use Codex, the plugin picks up the same [configuration](#common-configurations).

### Can I keep using my current API key or base URL setup?

Yes. Because the plugin uses your local Codex CLI, your existing sign-in method and config still apply.

If you need to point the built-in OpenAI provider at a different endpoint, set `openai_base_url` in your [Codex config](https://developers.openai.com/codex/config-advanced/#config-and-state-locations).

## Execution and recovery

| Command | How background execution works |
| --- | --- |
| `/codex:delegate`, `/codex:rescue` | `task --background` saves the request and waits for the detached worker's startup acknowledgement. The receipt confirms launch, not completion. |
| `/codex:review`, `/codex:adversarial-review` | Claude runs Bash in the background. Passing `--background` to the review script alone does not detach it. |

`status` reconciles jobs whose worker exited without recording a final result.
It never automatically retries a task. Terminal states cannot be overwritten by late progress.
A final assistant message without `turn/completed` remains unconfirmed; after ten seconds
without the terminal event once known subagent work has drained, the job fails explicitly.
Inspect its Codex thread before deciding whether to resume it.

`result --json` returns the stored job status and structured error. The result command's
exit code describes the lookup; inspect `job.status` to determine whether the task succeeded.
Text results identify failed/cancelled tasks and label any partial output.
A failed authentication lookup is reported as unknown, not as a logout. Read-only setup
checks may use a fresh connection when a shared broker is stale or busy.

State updates use a short per-workspace lock and atomic file replacement. If a process is
forcibly terminated inside a state update, an error reports the exact `state.lock` path.
Verify that its recorded owner has exited before removing that exact stale lock.
Finished-job retention keeps the latest 50 entries and preserves all active jobs.
Each job log keeps a current file and one rotated file of up to 1 MiB each; the complete
stored final result is separate. Progress previews read at most the last 64 KiB.

## Development and validation

```bash
npm ci
npm run check-version
npm test
npm run build
claude --plugin-dir ./plugins/codex
```

Tests use a fake Codex server and real local child processes; they do not invoke a paid model.
The build type-checks all runtime entrypoints and generates protocol types from the installed Codex CLI.
The CI compatibility baseline is Codex `0.154.0`; a separate advisory job checks the latest CLI.
The matrix covers Node 18.18, 22 and 24 on Linux, plus Node 22 on macOS and Windows.
Use a current supported Node release for normal development; Node 18.18 is the minimum compatibility target.

For a real integration smoke test in a disposable workspace, start a read-only background task,
check `status`, send `steer`, cancel it, resume the same thread with a short instruction, and read
`result`. Verify the returned thread ID and terminal status. Load the local plugin with
`--plugin-dir` for that session; do not enable the official plugin alongside this fork.
