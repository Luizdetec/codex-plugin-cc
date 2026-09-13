import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

// Keep only a bounded suffix, even for a single oversized line.
export function readFileTail(file, maxBytes = 64 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function appendBoundedLog(file, text, maxBytes = 1024 * 1024) {
  if (!file) return;
  const buffer = Buffer.from(text, "utf8");
  const bounded = buffer.subarray(Math.max(0, buffer.length - maxBytes));
  let size = 0;
  try { size = fs.statSync(file).size; } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (size + bounded.length > maxBytes && size > 0) {
    fs.renameSync(file, `${file}.1`);
  }
  fs.appendFileSync(file, bounded, { mode: 0o600 });
}
