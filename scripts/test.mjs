import fs from "node:fs";
import { spawnSync } from "node:child_process";

// Pass actual file names: cmd.exe does not expand the test glob on Windows.
const files = fs.readdirSync("tests").filter(file => file.endsWith(".test.mjs")).sort();
const result = spawnSync(process.execPath, ["--test", ...files.map(file => `tests/${file}`)], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
