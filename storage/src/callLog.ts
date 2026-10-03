/**
 * The call log — a read-only record of observed Claude Code agent activity.
 *
 * Agent Office is an observation surface (docs/observation.md): it never
 * starts, steers or finishes an agent's work. A row here is what Office SAW
 * — a subagent delegation, a background spawn, a teammate spawn, or a skill
 * invocation — plus the evidence it had for each status change. It is not a
 * task, it has no project, and it never stores the agent's own work product.
 *
 * Identity for dedup and lookup is `(parentSessionId, toolUseId)`: the
 * Claude session id the activity was observed in, plus a stable id from the
 * transcript (the spawn/Skill tool_use id, or the slash-command record uuid).
 * Both come straight from the transcript, never invented, so a repeated or
 * late-arriving event for the same invocation is a no-op rather than a
 * duplicate row.
 *
 * Data minimization: new rows keep only an identity, a short activity
 * summary (`activitySummary`, capped by `ACTIVITY_SUMMARY_MAX`), times and
 * status. The full prompt is NOT stored. `taskText` / `taskDescription` stay
 * readable for rows written by earlier versions, and are never written now.
 */

/** ISO 8601 UTC text, exactly as SQLite stores it. */
export type Timestamp = string;

export type AgentCallStatus =
  | 'running'
  | 'waiting_response'
  | 'ended'
  | 'failed'
  /** No reliable signal says what happened: the server that was tracking it
   *  stopped, the session's turn ended without a completion signal, or a
   *  teammate left for a reason that is not evidence of completion. Never
   *  silently promoted to 'ended' — only new evidence may move it on. */
  | 'unknown'
  /** An async launch was acknowledged ("Async agent launched
   *  successfully...") and the real completion has not been observed yet. */
  | 'background_running'
  /** Legacy (written by the previous version only): an async launch whose
   *  completion that version did not track. Still readable; never written. */
  | 'background_not_tracked';

/** How the activity was invoked — not a status. */
export type AgentCallKind =
  /** A foreground `Task`/`Agent` delegation with a `subagent_type`. */
  | 'subagent'
  /** A `Task`/`Agent` delegation whose result was an async launch ack. */
  | 'background'
  /** A spawn that became a teammate (named, or an implicit-team spawn). */
  | 'teammate'
  /** A skill invocation: the `Skill` tool, or a `/name` slash command. */
  | 'skill';

/** What the CURRENT status rests on. Shown to the person, so "ended" is
 *  never mistaken for "succeeded" — a tool returning, a session ending or a
 *  lock being released are different kinds of evidence. */
export type EvidenceSource =
  /** A transcript record (tool_use / tool_result). */
  | 'transcript'
  /** A Claude Code hook event (permission prompt, turn end). */
  | 'hook'
  /** A `queue-operation` completion notification for a background spawn. */
  | 'queue_operation'
  /** The team config marked the teammate inactive / gone. */
  | 'team_config'
  /** The session (or teammate session) ended. Not a success signal. */
  | 'session_end'
  /** The turn the invocation ran in ended. Not a completion signal. */
  | 'turn_end'
  /** An agent's own pre-existing run record (e.g. a figma-ui ledger). */
  | 'run_record'
  /** The optional shared status report format (docs/observation.md). */
  | 'status_report'
  /** Office restarted while the invocation was open. */
  | 'restart';

export const ACTIVITY_SUMMARY_MAX = 120;

/** One line, at most `ACTIVITY_SUMMARY_MAX` characters. Used for every new
 *  row, so the call log never keeps a full prompt. */
export function summarizeActivity(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return undefined;
  const collapsed = firstLine.replace(/\s+/g, ' ');
  return collapsed.length > ACTIVITY_SUMMARY_MAX
    ? `${collapsed.slice(0, ACTIVITY_SUMMARY_MAX - 1)}…`
    : collapsed;
}

