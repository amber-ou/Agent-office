/**
 * Read-only access to run records an agent ALREADY keeps, so Office can show
 * a verifiable phase or a waiting/completed state without the agent adding
 * any Office-specific code (docs/observation.md §Run records).
 *
 * Two readers:
 *
 *   figma-ui ledger   `<dir>/design-runs/<run-id>/ledger.json`, written by the
 *                     figma-ui skill's own state store.
 *   status report     `<dir>/.agent-status/<run-id>.json` — an OPTIONAL shared
 *                     format any agent may write; nothing requires it.
 *
 * Rules this file keeps:
 *  - Read only. No write, no lock, no `.figma-ui/active-run.json` (that file
 *    belongs to the skill's write lock and is not evidence of a whole run).
 *  - A field this reader does not recognize is "unknown", never a guess.
 *  - A record existing is not evidence the run is executing: `active` only
 *    counts together with a recent update (see `RUN_ACTIVE_WINDOW_MS`).
 *
 * The figma-ui reader follows `schemas/ledger.schema.json` and
 * `scripts/run-report.mjs` of amber-ou/Agent-Figma-UI-agent at 69ad2f8 (spec
 * v1.6): `phase`, `status` (in_progress | complete |
 * complete_with_exceptions | awaiting_user | blocked | partial, written by
 * evaluate-completion.mjs together with `completionEvaluatedAt`),
 * `questionRounds[{askedAt, answeredAt|null}]`, `phaseHistory`, `updatedAt`.
 * The ledger carries no Claude session id.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export type RunState = 'active' | 'waiting_response' | 'completed' | 'failed' | 'unknown';

export interface RunRecord {
  source: 'figma-ui-ledger' | 'status-report';
  runId: string;
  filePath: string;
  /** The agent/skill name the record declares (status reports). */
  agent?: string;
  /** A Claude session id, when the record carries one. */
  sessionId?: string;
  state: RunState;
  phase?: string;
  /** ms since epoch. */
  createdAt?: number;
  updatedAt: number;
  /** When the evidence for `state` was written (ms). Evidence older than the
   *  invocation it is matched to belongs to an earlier invocation and is not
   *  applied (e.g. a run completed yesterday, now continued). */
  stateAt?: number;
}

/** An `active` record older than this is not taken as "still running". */
export const RUN_ACTIVE_WINDOW_MS = 10 * 60 * 1000;
/** A run created this long before the invocation was observed may still be
 *  the invocation's own (clock skew, observation lag). */
export const RUN_START_SLACK_MS = 2 * 60 * 1000;
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const MAX_RUN_DIRS = 200;

type Json = Record<string, unknown>;

function readJson(filePath: string): { json: Json; stat: fs.Stats } | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) return null;
    const json: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return json && typeof json === 'object' && !Array.isArray(json)
      ? { json: json as Json, stat }
      : null;
  } catch {
    return null;
  }
}

