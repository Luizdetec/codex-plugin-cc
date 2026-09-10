import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { makeTempDir, run, initGitRepo } from "./helpers.mjs";
import { installFakeCodex, buildEnv } from "./fake-codex-fixture.mjs";
import { listAvailableModels, resolveTaskModel } from "../plugins/codex/scripts/lib/models.mjs";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import { sendBrokerShutdown, loadBrokerSession } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = path.join(ROOT, "plugins/codex/scripts/codex-companion.mjs");
const LOCK_MODULE = new URL("../plugins/codex/scripts/lib/workspace-lock.mjs", import.meta.url).href;
function fixture(behavior = "review-ok") {
  const repo = makeTempDir();
  const bin = makeTempDir();
  installFakeCodex(bin, behavior);
  initGitRepo(repo);
  const env = { ...buildEnv(bin), CODEX_COMPANION_SESSION_ID: "astra-test" };
  return { repo, bin, env, invoke: (...args) => run(process.execPath, [SCRIPT, ...args], { cwd: repo, env }) };
}

test("Astra default and max are forwarded; invalid effort and unavailable model never start a turn", () => {
  const f = fixture();
  const result = f.invoke("task", "--json", "--effort", "max", "inspect");
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.model, "gpt-6-astra");
  assert.equal(payload.effort, "max");
  const invalid = f.invoke("task", "--effort", "none", "inspect");
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Unsupported reasoning effort/);
  const missing = fixture("no-astra");
  const rejected = missing.invoke("task", "inspect");
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /No fallback was used/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(missing.bin, "fake-codex-state.json"))).lastTurnStart, undefined);
});

test("model discovery paginates, rejects cursor loops, and accepts runtime-specific efforts", async () => {
  const calls = [];
  const client = { request: async (_method, params) => {
    calls.push(params.cursor);
    return params.cursor ? { data: [{ id: "astra", model: "gpt-6-astra", defaultReasoningEffort: "ultra", supportedReasoningEfforts: [{ reasoningEffort: "ultra" }] }], nextCursor: null } : { data: [], nextCursor: "next" };
  } };
  assert.deepEqual(await resolveTaskModel(client, "gpt-6-astra"), { model: "gpt-6-astra", effort: "ultra" });
  assert.deepEqual(calls, [null, "next"]);
  await assert.rejects(listAvailableModels({ request: async () => ({ data: [], nextCursor: "loop" }) }), /repeated/);
});

test("direct client kills a child that ignores EOF and SIGTERM, and bounds initialization", async () => {
  const f = fixture("ignore-shutdown");
  const client = await CodexAppServerClient.connect(f.repo, { disableBroker: true, env: f.env });
  const pid = client.proc.pid;
  await client.close();
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  const hung = fixture("hang-initialize");
  await assert.rejects(CodexAppServerClient.connect(hung.repo, { disableBroker: true, env: hung.env, requestTimeoutMs: 100 }), /timed out/);
});

