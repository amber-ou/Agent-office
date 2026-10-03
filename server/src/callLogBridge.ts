/**
 * The call-log tracker: turns observed Claude Code activity into evidence-
 * backed call-log rows and pushes each change to connected clients.
 *
 * Inputs, all observational:
 *  - transcript events (`setObservationCallback`, transcriptParser.ts):
 *    delegation start/result, background completion, skill invocation;
 *  - the store's own broadcasts: permission prompts and their resolution,
 *    turn ends, sessions going away — the same signals the pixel office
 *    renders, in both hooks and heuristic mode;
 *  - teammate departures from the runtime (`observationHooks.ts`);
 *  - an agent's own run records, polled read-only (`runRecords.ts`).
 *
 * Output: `storage.callLog` writes + `agentCallUpdated` broadcasts. Nothing
 * here starts, stops or answers an agent, and nothing is written anywhere
 * but Office's own database.
 *
 * "Ended" is never "succeeded": every status change records what it rests
 * on (`evidenceSource`), and the absence of a signal is `unknown`.
 */

import * as path from 'node:path';

import type {
  AgentCall,
  AgentCallStatus,
  EvidenceSource,
  NativeAgentRosterEntry,
} from '../../storage/src/index.js';
import { resolveDefinition, summarizeActivity } from '../../storage/src/index.js';
import type { AgentStateStore } from './agentStateStore.js';
import type { OfficeStorage } from './control/observationStorage.js';
import { getOfficeStorage } from './control/observationStorage.js';
import { scanNativeAgentRoster } from './nativeAgentRoster.js';
import type { TeammateDeparture } from './observationHooks.js';
import { setTeammateDepartureObserver } from './observationHooks.js';
import type { RunRecord } from './runRecords.js';
import {
  correlateRun,
  findRunRecords,
  RUN_ACTIVE_WINDOW_MS,
  RUN_START_SLACK_MS,
  runIdFromInvocationArgs,
} from './runRecords.js';
import type { ObservationEvent } from './transcriptParser.js';
import { setObservationCallback } from './transcriptParser.js';

const debug = process.env.PIXEL_AGENTS_DEBUG !== '0';

export const RUN_RECORD_POLL_INTERVAL_MS = 3000;

/** `AgentCall`'s shape matches `AgentCallLogEntry` (core/asyncapi.yaml). */
function toWireCall(call: AgentCall): Record<string, unknown> {
  return call as unknown as Record<string, unknown>;
}

/** In-memory facts about an open invocation this process observed. Not
 *  persisted: after a restart every open row is `unknown` anyway. */
interface OpenInvocation {
  sessionId: string;
  toolUseId: string;
  name: string;
  kind: AgentCall['kind'];
  cwd?: string;
  projectRoot?: string;
  startedAt: number;
  teammateName?: string;
  linkedRunId?: string;
  /** Whether `runId` has been written to the row yet. */
  runIdRecorded?: boolean;
  /** Last run-record fingerprint applied, so a poll writes only on change. */
  appliedRun?: string;
  /** The run-record state last applied (decides what a turn end means). */
  appliedState?: RunRecord['state'];
  /** Set while WE moved it to waiting_response on a permission prompt — so
   *  resumption only reverts waits this tracker itself introduced. */
  permissionWait?: boolean;
}

export interface CallLogBridgeOptions {
  /** Inject a roster (tests). Defaults to a fresh discovery scan. */
  roster?: () => readonly NativeAgentRosterEntry[];
  /** Run-record poll cadence; 0 disables the poll (tests drive it). */
  runRecordPollMs?: number;
}

export interface CallLogBridge {
  /** Apply run records now (tests; the poll calls this). */
  pollRunRecords(): Promise<void>;
  /** Resolves when every queued write has been applied. */
  flush(): Promise<void>;
  dispose(): void;
}

let installed: CallLogBridge | null = null;

/** Wire observation into storage + broadcast. Re-installing replaces the
 *  previous bridge, matching every other module-level `set*Callback`. */
