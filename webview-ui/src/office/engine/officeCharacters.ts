import type {
  AgentCallLogEntry,
  NativeAgentRosterEntry,
  ServerMessage,
} from '../../../../core/src/messages.js';
import { AGENT_STATUS_LABELS, deriveAgentState } from '../../control/agentDirectory.js';
import { getLoadedCharacterCount } from '../sprites/spriteData.js';
import type { OfficeState } from './officeState.js';

export const OFFICE_CHARACTER_LABELS = AGENT_STATUS_LABELS;

/** Calls whose runtime character (Subtask / teammate) the resident stands in for. */
const LINKABLE_STATUSES: ReadonlySet<AgentCallLogEntry['status']> = new Set([
  'running',
  'waiting_response',
  'background_running',
]);

function hashId(value: string): number {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

/**
 * Persistent resident characters, one per discovered definition (agents,
 * plus the skills the discovery settings show) — see docs/observation.md.
 * Claude Code is the sole authority on which agents exist; Office only
 * observes.
 *
 * Status comes from `deriveAgentState` (`control/agentDirectory.ts`), the
 * same function the Agent panel and detail view call, so the three can
 * never disagree. An unrecognized call never creates or activates a
 * character. Creating or idling a character never launches a model.
 *
 * Dedup: while a recognized call is open, the transient runtime character
 * for the SAME invocation — the Subtask sub-character keyed by the spawn's
 * tool_use id, or the teammate character with the call's teammate name
 * under the same lead session — is hidden, so one piece of work is one
 * character (the resident). It reappears if the link goes away.
 */
export class OfficeCharacters {
  private roster: NativeAgentRosterEntry[] = [];
  /** agentFilePath -> (callId -> call). */
  private readonly callsByAgent = new Map<string, Map<string, AgentCallLogEntry>>();
  /** agentFilePath -> stable negative character id. */
  private readonly ids = new Map<string, number>();
  /** Runtime agent id -> Claude session id (from agentCreated / existingAgents). */
  private readonly sessionByAgentId = new Map<number, string>();
  /** Runtime characters this class currently hides. */
  private readonly suppressed = new Set<number>();

  receive(message: ServerMessage): void {
    if (message.type === 'nativeAgentRoster') {
      this.roster = message.agents;
    } else if (message.type === 'agentCallLogSnapshot') {
      this.callsByAgent.clear();
      for (const call of message.calls) this.applyCall(call);
    } else if (message.type === 'agentCallUpdated') {
      this.applyCall(message.call);
    } else if (message.type === 'agentCreated') {
      if (message.sessionId) this.sessionByAgentId.set(message.id, message.sessionId);
    } else if (message.type === 'existingAgents') {
      for (const [id, meta] of Object.entries(message.agentMeta ?? {})) {
        const sessionId = (meta as { sessionId?: string } | undefined)?.sessionId;
        if (sessionId) this.sessionByAgentId.set(Number(id), sessionId);
      }
    } else if (message.type === 'agentClosed') {
      this.sessionByAgentId.delete(message.id);
    }
  }

  private applyCall(call: AgentCallLogEntry): void {
    if (!call.recognized || !call.agentFilePath) return;
    const calls = this.callsByAgent.get(call.agentFilePath) ?? new Map<string, AgentCallLogEntry>();
    calls.set(call.id, call);
    this.callsByAgent.set(call.agentFilePath, calls);
  }

  /** A runtime agent belongs to the call's session — or the session is not
   *  known yet (older server), in which case the globally unique tool_use
   *  id alone links a Subtask. */
  private sameSession(agentId: number, sessionId: string): boolean {
    const known = this.sessionByAgentId.get(agentId);
    return known === undefined || known === sessionId;
  }

  /** Runtime characters standing for an open recognized call of a resident. */
  private linkedRuntimeCharacters(os: OfficeState, residentPaths: Set<string>): Set<number> {
    const linked = new Set<number>();
    for (const [filePath, calls] of this.callsByAgent) {
      if (!residentPaths.has(filePath)) continue;
      for (const call of calls.values()) {
        if (!LINKABLE_STATUSES.has(call.status)) continue;
        for (const [subId, meta] of os.subagentMeta) {
          if (
            meta.parentToolId === call.toolUseId &&
            this.sameSession(meta.parentAgentId, call.parentSessionId)
          ) {
            linked.add(subId);
          }
        }
        if (call.teammateName) {
          for (const ch of os.characters.values()) {
            if (
              ch.leadAgentId !== undefined &&
              ch.agentName === call.teammateName &&
              this.sessionByAgentId.get(ch.leadAgentId) === call.parentSessionId
            ) {
              linked.add(ch.id);
            }
          }
        }
      }
    }
    return linked;
  }

  sync(os: OfficeState, layoutReady: boolean): number[] {
    if (!layoutReady) return [];
    const wanted = new Set(this.roster.map((agent) => agent.filePath));
    for (const ch of [...os.characters.values()]) {
      if (ch.officeAgentId && !wanted.has(ch.officeAgentId)) {
        os.removeAgent(ch.id);
        os.characters.delete(ch.id);
      }
    }
    const result: number[] = [];
    for (const agent of [...this.roster].sort((a, b) => a.filePath.localeCompare(b.filePath))) {
      let id = this.ids.get(agent.filePath);
      if (id === undefined) {
        // Separate from positive runtime ids, small negative subagents and greeter.
        id = -10_000_000_000 - hashId(agent.filePath);
        while ([...this.ids.values()].includes(id) || os.characters.has(id)) id--;
        this.ids.set(agent.filePath, id);
      }
      const palette = hashId(agent.filePath) % Math.max(1, getLoadedCharacterCount());
      os.addAgent(id, palette, 0);
      const ch = os.characters.get(id)!;
      ch.officeAgentId = agent.filePath;
      ch.agentName = agent.name;
      const calls = [...(this.callsByAgent.get(agent.filePath)?.values() ?? [])];
      const { status, currentCall } = deriveAgentState(calls);
      ch.officeStatus = status;
      ch.officeDetail =
        status === 'idle' ? undefined : (currentCall?.phase ?? currentCall?.activitySummary);
      // 'unknown' never plays the working animation: Office does not
      // actually know the agent is still busy.
      const active = status === 'working' || status === 'waiting_response';
      if (ch.isActive !== active) os.setAgentActive(id, active);
      os.setAgentTool(id, null);
      ch.bubbleType = status === 'waiting_response' ? 'permission' : null;
      result.push(id);
    }

    const linked = this.linkedRuntimeCharacters(os, wanted);
    for (const id of this.suppressed) {
      if (!linked.has(id)) {
        os.setOfficeSuppressed(id, false);
        this.suppressed.delete(id);
      }
    }
    for (const id of linked) {
      if (!this.suppressed.has(id) && os.characters.has(id)) {
        os.setOfficeSuppressed(id, true);
        this.suppressed.add(id);
      }
    }
    return result;
  }
}
