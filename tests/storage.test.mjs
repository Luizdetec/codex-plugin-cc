import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDir } from "./helpers.mjs";
import { updateJob, loadState, saveState, resolveJobFile, listJobs } from "../plugins/codex/scripts/lib/state.mjs";
import { appendBoundedLog, readFileTail } from "../plugins/codex/scripts/lib/storage.mjs";
import { terminateProcessTree } from "../plugins/codex/scripts/lib/process.mjs";
import { runTrackedJob } from "../plugins/codex/scripts/lib/tracked-jobs.mjs";

test("a worker cannot recreate a task removed by session cleanup", async () => {
  const cwd = makeTempDir();
  let ran = false;
  await assert.rejects(runTrackedJob({ workspaceRoot: cwd, id: "removed", status: "queued" }, async () => { ran = true; }, { requireExisting: true }), /cancelled before execution/);
  assert.equal(ran, false);
  assert.equal(loadState(cwd).jobs.length, 0);
  assert.equal(fs.existsSync(resolveJobFile(cwd, "removed")), false);
});

test("terminal jobs reject late launch and progress updates in both payload and index", () => {
  const cwd = makeTempDir();
  updateJob(cwd, "task-a", { status: "running", phase: "editing" });
  updateJob(cwd, "task-a", { status: "cancelled", phase: "cancelled", result: { rawOutput: "partial" } });
  updateJob(cwd, "task-a", { status: "queued", pid: 12345 });
  updateJob(cwd, "task-a", { phase: "verifying" });
  assert.equal(loadState(cwd).jobs[0].status, "cancelled");
  const stored = JSON.parse(fs.readFileSync(resolveJobFile(cwd, "task-a")));
  assert.equal(stored.phase, "cancelled");
  assert.equal(stored.pid, undefined);
  assert.equal(stored.result.rawOutput, "partial");
});

test("retention preserves old active jobs alongside fifty finished jobs", () => {
  const cwd = makeTempDir();
  saveState(cwd, { jobs: [
    { id: "active", status: "running", updatedAt: "2000" },
    ...Array.from({ length: 55 }, (_, i) => ({ id: `done-${i}`, status: "completed", updatedAt: `2026-${i.toString().padStart(2, '0')}` }))
  ] });
  const jobs = loadState(cwd).jobs;
  assert.equal(jobs.length, 51);
  assert.ok(jobs.some(job => job.id === "active"));
});

test("status reconciles an exited worker without silently retrying it", () => {
  const cwd = makeTempDir();
  // A real child exits and is reaped synchronously before its PID is recorded.
  const { pid } = spawnSync(process.execPath, ["-e", ""], { encoding: "utf8" });
  updateJob(cwd, "lost", { status: "running", pid });
  const [job] = listJobs(cwd);
  assert.equal(job.status, "failed");
  assert.match(job.errorMessage, /without a terminal result/);
});

test("large logs rotate within the size bound and tail reads preserve recent progress", () => {
  const file = path.join(makeTempDir(), "task.log");
  appendBoundedLog(file, "x".repeat(90) + "\n", 100);
  appendBoundedLog(file, "[now] latest progress\n", 100);
  assert.ok(fs.statSync(`${file}.1`).size <= 100);
  assert.ok(fs.statSync(file).size <= 100);
  assert.match(readFileTail(file, 100), /latest progress/);
  appendBoundedLog(file, "z".repeat(300), 100);
  assert.equal(fs.statSync(file).size, 100);
  assert.ok(Buffer.byteLength(readFileTail(file, 50)) <= 50);
});

test("POSIX cancellation falls back to the worker PID when it has no process group", () => {
  const calls = [];
  const result = terminateProcessTree(4321, { platform: "darwin", killImpl: (pid, signal) => {
    calls.push([pid, signal]);
    if (pid < 0) throw Object.assign(new Error("no group"), { code: "ESRCH" });
  } });
  assert.equal(result.delivered, true);
  assert.deepEqual(calls, [[-4321, "SIGTERM"], [4321, "SIGTERM"]]);
});
