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
 * The figma-ui field names below are read tolerantly (several spellings),
 * because the ledger schema at the skill's baseline commit could not be
 * inspected from here; see docs/observation.md for the open item.
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

const COMPLETED = /^(completed?|done|finished|success(ful)?|succeeded|accepted)$/i;
const FAILED = /^(failed|failure|error|errored|aborted|cancell?ed)$/i;
const WAITING =
  /^(waiting|awaiting|awaiting[-_ ]?(answers?|input|user|response)|needs[-_ ]?input|question(s)?[-_ ]?pending|blocked[-_ ]?on[-_ ]?user)$/i;
const ACTIVE = /^(running|active|in[-_ ]?progress|working|started)$/i;

function stateFromText(text: string | undefined): RunState | undefined {
  if (!text) return undefined;
  if (COMPLETED.test(text)) return 'completed';
  if (FAILED.test(text)) return 'failed';
  if (WAITING.test(text)) return 'waiting_response';
  if (ACTIVE.test(text)) return 'active';
  return undefined;
}

/** A question round is open when it has no recorded answer and is not
 *  explicitly closed. Unrecognized shapes count as "not evidence". */
function hasOpenQuestionRound(ledger: Json): boolean | undefined {
  const rounds = pick(ledger, 'questionRounds', 'question_rounds', 'questions');
  if (!Array.isArray(rounds) || rounds.length === 0) return undefined;
  const last = asObject(rounds[rounds.length - 1]);
  if (!last) return undefined;
  const status = str(pick(last, 'status', 'state'));
  if (status) {
    if (/^(open|pending|asked|awaiting([-_ ]?answers?)?|waiting)$/i.test(status)) return true;
    if (/^(answered|closed|resolved|done|complete(d)?)$/i.test(status)) return false;
  }
  if (typeof last['answered'] === 'boolean') return !last['answered'];
  const answers = pick(last, 'answers', 'answer', 'responses');
  if (Array.isArray(answers)) return answers.length === 0;
  if (answers !== undefined) return !str(answers) && !asObject(answers);
  if (pick(last, 'answeredAt', 'answered_at') !== undefined) return false;
  return undefined;
}

/** The explicit completion verdict, when the ledger states one. */
function completionVerdict(ledger: Json): RunState | undefined {
  for (const key of ['completed', 'complete', 'done', 'isComplete']) {
    if (ledger[key] === true) return 'completed';
  }
  const verdict = asObject(pick(ledger, 'completion', 'verdict', 'result', 'outcome'));
  if (verdict) {
    if (
      verdict['complete'] === true ||
      verdict['completed'] === true ||
      verdict['passed'] === true
    ) {
      return 'completed';
    }
    const text = stateFromText(str(pick(verdict, 'status', 'state', 'verdict')));
    if (text === 'completed' || text === 'failed') return text;
  } else {
    const text = stateFromText(str(pick(ledger, 'completion', 'verdict', 'result', 'outcome')));
    if (text === 'completed' || text === 'failed') return text;
  }
  return undefined;
}

export function parseFigmaLedger(json: Json, filePath: string, stat: fs.Stats): RunRecord {
  const stateObj = asObject(json['state']);
  const statusText = str(pick(json, 'status')) ?? str(pick(stateObj, 'status'));
  const phase =
    str(pick(json, 'phase', 'currentPhase', 'current_phase')) ??
    str(pick(stateObj, 'phase')) ??
    str(pick(asObject(json['status']), 'phase'));
  let state: RunState = completionVerdict(json) ?? stateFromText(statusText) ?? 'unknown';
  if (state === 'active' || state === 'unknown') {
    const open = hasOpenQuestionRound(json);
    if (open === true) state = 'waiting_response';
  }
  return {
    source: 'figma-ui-ledger',
    runId: str(pick(json, 'runId', 'run_id', 'id')) ?? path.basename(path.dirname(filePath)),
    filePath,
    ...(str(pick(json, 'sessionId', 'session_id', 'claudeSessionId'))
      ? { sessionId: str(pick(json, 'sessionId', 'session_id', 'claudeSessionId')) }
      : {}),
    state,
    ...(phase ? { phase } : {}),
    createdAt:
      time(pick(json, 'createdAt', 'created_at', 'startedAt', 'started_at')) ??
      (stat.birthtimeMs > 0 ? stat.birthtimeMs : undefined),
    updatedAt: time(pick(json, 'updatedAt', 'updated_at', 'lastUpdated')) ?? stat.mtimeMs,
  };
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
