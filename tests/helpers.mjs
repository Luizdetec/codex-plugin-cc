import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { after } from "node:test";
import { loadBrokerSession, sendBrokerShutdown } from "../plugins/codex/scripts/lib/broker-lifecycle.mjs";

const brokerWorkspaces = new Set();
after(async () => {
  const sessions = [...brokerWorkspaces].map(cwd => loadBrokerSession(cwd)).filter(Boolean);
  await Promise.all(sessions.map(async session => {
    await sendBrokerShutdown(session.endpoint);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try { process.kill(session.pid, 0); } catch { return; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`Test broker ${session.pid} did not exit after shutdown.`);
  }));
});

export function makeTempDir(prefix = "codex-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  if (options.cwd && args.some(arg => String(arg).includes("codex-companion.mjs"))) brokerWorkspaces.add(options.cwd);
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    timeout: options.timeout ?? 30000,
    shell: options.shell ?? (process.platform === "win32" && !path.isAbsolute(command)),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}

// Keep the test event loop free to reap its own children while cancellation waits for exit.
export function runAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd, env: options.env,
      shell: process.platform === "win32" && !path.isAbsolute(command),
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Test command timed out")); }, options.timeout ?? 30000);
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr }); });
    child.stdin.end(options.input ?? "");
  });
}
