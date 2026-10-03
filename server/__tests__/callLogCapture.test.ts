/**
 * Observation events from transcriptParser.ts — the evidence the Agent
 * Office call log is built on (docs/observation.md). Covers both spawn tool
 * names (`Task` on older CLI builds, `Agent` on current ones), teammate
 * spawns (named, and implicit-team results), async launch acks, background
 * completion via queue-operation, and skill invocations (Skill tool and
 * slash command).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { ObservationEvent } from '../src/transcriptParser.js';
import {
  processTranscriptLine,
  setHookProvider,
  setObservationCallback,
} from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';

function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: 'parent-session-1',
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

function toolUseRecord(
  toolId: string,
  name: string,
  input: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return JSON.stringify({
    type: 'assistant',
    ...extra,
    message: { content: [{ type: 'tool_use', id: toolId, name, input }] },
  });
}

function toolResultRecord(toolId: string, text: string, isError = false) {
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

describe('observation events', () => {
  let agents: AgentStateStore;
  let events: ObservationEvent[];
  const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const line = (text: string) =>
    processTranscriptLine(1, text, agents, waitingTimers, permissionTimers);

  beforeEach(() => {
    setHookProvider(claudeProvider);
    agents = new AgentStateStore();
    agents.set(1, createTestAgent());
    events = [];
    setObservationCallback((event) => events.push(event));
    vi.useFakeTimers();
    return () => {
      vi.useRealTimers();
      setObservationCallback(null);
    };
  });

  it.each(['Task', 'Agent'])(
    'captures a %s delegation with a short description, never the prompt',
    (tool) => {
      line(
        toolUseRecord(
          'toolu_1',
          tool,
          {
            subagent_type: 'skill-retriever',
            prompt: 'Find skills for authentication\nwith a long second line of private detail',
            description: 'Find skills',
          },
          { cwd: '/work/project' },
        ),
      );
      expect(events).toEqual([
        {
          kind: 'delegateStart',
          agentId: 1,
          sessionId: 'parent-session-1',
          toolUseId: 'toolu_1',
          subagentType: 'skill-retriever',
          description: 'Find skills',
          promptHead: 'Find skills for authentication',
          runInBackground: false,
          cwd: '/work/project',
        },
      ]);
      expect(JSON.stringify(events)).not.toContain('private detail');
    },
  );

  it('ignores a spawn without subagent_type', () => {
    line(toolUseRecord('toolu_1', 'Agent', { prompt: 'do it' }));
    expect(events).toEqual([]);
  });

  it('records a named spawn as a teammate-to-be', () => {
    line(toolUseRecord('toolu_1', 'Agent', { subagent_type: 'reviewer', name: 'rev-1' }));
    expect(events[0]).toMatchObject({ kind: 'delegateStart', teammateName: 'rev-1' });
  });

  it('reports a real result as completed, and is_error as error', () => {
    line(toolUseRecord('toolu_1', 'Task', { subagent_type: 'a' }));
    line(toolUseRecord('toolu_2', 'Task', { subagent_type: 'b' }));
    line(toolResultRecord('toolu_1', 'done'));
    line(toolResultRecord('toolu_2', 'boom', true));
    expect(events.filter((e) => e.kind === 'delegateResult')).toEqual([
      {
        kind: 'delegateResult',
        agentId: 1,
        sessionId: 'parent-session-1',
        toolUseId: 'toolu_1',
        outcome: 'completed',
      },
      {
        kind: 'delegateResult',
        agentId: 1,
        sessionId: 'parent-session-1',
        toolUseId: 'toolu_2',
        outcome: 'error',
      },
    ]);
  });

  it('reports an async launch acknowledgment as async, not completed', () => {
    line(toolUseRecord('toolu_1', 'Agent', { subagent_type: 'a' }));
    line(toolResultRecord('toolu_1', 'Async agent launched successfully. agentId: abc123'));
    const results = events.filter((e) => e.kind === 'delegateResult');
    expect(results).toEqual([
      {
        kind: 'delegateResult',
        agentId: 1,
        sessionId: 'parent-session-1',
        toolUseId: 'toolu_1',
        outcome: 'async',
      },
    ]);
  });

  it('reports an implicit-team spawn result as a teammate start, not an end', () => {
    line(toolUseRecord('toolu_1', 'Agent', { subagent_type: 'reviewer' }));
    line(toolResultRecord('toolu_1', 'Spawned. agent_id: rev-1@session-abcdef12'));
    const result = events.find((e) => e.kind === 'delegateResult');
    expect(result).toMatchObject({ outcome: 'teammate', teammateName: 'rev-1' });
  });

  it('reports a queue-operation completion with its status', () => {
    line(
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content:
          '<task-notification><task-id>t</task-id><tool-use-id>toolu_9</tool-use-id><status>completed</status></task-notification>',
      }),
    );
    expect(events).toEqual([
      {
        kind: 'backgroundDone',
        agentId: 1,
        sessionId: 'parent-session-1',
        toolUseId: 'toolu_9',
        status: 'completed',
      },
    ]);
  });

  it('captures a Skill tool invocation', () => {
    line(toolUseRecord('toolu_s', 'Skill', { skill: 'figma-ui' }, { cwd: '/work/design' }));
    expect(events).toEqual([
      {
        kind: 'skillStart',
        agentId: 1,
        sessionId: 'parent-session-1',
        invocationId: 'toolu_s',
        skill: 'figma-ui',
        via: 'tool',
        cwd: '/work/design',
      },
    ]);
  });

  it('captures a slash-command skill invocation keyed by the record uuid', () => {
    line(
      JSON.stringify({
        type: 'user',
        uuid: 'rec-1',
        cwd: '/work/design',
        message: {
          content:
            '<command-message>figma-ui is running…</command-message>\n<command-name>/figma-ui</command-name>\n<command-args>login page</command-args>',
        },
      }),
    );
    expect(events).toEqual([
      {
        kind: 'skillStart',
        agentId: 1,
        sessionId: 'parent-session-1',
        invocationId: 'rec-1',
        skill: 'figma-ui',
        via: 'slash',
        cwd: '/work/design',
        args: 'login page',
      },
    ]);
  });

  it('ignores slash commands inside a sidechain', () => {
    line(
      JSON.stringify({
        type: 'user',
        uuid: 'rec-2',
        isSidechain: true,
        message: { content: '<command-name>/figma-ui</command-name>' },
      }),
    );
    expect(events).toEqual([]);
  });
});
