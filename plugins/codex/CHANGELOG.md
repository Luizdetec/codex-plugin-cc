# Changelog

## 1.1.0-astra.2 — Runtime reliability

- Serialize state updates, preserve active jobs, atomically replace JSON and prevent terminal-state regressions.
- Persist background requests before spawning workers and acknowledge startup over IPC.
- Cancel cooperatively during initialization and active turns; retain cancellation state and release write locks.
- Require terminal completion, preserve turn errors and recover read-only setup checks from stale or busy brokers.
- Bound progress reads, log retention and stderr; reuse availability checks and small diffs.
- Type-check every runtime script and add cross-platform, version-pinned CI plus an advisory latest-Codex check.

## 1.1.0-astra.1 — VanguardIA fork

- Default delegated tasks to Astra; discover models and reasoning efforts from Codex instead of a fixed catalog.
- Add delegate, models and steer commands; preserve rescue compatibility and explicit model overrides.
- Unify tracked background execution, preserve invocation errors and avoid redundant continuation questions.
- Exclude concurrent writes to one checkout; preserve other sessions during shutdown.
- Bound RPC and process shutdown, serialize broker startup and disconnect failed/orphaned streams without replaying work.
- Add real-process regression coverage and explicit test broker cleanup.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
