import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";
import { writeJsonAtomic } from "./storage.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "codex-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
const stateDirectories = new Map();

export function isActiveJob(job) {
  return job?.status === "queued" || job?.status === "running";
}

function withStateLock(cwd, run) {
  ensureStateDir(cwd);
  const lock = path.join(resolveStateDir(cwd), "state.lock");
  const deadline = Date.now() + 5000;
  let fd;
  while (fd === undefined) {
    try { fd = fs.openSync(lock, "wx", 0o600); } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error(`State is locked: ${lock}. Verify its owner has exited before removing a stale lock.`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    return run();
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const cacheKey = JSON.stringify([path.resolve(cwd), process.env[PLUGIN_DATA_ENV] ?? null]);
  if (stateDirectories.has(cacheKey)) return stateDirectories.get(cacheKey);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  const directory = path.join(stateRoot, `${slug}-${hash}`);
  stateDirectories.set(cacheKey, directory);
  return directory;
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch (error) {
    if (error.code === "ENOENT") return defaultState();
    throw new Error(`Cannot read state ${stateFile}: ${error.message}`);
  }
}

function pruneJobs(jobs) {
  let finished = 0;
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .filter(job => isActiveJob(job) || ++finished <= MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function saveState(cwd, state) {
  return withStateLock(cwd, () => saveStateUnlocked(cwd, state));
}

function saveStateUnlocked(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  writeJsonAtomic(resolveStateFile(cwd), nextState);
  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
    if (job.logFile) removeFileIfExists(`${job.logFile}.1`);
  }

  return nextState;
}

export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    mutate(state);
    return saveStateUnlocked(cwd, state);
  });
}

// All runtime transitions update the payload and index under the same lock.
// Terminal states are immutable; delayed progress and launch receipts cannot resurrect jobs.
export function updateJob(cwd, jobId, change) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    const index = state.jobs.findIndex(job => job.id === jobId);
    const jobFile = resolveJobFile(cwd, jobId);
    const stored = fs.existsSync(jobFile) ? readJobFile(jobFile) : {};
    const existing = { ...stored, ...(state.jobs[index] ?? {}) };
    if (existing.status && !isActiveJob(existing)) return existing;
    const patch = typeof change === "function" ? change(existing) : change;
    if (!patch) return existing;
    if (existing.status === "running" && patch.status === "queued") return existing;
    const next = { createdAt: nowIso(), ...existing, ...patch, id: jobId, updatedAt: nowIso() };
    writeJsonAtomic(jobFile, next);
    const { result, rendered, request, ...summary } = next;
    if (index < 0) state.jobs.unshift(summary);
    else state.jobs[index] = summary;
    saveStateUnlocked(cwd, state);
    return next;
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  const jobs = loadState(cwd).jobs;
  for (const job of jobs) {
    if (!isActiveJob(job)) continue;
    const pid = job.pid ?? job.launcherPid;
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try { process.kill(pid, 0); } catch (error) {
      if (error.code !== "ESRCH") continue;
      updateJob(cwd, job.id, existing => {
        if ((existing.pid ?? existing.launcherPid) !== pid) return null;
        return { status: existing.cancelRequestedAt ? "cancelled" : "failed", phase: "failed", pid: null, completedAt: nowIso(), errorMessage: "Task process exited without a terminal result. Inspect its thread before retrying." };
      });
    }
  }
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  withStateLock(cwd, () => writeJsonAtomic(jobFile, payload));
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
