/**
 * Integration test for Agent Office observation: transcript lines and store
 * broadcasts → `installCallLogBridge` → real (temporary) SQLite rows →
 * `agentCallUpdated` broadcasts. No real Claude process and no browser, but
 * the real parser, the real discovery scan over a temporary Claude home,
 * real storage, and real run-record files.
 *
 * Isolation: every path (Claude home, Office data root, project) lives in a
 * fresh temp directory; the real `~/.claude` and `~/.agent-office` are never
 * named. The final suite asserts Office wrote nothing into the agent side.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentCall } from '../../storage/src/index.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import type { CallLogBridge } from '../src/callLogBridge.js';
import { installCallLogBridge } from '../src/callLogBridge.js';
import {
  awaitRestartReconcile,
  closeOfficeStorage,
  getOfficeStorage,
  setClaudeHome,
  setOfficeDataRoot,
} from '../src/control/observationStorage.js';
import { notifyTeammateDeparture } from '../src/observationHooks.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { processTranscriptLine, setHookProvider } from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';

let root: string;
let claudeHome: string;
let dataRoot: string;
let project: string;
let store: AgentStateStore;
let bridge: CallLogBridge;
let broadcasts: Record<string, unknown>[];
const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: 'session-A',
    terminalRef: undefined,
    isExternal: true,
    projectDir: '/test',
    jsonlFile: '/test/session.jsonl',
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    contextTokens: 0,
    maxContextTokens: 200_000,
    ...overrides,
  } as AgentState;
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function toolUse(toolId: string, name: string, input: Record<string, unknown>, cwd = project) {
  return JSON.stringify({
    type: 'assistant',
    cwd,
    message: { content: [{ type: 'tool_use', id: toolId, name, input }] },
  });
}

function toolResult(toolId: string, text: string, isError = false) {
  return JSON.stringify({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolId,
          is_error: isError,
          content: [{ type: 'text', text }],
        },
      ],
    },
  });
}

function slashCommand(uuid: string, name: string, cwd = project) {
  return JSON.stringify({
    type: 'user',
    uuid,
    cwd,
    message: {
      content: `<command-message>${name} is running…</command-message>\n<command-name>/${name}</command-name>`,
    },
  });
}

function queueDone(toolId: string, status: string) {
  return JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    content: `<task-notification><tool-use-id>${toolId}</tool-use-id><status>${status}</status></task-notification>`,
  });
}

function line(agentId: number, text: string): void {
  processTranscriptLine(agentId, text, store, waitingTimers, permissionTimers);
}

async function call(sessionId: string, toolUseId: string): Promise<AgentCall> {
  await bridge.flush();
  const found = await getOfficeStorage()!.callLog.get(sessionId, toolUseId);
  if (!found) throw new Error(`no call ${sessionId}/${toolUseId}`);
  return found;
}

async function allCalls(): Promise<AgentCall[]> {
  await bridge.flush();
  return getOfficeStorage()!.callLog.listRecent(100);
}

/** Every file under `dir` with a content hash — to prove nothing changed. */
function treeSnapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    const stat = fs.statSync(full);
    out[path.relative(dir, full)] =
      `${stat.mtimeMs}:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`;
  }
  return out;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-observe-'));
  claudeHome = path.join(root, 'claude-home');
  dataRoot = path.join(root, 'office-data');
  project = path.join(root, 'design-project');
  write(
    path.join(claudeHome, 'agents', 'skill-retriever.md'),
    '---\nname: skill-retriever\ndescription: Finds relevant skills.\n---\nBody.\n',
  );
  write(
    path.join(claudeHome, 'skills', 'helper', 'SKILL.md'),
    '---\nname: helper\ndescription: A helper skill nobody wants as a character.\n---\n',
  );
  write(
    path.join(project, '.claude', 'skills', 'figma-ui', 'SKILL.md'),
    '---\nname: figma-ui\ndescription: Designs UI in Figma.\n---\n',
  );
  write(
    path.join(dataRoot, 'discovery.json'),
    JSON.stringify({ projectRoots: [project], skillInclude: ['figma-ui'] }),
  );
  setClaudeHome(claudeHome);
  setOfficeDataRoot(dataRoot);
  setHookProvider(claudeProvider);
  store = new AgentStateStore();
  broadcasts = [];
  store.on('broadcast', (msg) => broadcasts.push(msg));
  bridge = installCallLogBridge(store, { runRecordPollMs: 0 });
  store.set(1, createTestAgent());
});

