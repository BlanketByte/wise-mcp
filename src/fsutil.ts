import { chmodSync, renameSync, writeFileSync } from "node:fs";

/**
 * Writes JSON atomically and owner-only: a crash mid-write can't leave a half-written file
 * (which would read as "no sessions" on restart), and the file is never briefly world-readable.
 */
export function writeJsonAtomic(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* ignore on platforms without chmod */
  }
}