test("background task supports steering, rejects other sessions, and cancels its active turn", async () => {
  const f = fixture("interruptible-slow-task");
  const launch = f.invoke("task", "--background", "--write", "--json", "inspect");
  assert.equal(launch.status, 0, launch.stderr);
  const jobId = JSON.parse(launch.stdout).jobId;
  let state;
  for (let i = 0; i < 60; i++) {
    try { state = JSON.parse(fs.readFileSync(path.join(f.bin, "fake-codex-state.json"))); } catch {}
    if (state?.lastTurnStart) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(state?.lastTurnStart);
  const hook = path.join(ROOT, "plugins/codex/scripts/session-lifecycle-hook.mjs");
  const ended = run(process.execPath, [hook, "SessionEnd"], { cwd: f.repo, env: { ...f.env, CODEX_COMPANION_SESSION_ID: "other" }, input: JSON.stringify({ cwd: f.repo, session_id: "other" }) });
  assert.equal(ended.status, 0, ended.stderr);
  const other = run(process.execPath, [SCRIPT, "steer", jobId, "wrong"], { cwd: f.repo, env: { ...f.env, CODEX_COMPANION_SESSION_ID: "other" } });
  assert.notEqual(other.status, 0);
  assert.match(other.stderr, /another Claude session/);
  const steer = f.invoke("steer", jobId, "focus", "tests");
  assert.equal(steer.status, 0, steer.stderr);
  assert.match(steer.stdout, /accepted/);
  const current = JSON.parse(fs.readFileSync(path.join(f.bin, "fake-codex-state.json")));
  assert.equal(current.lastSteer.expectedTurnId, state.lastTurnStart.turnId);
  const cancel = f.invoke("cancel", jobId, "--json");
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.equal(JSON.parse(cancel.stdout).turnInterrupted, true);
  const retry = f.invoke("task", "--write", "--json", "inspect again");
  assert.equal(retry.status, 0, retry.stderr);
});

test("upstream crash finishes the job as failed without starting another server", async () => {
  const f = fixture("crash-task");
  const result = f.invoke("task", "inspect");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /disconnect|closed|exited/i);
  const state = JSON.parse(fs.readFileSync(path.join(f.bin, "fake-codex-state.json")));
  assert.equal(state.appServerStarts, 1);
});

test("disconnecting a stream owner terminates its broker and upstream process", async () => {
  const f = fixture("interruptible-slow-task");
  const client = await CodexAppServerClient.connect(f.repo, { env: f.env });
  const broker = loadBrokerSession(f.repo);
  try {
    const { thread } = await client.request("thread/start", { cwd: f.repo });
    await client.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "inspect" }] });
  } finally {
    await client.close();
  }
  const state = JSON.parse(fs.readFileSync(path.join(f.bin, "fake-codex-state.json")));
  for (const pid of [broker.pid, state.appServerPid]) {
    let exited = false;
    for (let i = 0; i < 100; i++) {
      try { process.kill(pid, 0); } catch { exited = true; break; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(exited, `Process ${pid} survived owner disconnect`);
  }
});

test("write lock excludes another process and is released on normal completion", async () => {
  const repo = makeTempDir();
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import {withWorkspaceWriteLock} from ${JSON.stringify(LOCK_MODULE)}; await withWorkspaceWriteLock(${JSON.stringify(repo)}, true, async () => { console.log("locked"); await new Promise(r => process.stdin.once("data", r)); });`], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise(resolve => child.once("exit", resolve));
  try {
    await new Promise(resolve => child.stdout.once("data", resolve));
    const source = `import {withWorkspaceWriteLock} from ${JSON.stringify(LOCK_MODULE)}; await withWorkspaceWriteLock(${JSON.stringify(repo)}, true, async () => {});`;
    const blocked = run(process.execPath, ["--input-type=module", "-e", source]);
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /locked by another/);
    child.stdin.end("release");
    await exited;
    const allowed = run(process.execPath, ["--input-type=module", "-e", source]);
    assert.equal(allowed.status, 0, allowed.stderr);
  } finally { child.stdin.end("release"); }
});

test("concurrent launchers share exactly one broker process", async () => {
  const f = fixture();
  const module = new URL("../plugins/codex/scripts/lib/broker-lifecycle.mjs", import.meta.url).href;
  const source = `import {ensureBrokerSession} from ${JSON.stringify(module)}; console.log(JSON.stringify(await ensureBrokerSession(process.cwd())));`;
  function start() {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd: f.repo, env: f.env, stdio: ["ignore", "pipe", "pipe"] });
      let output = "", errors = "";
      child.stdout.on("data", chunk => output += chunk);
      child.stderr.on("data", chunk => errors += chunk);
      child.on("error", reject);
      child.on("exit", code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(errors)));
    });
  }
  const sessions = await Promise.all([start(), start(), start()]);
  try {
    assert.equal(new Set(sessions.map(s => s.pid)).size, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.bin, "fake-codex-state.json"))).appServerStarts, 1);
  } finally {
    await Promise.all(sessions.map(s => sendBrokerShutdown(s.endpoint)));
  }
});
