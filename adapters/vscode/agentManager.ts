import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import type { StateAdapter } from '../../core/src/adapter.js';
import { resendAgentActivity } from '../../server/src/agentActivityResend.js';
import { AgentStateStore } from '../../server/src/agentStateStore.js';
import { DEFAULT_MAX_CONTEXT_TOKENS, JSONL_POLL_INTERVAL_MS } from '../../server/src/constants.js';
import { ensureProjectScan, startFileWatching } from '../../server/src/fileWatcher.js';
import { loadLayout } from '../../server/src/layoutPersistence.js';
import { assignPaletteIfNeeded } from '../../server/src/paletteAssigner.js';
import { claudeProvider } from '../../server/src/providers/index.js';
import { cancelPermissionTimer, cancelWaitingTimer } from '../../server/src/timerManager.js';
import type { AgentState, PersistedAgent } from '../../server/src/types.js';

export function getProjectDirPath(cwd?: string): string {
  // Fall back to home directory when no workspace folder is open (common on Linux/macOS
  // when VS Code is launched without a folder). The provider's getSessionDirs already
  // implements the Windows case-insensitive fallback for drive-letter casing.
  const workspacePath = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
  const dirs = claudeProvider.getSessionDirs?.(workspacePath) ?? [];
  if (dirs.length === 0) {
    throw new Error('claudeProvider.getSessionDirs returned no directories');
  }
  const projectDir = dirs[0];
  console.log(`[Pixel Agents] Terminal: Project dir: ${workspacePath} → ${projectDir}`);
  return projectDir;
}

export function removeAgent(
  agentId: number,
  store: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
): void {
  const agent = store.get(agentId);
  if (!agent) return;

  // Stop JSONL poll timer
  const jpTimer = jsonlPollTimers.get(agentId);
  if (jpTimer) {
    clearInterval(jpTimer);
  }
  jsonlPollTimers.delete(agentId);

  // Stop file watching
  fileWatchers.get(agentId)?.close();
  fileWatchers.delete(agentId);
  const pt = pollingTimers.get(agentId);
  if (pt) {
    clearInterval(pt);
  }
  pollingTimers.delete(agentId);

  // Cancel timers
  cancelWaitingTimer(agentId, waitingTimers);
  cancelPermissionTimer(agentId, permissionTimers);

  // Remove from store (fires agentRemoved event) and persist
  store.delete(agentId);
  store.persist();
}

/**
 * Reference implementation of the AgentState → PersistedAgent projection: it shows
 * exactly which fields survive a reload. Kept as the worked example for adapters that
 * persist through a StateAdapter directly; AgentStateStore.persist() is what the
 * VS Code surface calls at runtime.
 *
 * @public
 */
export function persistAgents(agents: AgentStateStore, adapter: StateAdapter): void {
  const persisted: PersistedAgent[] = [];
  for (const agent of agents.values()) {
    // Background-spawn children are derived state — never persisted (the 1s
    // scan re-materializes them from sidecars after a restore).
    if (agent.spawnToolUseId) continue;
    persisted.push({
      id: agent.id,
      sessionId: agent.sessionId,
      terminalName: agent.terminalRef?.name ?? '',
      isExternal: agent.isExternal || undefined,
      jsonlFile: agent.jsonlFile,
      projectDir: agent.projectDir,
      folderName: agent.folderName,
      teamName: agent.teamName,
      agentName: agent.agentName,
      isTeamLead: agent.isTeamLead,
      leadAgentId: agent.leadAgentId,
      teamUsesTmux: agent.teamUsesTmux,
      backgroundAgentToolIds:
        agent.backgroundAgentToolIds.size > 0 ? [...agent.backgroundAgentToolIds] : undefined,
    });
  }
  adapter.saveAgents(persisted);
}

