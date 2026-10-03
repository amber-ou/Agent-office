/**
 * `AgentCallLogStore` and the observation database open: dedup on replay,
 * no resurrection of a confirmed end, evidence-gated recovery from
 * `unknown`, the restart safety net, and the pre-migration backup that
 * keeps an earlier version's data intact.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ObservationStorage, StartAgentCallInput } from '../src/index.js';
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  openObservationStorage,
  SqliteDatabase,
  summarizeActivity,
} from '../src/index.js';

let dataRoot: string;
let storage: ObservationStorage;

const base: StartAgentCallInput = {
  agentName: 'skill-retriever',
  agentFilePath: '/home/user/.claude/agents/skill-retriever.md',
  recognized: true,
  sourceKind: 'agent',
  kind: 'subagent',
  parentSessionId: 'session-1',
  toolUseId: 'toolu_1',
  activitySummary: 'Find skills',
  startedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-calllog-'));
  storage = openObservationStorage({ dataRoot });
});

afterEach(() => {
  storage.close();
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('SqliteAgentCallLogStore', () => {
  it('records a start and reads it back', async () => {
    const call = await storage.callLog.start(base);
    expect(call).toMatchObject({
      status: 'running',
      kind: 'subagent',
      sourceKind: 'agent',
      recognized: true,
      activitySummary: 'Find skills',
      evidenceSource: 'transcript',
      startUnknown: false,
    });
    expect(call.endedAt).toBeUndefined();
    expect(await storage.callLog.get('session-1', 'toolu_1')).toEqual(call);
  });

  it('is idempotent on (parentSessionId, toolUseId)', async () => {
    const first = await storage.callLog.start(base);
    const second = await storage.callLog.start({ ...base, startedAt: '2030-01-01T00:00:00.000Z' });
    expect(second).toEqual(first);
    expect(await storage.callLog.listRecent(10)).toHaveLength(1);
  });

  it('records start-unknown when the start was not observed', async () => {
    const { startedAt: _ignored, ...rest } = base;
    const call = await storage.callLog.start(rest);
    expect(call.startUnknown).toBe(true);
    expect(call.startedAt).toBeUndefined();
  });

  it('never lets a later event overwrite a confirmed end', async () => {
    await storage.callLog.start(base);
    await storage.callLog.end({
      parentSessionId: 'session-1',
      toolUseId: 'toolu_1',
      status: 'ended',
      endedAt: '2026-01-01T00:01:00.000Z',
      evidenceSource: 'transcript',
    });
    await storage.callLog.end({
      parentSessionId: 'session-1',
      toolUseId: 'toolu_1',
      status: 'failed',
      endedAt: '2026-01-01T00:05:00.000Z',
      evidenceSource: 'queue_operation',
    });
    await storage.callLog.markStatus('session-1', 'toolu_1', 'running', { allowFromUnknown: true });
    const call = await storage.callLog.get('session-1', 'toolu_1');
    expect(call).toMatchObject({ status: 'ended', endedAt: '2026-01-01T00:01:00.000Z' });
  });

  it('only moves an unknown call on with explicit new evidence', async () => {
    await storage.callLog.start(base);
    expect(await storage.callLog.markOpenCallsUnknown()).toBe(1);
    await storage.callLog.markStatus('session-1', 'toolu_1', 'running');
    expect((await storage.callLog.get('session-1', 'toolu_1'))!.status).toBe('unknown');
    await storage.callLog.markStatus('session-1', 'toolu_1', 'waiting_response', {
      evidenceSource: 'run_record',
      phase: 'questions',
      allowFromUnknown: true,
    });
    expect(await storage.callLog.get('session-1', 'toolu_1')).toMatchObject({
      status: 'waiting_response',
      evidenceSource: 'run_record',
      phase: 'questions',
    });
  });

  it('restart safety net covers background_running and never fabricates an end', async () => {
    await storage.callLog.start(base);
    await storage.callLog.start({ ...base, toolUseId: 'toolu_bg', kind: 'background' });
    await storage.callLog.markStatus('session-1', 'toolu_bg', 'background_running');
    await storage.callLog.start({ ...base, toolUseId: 'toolu_done' });
    await storage.callLog.end({
      parentSessionId: 'session-1',
      toolUseId: 'toolu_done',
      status: 'ended',
      endedAt: '2026-01-01T00:01:00.000Z',
      evidenceSource: 'transcript',
    });
    expect(await storage.callLog.markOpenCallsUnknown()).toBe(2);
    for (const id of ['toolu_1', 'toolu_bg']) {
      const call = await storage.callLog.get('session-1', id);
      expect(call).toMatchObject({ status: 'unknown', evidenceSource: 'restart' });
      expect(call!.endedAt).toBeUndefined();
    }
    expect((await storage.callLog.get('session-1', 'toolu_done'))!.status).toBe('ended');
    expect(await storage.callLog.listOpen()).toEqual([]);
  });

  it('annotates identity details without touching status', async () => {
    await storage.callLog.start(base);
    await storage.callLog.annotate('session-1', 'toolu_1', {
      kind: 'teammate',
      teammateName: 'r1',
      runId: 'run-9',
    });
    expect(await storage.callLog.get('session-1', 'toolu_1')).toMatchObject({
      status: 'running',
      kind: 'teammate',
      teammateName: 'r1',
      runId: 'run-9',
    });
  });
});

describe('summarizeActivity', () => {
  it('keeps one short line, never the whole prompt', () => {
    expect(summarizeActivity('\n  First   line\nsecond line')).toBe('First line');
    const long = summarizeActivity('x'.repeat(500))!;
    expect(long.length).toBe(120);
    expect(long.endsWith('…')).toBe(true);
    expect(summarizeActivity(undefined)).toBeUndefined();
  });
});

describe('openObservationStorage', () => {
  it('creates only the database in the data root — no agent, blob or runtime trees', () => {
    expect(fs.readdirSync(dataRoot)).toEqual(['agent-office.db']);
    expect(storage.backupPath).toBeUndefined();
  });

  it('backs up a previous-version database before migrating, and keeps its data', async () => {
    storage.close();
    const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-legacy-'));
    try {
      // Build a v4 file the way the previous version left it: all of its
      // tables, one project, one legacy call with the full prompt.
      const dbPath = path.join(legacyRoot, 'agent-office.db');
      const legacy = new SqliteDatabase({ path: dbPath });
      legacy.exec('BEGIN');
      for (const migration of MIGRATIONS.filter((m) => m.version <= 4)) {
        legacy.exec(migration.up);
      }
      legacy.setUserVersion(4);
      legacy.exec('COMMIT');
      legacy.run(
        `INSERT INTO projects (id, name, description, status, settings, created_at, updated_at)
         VALUES ('p1', 'Old project', '', 'active', '{}', '2026-01-01', '2026-01-01')`,
      );
      legacy.run(
        `INSERT INTO agent_calls (id, agent_name, recognized, parent_session_id, tool_use_id,
           task_text, status, start_unknown, created_at, updated_at)
         VALUES ('c1', 'old-agent', 0, 's', 't', 'full legacy prompt', 'background_not_tracked', 0,
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      );
      legacy.close();
      const before = fs.readFileSync(dbPath);

      storage = openObservationStorage({
        dataRoot: legacyRoot,
        now: () => new Date('2026-10-01T12:00:00.000Z'),
      });
      expect(storage.applied.map((m) => m.version)).toEqual([5]);
      expect(storage.schemaVersion).toBe(LATEST_SCHEMA_VERSION);
      expect(storage.backupPath).toBe(`${dbPath}.backup-v4-2026-10-01T12-00-00-000Z`);
      expect(fs.readFileSync(storage.backupPath!)).toEqual(before);

      // Old data survives in place: the legacy table and the legacy call.
      expect(storage.db.get("SELECT name FROM projects WHERE id = 'p1'")).toEqual({
        name: 'Old project',
      });
      expect(await storage.callLog.get('s', 't')).toMatchObject({
        kind: 'subagent',
        status: 'background_not_tracked',
        taskText: 'full legacy prompt',
      });

      // Reopening an up-to-date file makes no further backup.
      storage.close();
      storage = openObservationStorage({ dataRoot: legacyRoot });
      expect(storage.backupPath).toBeUndefined();
      expect(fs.readdirSync(legacyRoot).filter((f) => f.includes('.backup-'))).toHaveLength(1);
    } finally {
      storage.close();
      fs.rmSync(legacyRoot, { recursive: true, force: true });
      storage = openObservationStorage({ dataRoot });
    }
  });
});
