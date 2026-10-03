/**
 * The Agent panel — the read-only entry point for every agent (and shown
 * skill) Office discovered, its observed activity, and the discovery
 * settings that decide where Office looks.
 *
 * Observation only: no create/edit form, no Run/Cancel/Resume/Accept. See
 * docs/observation.md for the model and its known limits.
 */

import { useEffect, useState } from 'react';

import { Button } from '../components/ui/Button.js';
import { Modal } from '../components/ui/Modal.js';
import { AGENT_STATUS_LABELS } from './agentDirectory.js';
import {
  activityText,
  agentLabel,
  CALL_KIND_LABELS,
  CALL_STATUS_LABELS,
  durationLabel,
  evidenceLabel,
  formatTimestamp,
  truncate,
} from './callLogFormat.js';
import { DiscoverySettings } from './DiscoverySettings.js';
import { useAgentDirectory } from './useAgentDirectory.js';

interface AgentPanelProps {
  isOpen: boolean;
  onClose: () => void;
  /** Opens AgentDetailPanel for one agent — the same entry point a
   *  character click uses, so a row here and a character always lead to
   *  the identical view. */
  onSelectAgent: (agentKey: string) => void;
}

const rowClass = 'border-b border-border last:border-0';
const cellClass = 'py-3 px-4 align-top text-sm';
const headClass = 'py-2 px-4 text-left text-text-muted text-xs uppercase tracking-wide';