export function installCallLogBridge(
  store: AgentStateStore,
  options: CallLogBridgeOptions = {},
): CallLogBridge {
  installed?.dispose();
  const roster = options.roster ?? scanNativeAgentRoster;
  const open = new Map<string, OpenInvocation>();
  const sessionByAgentId = new Map<number, string>();
  let queue: Promise<unknown> = Promise.resolve();

  const key = (sessionId: string, toolUseId: string) => `${sessionId}\u0000${toolUseId}`;

  /** Serialize writes so events for one invocation apply in order. */
  function enqueue(work: (storage: OfficeStorage) => Promise<void>): void {
    const storage = getOfficeStorage();
    if (!storage) {
      if (debug) console.log('[Agent Office] Call log: storage unavailable, event not recorded');
      return;
    }
    queue = queue
      .then(() => work(storage))
      .catch((err: unknown) => console.error('[Agent Office] Call log write failed:', err));
  }

  async function publish(storage: OfficeStorage, sessionId: string, toolUseId: string) {
    const call = await storage.callLog.get(sessionId, toolUseId);
    if (call) store.broadcast({ type: 'agentCallUpdated', call: toWireCall(call) });
    return call;
  }

  function sessionOf(agentId: number): string | undefined {
    const sessionId = store.get(agentId)?.sessionId;
    if (sessionId) sessionByAgentId.set(agentId, sessionId);
    return sessionId ?? sessionByAgentId.get(agentId);
  }

  function openIn(sessionId: string): OpenInvocation[] {
    return [...open.values()].filter((inv) => inv.sessionId === sessionId);
  }

  function setStatus(
    inv: OpenInvocation,
    status: AgentCallStatus,
    evidenceSource: EvidenceSource,
    extra: { phase?: string; allowFromUnknown?: boolean } = {},
  ): void {
    enqueue(async (storage) => {
      await storage.callLog.markStatus(inv.sessionId, inv.toolUseId, status, {
        evidenceSource,
        ...extra,
      });
      await publish(storage, inv.sessionId, inv.toolUseId);
    });
  }

  function finish(
    inv: OpenInvocation,
    status: 'ended' | 'failed',
    evidenceSource: EvidenceSource,
    phase?: string,
  ): void {
    open.delete(key(inv.sessionId, inv.toolUseId));
    enqueue(async (storage) => {
      if (phase !== undefined) {
        await storage.callLog.annotate(inv.sessionId, inv.toolUseId, { phase });
      }
      await storage.callLog.end({
        parentSessionId: inv.sessionId,
        toolUseId: inv.toolUseId,
        status,
        endedAt: new Date().toISOString(),
        evidenceSource,
      });
      await publish(storage, inv.sessionId, inv.toolUseId);
    });
  }

  function startInvocation(
    inv: OpenInvocation,
    identity: { recognized: boolean; entry?: NativeAgentRosterEntry },
    activitySummary: string | undefined,
  ): void {
    open.set(key(inv.sessionId, inv.toolUseId), inv);
    enqueue(async (storage) => {
      const call = await storage.callLog.start({
        agentName: inv.name,
        recognized: identity.recognized,
        ...(identity.entry
          ? { agentFilePath: identity.entry.filePath, sourceKind: identity.entry.kind }
          : {}),
        kind: inv.kind,
        parentSessionId: inv.sessionId,
        toolUseId: inv.toolUseId,
        ...(inv.teammateName ? { teammateName: inv.teammateName } : {}),
        ...(activitySummary ? { activitySummary } : {}),
        startedAt: new Date(inv.startedAt).toISOString(),
        evidenceSource: 'transcript',
      });
      store.broadcast({ type: 'agentCallUpdated', call: toWireCall(call) });
    });
  }

  // ── Transcript events ──────────────────────────────────────────

  function onObservation(event: ObservationEvent): void {
    switch (event.kind) {
      case 'delegateStart': {
        if (open.has(key(event.sessionId, event.toolUseId))) return;
        const cwd = event.cwd ?? undefined;
        const identity = resolveDefinition(event.subagentType, 'agent', roster(), cwd);
        startInvocation(
          {
            sessionId: event.sessionId,
            toolUseId: event.toolUseId,
            name: event.subagentType,
            kind: event.teammateName
              ? 'teammate'
              : event.runInBackground
                ? 'background'
                : 'subagent',
            ...(cwd ? { cwd } : {}),
            startedAt: Date.now(),
            ...(event.teammateName ? { teammateName: event.teammateName } : {}),
          },
          identity,
          summarizeActivity(event.description ?? event.promptHead),
        );
        return;
      }
      case 'delegateResult': {
        const inv = open.get(key(event.sessionId, event.toolUseId));
        if (event.outcome === 'completed' || event.outcome === 'error') {
          // A result for a row this process never saw open (e.g. after a
          // restart) is still evidence: end() accepts it from `unknown`.
          finish(
            inv ?? {
              sessionId: event.sessionId,
              toolUseId: event.toolUseId,
              name: '',
              kind: 'subagent',
              startedAt: Date.now(),
            },
            event.outcome === 'error' ? 'failed' : 'ended',
            'transcript',
          );
          return;
        }
        if (!inv) return;
        if (event.outcome === 'teammate') {
          inv.kind = 'teammate';
          if (event.teammateName) inv.teammateName = event.teammateName;
        } else if (inv.kind === 'subagent') {
          inv.kind = 'background';
        }
        enqueue(async (storage) => {
          await storage.callLog.annotate(inv.sessionId, inv.toolUseId, {
            kind: inv.kind,
            ...(inv.teammateName ? { teammateName: inv.teammateName } : {}),
          });
          await storage.callLog.markStatus(inv.sessionId, inv.toolUseId, 'background_running', {
            evidenceSource: 'transcript',
          });
          await publish(storage, inv.sessionId, inv.toolUseId);
        });
        return;
      }
      case 'backgroundDone': {
        const inv: OpenInvocation = open.get(key(event.sessionId, event.toolUseId)) ?? {
          sessionId: event.sessionId,
          toolUseId: event.toolUseId,
          name: '',
          kind: 'background',
          startedAt: Date.now(),
        };
        const status = event.status;
        const failed = status !== undefined && /fail|error/i.test(status);
        const plainSuccess = status === undefined || /^(completed?|success|done)$/i.test(status);
        finish(
          inv,
          failed ? 'failed' : 'ended',
          'queue_operation',
          plainSuccess ? undefined : `背景狀態：${status}`,
        );
        return;
      }
      case 'skillStart': {
        const cwd = event.cwd ?? undefined;
        const identity = resolveDefinition(event.skill, 'skill', roster(), cwd);
        // Only skills shown as agents are tracked; helper skills leave no row.
        if (!identity.recognized || !identity.entry) return;
        // One invocation per skill per session at a time: a slash command and
        // a Skill tool_use for the same skill in the same turn are one run.
        const duplicate = openIn(event.sessionId).find(
          (inv) => inv.kind === 'skill' && inv.name === event.skill,
        );
        if (duplicate) return;
        startInvocation(
          {
            sessionId: event.sessionId,
            toolUseId: event.invocationId,
            name: event.skill,
            kind: 'skill',
            ...(cwd ? { cwd } : {}),
            ...(identity.entry.projectRoot ? { projectRoot: identity.entry.projectRoot } : {}),
            startedAt: Date.now(),
            // `continue <run-id>` / `resume <run-id>` name the run outright.
            ...(runIdFromInvocationArgs(event.skill, event.args)
              ? { linkedRunId: runIdFromInvocationArgs(event.skill, event.args) }
              : {}),
          },
          identity,
          `/${event.skill}`,
        );
        return;
      }
    }
  }

  // ── Store broadcasts: permission waits, resumption, turn and session end ──

  const RESUME_TYPES = new Set([
    'agentToolStart',
    'agentToolDone',
    'agentToolPermissionClear',
    'subagentToolStart',
    'subagentToolDone',
  ]);

  function onBroadcast(message: Record<string, unknown>): void {
    const type = message['type'];
    const id = message['id'];
    if (typeof id !== 'number') return;
    const sessionId = sessionOf(id);
    if (!sessionId) return;
    const hookDelivered = store.get(id)?.hookDelivered === true;

    if (type === 'subagentToolPermission' && typeof message['parentToolId'] === 'string') {
      // Real waiting only: the heuristic 7 s timer is a guess, not evidence.
      if (!hookDelivered) return;
      const inv = open.get(key(sessionId, message['parentToolId']));
      if (inv && !inv.permissionWait) {
        inv.permissionWait = true;
        setStatus(inv, 'waiting_response', 'hook', { phase: '等待權限確認' });
      }
      return;
    }
    if (type === 'agentToolPermission') {
      if (!hookDelivered) return;
      for (const inv of openIn(sessionId)) {
        if (inv.kind === 'skill' && !inv.permissionWait) {
          inv.permissionWait = true;
          setStatus(inv, 'waiting_response', 'hook', { phase: '等待權限確認' });
        }
      }
      return;
    }
    if (
      RESUME_TYPES.has(String(type)) ||
      (type === 'agentStatus' && message['status'] === 'active')
    ) {
      for (const inv of openIn(sessionId)) {
        if (!inv.permissionWait) continue;
        const parentToolId = message['parentToolId'];
        if (typeof parentToolId === 'string' && parentToolId !== inv.toolUseId) continue;
        inv.permissionWait = false;
        setStatus(
          inv,
          inv.kind === 'teammate' || inv.kind === 'background' ? 'background_running' : 'running',
          hookDelivered ? 'hook' : 'transcript',
          { phase: '' },
        );
      }
      return;
    }
    if (type === 'agentStatus' && message['status'] === 'waiting') {
      // The session's turn ended. A skill runs inside that turn, so its
      // progress is no longer observable from the session; without a run
      // record saying "waiting" or "done", what it is doing now is unknown.
      for (const inv of openIn(sessionId)) {
        if (inv.kind !== 'skill') continue;
        inv.permissionWait = false;
        // A run record that says "waiting for your answer" explains the turn
        // end; anything else (including "in progress") does not.
        if (inv.appliedState === 'waiting_response') continue;
        inv.appliedState = undefined;
        setStatus(inv, 'unknown', 'turn_end', { phase: '回合已結束，未取得完成或等待訊號' });
      }
    }
  }

  function onAgentAdded(id: number, agent: { sessionId?: string }): void {
    if (agent.sessionId) sessionByAgentId.set(id, agent.sessionId);
  }

  function onAgentRemoved(id: number): void {
    const sessionId = sessionByAgentId.get(id);
    sessionByAgentId.delete(id);
    if (!sessionId) return;
    // Another runtime agent can share the session (a background teammate
    // shares its lead's). Only the session's last agent ending counts.
    for (const [otherId, other] of sessionByAgentId) {
      if (other === sessionId && store.get(otherId)) return;
    }
    for (const inv of openIn(sessionId)) {
      open.delete(key(inv.sessionId, inv.toolUseId));
      setStatus(inv, 'unknown', 'session_end', { phase: '工作階段已結束，未取得完成訊號' });
    }
  }

  // ── Teammate departures ────────────────────────────────────────

  function onTeammateDeparture(d: TeammateDeparture): void {
    if (d.source === 'background-complete') return; // queue-operation already ended it
    const inv =
      (d.spawnToolUseId ? open.get(key(d.leadSessionId, d.spawnToolUseId)) : undefined) ??
      openIn(d.leadSessionId).find(
        (candidate) =>
          candidate.kind === 'teammate' &&
          d.teammateName !== undefined &&
          candidate.teammateName === d.teammateName,
      );
    if (!inv) return;
    if (d.source === 'team-config') {
      finish(inv, 'ended', 'team_config');
    } else if (d.source === 'hooks') {
      finish(inv, 'ended', 'session_end');
    } else {
      open.delete(key(inv.sessionId, inv.toolUseId));
      setStatus(inv, 'unknown', 'session_end', { phase: '隊友已被新的團隊取代' });
    }
  }

  // ── Run records ────────────────────────────────────────────────

  function runFingerprint(run: RunRecord): string {
    return `${run.runId}|${run.state}|${run.phase ?? ''}|${run.updatedAt}`;
  }

  async function pollRunRecords(): Promise<void> {
    const skills = [...open.values()].filter((inv) => inv.kind === 'skill' && inv.cwd);
    if (skills.length === 0) return;
    for (const inv of skills) {
      const dirs = [inv.cwd!, ...(inv.projectRoot ? [inv.projectRoot] : [])];
      const runs = findRunRecords(inv.name, dirs);
      if (runs.length === 0) continue;
      const sameDir = skills.filter(
        (other) => other.name === inv.name && path.resolve(other.cwd!) === path.resolve(inv.cwd!),
      ).length;
      const run = correlateRun(
        {
          sessionId: inv.sessionId,
          startedAt: inv.startedAt,
          ...(inv.linkedRunId ? { linkedRunId: inv.linkedRunId } : {}),
          concurrentInvocations: sameDir,
        },
        runs,
      );
      if (!run) continue;
      const fingerprint = runFingerprint(run);
      if (inv.appliedRun === fingerprint) continue;
      inv.linkedRunId = run.runId;
      inv.appliedRun = fingerprint;
      const evidence: EvidenceSource =
        run.source === 'status-report' ? 'status_report' : 'run_record';
      if (!inv.runIdRecorded) {
        inv.runIdRecorded = true;
        enqueue(async (storage) => {
          await storage.callLog.annotate(inv.sessionId, inv.toolUseId, { runId: run.runId });
        });
      }
      // Evidence written before this invocation began belongs to an earlier
      // one (a run completed yesterday and now continued, an old question
      // round): its phase is shown, its state is not applied.
      const fresh = run.stateAt !== undefined && run.stateAt >= inv.startedAt - RUN_START_SLACK_MS;
      if (fresh && (run.state === 'completed' || run.state === 'failed')) {
        inv.appliedState = run.state;
        finish(inv, run.state === 'completed' ? 'ended' : 'failed', evidence, run.phase);
      } else if (fresh && run.state === 'waiting_response') {
        inv.appliedState = run.state;
        setStatus(inv, 'waiting_response', evidence, {
          phase: run.phase ?? '等待回答',
          allowFromUnknown: true,
        });
      } else if (
        fresh &&
        run.state === 'active' &&
        Date.now() - run.updatedAt <= RUN_ACTIVE_WINDOW_MS
      ) {
        inv.appliedState = run.state;
        setStatus(inv, 'running', evidence, {
          ...(run.phase ? { phase: run.phase } : {}),
          allowFromUnknown: true,
        });
      } else if (run.phase) {
        // A phase without fresh evidence is shown, but proves nothing about
        // whether the run is executing — status is left as it was.
        enqueue(async (storage) => {
          await storage.callLog.annotate(inv.sessionId, inv.toolUseId, { phase: run.phase });
          await publish(storage, inv.sessionId, inv.toolUseId);
        });
      }
    }
    await queue;
  }

  setObservationCallback(onObservation);
  setTeammateDepartureObserver(onTeammateDeparture);
  store.on('broadcast', onBroadcast);
  store.on('agentAdded', onAgentAdded);
  store.on('agentRemoved', onAgentRemoved);
  for (const [id, agent] of store) onAgentAdded(id, agent);

  const pollMs = options.runRecordPollMs ?? RUN_RECORD_POLL_INTERVAL_MS;
  const timer =
    pollMs > 0
      ? setInterval(() => {
          void pollRunRecords().catch((err: unknown) =>
            console.error('[Agent Office] Run record poll failed:', err),
          );
        }, pollMs)
      : null;
  timer?.unref?.();

  const bridge: CallLogBridge = {
    pollRunRecords,
    async flush() {
      // Writes can enqueue further writes; settle until the queue is stable.
      let last: Promise<unknown> | null = null;
      while (last !== queue) {
        last = queue;
        await queue;
      }
    },
    dispose() {
      if (timer) clearInterval(timer);
      setObservationCallback(null);
      setTeammateDepartureObserver(null);
      store.off('broadcast', onBroadcast);
      store.off('agentAdded', onAgentAdded);
      store.off('agentRemoved', onAgentRemoved);
      if (installed === bridge) installed = null;
    },
  };
  installed = bridge;
  return bridge;
}
