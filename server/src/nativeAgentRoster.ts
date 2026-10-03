/**
 * The discovered roster: what Office shows as persistent, idle-capable
 * characters. Read straight from Claude Code's own definition files in the
 * configured sources (see storage/src/files/nativeAgentDiscovery.ts) — no
 * registration step, no Office-side agent record, nothing written.
 */

import * as path from 'node:path';

import type { DiscoveryResult, NativeAgentRosterEntry } from '../../storage/src/index.js';
import { discoverDefinitions } from '../../storage/src/index.js';
import type { AgentStateStore } from './agentStateStore.js';
import { loadDiscoveryConfig } from './control/discoveryConfig.js';
import { getClaudeHome } from './control/observationStorage.js';

/** Rescan cadence. Polling (not fs.watch) because a source directory that
 *  does not exist yet must be noticed when it appears, and watching it would
 *  mean creating it — which Office must never do. */
export const ROSTER_POLL_INTERVAL_MS = 3000;

export interface NativeAgentRosterSnapshot extends DiscoveryResult {
  /** User-level agents directory — named when nothing was found. */
  root: string;
  config: ReturnType<typeof loadDiscoveryConfig>;
}

export function scanNativeAgentRosterSnapshot(): NativeAgentRosterSnapshot {
  const claudeHome = getClaudeHome();
  const config = loadDiscoveryConfig();
  return {
    ...discoverDefinitions(claudeHome, config),
    root: path.join(claudeHome, 'agents'),
    config,
  };
}

/** Shown definitions only — what identity resolution matches against. */
export function scanNativeAgentRoster(): NativeAgentRosterEntry[] {
  return scanNativeAgentRosterSnapshot().agents;
}

export function rosterMessage(snapshot: NativeAgentRosterSnapshot): Record<string, unknown> {
  return {
    type: 'nativeAgentRoster',
    agents: snapshot.agents,
    candidates: snapshot.candidates,
    sources: snapshot.sources,
    problems: snapshot.problems,
    config: snapshot.config,
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

let pollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Re-broadcast the roster whenever any source changes, so a new agent or
 * skill appears without a reload, a config edit, or an Office code change.
 */
export function watchNativeAgentRoster(store: AgentStateStore): () => void {
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
  return stopWatchingNativeAgentRoster;
}

export function stopWatchingNativeAgentRoster(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
