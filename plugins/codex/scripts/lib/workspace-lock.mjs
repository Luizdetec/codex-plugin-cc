import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

// Independent of Claude session/plugin data: two sessions must not write the same checkout.
export async function withWorkspaceWriteLock(cwd, enabled, run) {
  if (!enabled) return run();
  const root = fs.realpathSync(cwd);
  const key = createHash("sha256").update(root).digest("hex");
  const directory = path.join(os.tmpdir(), "codex-astra-write-locks");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, key);
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(`This checkout is locked by another Codex write task. Wait or use a separate worktree. After a crash, verify all task processes stopped before removing the stale lock: ${lock}`);
  }
  let preserveLock = false;
  try {
    fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, cwd: root }), { mode: 0o600 });
    return await run();
  } catch (error) {
    preserveLock = error.preserveWriteLock === true;
    throw error;
  } finally {
    if (!preserveLock) {
      fs.rmSync(path.join(lock, "owner.json"), { force: true });
      fs.rmdirSync(lock);
    }
  }
}