export interface AgentCallUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface AgentCall {
  id: string;
  /** The name the transcript used: `subagent_type`, or the skill name. */
  agentName: string;
  /** Set once the name was matched, unambiguously, to one discovered
   *  definition file. Absent for a built-in or unknown name. */
  agentFilePath?: string;
  /** True only when `agentName` matched exactly one discovered definition.
   *  A caller must never guess an identity when this is false. */
  recognized: boolean;
  /** Which kind of definition `agentFilePath` is. */
  sourceKind?: 'agent' | 'skill';
  kind: AgentCallKind;
  /** The Claude session id the activity was observed in. */
  parentSessionId: string;
  /** Stable transcript id of the invocation (tool_use id or record uuid). */
  toolUseId: string;
  /** For a teammate: its name (`name` input, or `<name>@<team>` result). */
  teammateName?: string;
  /** An agent's own run id, once a run record was linked. */
  runId?: string;
  /** Short one-line description of the activity (never the full prompt). */
  activitySummary?: string;
  /** Legacy rows only — earlier versions stored the full prompt here. */
  taskText?: string;
  /** Legacy rows only. */
  taskDescription?: string;
  status: AgentCallStatus;
  /** A verifiable phase from a run record or status report, if any. */
  phase?: string;
  /** What the current status rests on. Absent on legacy rows. */
  evidenceSource?: EvidenceSource;
  startedAt?: Timestamp;
  startUnknown: boolean;
  /** Last time any evidence about this invocation was observed. */
  lastSeenAt?: Timestamp;
  /** Set only by a confirmed end. */
  endedAt?: Timestamp;
  usage?: AgentCallUsage;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface StartAgentCallInput {
  agentName: string;
  agentFilePath?: string;
  recognized: boolean;
  sourceKind?: 'agent' | 'skill';
  kind: AgentCallKind;
  parentSessionId: string;
  toolUseId: string;
  teammateName?: string;
  activitySummary?: string;
  /** Absent when observation began mid-invocation. */
  startedAt?: Timestamp;
  evidenceSource?: EvidenceSource;
}

export interface EndAgentCallInput {
  parentSessionId: string;
  toolUseId: string;
  status: 'ended' | 'failed';
  endedAt: Timestamp;
  evidenceSource: EvidenceSource;
}

export interface MarkStatusOptions {
  evidenceSource?: EvidenceSource;
  /** Phase text to record alongside, when the evidence carries one. */
  phase?: string;
  /** Move an `unknown` row back to an open status. Only for direct new
   *  evidence (a hook, a transcript record, a run record) — never for a
   *  guess. */
  allowFromUnknown?: boolean;
}

export interface AnnotateAgentCallInput {
  kind?: AgentCallKind;
  teammateName?: string;
  runId?: string;
  phase?: string;
  lastSeenAt?: Timestamp;
}

/** Statuses that a later event may still move on. */
export const OPEN_CALL_STATUSES: readonly AgentCallStatus[] = [
  'running',
  'waiting_response',
  'background_running',
];

export interface AgentCallLogStore {
  /** Idempotent on `(parentSessionId, toolUseId)`. */
  start(input: StartAgentCallInput): Promise<AgentCall>;

  /** Change an open call's status. No-op on `ended`/`failed`, and on
   *  `unknown`/`background_not_tracked` unless `allowFromUnknown`. */
  markStatus(
    parentSessionId: string,
    toolUseId: string,
    status: AgentCallStatus,
    options?: MarkStatusOptions,
  ): Promise<void>;

  /** Record a confirmed end. A call already `ended`/`failed` keeps its
   *  original end. An `unknown` or legacy untracked call accepts it — that
   *  is new evidence, not a guess. */
  end(input: EndAgentCallInput): Promise<void>;

  /** Attach identity details learned later (teammate name, run id, phase)
   *  without touching status. */
  annotate(
    parentSessionId: string,
    toolUseId: string,
    input: AnnotateAgentCallInput,
  ): Promise<void>;

  setUsage(parentSessionId: string, toolUseId: string, usage: AgentCallUsage): Promise<void>;

  /** Newest first. */
  listRecent(limit: number, offset?: number): Promise<AgentCall[]>;

  /** Every call still in an open status, newest first. */
  listOpen(): Promise<AgentCall[]>;

  get(parentSessionId: string, toolUseId: string): Promise<AgentCall | null>;

  /** Restart safety net: every open call moves to `unknown` with evidence
   *  `restart`. Never sets `endedAt`. Returns how many rows changed. */
  markOpenCallsUnknown(): Promise<number>;
}
