/**
 * Display formatting shared by `AgentPanel.tsx` and `AgentDetailPanel.tsx` —
 * kept in one place so a call's status, duration and identity read the same
 * way in both the full list and a single agent's detail.
 */

import type {
  AgentCallKind,
  AgentCallLogEntry,
  AgentCallStatus,
  EvidenceSource,
} from '../../../core/src/messages.js';

export const CALL_STATUS_LABELS: Record<AgentCallStatus, string> = {
  running: '執行中',
  waiting_response: '等待回應',
  ended: '已結束',
  failed: '失敗',
  unknown: '狀態未知',
  background_running: '背景執行中',
  background_not_tracked: '背景委派（舊版未追蹤結果）',
};

export const CALL_KIND_LABELS: Record<AgentCallKind, string> = {
  subagent: '子 Agent',
  background: '背景子 Agent',
  teammate: '隊友',
  skill: 'Skill',
};

/** What a status rests on — shown so "已結束" is never read as "成功". */
export const EVIDENCE_LABELS: Record<EvidenceSource, string> = {
  transcript: '對話紀錄',
  hook: 'Claude hook 事件',
  queue_operation: '背景完成通知',
  team_config: '團隊設定（隊友已離開）',
  session_end: '工作階段結束',
  turn_end: '回合結束（未含完成訊號）',
  run_record: 'Agent 自身的執行紀錄',
  status_report: '共用狀態回報',
  restart: 'Office 重新啟動',
};

/** The short activity line: new rows carry `activitySummary`; legacy rows
 *  only had the description or the full prompt. */
export function activityText(call: AgentCallLogEntry): string {
  return call.activitySummary ?? call.taskDescription ?? call.taskText ?? '（無描述）';
}

export function evidenceLabel(call: AgentCallLogEntry): string | undefined {
  return call.evidenceSource ? EVIDENCE_LABELS[call.evidenceSource] : undefined;
}

export function formatTimestamp(iso: string | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}時${String(minutes).padStart(2, '0')}分`;
  if (minutes > 0) return `${minutes}分${String(seconds).padStart(2, '0')}秒`;
  return `${seconds}秒`;
}

/** Live for a running call (ticks against `now`); fixed once a call ends.
 *  Never claims a duration when the start time itself is unknown, and never
 *  computes one against "now" for a call whose real end isn't observed. */
export function durationLabel(call: AgentCallLogEntry, now: number): string {
  if (call.status === 'background_not_tracked') return '未追蹤（背景委派）';
  if (call.status === 'unknown' && call.startedAt && !call.startUnknown) {
    return `未知（最後觀測 ${formatTimestamp(call.lastSeenAt ?? call.updatedAt)}）`;
  }
  if (call.startUnknown || !call.startedAt) {
    return call.status === 'unknown' ? '未知' : '開始時間未知';
  }
  const start = new Date(call.startedAt).getTime();
  const end = call.endedAt ? new Date(call.endedAt).getTime() : now;
  return formatDuration(end - start);
}

export function agentLabel(call: AgentCallLogEntry): string {
  const name = call.teammateName ? `${call.agentName}（${call.teammateName}）` : call.agentName;
  return call.recognized ? name : `未辨識 Agent（${name}）`;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