export function AgentPanel({ isOpen, onClose, onSelectAgent }: AgentPanelProps) {
  const directory = useAgentDirectory();
  const { agents, calls, rosterLoaded, scanRoot, connectionState } = directory;
  const [expandedCallId, setExpandedCallId] = useState<string | null>(null);
  const [tab, setTab] = useState<'status' | 'discovery'>('status');
  const [now, setNow] = useState(() => Date.now());

  // Live-updating duration for any agent or call currently working — a
  // render tick only, never a per-second database write (see spec:
  // 執行時長規則).
  useEffect(() => {
    if (!isOpen) return;
    const hasOpenWork =
      agents.some((a) => a.status === 'working' || a.status === 'waiting_response') ||
      calls.some((call) => call.status === 'running' || call.status === 'background_running');
    if (!hasOpenWork) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [isOpen, agents, calls]);

  if (!isOpen) {
    return null;
  }

  const disconnected = connectionState !== 'connected';

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Agent" className="w-256 max-w-[92vw]">
      <div className="flex flex-col gap-4 max-h-[70vh] overflow-y-auto">
        <p className="text-text-muted text-sm px-4">
          Office 只觀測與顯示 Claude Code 的 Agent 與
          Skill；不啟動、不派工，也不修改它們的指示、記憶或成果。
        </p>

        <div className="flex gap-2 px-4">
          <Button
            size="sm"
            variant={tab === 'status' ? 'active' : 'default'}
            onClick={() => setTab('status')}
          >
            狀態與歷史
          </Button>
          <Button
            size="sm"
            variant={tab === 'discovery' ? 'active' : 'default'}
            onClick={() => setTab('discovery')}
          >
            探索設定
          </Button>
        </div>

        {tab === 'discovery' ? (
          <div className="px-4">
            <DiscoverySettings
              config={directory.config}
              sources={directory.sources}
              candidates={directory.candidates}
              problems={directory.problems}
              configError={directory.configError}
              onSave={directory.saveDiscoveryConfig}
            />
          </div>
        ) : (
          <>
            {disconnected && rosterLoaded && agents.length > 0 && (
              <p className="text-warning text-sm px-4">連線中斷，以下為最後已知狀態。</p>
            )}

            {disconnected && !rosterLoaded ? (
              <p className="text-warning text-sm px-4 py-6">連線中斷，尚未取得 Agent 名單。</p>
            ) : !rosterLoaded ? (
              <p className="text-text-muted text-sm px-4 py-6">讀取中…</p>
            ) : agents.length === 0 ? (
              <p className="text-text-muted text-sm px-4 py-6">
                尚未找到 Agent。使用者掃描位置：{scanRoot ?? '—'}
                。可在「探索設定」加入本機專案來源。
              </p>
            ) : (
              <>
                <section>
                  <h3 className="text-accent-bright text-lg px-4 mb-2">Agent 狀態</h3>
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className="border-b-2 border-border">
                        <th className={headClass}>名稱</th>
                        <th className={headClass}>狀態</th>
                        <th className={headClass}>目前任務</th>
                        <th className={headClass}>執行時長</th>
                      </tr>
                    </thead>
                    <tbody>
                      {agents.map((agent) => (
                        <tr
                          key={agent.key}
                          className={`${rowClass} cursor-pointer hover:bg-btn-bg`}
                          onClick={() => onSelectAgent(agent.key)}
                        >
                          <td className={cellClass}>
                            {agent.name}
                            <span className="text-text-muted text-xs">
                              {' '}
                              {agent.kind === 'skill' ? 'Skill' : 'Agent'}・
                              {agent.scope === 'project' ? '專案' : '使用者'}
                            </span>
                            {agent.ambiguous && (
                              <span className="text-warning text-xs">
                                {' '}
                                （名稱衝突，不歸屬活動）
                              </span>
                            )}
                          </td>
                          <td className={cellClass}>{AGENT_STATUS_LABELS[agent.status]}</td>
                          <td className={cellClass}>
                            {agent.status === 'idle' || !agent.currentCall ? (
                              <span className="text-text-muted">
                                目前無執行任務{!agent.everCalled && ' ・尚未呼叫'}
                              </span>
                            ) : (
                              <>
                                {truncate(activityText(agent.currentCall), 60)}
                                {agent.currentCall.phase && (
                                  <span className="text-text-muted text-xs">
                                    {' '}
                                    ・{agent.currentCall.phase}
                                  </span>
                                )}
                              </>
                            )}
                          </td>
                          <td className={cellClass}>
                            {agent.status === 'idle' || !agent.currentCall
                              ? '—'
                              : durationLabel(agent.currentCall, now)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>

                <section>
                  <h3 className="text-accent-bright text-lg px-4 mb-2 mt-4">呼叫歷史</h3>
                  {calls.length === 0 ? (
                    <p className="text-text-muted text-sm px-4 py-6">尚未觀察到任何呼叫。</p>
                  ) : (
                    <table className="w-full border-collapse">
                      <thead>
                        <tr className="border-b-2 border-border">
                          <th className={headClass}>呼叫時間</th>
                          <th className={headClass}>Agent</th>
                          <th className={headClass}>活動</th>
                          <th className={headClass}>狀態</th>
                          <th className={headClass}>執行時長</th>
                          <th className={headClass}>結束時間</th>
                        </tr>
                      </thead>
                      <tbody>
                        {calls.map((call) => {
                          const expanded = expandedCallId === call.id;
                          return (
                            <tr
                              key={call.id}
                              className={`${rowClass} cursor-pointer hover:bg-btn-bg`}
                              onClick={() => setExpandedCallId(expanded ? null : call.id)}
                            >
                              <td className={cellClass}>{formatTimestamp(call.startedAt)}</td>
                              <td className={cellClass}>{agentLabel(call)}</td>
                              <td className={cellClass}>
                                <span className="text-text-muted">
                                  {expanded ? activityText(call) : truncate(activityText(call), 60)}
                                </span>
                                {expanded && (
                                  <div className="text-xs text-text-muted mt-1">
                                    {CALL_KIND_LABELS[call.kind]}
                                    {call.phase && `・階段：${call.phase}`}
                                    {call.runId && `・執行紀錄：${call.runId}`}
                                    {evidenceLabel(call) && `・依據：${evidenceLabel(call)}`}
                                  </div>
                                )}
                              </td>
                              <td className={cellClass}>{CALL_STATUS_LABELS[call.status]}</td>
                              <td className={cellClass}>{durationLabel(call, now)}</td>
                              <td className={cellClass}>{formatTimestamp(call.endedAt)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </section>
              </>
            )}
          </>
        )}

        <div className="px-4">
          <Button size="sm" onClick={onClose}>
            關閉
          </Button>
        </div>
      </div>
    </Modal>
  );
}
