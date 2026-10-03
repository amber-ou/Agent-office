/**
 * Discovery settings — where Office READS its agent list: the GitHub agent
 * repositories (`<owner>/<prefix>*`), plus local Claude Code definitions.
 *
 * These are Office's own settings (`~/.agent-office/discovery.json`, and the
 * GitHub token in `~/.agent-office/github-token`). They never create, edit
 * or register an agent, and Office never writes to GitHub.
 */

import { useState } from 'react';

import type {
  DiscoveryConfig,
  DiscoveryProblem,
  DiscoverySource,
  GithubSyncStatus,
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
  /** False when this page has no permission to change settings. */
  canEdit: boolean | undefined;
  /** An older Office server is serving this page: no GitHub roster there. */
  serverOutdated: boolean;
  github: GithubSyncStatus | undefined;
  onSave: (config: DiscoveryConfig) => void;
  onSetGithubToken: (token: string) => void;
  onSyncGithub: () => void;
}

const muted = 'text-text-muted text-agent-body';
const SOURCE_KIND_LABEL = { agent: 'Agents', skill: 'Skills' } as const;
const SCOPE_LABEL = { user: '使用者', project: '專案', github: 'GitHub' } as const;
const inputClass = 'flex-1 bg-bg-dark border-2 border-border rounded-none px-4 py-1 text-text';

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
  canEdit,
  serverOutdated,
  github,
  onSave,
  onSetGithubToken,
  onSyncGithub,
}: DiscoverySettingsProps) {
  const [newRoot, setNewRoot] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [newExclude, setNewExclude] = useState('');
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

  const saveGithub = (next: Partial<DiscoveryConfig['github']>) =>
    save({ github: { ...config.github, ...next } });

  const addPattern = (pattern: string) => {
    const value = pattern.trim();
    if (!value || config.skillInclude.includes(value)) return;
    save({ skillInclude: [...config.skillInclude, value] });
  };

  const readOnly = canEdit === false;
  const githubStatus = !config.github.enabled
    ? '已停用'
    : github?.error
      ? `同步失敗：${github.error}`
      : github?.lastSyncAt
        ? `已同步 ${github.repoCount} 個 repo（${new Date(github.lastSyncAt).toLocaleString()}）`
        : '尚未同步';

  return (
    <div className="flex flex-col gap-4 text-agent-body">
      {serverOutdated && (
        <p className="text-warning border-2 border-warning px-4 py-2" role="alert">
          執行中的 Office 伺服器是舊版本（更新前就開著的 Agent Office 視窗），所以沒有 GitHub
          名單設定。請關閉所有 Agent Office 視窗，再執行 agent-office.cmd，開新印出的網址。
        </p>
      )}
      {readOnly && (
        <p className="text-warning border-2 border-warning px-4 py-2" role="alert">
          此頁面只能檢視，無法修改設定。請關閉這個分頁，改開 Office 視窗中顯示的最新網址（
          <code>http://127.0.0.1:…/?token=…</code>）。Office 每次重新啟動後，舊分頁都會失效。
        </p>
      )}
      {configError && (
        <p className="text-warning" role="alert">
          設定未儲存：{configError}
        </p>
      )}
      <p className={muted}>
        這些設定只決定 Office 從哪裡讀取 Agent 名單，不會建立或修改任何 Agent，也不會寫入
        GitHub。來源目錄不存在時顯示「未找到」，Office 不會替你建立。
      </p>

      <fieldset
        disabled={readOnly}
        className="m-0 p-0 border-0 min-w-0 flex flex-col gap-4 disabled:opacity-60"
      >
        {!serverOutdated && (
          <section>
            <h4 className="text-accent-bright text-agent-heading mb-2">GitHub Agent 名單</h4>
            <p className={muted}>
              帳號下名稱以前綴開頭的 repo，每個都是一個 Agent。repo 裡的 .claude
              定義檔決定呼叫名稱；沒有定義檔時，用 repo 名稱去掉前綴、轉小寫（Agent-skill-Retriever
              → skill-retriever）。
            </p>
            <div className="border border-border mt-2">
              <Checkbox
                label="從 GitHub 讀取 Agent 名單"
                checked={config.github.enabled}
                onChange={() => saveGithub({ enabled: !config.github.enabled })}
              />
            </div>
            <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 mt-2 items-center">
              <span className={muted}>帳號</span>
              <input
                className={inputClass}
                placeholder={
                  github?.owner
                    ? `（token 所屬帳號：${github.owner}）`
                    : 'GitHub 帳號，例如 amber-ou'
                }
                key={`owner:${config.github.owner}`}
                defaultValue={config.github.owner}
                onBlur={(e) => {
                  if (e.target.value.trim() !== config.github.owner)
                    saveGithub({ owner: e.target.value.trim() });
                }}
              />
              <span className={muted}>repo 前綴</span>
              <input
                className={inputClass}
                key={`prefix:${config.github.repoPrefix}`}
                defaultValue={config.github.repoPrefix}
                onBlur={(e) => {
                  if (e.target.value.trim() !== config.github.repoPrefix)
                    saveGithub({ repoPrefix: e.target.value.trim() });
                }}
              />
            </div>
            <p className={`${muted} mt-2`}>排除的 repo：</p>
            <ul className="flex flex-wrap gap-2 mt-1">
              {config.github.exclude.map((name) => (
                <li key={name} className="flex items-center gap-2 border border-border px-4 py-1">
                  <span>{name}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      saveGithub({ exclude: config.github.exclude.filter((n) => n !== name) })
                    }
                  >
                    ×
                  </Button>
                </li>
              ))}
            </ul>
            <div className="flex gap-2 mt-2">
              <input
                className={inputClass}
                placeholder="repo 名稱，例如 Agent-office"
                value={newExclude}
                onChange={(e) => setNewExclude(e.target.value)}
              />
              <Button
                size="sm"
                onClick={() => {
                  const value = newExclude.trim();
                  setNewExclude('');
                  if (value && !config.github.exclude.includes(value))
                    saveGithub({ exclude: [...config.github.exclude, value] });
                }}
              >
                排除
              </Button>
            </div>

            <p className={`${muted} mt-3`}>
              GitHub token（唯讀即可，用於列出私人 repo）：
              {github?.tokenSet ? (github.tokenFromEnv ? '已由環境變數設定' : '已設定') : '未設定'}
            </p>
            <div className="flex gap-2 mt-1">
              <input
                className={inputClass}
                type="password"
                autoComplete="off"
                placeholder={github?.tokenSet ? '輸入新 token 以取代' : '貼上 GitHub token'}
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
              />
              <Button
                size="sm"
                onClick={() => {
                  if (!tokenInput.trim()) return;
                  onSetGithubToken(tokenInput.trim());
                  setTokenInput('');
                }}
              >
                儲存
              </Button>
              {github?.tokenSet && !github.tokenFromEnv && (
                <Button size="sm" variant="ghost" onClick={() => onSetGithubToken('')}>
                  清除
                </Button>
              )}
            </div>
            <div className="flex items-center justify-between gap-4 mt-2">
              <span className={config.github.enabled && github?.error ? 'text-warning' : muted}>
                {githubStatus}
              </span>
              <Button size="sm" disabled={!config.github.enabled} onClick={onSyncGithub}>
                立即同步
              </Button>
            </div>
          </section>
        )}

        <h4 className="text-accent-bright text-agent-heading">本機定義</h4>
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
          <h4 className="text-accent-bright text-agent-heading mb-2">本機專案來源</h4>
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
              className={inputClass}
              placeholder="專案根目錄的完整路徑"
              value={newRoot}
              onChange={(e) => setNewRoot(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addRoot()}
            />
            <Button size="sm" onClick={addRoot}>
              加入
            </Button>
          </div>
          {inputError && <p className="text-warning text-agent-body mt-1">{inputError}</p>}
        </section>

        <section>
          <h4 className="text-accent-bright text-agent-heading mb-2">本機 Skills 篩選</h4>
          <p className={muted}>
            只影響不在 GitHub 名單中的本機
            skill：多半是輔助工具，只有列在這裡的名稱才會成為人物（可用 * 萬用字元）。GitHub
            名單中的 Agent 不受此限制。
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
      </fieldset>

      <section>
        <h4 className="text-accent-bright text-agent-heading mb-2">掃描位置</h4>
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
          <h4 className="text-warning text-agent-heading mb-2">無法辨識的定義</h4>
          <ul className="flex flex-col gap-1">
            {problems.map((problem) => (
              <li key={`${problem.filePath}:${problem.reason}`} className="break-all">
                {problem.filePath}：<span className={muted}>{problem.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
