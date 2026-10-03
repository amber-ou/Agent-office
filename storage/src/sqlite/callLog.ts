/**
 * SQLite adapter for `AgentCallLogStore`. See `storage/src/callLog.ts`.
 */

import * as crypto from 'node:crypto';

import type {
  AgentCall,
  AgentCallKind,
  AgentCallLogStore,
  AgentCallStatus,
  AgentCallUsage,
  AnnotateAgentCallInput,
  EndAgentCallInput,
  EvidenceSource,
  MarkStatusOptions,
  StartAgentCallInput,
} from '../callLog.js';
import { OPEN_CALL_STATUSES } from '../callLog.js';
import type { Param, Row, SqliteDatabase } from './database.js';

/** Statuses an `end()` may never overwrite. */
const CONFIRMED_END_STATUSES: readonly AgentCallStatus[] = ['ended', 'failed'];
/** Statuses `markStatus()` leaves alone unless `allowFromUnknown`. */
const UNRESOLVED_STATUSES: readonly AgentCallStatus[] = ['unknown', 'background_not_tracked'];

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(',');
}

export class SqliteAgentCallLogStore implements AgentCallLogStore {
  constructor(private readonly db: SqliteDatabase) {}

  async start(input: StartAgentCallInput): Promise<AgentCall> {
    const existing = await this.get(input.parentSessionId, input.toolUseId);
    if (existing) {
      return existing;
    }
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO agent_calls
         (id, agent_name, agent_file_path, recognized, source_kind, kind,
          parent_session_id, tool_use_id, teammate_name, activity_summary,
          status, evidence_source, started_at, start_unknown, last_seen_at,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        input.agentName,
        input.agentFilePath ?? null,
        input.recognized ? 1 : 0,
        input.sourceKind ?? null,
        input.kind,
        input.parentSessionId,
        input.toolUseId,
        input.teammateName ?? null,
        input.activitySummary ?? null,
        input.evidenceSource ?? 'transcript',
        input.startedAt ?? null,
        input.startedAt ? 0 : 1,
        now,
        now,
        now,
      ],
    );
    const created = await this.get(input.parentSessionId, input.toolUseId);
    if (!created) {
      throw new Error('agent_calls: row vanished immediately after insert');
    }
    return created;
  }

  async markStatus(
    parentSessionId: string,
    toolUseId: string,
    status: AgentCallStatus,
    options: MarkStatusOptions = {},
  ): Promise<void> {
    const blocked: AgentCallStatus[] = [...CONFIRMED_END_STATUSES];
    if (!options.allowFromUnknown) blocked.push(...UNRESOLVED_STATUSES);
    const now = new Date().toISOString();
    const sets = ['status = ?', 'updated_at = ?', 'last_seen_at = ?'];
    const params: Param[] = [status, now, now];
    if (options.evidenceSource) {
      sets.push('evidence_source = ?');
      params.push(options.evidenceSource);
    }
    if (options.phase !== undefined) {
      sets.push('phase = ?');
      params.push(options.phase);
    }
    this.db.run(
      `UPDATE agent_calls SET ${sets.join(', ')}
        WHERE parent_session_id = ? AND tool_use_id = ?
          AND status NOT IN (${placeholders(blocked)})`,
      [...params, parentSessionId, toolUseId, ...blocked],
    );
  }

  async end(input: EndAgentCallInput): Promise<void> {
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE agent_calls
          SET status = ?, ended_at = ?, evidence_source = ?, updated_at = ?, last_seen_at = ?
        WHERE parent_session_id = ? AND tool_use_id = ?
          AND status NOT IN (${placeholders(CONFIRMED_END_STATUSES)})`,
      [
        input.status,
        input.endedAt,
        input.evidenceSource,
        now,
        now,
        input.parentSessionId,
        input.toolUseId,
        ...CONFIRMED_END_STATUSES,
      ],
    );
  }

  async annotate(
    parentSessionId: string,
    toolUseId: string,
    input: AnnotateAgentCallInput,
  ): Promise<void> {
    const sets: string[] = [];
    const params: Param[] = [];
    const add = (column: string, value: string | undefined): void => {
      if (value === undefined) return;
      sets.push(`${column} = ?`);
      params.push(value);
    };
    add('kind', input.kind);
    add('teammate_name', input.teammateName);
    add('run_id', input.runId);
    add('phase', input.phase);
    add('last_seen_at', input.lastSeenAt);
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    params.push(new Date().toISOString());
    this.db.run(
      `UPDATE agent_calls SET ${sets.join(', ')} WHERE parent_session_id = ? AND tool_use_id = ?`,
      [...params, parentSessionId, toolUseId],
    );
  }

  async setUsage(parentSessionId: string, toolUseId: string, usage: AgentCallUsage): Promise<void> {
    this.db.run(
      `UPDATE agent_calls SET
         usage_input_tokens = ?, usage_output_tokens = ?,
         usage_cache_creation_tokens = ?, usage_cache_read_tokens = ?,
         updated_at = ?
       WHERE parent_session_id = ? AND tool_use_id = ?`,
      [
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheCreationTokens,
        usage.cacheReadTokens,
        new Date().toISOString(),
        parentSessionId,
        toolUseId,
      ],
    );
  }

  async listRecent(limit: number, offset = 0): Promise<AgentCall[]> {
    return this.db
      .all(
        `SELECT * FROM agent_calls
          ORDER BY COALESCE(started_at, created_at) DESC, id DESC
          LIMIT ? OFFSET ?`,
        [limit, offset],
      )
      .map(toAgentCall);
  }

  async listOpen(): Promise<AgentCall[]> {
    return this.db
      .all(
        `SELECT * FROM agent_calls WHERE status IN (${placeholders(OPEN_CALL_STATUSES)})
          ORDER BY COALESCE(started_at, created_at) DESC, id DESC`,
        [...OPEN_CALL_STATUSES],
      )
      .map(toAgentCall);
  }

  async get(parentSessionId: string, toolUseId: string): Promise<AgentCall | null> {
    const row = this.db.get(
      'SELECT * FROM agent_calls WHERE parent_session_id = ? AND tool_use_id = ?',
      [parentSessionId, toolUseId],
    );
    return row ? toAgentCall(row) : null;
  }

  async markOpenCallsUnknown(): Promise<number> {
    return this.db.run(
      `UPDATE agent_calls SET status = 'unknown', evidence_source = 'restart', updated_at = ?
        WHERE status IN (${placeholders(OPEN_CALL_STATUSES)})`,
      [new Date().toISOString(), ...OPEN_CALL_STATUSES],
    );
  }
}

function optional<K extends string>(key: K, value: Row[string]): Partial<Record<K, string>> {
  return value === null || value === undefined
    ? {}
    : ({ [key]: String(value) } as Record<K, string>);
}

function toAgentCall(row: Row): AgentCall {
  const usage =
    row['usage_input_tokens'] === null
      ? undefined
      : {
          inputTokens: Number(row['usage_input_tokens']),
          outputTokens: Number(row['usage_output_tokens'] ?? 0),
          cacheCreationTokens: Number(row['usage_cache_creation_tokens'] ?? 0),
          cacheReadTokens: Number(row['usage_cache_read_tokens'] ?? 0),
        };
  const sourceKind = row['source_kind'];
  return {
    id: String(row['id']),
    agentName: String(row['agent_name']),
    ...optional('agentFilePath', row['agent_file_path']),
    recognized: Number(row['recognized']) === 1,
    ...(sourceKind === 'agent' || sourceKind === 'skill' ? { sourceKind } : {}),
    kind: String(row['kind'] ?? 'subagent') as AgentCallKind,
    parentSessionId: String(row['parent_session_id']),
    toolUseId: String(row['tool_use_id']),
    ...optional('teammateName', row['teammate_name']),
    ...optional('runId', row['run_id']),
    ...optional('activitySummary', row['activity_summary']),
    ...optional('taskText', row['task_text']),
    ...optional('taskDescription', row['task_description']),
    status: String(row['status']) as AgentCallStatus,
    ...optional('phase', row['phase']),
    ...(row['evidence_source'] === null || row['evidence_source'] === undefined
      ? {}
      : { evidenceSource: String(row['evidence_source']) as EvidenceSource }),
    ...optional('startedAt', row['started_at']),
    startUnknown: Number(row['start_unknown']) === 1,
    ...optional('lastSeenAt', row['last_seen_at']),
    ...optional('endedAt', row['ended_at']),
    ...(usage ? { usage } : {}),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}