afterEach(() => {
  bridge.dispose();
  closeOfficeStorage();
  setOfficeDataRoot(undefined);
  setClaudeHome(undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('delegations', () => {
  it('records a recognized call with a short summary (no prompt), then a confirmed end', async () => {
    line(
      1,
      toolUse('toolu_1', 'Agent', {
        subagent_type: 'skill-retriever',
        prompt: 'Find skills for auth\nSECRET second line',
        description: 'Find skills',
      }),
    );
    const started = await call('session-A', 'toolu_1');
    expect(started).toMatchObject({
      status: 'running',
      kind: 'subagent',
      recognized: true,
      agentFilePath: path.join(claudeHome, 'agents', 'skill-retriever.md'),
      activitySummary: 'Find skills',
      evidenceSource: 'transcript',
    });
    expect(started.taskText).toBeUndefined();
    expect(JSON.stringify(await allCalls())).not.toContain('SECRET');

    line(1, toolResult('toolu_1', 'Here are the skills.'));
    const ended = await call('session-A', 'toolu_1');
    expect(ended.status).toBe('ended');
    expect(ended.evidenceSource).toBe('transcript');
    expect(ended.endedAt).toBeDefined();
    expect(broadcasts.filter((b) => b.type === 'agentCallUpdated').length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it('marks an error result failed and a built-in name unrecognized', async () => {
    line(1, toolUse('toolu_1', 'Task', { subagent_type: 'general-purpose', description: 'x' }));
    line(1, toolResult('toolu_1', 'boom', true));
    const c = await call('session-A', 'toolu_1');
    expect(c).toMatchObject({ status: 'failed', recognized: false });
    expect(c.agentFilePath).toBeUndefined();
  });

  it('keeps concurrent calls to the same agent independent', async () => {
    line(1, toolUse('toolu_1', 'Agent', { subagent_type: 'skill-retriever', description: 'one' }));
    line(1, toolUse('toolu_2', 'Agent', { subagent_type: 'skill-retriever', description: 'two' }));
    line(1, toolResult('toolu_1', 'done'));
    expect((await call('session-A', 'toolu_1')).status).toBe('ended');
    expect((await call('session-A', 'toolu_2')).status).toBe('running');
  });

  it('runs two sessions in parallel without mixing them up', async () => {
    store.set(2, createTestAgent({ id: 2, sessionId: 'session-B', jsonlFile: '/test/b.jsonl' }));
    line(1, toolUse('toolu_1', 'Agent', { subagent_type: 'skill-retriever' }));
    line(2, toolUse('toolu_1', 'Agent', { subagent_type: 'skill-retriever' }));
    line(2, toolResult('toolu_1', 'done'));
    expect((await call('session-A', 'toolu_1')).status).toBe('running');
    expect((await call('session-B', 'toolu_1')).status).toBe('ended');
  });

  it('dedups a replayed start: one row, original start time kept', async () => {
    const record = toolUse('toolu_1', 'Agent', { subagent_type: 'skill-retriever' });
    line(1, record);
    const first = await call('session-A', 'toolu_1');
    line(1, record);
    const calls = await allCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.startedAt).toBe(first.startedAt);
  });
});

describe('background spawns', () => {
  it('treats the launch ack as background_running, and the queue-operation as the end', async () => {
    line(1, toolUse('toolu_bg', 'Agent', { subagent_type: 'skill-retriever', description: 'bg' }));
    line(1, toolResult('toolu_bg', 'Async agent launched successfully. agentId: a1'));
    const launched = await call('session-A', 'toolu_bg');
    expect(launched).toMatchObject({ status: 'background_running', kind: 'background' });
    expect(launched.endedAt).toBeUndefined();

    line(1, queueDone('toolu_bg', 'completed'));
    const done = await call('session-A', 'toolu_bg');
    expect(done).toMatchObject({ status: 'ended', evidenceSource: 'queue_operation' });
    expect(done.endedAt).toBeDefined();
  });

  it('records a failed background completion as failed', async () => {
    line(1, toolUse('toolu_bg', 'Agent', { subagent_type: 'skill-retriever' }));
    line(1, toolResult('toolu_bg', 'Async agent launched successfully. agentId: a1'));
    line(1, queueDone('toolu_bg', 'failed'));
    expect((await call('session-A', 'toolu_bg')).status).toBe('failed');
  });
});

describe('teammates', () => {
  it('links an implicit-team spawn to its teammate and ends it on the team config', async () => {
    line(1, toolUse('toolu_t', 'Agent', { subagent_type: 'skill-retriever' }));
    line(1, toolResult('toolu_t', 'Spawned. agent_id: retriever-1@session-abcdef12'));
    const spawned = await call('session-A', 'toolu_t');
    expect(spawned).toMatchObject({
      status: 'background_running',
      kind: 'teammate',
      teammateName: 'retriever-1',
    });
    expect(spawned.endedAt).toBeUndefined();

    notifyTeammateDeparture({
      leadSessionId: 'session-A',
      teammateName: 'retriever-1',
      source: 'team-config',
    });
    expect(await call('session-A', 'toolu_t')).toMatchObject({
      status: 'ended',
      evidenceSource: 'team_config',
    });
  });

  it('marks a teammate superseded by a new team unknown, not ended', async () => {
    line(1, toolUse('toolu_t', 'Agent', { subagent_type: 'skill-retriever', name: 'r1' }));
    line(1, toolResult('toolu_t', 'Async agent launched successfully. agentId: r1'));
    notifyTeammateDeparture({
      leadSessionId: 'session-A',
      teammateName: 'r1',
      source: 'team-switch',
    });
    const c = await call('session-A', 'toolu_t');
    expect(c.status).toBe('unknown');
    expect(c.endedAt).toBeUndefined();
  });
});

describe('waiting and resuming', () => {
  it('moves a call to waiting_response on a hook permission prompt and back on activity', async () => {
    store.get(1)!.hookDelivered = true;
    line(1, toolUse('toolu_1', 'Agent', { subagent_type: 'skill-retriever' }));
    await bridge.flush();
    store.broadcast({ type: 'subagentToolPermission', id: 1, parentToolId: 'toolu_1' });
    expect((await call('session-A', 'toolu_1')).status).toBe('waiting_response');
    store.broadcast({ type: 'subagentToolDone', id: 1, parentToolId: 'toolu_1', toolId: 'x' });
    expect((await call('session-A', 'toolu_1')).status).toBe('running');
  });

  it('does not treat the heuristic permission timer as evidence of waiting', async () => {
    line(1, toolUse('toolu_1', 'Agent', { subagent_type: 'skill-retriever' }));
    await bridge.flush();
    store.broadcast({ type: 'subagentToolPermission', id: 1, parentToolId: 'toolu_1' });
    expect((await call('session-A', 'toolu_1')).status).toBe('running');
  });

  it('marks open calls unknown when their session goes away', async () => {
    line(1, toolUse('toolu_1', 'Agent', { subagent_type: 'skill-retriever' }));
    await bridge.flush();
    store.delete(1);
    const c = await call('session-A', 'toolu_1');
    expect(c).toMatchObject({ status: 'unknown', evidenceSource: 'session_end' });
    expect(c.endedAt).toBeUndefined();
  });
});

describe('skills and run records (/figma-ui)', () => {
  const ledger = (runId: string, body: Record<string, unknown>) =>
    write(path.join(project, 'design-runs', runId, 'ledger.json'), JSON.stringify(body));

  it('tracks a shown skill, but never a helper skill', async () => {
    line(1, slashCommand('rec-1', 'figma-ui'));
    line(1, slashCommand('rec-2', 'helper'));
    line(1, toolUse('toolu_h', 'Skill', { skill: 'helper' }));
    const calls = await allCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      agentName: 'figma-ui',
      kind: 'skill',
      sourceKind: 'skill',
      recognized: true,
      status: 'running',
      activitySummary: '/figma-ui',
      agentFilePath: path.join(project, '.claude', 'skills', 'figma-ui', 'SKILL.md'),
    });
  });

  it('does not attribute a project skill to a session outside that project', async () => {
    line(1, slashCommand('rec-1', 'figma-ui', path.join(root, 'elsewhere')));
    expect(await allCalls()).toHaveLength(0);
  });

  it('counts a slash command and a Skill tool_use in the same turn as one invocation', async () => {
    line(1, slashCommand('rec-1', 'figma-ui'));
    line(1, toolUse('toolu_s', 'Skill', { skill: 'figma-ui' }));
    expect(await allCalls()).toHaveLength(1);
  });

  it('says unknown at turn end without a run record, then follows the ledger', async () => {
    line(1, slashCommand('rec-1', 'figma-ui'));
    await bridge.flush();
    store.broadcast({ type: 'agentStatus', id: 1, status: 'waiting' });
    expect(await call('session-A', 'rec-1')).toMatchObject({
      status: 'unknown',
      evidenceSource: 'turn_end',
    });

    ledger('run-1', {
      runId: 'run-1',
      phase: 'requirements',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      questionRounds: [{ questions: ['Which page?'], answers: [] }],
    });
    await bridge.pollRunRecords();
    expect(await call('session-A', 'rec-1')).toMatchObject({
      status: 'waiting_response',
      evidenceSource: 'run_record',
      runId: 'run-1',
      phase: 'requirements',
    });

    ledger('run-1', {
      runId: 'run-1',
      phase: 'delivery',
      createdAt: new Date().toISOString(),
      updatedAt: new Date(Date.now() + 1000).toISOString(),
      completed: true,
    });
    await bridge.pollRunRecords();
    const done = await call('session-A', 'rec-1');
    expect(done).toMatchObject({
      status: 'ended',
      evidenceSource: 'run_record',
      phase: 'delivery',
    });
    expect(done.endedAt).toBeDefined();
  });

  it('ignores a ledger from before the invocation, and an ambiguous one', async () => {
    ledger('old-run', {
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
      completed: true,
    });
    line(1, slashCommand('rec-1', 'figma-ui'));
    await bridge.pollRunRecords();
    expect((await call('session-A', 'rec-1')).status).toBe('running');

    // Two concurrent invocations in the same project: a time-based link
    // would be a guess, so neither gets one.
    store.set(2, createTestAgent({ id: 2, sessionId: 'session-B', jsonlFile: '/test/b.jsonl' }));
    line(2, slashCommand('rec-2', 'figma-ui'));
    ledger('new-run', { createdAt: new Date().toISOString(), completed: true });
    await bridge.pollRunRecords();
    expect((await call('session-A', 'rec-1')).status).toBe('running');
    expect((await call('session-B', 'rec-2')).status).toBe('running');
  });
});

describe('restart', () => {
  it('marks open calls unknown on reopen and accepts a late result as evidence', async () => {
    line(1, toolUse('toolu_1', 'Agent', { subagent_type: 'skill-retriever' }));
    line(1, toolUse('toolu_bg', 'Agent', { subagent_type: 'skill-retriever' }));
    line(1, toolResult('toolu_bg', 'Async agent launched successfully. agentId: a1'));
    await bridge.flush();

    // Simulate an Office restart: a fresh process opens the same database.
    bridge.dispose();
    closeOfficeStorage();
    store = new AgentStateStore();
    bridge = installCallLogBridge(store, { runRecordPollMs: 0 });
    store.set(1, createTestAgent());
    getOfficeStorage();
    expect(await awaitRestartReconcile()).toBe(2);
    for (const id of ['toolu_1', 'toolu_bg']) {
      const c = await call('session-A', id);
      expect(c).toMatchObject({ status: 'unknown', evidenceSource: 'restart' });
      expect(c.endedAt).toBeUndefined();
    }

    // Late evidence after the restart still resolves the unknown rows.
    line(1, toolResult('toolu_1', 'done'));
    line(1, queueDone('toolu_bg', 'completed'));
    expect((await call('session-A', 'toolu_1')).status).toBe('ended');
    expect((await call('session-A', 'toolu_bg')).status).toBe('ended');
  });
});

describe('data boundary', () => {
  it('writes nothing into the Claude home or the project while observing', async () => {
    const claudeBefore = treeSnapshot(claudeHome);
    const projectBefore = treeSnapshot(project);
    store.get(1)!.hookDelivered = true;
    line(1, toolUse('toolu_1', 'Agent', { subagent_type: 'skill-retriever' }));
    line(1, slashCommand('rec-1', 'figma-ui'));
    store.broadcast({ type: 'agentToolPermission', id: 1 });
    store.broadcast({ type: 'agentStatus', id: 1, status: 'waiting' });
    await bridge.pollRunRecords();
    line(1, toolResult('toolu_1', 'done'));
    await bridge.flush();
    expect(treeSnapshot(claudeHome)).toEqual(claudeBefore);
    expect(treeSnapshot(project)).toEqual(projectBefore);
    // Office's own writes stay in its data root.
    expect(fs.readdirSync(dataRoot).sort()).toEqual(['agent-office.db', 'discovery.json']);
  });
});
