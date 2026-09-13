import fs from "node:fs";
import process from "node:process";

import { resolveJobLogFile, resolveJobFile, readJobFile, updateJob, isActiveJob } from "./state.mjs";

import { appendBoundedLog } from "./storage.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  appendBoundedLog(logFile, `[${nowIso()}] ${normalized}\n`);
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  appendBoundedLog(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`);
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (!changed) {
      return;
    }

    updateJob(workspaceRoot, jobId, existing => existing.id ? patch : null);
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[codex] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

export async function runTrackedJob(job, runner, options = {}) {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("Cancelled by user."));
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);
  const jobFile = resolveJobFile(job.workspaceRoot, job.id);
  const cancelTimer = setInterval(() => {
    try { if (readJobFile(jobFile).cancelSignalAt) cancel(); } catch { /* A concurrent session cleanup may remove the file. */ }
  }, 100);
  cancelTimer.unref();
  try {
    const runningRecord = updateJob(job.workspaceRoot, job.id, existing => {
      if (options.requireExisting && !existing.id) return null;
      if (existing.cancelRequestedAt) return null;
      return {
        ...job,
        status: "running",
        startedAt: nowIso(),
        phase: "starting",
        pid: process.pid,
        managedWorker: true,
        logFile: options.logFile ?? job.logFile ?? null
      };
    });
    if (!isActiveJob(runningRecord) || runningRecord.cancelRequestedAt) {
      throw new Error("Task was cancelled before execution.");
    }
    // The launcher only acknowledges a worker after its running state is durable.
    if (process.send) process.send({ type: "ready", jobId: job.id });
    if (process.connected) process.disconnect();
    const execution = await runner(controller.signal);
    const record = updateJob(job.workspaceRoot, job.id, existing => {
      const status = existing.cancelRequestedAt || controller.signal.aborted
        ? "cancelled" : execution.exitStatus === 0 ? "completed" : "failed";
      return {
        status,
        threadId: execution.threadId ?? existing.threadId ?? null,
        turnId: execution.turnId ?? existing.turnId ?? null,
        summary: execution.summary,
        pid: null,
        phase: status === "completed" ? "done" : status,
        completedAt: nowIso(),
        result: execution.payload,
        rendered: execution.rendered,
        errorMessage: status === "cancelled" ? "Cancelled by user." : execution.payload?.error?.message ?? null
      };
    });
    appendLogBlock(options.logFile ?? job.logFile, "Final output", execution.rendered);
    if (record.status === "cancelled") return { ...execution, exitStatus: 1 };
    return execution;
  } catch (error) {
    updateJob(job.workspaceRoot, job.id, existing => options.requireExisting && !existing.id ? null : ({
      status: existing.cancelRequestedAt || controller.signal.aborted ? "cancelled" : "failed",
      phase: existing.cancelRequestedAt || controller.signal.aborted ? "cancelled" : "failed",
      pid: null,
      errorMessage: existing.cancelRequestedAt || controller.signal.aborted ? "Cancelled by user." : String(error?.message ?? error),
      completedAt: nowIso()
    }));
    throw error;
  } finally {
    clearInterval(cancelTimer);
    if (process.connected) process.disconnect();
    process.removeListener("SIGTERM", cancel);
    process.removeListener("SIGINT", cancel);
  }
}
