import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_BYTES = 5 * 1024 * 1024;
let file: string | null = null;

/** Also write log lines to DATA_DIR/anvil.log, keeping one 5 MB backup. */
export function logToDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  file = join(dir, "anvil.log");
}

function write(level: string, message: string): void {
  const line = `${new Date().toISOString()} ${level} ${message}`;
  (level === "ERROR" ? console.error : console.log)(line);
  if (!file) return;
  try {
    const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
    if (size > MAX_BYTES) renameSync(file, `${file}.1`);
    appendFileSync(file, line + "\n");
  } catch {
    // Logging must never take the bot down; stdout still has the line.
  }
}

export const log = {
  info: (message: string) => write("INFO", message),
  warn: (message: string) => write("WARN", message),
  error: (message: string, err?: unknown) =>
    write("ERROR", err === undefined ? message : `${message}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`),
};
