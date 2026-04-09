import type { DB } from "./db";

export class Logger {
  constructor(private db: DB) {}

  info(msg: string, videoId?: number): void {
    const ts = new Date().toISOString();
    console.log(`\x1b[90m${ts}\x1b[0m \x1b[36m[INFO]\x1b[0m ${msg}`);
    this.db.addLog("info", msg, videoId);
  }

  warn(msg: string, videoId?: number): void {
    const ts = new Date().toISOString();
    console.warn(`\x1b[90m${ts}\x1b[0m \x1b[33m[WARN]\x1b[0m ${msg}`);
    this.db.addLog("warn", msg, videoId);
  }

  error(msg: string, videoId?: number): void {
    const ts = new Date().toISOString();
    console.error(`\x1b[90m${ts}\x1b[0m \x1b[31m[ERROR]\x1b[0m ${msg}`);
    this.db.addLog("error", msg, videoId);
  }
}
