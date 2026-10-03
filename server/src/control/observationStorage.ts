/**
 * The one place the server opens the Agent Office database — observation
 * only (docs/observation.md).
 *
 * Lazily opened on first use and held for the life of the process. Opening
 * does exactly three things: back up an existing file before a schema
 * migration, migrate, and mark calls left open by a previous process as
 * `unknown`. It does NOT migrate, import or link agent files, and it never
 * writes into `~/.claude` — earlier versions did all of that here at boot.
 *
 * Opening is allowed to fail (read-only home, corrupt file, newer schema).
 * A failure is recorded and reported as `ready: false`: the office still
 * renders and still shows discovered agents, it just cannot keep history.
 */

import * as os from 'node:os';
import * as path from 'node:path';

import type { AgentCallLogStore, ObservationStorage } from '../../../storage/src/index.js';
import { defaultDataRoot, openObservationStorage } from '../../../storage/src/index.js';

export interface OfficeStorage {
  callLog: AgentCallLogStore;
  dataRoot: string;
  databasePath: string;
  schemaVersion: number;
  backupPath?: string;
}

let opened: ObservationStorage | null = null;
let openError: string | null = null;
let restartReconcile: Promise<number> | null = null;
/** Set by tests; production uses `~/.agent-office`. */
let dataRootOverride: string | undefined;
/** Set by tests; production uses `~/.claude`. */
let claudeHomeOverride: string | undefined;

/** Point the office at a different data root. Closes anything already open. */
export function setOfficeDataRoot(dataRoot: string | undefined): void {
  closeOfficeStorage();
  dataRootOverride = dataRoot;
}

/** The Office data root (database, discovery config). Never `~/.claude`. */
export function getOfficeDataRoot(): string {
  return dataRootOverride ?? defaultDataRoot();
}

/** Point discovery at a different Claude home than the real `~/.claude`. */
export function setClaudeHome(claudeHome: string | undefined): void {
  claudeHomeOverride = claudeHome;
}

/** Where Claude Code keeps user-level agents and skills. Read, never written. */
export function getClaudeHome(): string {
  return claudeHomeOverride ?? path.join(os.homedir(), '.claude');
}

export function getOfficeStorage(): OfficeStorage | null {
  if (opened) return toOfficeStorage(opened);
  if (openError !== null) return null;
  try {
    const storage = openObservationStorage({ dataRoot: getOfficeDataRoot() });
    opened = storage;
    console.log(
      `[Agent Office] Storage ready: ${storage.databasePath} (schema v${storage.schemaVersion})`,
    );
    if (storage.backupPath) {
      console.log(`[Agent Office] Database backed up before migration: ${storage.backupPath}`);
    }
    // Any call still open from a previous process is not still being
    // tracked — but when it actually ended is unknown, so it becomes
    // 'unknown' rather than ended/failed with a fabricated time.
    restartReconcile = storage.callLog.markOpenCallsUnknown().then((count) => {
      if (count > 0) {
        console.log(
          `[Agent Office] ${count} call(s) still open from a previous run marked status "unknown".`,
        );
      }
      return count;
    });
    return toOfficeStorage(storage);
  } catch (error) {
    openError = error instanceof Error ? error.message : String(error);
    console.error(`[Agent Office] Storage unavailable: ${openError}`);
    return null;
  }
}

/** Resolves once the restart safety net has run for the open database. */
export async function awaitRestartReconcile(): Promise<number> {
  return restartReconcile ?? 0;
}

function toOfficeStorage(storage: ObservationStorage): OfficeStorage {
  return {
    callLog: storage.callLog,
    dataRoot: storage.dataRoot,
    databasePath: storage.databasePath,
    schemaVersion: storage.schemaVersion,
    ...(storage.backupPath ? { backupPath: storage.backupPath } : {}),
  };
}

/** Close the database and forget any recorded failure. Shutdown and tests. */
export function closeOfficeStorage(): void {
  opened?.close();
  opened = null;
  openError = null;
  restartReconcile = null;
}
