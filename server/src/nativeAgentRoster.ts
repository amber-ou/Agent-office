/**
 * The agent roster: what Office shows as persistent, idle-capable
 * characters. GitHub agent repositories (`<owner>/<repoPrefix>*`, see
 * githubRoster.ts) merged with Claude Code's own local definition files
 * (storage/src/files/nativeAgentDiscovery.ts) — no registration step, no
 * Office-side agent record, nothing written outside ~/.agent-office.
 */

import * as path from 'node:path';

import type {
  DefinitionKind,
  DiscoveryResult,
  MergedRoster,
  NativeAgentRosterEntry,
  RosterIdentity,
} from '../../storage/src/index.js';
import { discoverDefinitions, mergeRoster } from '../../storage/src/index.js';
import type { AgentStateStore } from './agentStateStore.js';
import { loadDiscoveryConfig } from './control/discoveryConfig.js';
import { getClaudeHome } from './control/observationStorage.js';
import type { GithubSyncStatus } from './githubRoster.js';
import {
  getGithubRepos,
  getGithubStatus,
  GITHUB_SYNC_INTERVAL_MS,
  syncGithubRoster,
} from './githubRoster.js';

/** Rescan cadence. Polling (not fs.watch) because a source directory that
 *  does not exist yet must be noticed when it appears, and watching it would
 *  mean creating it — which Office must never do. */
export const ROSTER_POLL_INTERVAL_MS = 3000;

export interface NativeAgentRosterSnapshot extends Omit<DiscoveryResult, 'agents' | 'candidates'> {
  agents: NativeAgentRosterEntry[];
  candidates: NativeAgentRosterEntry[];
  /** User-level agents directory — named when nothing was found. */
  root: string;
  config: ReturnType<typeof loadDiscoveryConfig>;
  github: GithubSyncStatus;
  resolve: MergedRoster['resolve'];
}

export function scanNativeAgentRosterSnapshot(): NativeAgentRosterSnapshot {
  const claudeHome = getClaudeHome();
  const config = loadDiscoveryConfig();
  const local = discoverDefinitions(claudeHome, config);
  const merged = mergeRoster(local, getGithubRepos(config.github), config.github.repoPrefix);
  return {
    sources: local.sources,
    agents: merged.agents,
    candidates: merged.candidates,
    problems: merged.problems,
    resolve: merged.resolve,
    root: path.join(claudeHome, 'agents'),
    config,
    github: getGithubStatus(config.github),
  };
}

/** Map an observed name to one roster entry (see agentRoster.ts). */
export function resolveRosterIdentity(
  name: string,
  kind: DefinitionKind,
  cwd: string | undefined,
): RosterIdentity {
  return scanNativeAgentRosterSnapshot().resolve(name, kind, cwd);
}

export function rosterMessage(snapshot: NativeAgentRosterSnapshot): Record<string, unknown> {
  return {
    type: 'nativeAgentRoster',
    agents: snapshot.agents,
    candidates: snapshot.candidates,
    sources: snapshot.sources,
    problems: snapshot.problems,
    config: snapshot.config,
    github: snapshot.github,
    root: snapshot.root,
  };
}

let lastFingerprint = '';

export function broadcastNativeAgentRoster(store: AgentStateStore): NativeAgentRosterEntry[] {
  const snapshot = scanNativeAgentRosterSnapshot();
  lastFingerprint = JSON.stringify(rosterMessage(snapshot));
  store.broadcast(rosterMessage(snapshot));
  return snapshot.agents;
}

/** Sync the GitHub listing now, then re-broadcast the roster. */
export async function syncGithubAndBroadcast(store: AgentStateStore): Promise<void> {
  await syncGithubRoster(loadDiscoveryConfig().github);
  broadcastNativeAgentRoster(store);
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let githubTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Re-broadcast the roster whenever any source changes, so a new agent
 * appears without a reload, a config edit, or an Office code change. The
 * GitHub listing refreshes on its own, slower cadence.
 */
export function watchNativeAgentRoster(
  store: AgentStateStore,
  options: { githubSync?: boolean } = {},
): () => void {
  stopWatchingNativeAgentRoster();
  pollTimer = setInterval(() => {
    let message: Record<string, unknown>;
    try {
      message = rosterMessage(scanNativeAgentRosterSnapshot());
    } catch (error) {
      console.warn('[Agent Office] Roster scan failed:', error);
      return;
    }
    const fingerprint = JSON.stringify(message);
    if (fingerprint !== lastFingerprint) {
      lastFingerprint = fingerprint;
      store.broadcast(message);
    }
  }, ROSTER_POLL_INTERVAL_MS);
  pollTimer.unref?.();
  if (options.githubSync !== false) {
    void syncGithubAndBroadcast(store);
    githubTimer = setInterval(() => void syncGithubAndBroadcast(store), GITHUB_SYNC_INTERVAL_MS);
    githubTimer.unref?.();
  }
  return stopWatchingNativeAgentRoster;
}

export function stopWatchingNativeAgentRoster(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (githubTimer) {
    clearInterval(githubTimer);
    githubTimer = null;
  }
}
