import fs from "node:fs";
import { spawnSync } from "node:child_process";

const directory = "plugins/codex/.generated/app-server-types";
fs.mkdirSync(directory, { recursive: true });
const result = spawnSync("codex", ["app-server", "generate-ts", "--out", directory], {
  stdio: "inherit",
  shell: process.platform === "win32"
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
