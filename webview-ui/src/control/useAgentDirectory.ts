/**
 * Read-only Agent Office observation state in the webview.
 *
 * Subscribes to `nativeAgentRoster` (what discovery found: agents, shown
 * skills, candidate skills, sources, problems, settings), the observed call
 * log (`agentCallLogSnapshot` / `agentCallUpdated`), and the transport's
 * connection state. The only commands are `requestCallLog` and
 * `setDiscoveryConfig` / `setGithubToken` / `syncGithub` — these change
 * where Office READS its agent list; nothing here creates, edits or
 * dispatches an agent.
 *
 * `agents` (per-agent status) is derived once here via
 * `computeAgentSummaries`, so a character, the full list and a single
 * agent's detail can never disagree.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  AgentCallLogEntry,
  DiscoveryConfig,
  DiscoveryProblem,
  DiscoverySource,
  GithubSyncStatus,
  NativeAgentRosterEntry,
} from '../../../core/src/messages.js';
import { transport } from '../transport/index.js';
import type { TransportState } from '../transport/types.js';
import type { AgentSummary } from './agentDirectory.js';
import { computeAgentSummaries } from './agentDirectory.js';

interface RawState {
  roster: NativeAgentRosterEntry[];
  candidates: NativeAgentRosterEntry[];
  sources: DiscoverySource[];
  problems: DiscoveryProblem[];
  config: DiscoveryConfig | undefined;
  github: GithubSyncStatus | undefined;
  calls: AgentCallLogEntry[];
  /** True once a roster message arrived — "loading" vs "confirmed none". */
  rosterLoaded: boolean;
  /** The user-level agents directory, from the most recent roster message. */
  scanRoot: string | undefined;
  /** Last setDiscoveryConfig outcome, for the settings form. */
  configError: string | undefined;
  /** Whether this connection may change discovery settings (undefined
   *  until the server says). Standalone needs the CURRENT server token in
   *  the page URL; an old tab from before a restart cannot edit. */
  canEdit: boolean | undefined;
}

export interface AgentDirectoryView extends RawState {
  agents: AgentSummary[];
  connectionState: TransportState;
  saveDiscoveryConfig: (config: DiscoveryConfig) => void;
  setGithubToken: (token: string) => void;
  syncGithub: () => void;
}

const EMPTY_RAW: RawState = {
  roster: [],
  candidates: [],
  sources: [],
  problems: [],
  config: undefined,
  github: undefined,
  calls: [],
  rosterLoaded: false,
  scanRoot: undefined,
  configError: undefined,
  canEdit: undefined,
};

export function useAgentDirectory(): AgentDirectoryView {
  const [raw, setRaw] = useState<RawState>(EMPTY_RAW);
  const [connectionState, setConnectionState] = useState<TransportState>(transport.state);

  useEffect(() => {
    setConnectionState(transport.state);
    let previous = transport.state;
    return transport.onStateChange((state) => {
      setConnectionState(state);
      // Back after a drop (e.g. Office restarted): ask again, so the roster,
      // call log and edit access describe the server we reconnected to.
      if (state === 'connected' && previous === 'reconnecting') {
        transport.send({ type: 'requestCallLog' });
      }
      previous = state;
    });
  }, []);

  useEffect(() => {
    const unsubscribe = transport.onMessage((message) => {
      if (message.type === 'nativeAgentRoster') {
        setRaw((current) => ({
          ...current,
          roster: message.agents,
          candidates: message.candidates,
          sources: message.sources,
          problems: message.problems,
          config: message.config,
          github: message.github,
          rosterLoaded: true,
          scanRoot: message.root,
        }));
      } else if (message.type === 'observationAccess') {
        setRaw((current) => ({ ...current, canEdit: message.canEdit }));
      } else if (message.type === 'discoveryConfigResult') {
        setRaw((current) => ({
          ...current,
          configError: message.ok ? undefined : (message.error ?? '設定未儲存'),
          ...(message.config ? { config: message.config } : {}),
        }));
      } else if (message.type === 'agentCallLogSnapshot') {
        setRaw((current) => ({ ...current, calls: message.calls }));
      } else if (message.type === 'agentCallUpdated') {
        setRaw((current) => {
          const index = current.calls.findIndex((call) => call.id === message.call.id);
          const calls =
            index === -1
              ? [message.call, ...current.calls]
              : current.calls.map((call, i) => (i === index ? message.call : call));
          return { ...current, calls };
        });
      }
    });
    // The server pushes both on the ready handshake; this covers a panel
    // opened later (a reconnect is handled by the state listener above).
    transport.send({ type: 'requestCallLog' });
    return unsubscribe;
  }, []);

  const saveDiscoveryConfig = useCallback((config: DiscoveryConfig) => {
    transport.send({ type: 'setDiscoveryConfig', config });
  }, []);

  const setGithubToken = useCallback((token: string) => {
    transport.send({ type: 'setGithubToken', token });
  }, []);

  const syncGithub = useCallback(() => {
    transport.send({ type: 'syncGithub' });
  }, []);

  const agents = useMemo(
    () => computeAgentSummaries(raw.roster, raw.calls),
    [raw.roster, raw.calls],
  );

  return { ...raw, agents, connectionState, saveDiscoveryConfig, setGithubToken, syncGithub };
}