export function restoreAgents(
  adapter: StateAdapter,
  nextAgentIdRef: { current: number },
  nextTerminalIndexRef: { current: number },
  store: AgentStateStore,
  knownJsonlFiles: Set<string>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
  projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
  activeAgentIdRef: { current: number | null },
): void {
  const persisted = adapter.loadAgents();
  if (persisted.length === 0) return;

  const liveTerminals = vscode.window.terminals;
  let maxId = 0;
  let maxIdx = 0;
  let restoredProjectDir: string | null = null;

  // IDs of agents we ACTUALLY restored in this call (newly added to the store).
  // The cleanup pass below targets only these; pre-existing agents (e.g., a
  // freshly launched one whose webview just remounted and re-fired
  // webviewReady) must not be culled by this restore-time grace period, since
  // their JSONL may still be on its way (heuristic /resume path waits ~11s).
  const justRestoredTerminalIds: number[] = [];

  for (const p of persisted) {
    // Skip agents already in the map — prevents duplicate file watchers on re-entry
    // (webviewReady fires on every panel focus, re-calling restoreAgents each time)
    if (store.has(p.id)) {
      knownJsonlFiles.add(p.jsonlFile);
      continue;
    }

    // Background-spawn children (a leadAgentId but no teamName) are derived
    // state re-materialized by the 1s scan — never restored directly (also
    // skips stale entries written by older builds that persisted them).
    if (p.leadAgentId !== undefined && !p.teamName) continue;

    let terminal: vscode.Terminal | undefined;
    const isExternal = p.isExternal ?? false;

    if (isExternal) {
      // External agents — restore if JSONL file still exists on disk
      try {
        if (!fs.existsSync(p.jsonlFile)) continue;
      } catch {
        continue;
      }
    } else {
      // Terminal agents — find matching terminal by name
      terminal = liveTerminals.find((t) => t.name === p.terminalName);
      if (!terminal) continue;
    }

    const agent: AgentState = {
      id: p.id,
      sessionId: p.sessionId || path.basename(p.jsonlFile, '.jsonl'),
      terminalRef: terminal,
      isExternal,
      projectDir: p.projectDir,
      jsonlFile: p.jsonlFile,
      fileOffset: 0,
      lineBuffer: '',
      activeToolIds: new Set(),
      activeToolStatuses: new Map(),
      activeToolNames: new Map(),
      activeSubagentToolIds: new Map(),
      activeSubagentToolNames: new Map(),
      // Live spawn ids survive the reload so the 1s scan can re-adopt the
      // spawns' transcripts and the completion queue-op still matches.
      backgroundAgentToolIds: new Set(p.backgroundAgentToolIds ?? []),
      isWaiting: false,
      permissionSent: false,
      hadToolsInTurn: false,
      lastDataAt: 0,
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      folderName: p.folderName,
      hookDelivered: false,
      contextTokens: 0,
      maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
      teamName: p.teamName,
      agentName: p.agentName,
      // A named agent is a teammate; never restore it as a lead (guards against
      // state persisted before linkTeammates stopped promoting teammates).
      isTeamLead: p.agentName ? undefined : p.isTeamLead,
      leadAgentId: p.leadAgentId,
      teamUsesTmux: p.teamUsesTmux,
      palette: p.palette,
      hueShift: p.hueShift,
    };

    assignPaletteIfNeeded(agent, store);
    store.set(p.id, agent);
    knownJsonlFiles.add(p.jsonlFile);
    if (isExternal) {
      console.log(
        `[Pixel Agents] Terminal: Agent ${p.id} - restored external → ${path.basename(p.jsonlFile)}`,
      );
    } else {
      console.log(
        `[Pixel Agents] Terminal: Agent ${p.id} - restored → terminal "${p.terminalName}"`,
      );
      justRestoredTerminalIds.push(p.id);
    }

    if (p.id > maxId) maxId = p.id;
    // Extract terminal index from name like "Claude Code #3"
    const match = p.terminalName.match(/#(\d+)$/);
    if (match) {
      const idx = parseInt(match[1], 10);
      if (idx > maxIdx) maxIdx = idx;
    }

    restoredProjectDir = p.projectDir;

    // Start file watching if JSONL exists, skipping to end of file
    try {
      if (fs.existsSync(p.jsonlFile)) {
        const stat = fs.statSync(p.jsonlFile);
        agent.fileOffset = stat.size;
        startFileWatching(
          p.id,
          p.jsonlFile,
          store,
          fileWatchers,
          pollingTimers,
          waitingTimers,
          permissionTimers,
        );
      } else {
        // Poll for the file to appear
        const pollTimer = setInterval(() => {
          try {
            if (fs.existsSync(agent.jsonlFile)) {
              console.log(`[Pixel Agents] Terminal: Agent ${p.id} - found JSONL file`);
              clearInterval(pollTimer);
              jsonlPollTimers.delete(p.id);
              const stat = fs.statSync(agent.jsonlFile);
              agent.fileOffset = stat.size;
              startFileWatching(
                p.id,
                agent.jsonlFile,
                store,
                fileWatchers,
                pollingTimers,
                waitingTimers,
                permissionTimers,
              );
            }
          } catch {
            /* file may not exist yet */
          }
        }, JSONL_POLL_INTERVAL_MS);
        jsonlPollTimers.set(p.id, pollTimer);
      }
    } catch {
      /* ignore errors during restore */
    }
  }

  // After a short delay, remove terminal agents that we JUST restored from
  // workspaceState and which never received data. These are dead terminals
  // restored by VS Code (e.g., after a window reload) where Claude is no
  // longer running. Only target the IDs the loop above actually added — never
  // pre-existing agents from launchNewTerminal in the same session whose
  // expected JSONL may still be on its way (heuristic /resume waits ~11s).
  if (justRestoredTerminalIds.length > 0) {
    setTimeout(() => {
      for (const id of justRestoredTerminalIds) {
        const agent = store.get(id);
        if (agent && !agent.isExternal && agent.linesProcessed === 0) {
          console.log(
            `[Pixel Agents] Terminal: Agent ${id} - removing restored agent, no data received`,
          );
          agent.terminalRef?.dispose();
          removeAgent(
            id,
            store,
            fileWatchers,
            pollingTimers,
            waitingTimers,
            permissionTimers,
            jsonlPollTimers,
          );
        }
      }
    }, 10_000); // 10 seconds grace period
  }

  // Advance counters past restored IDs
  if (maxId >= nextAgentIdRef.current) {
    nextAgentIdRef.current = maxId + 1;
  }
  if (maxIdx >= nextTerminalIndexRef.current) {
    nextTerminalIndexRef.current = maxIdx + 1;
  }

  // Re-persist cleaned-up list (removes entries whose terminals are gone)
  store.persist();

  // Start project scan for /clear detection
  if (restoredProjectDir) {
    ensureProjectScan(
      restoredProjectDir,
      knownJsonlFiles,
      projectScanTimerRef,
      activeAgentIdRef,
      nextAgentIdRef,
      store,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      () => store.persist(),
    );
  }
}

export function sendExistingAgents(
  agents: AgentStateStore,
  adapter: StateAdapter,
  webview: vscode.Webview | undefined,
): void {
  if (!webview) return;
  const agentIds: number[] = [];
  for (const id of agents.keys()) {
    agentIds.push(id);
  }
  agentIds.sort((a, b) => a - b);

  // Include persisted palette/seatId from separate key
  const agentMeta = adapter.loadSeats();

  // Include folderName and isExternal per agent
  const folderNames: Record<number, string> = {};
  const externalAgents: Record<number, boolean> = {};
  for (const [id, agent] of agents) {
    if (agent.folderName) {
      folderNames[id] = agent.folderName;
    }
    if (agent.isExternal) {
      externalAgents[id] = true;
    }
  }
  console.log(
    `[Pixel Agents] sendExistingAgents: agents=${JSON.stringify(agentIds)}, meta=${JSON.stringify(agentMeta)}`,
  );

  webview.postMessage({
    type: 'existingAgents',
    agents: agentIds,
    agentMeta,
    folderNames,
    externalAgents,
  });
  // Note: sendCurrentAgentStatuses is called separately AFTER layoutLoaded
  // so that agentStatus/agentToolStart messages arrive after characters are created.
}

export function sendCurrentAgentStatuses(
  agents: AgentStateStore,
  webview: vscode.Webview | undefined,
): void {
  if (!webview) return;
  resendAgentActivity((msg) => webview.postMessage(msg), agents);
}

export function sendLayout(
  webview: vscode.Webview | undefined,
  defaultLayout?: Record<string, unknown> | null,
): void {
  if (!webview) return;
  const result = loadLayout(defaultLayout);
  webview.postMessage({
    type: 'layoutLoaded',
    layout: result?.layout ?? null,
    wasReset: result?.wasReset ?? false,
  });
}