function pick(obj: Json | undefined, ...keys: string[]): unknown {
  if (!obj) return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function time(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

function asObject(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
}

/** figma-ui phases (common.schema.json `phase`), with a short label. */
const FIGMA_PHASE_LABELS: Record<string, string> = {
  intake: '需求確認',
  preflight: '前置檢查',
  discover: '探索',
  plan: '規劃',
  build: '建置',
  validate: '驗證',
  handoff: '交付',
  reconcile: '對帳',
};

/** Evaluation results that are not a completion (status stays observed only). */
const FIGMA_UNRESOLVED_STATUS_LABELS: Record<string, string> = {
  blocked: '評估：受阻',
  partial: '評估：部分完成',
};

export function parseFigmaLedger(json: Json, filePath: string, stat: fs.Stats): RunRecord {
  const rawPhase = str(json['phase']);
  const status = str(json['status']);
  const updatedAt = time(json['updatedAt']) ?? stat.mtimeMs;
  const evaluatedAt = time(json['completionEvaluatedAt']);
  const rounds = Array.isArray(json['questionRounds']) ? json['questionRounds'] : [];
  const openRound = [...rounds]
    .reverse()
    .map(asObject)
    .find(
      (r) =>
        r &&
        (r['answeredAt'] === null || r['answeredAt'] === undefined) &&
        time(r['askedAt']) !== undefined,
    );
  const history = Array.isArray(json['phaseHistory']) ? json['phaseHistory'] : [];
  const firstPhaseAt = time(asObject(history[0])?.['enteredAt']);

  let state: RunState = 'unknown';
  let stateAt: number | undefined;
  if ((status === 'complete' || status === 'complete_with_exceptions') && evaluatedAt) {
    // Only evaluate-completion.mjs writes these, together with the time.
    state = 'completed';
    stateAt = evaluatedAt;
  } else if (openRound) {
    state = 'waiting_response';
    stateAt = time(openRound['askedAt']);
  } else if (status === 'awaiting_user') {
    state = 'waiting_response';
    stateAt = evaluatedAt ?? updatedAt;
  } else if (status === 'in_progress') {
    state = 'active';
    stateAt = updatedAt;
  }

  const phaseParts: string[] = [];
  if (rawPhase) phaseParts.push(`${FIGMA_PHASE_LABELS[rawPhase] ?? rawPhase}（${rawPhase}）`);
  if (status && FIGMA_UNRESOLVED_STATUS_LABELS[status]) {
    phaseParts.push(FIGMA_UNRESOLVED_STATUS_LABELS[status]!);
  }
  if (status === 'complete_with_exceptions') phaseParts.push('完成（含例外）');

  return {
    source: 'figma-ui-ledger',
    runId: str(json['runId']) ?? path.basename(path.dirname(filePath)),
    filePath,
    state,
    ...(phaseParts.length ? { phase: phaseParts.join('・') } : {}),
    createdAt: firstPhaseAt ?? (stat.birthtimeMs > 0 ? stat.birthtimeMs : undefined),
    updatedAt,
    ...(stateAt !== undefined ? { stateAt } : {}),
  };
}

/** `/figma-ui continue <run-id> …` and `/figma-ui resume <run-id>` name their
 *  run outright (state-store.mjs parseInvocation) — the strongest link there
 *  is. The arguments are used in memory only, never stored. */
export function runIdFromInvocationArgs(
  skill: string,
  args: string | undefined,
): string | undefined {
  if (skill !== 'figma-ui' || !args) return undefined;
  const match = args.trim().match(/^(continue|resume)\s+([A-Za-z0-9][A-Za-z0-9._-]{0,63})\b/i);
  return match?.[2];
}

export function readFigmaLedgers(dir: string): RunRecord[] {
  const runsDir = path.join(dir, 'design-runs');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: RunRecord[] = [];
  for (const entry of entries.slice(0, MAX_RUN_DIRS)) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(runsDir, entry.name, 'ledger.json');
    const read = readJson(filePath);
    if (read) out.push(parseFigmaLedger(read.json, filePath, read.stat));
  }
  return out;
}

export function parseStatusReport(json: Json, filePath: string, stat: fs.Stats): RunRecord | null {
  const agent = str(pick(json, 'agent', 'skill', 'name'));
  if (!agent) return null;
  const statusText = str(pick(json, 'status'));
  const state: RunState =
    statusText === 'running'
      ? 'active'
      : statusText === 'waiting_response'
        ? 'waiting_response'
        : statusText === 'ended'
          ? 'completed'
          : statusText === 'failed'
            ? 'failed'
            : 'unknown';
  const phase = str(pick(json, 'phase'));
  const sessionId = str(pick(json, 'sessionId'));
  return {
    source: 'status-report',
    runId: str(pick(json, 'runId')) ?? path.basename(filePath, '.json'),
    filePath,
    agent,
    ...(sessionId ? { sessionId } : {}),
    state,
    ...(phase ? { phase } : {}),
    createdAt: time(pick(json, 'startedAt')),
    updatedAt: time(pick(json, 'updatedAt')) ?? stat.mtimeMs,
    stateAt: time(pick(json, 'updatedAt')) ?? stat.mtimeMs,
  };
}

export function readStatusReports(dir: string): RunRecord[] {
  const reportsDir = path.join(dir, '.agent-status');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(reportsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: RunRecord[] = [];
  for (const entry of entries.slice(0, MAX_RUN_DIRS)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(reportsDir, entry.name);
    const read = readJson(filePath);
    const record = read ? parseStatusReport(read.json, filePath, read.stat) : null;
    if (record) out.push(record);
  }
  return out;
}

/** Every run record for `name` found in `dirs`. figma-ui ledgers belong to
 *  the `figma-ui` skill only; status reports name their own agent. */
export function findRunRecords(name: string, dirs: readonly string[]): RunRecord[] {
  const out: RunRecord[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const key = path.resolve(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    if (name === 'figma-ui') out.push(...readFigmaLedgers(dir));
    out.push(...readStatusReports(dir).filter((r) => r.agent === name));
  }
  return out;
}

export interface CorrelationInput {
  sessionId: string;
  /** When the invocation was observed (ms). */
  startedAt: number;
  /** A run id already linked to this invocation. */
  linkedRunId?: string;
  /** How many open invocations of the same name share these directories —
   *  a time-based link is only made when this is exactly one. */
  concurrentInvocations: number;
}

/**
 * Link an invocation to at most one run record. Strongest evidence first:
 * an existing link, then a record naming this session, then — only when
 * exactly one invocation and exactly one record are candidates — a record
 * created after the invocation started. Anything else is "no link".
 */
export function correlateRun(
  input: CorrelationInput,
  runs: readonly RunRecord[],
): RunRecord | undefined {
  if (input.linkedRunId) {
    return runs.find((r) => r.runId === input.linkedRunId);
  }
  const bySession = runs
    .filter((r) => r.sessionId === input.sessionId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (bySession.length > 0) return bySession[0];
  if (input.concurrentInvocations !== 1) return undefined;
  const afterStart = runs.filter(
    (r) => !r.sessionId && (r.createdAt ?? r.updatedAt) >= input.startedAt - RUN_START_SLACK_MS,
  );
  return afterStart.length === 1 ? afterStart[0] : undefined;
}
