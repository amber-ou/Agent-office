/**
 * Opening the local SQLite store — observation only.
 *
 * `openObservationStorage()` opens (or creates) `~/.agent-office/agent-office.db`,
 * backs the file up if a schema migration is about to run on existing data,
 * migrates it, and returns the call log. Nothing else: it does not create
 * agent directories, run scratch space or blob trees, it does not migrate or
 * import agent files, and it never touches `~/.claude`.
 *
 * Tables written by earlier Agent Office versions (projects, agents, tasks,
 * sessions, knowledge, outputs, review notes) are left in the file untouched.
 * This build does not read them; removing a feature is not a reason to
 * delete someone's data.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AgentCallLogStore } from '../callLog.js';
import { SqliteAgentCallLogStore } from './callLog.js';
import { SqliteDatabase } from './database.js';
import type { Migration } from './migrations.js';
import { LATEST_SCHEMA_VERSION, migrate } from './migrations.js';

export const DEFAULT_DATA_DIR_NAME = '.agent-office';
export const DATABASE_FILE_NAME = 'agent-office.db';

/** `~/.agent-office` — deliberately separate from upstream's `~/.pixel-agents`. */
export function defaultDataRoot(): string {
  return path.join(os.homedir(), DEFAULT_DATA_DIR_NAME);
}

export interface OpenObservationStorageOptions {
  /** Directory holding the database. Defaults to `~/.agent-office`. */
  dataRoot?: string;
  /** Override the database file path. `:memory:` gives an ephemeral database. */
  databasePath?: string;
  /** Clock for the backup file name. Tests pin it. */
  now?: () => Date;
}

export interface ObservationStorage {
  callLog: AgentCallLogStore;
  db: SqliteDatabase;
  dataRoot: string;
  databasePath: string;
  /** Schema version the file is at after opening. */
  schemaVersion: number;
  /** Migrations this call applied. Empty when the file was already current. */
  applied: readonly Migration[];
  /** Where the pre-migration copy was written, when one was. */
  backupPath?: string;
  close(): void;
}

/** `<db>.backup-v<from>-<stamp>` beside the database. Never overwrites. */
function backupBeforeMigration(databasePath: string, fromVersion: number, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  let candidate = `${databasePath}.backup-v${fromVersion}-${stamp}`;
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = `${databasePath}.backup-v${fromVersion}-${stamp}-${n++}`;
  }
  // COPYFILE_EXCL: a backup is never silently replaced.
  fs.copyFileSync(databasePath, candidate, fs.constants.COPYFILE_EXCL);
  return candidate;
}

export function openObservationStorage(
  options: OpenObservationStorageOptions = {},
): ObservationStorage {
  const dataRoot = options.dataRoot ?? defaultDataRoot();
  const databasePath = options.databasePath ?? path.join(dataRoot, DATABASE_FILE_NAME);
  const inMemory = databasePath === ':memory:';
  if (!inMemory) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  const db = new SqliteDatabase({ path: databasePath });
  let applied: readonly Migration[];
  let backupPath: string | undefined;
  try {
    const current = db.userVersion;
    if (!inMemory && current > 0 && current < LATEST_SCHEMA_VERSION) {
      // Existing data and a schema change ahead: copy the file first. Nothing
      // has been written through this connection yet, so the copy is the
      // file exactly as the previous version left it.
      backupPath = backupBeforeMigration(
        databasePath,
        current,
        (options.now ?? (() => new Date()))(),
      );
    }
    applied = migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }

  return {
    callLog: new SqliteAgentCallLogStore(db),
    db,
    dataRoot,
    databasePath,
    schemaVersion: LATEST_SCHEMA_VERSION,
    applied,
    ...(backupPath ? { backupPath } : {}),
    close(): void {
      db.close();
    },
  };
}

export { SqliteAgentCallLogStore } from './callLog.js';
export { SqliteDatabase } from './database.js';
export type { Migration } from './migrations.js';
export { LATEST_SCHEMA_VERSION, migrate, MIGRATIONS } from './migrations.js';
