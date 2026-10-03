/**
 * Discovery settings — which local sources Office READS to find Claude Code
 * agents and skills, and which skills to show as agents.
 *
 * These are Office's own settings (`~/.agent-office/discovery.json`). They
 * never create, edit or register an agent: adding a project root only makes
 * Office look at that project's `.claude/agents` and `.claude/skills`.
 */

import { useState } from 'react';

import type {
  DiscoveryConfig,
  DiscoveryProblem,
  DiscoverySource,
  NativeAgentRosterEntry,
} from '../../../core/src/messages.js';
import { Button } from '../components/ui/Button.js';
import { Checkbox } from '../components/ui/Checkbox.js';

interface DiscoverySettingsProps {
  config: DiscoveryConfig | undefined;
  sources: DiscoverySource[];
  candidates: NativeAgentRosterEntry[];
  problems: DiscoveryProblem[];
  configError: string | undefined;
  onSave: (config: DiscoveryConfig) => void;
}

const muted = 'text-text-muted text-sm';
const SOURCE_KIND_LABEL = { agent: 'Agents', skill: 'Skills' } as const;
const SCOPE_LABEL = { user: '使用者', project: '專案' } as const;

/** Absolute on POSIX (`/…`) or Windows (`C:\…`, `\\server\…`). */
function looksAbsolute(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

export function DiscoverySettings({
  config,
  sources,
  candidates,
  problems,
  configError,
  onSave,
}: DiscoverySettingsProps) {
  const [newRoot, setNewRoot] = useState('');
  const [newPattern, setNewPattern] = useState('');
  const [inputError, setInputError] = useState<string | null>(null);

  if (!config) {
    return <p className={muted}>讀取探索設定中…</p>;
  }

  const save = (next: Partial<DiscoveryConfig>) => onSave({ ...config, ...next });

  const addRoot = () => {
    const value = newRoot.trim();
    if (!value) return;
    if (!looksAbsolute(value)) {
      setInputError('請輸入完整路徑，例如 C:\\Users\\me\\Projects\\design');
      return;
    }
    setInputError(null);
    setNewRoot('');
    if (!config.projectRoots.includes(value))
      save({ projectRoots: [...config.projectRoots, value] });
  };

  const addPattern = (pattern: string) => {
    const value = pattern.trim();
    if (!value || config.skillInclude.includes(value)) return;
    save({ skillInclude: [...config.skillInclude, value] });
  };

  return (
    <div className="flex flex-col gap-4 text-sm">
      <p className={muted}>
        這些設定只決定 Office 讀取哪些本機位置，不會建立或修改任何
        Agent。來源目錄不存在時顯示「未找到」，Office 不會替你建立。
      </p>

      <div className="border border-border">
        <Checkbox
          label="掃描使用者 Agents（~/.claude/agents）"
          checked={config.includeUserAgents}
          onChange={() => save({ includeUserAgents: !config.includeUserAgents })}
        />
        <Checkbox
          label="掃描使用者 Skills（~/.claude/skills）"
          checked={config.includeUserSkills}
          onChange={() => save({ includeUserSkills: !config.includeUserSkills })}
        />
      </div>

      <section>
        <h4 className="text-accent-bright text-base mb-2">本機專案來源</h4>
        {config.projectRoots.length === 0 ? (
          <p className={muted}>
            尚未設定。加入專案根目錄後，會讀取其中的 .claude/agents 與 .claude/skills。
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {config.projectRoots.map((root) => (
              <li
                key={root}
                className="flex items-center justify-between gap-4 border border-border px-4 py-1"
              >
                <span className="break-all">{root}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    save({ projectRoots: config.projectRoots.filter((r) => r !== root) })
                  }
                >
                  移除
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-2 mt-2">
          <input
            className="flex-1 bg-bg-dark border-2 border-border rounded-none px-4 py-1 text-text"
            placeholder="專案根目錄的完整路徑"
            value={newRoot}
            onChange={(e) => setNewRoot(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addRoot()}
          />
          <Button size="sm" onClick={addRoot}>
            加入
          </Button>
        </div>
        {inputError && <p className="text-warning text-sm mt-1">{inputError}</p>}
      </section>

      <section>
        <h4 className="text-accent-bright text-base mb-2">顯示為 Agent 的 Skills</h4>
        <p className={muted}>
          Skill 多半是輔助工具，只有列在這裡的名稱才會成為人物（可用 * 萬用字元）。
        </p>
        <ul className="flex flex-wrap gap-2 mt-2">
          {config.skillInclude.map((pattern) => (
            <li key={pattern} className="flex items-center gap-2 border border-border px-4 py-1">
              <span>{pattern}</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  save({ skillInclude: config.skillInclude.filter((p) => p !== pattern) })
                }
              >
                ×
              </Button>
            </li>
          ))}
        </ul>
        <div className="flex gap-2 mt-2">
          <input
            className="flex-1 bg-bg-dark border-2 border-border rounded-none px-4 py-1 text-text"
            placeholder="Skill 名稱，例如 figma-ui"
            value={newPattern}
            onChange={(e) => setNewPattern(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                addPattern(newPattern);
                setNewPattern('');
              }
            }}
          />
          <Button
            size="sm"
            onClick={() => {
              addPattern(newPattern);
              setNewPattern('');
            }}
          >
            加入
          </Button>
        </div>
        {candidates.length > 0 && (
          <div className="mt-2">
            <p className={muted}>已找到但未顯示的 Skills：</p>
            <ul className="flex flex-wrap gap-2 mt-1">
              {candidates.map((skill) => (
                <li key={skill.filePath}>
                  <Button size="sm" title={skill.filePath} onClick={() => addPattern(skill.name)}>
                    + {skill.name}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section>
        <h4 className="text-accent-bright text-base mb-2">掃描位置</h4>
        <ul className="flex flex-col gap-1">
          {sources.map((source) => (
            <li key={`${source.kind}:${source.root}`} className="flex justify-between gap-4">
              <span className="break-all">
                {SCOPE_LABEL[source.scope]} {SOURCE_KIND_LABEL[source.kind]}：{source.root}
              </span>
              <span className={source.exists ? 'text-text' : 'text-warning'}>
                {source.exists ? '已找到' : '未找到'}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {problems.length > 0 && (
        <section>
          <h4 className="text-warning text-base mb-2">無法辨識的定義</h4>
          <ul className="flex flex-col gap-1">
            {problems.map((problem) => (
              <li key={`${problem.filePath}:${problem.reason}`} className="break-all">
                {problem.filePath}：<span className={muted}>{problem.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {configError && <p className="text-warning">設定未儲存：{configError}</p>}
    </div>
  );
}
