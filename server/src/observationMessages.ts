/**
 * Agent Office observation messages, shared by both surfaces (standalone
 * `clientMessageHandler.ts` and the VS Code provider) so neither can drift.
 *
 *   requestCallLog       → nativeAgentRoster + agentCallLogSnapshot (read-only)
 *   setDiscoveryConfig   → saves Office's own discovery settings, then
 *                          re-broadcasts the roster. Privileged only: it
 *                          decides which local directories Office reads.
 */

import type { AgentStateStore } from './agentStateStore.js';
import { normalizeDiscoveryConfig, saveDiscoveryConfig } from './control/discoveryConfig.js';
import { getOfficeStorage } from './control/observationStorage.js';
import {
  broadcastNativeAgentRoster,
  rosterMessage,
  scanNativeAgentRosterSnapshot,
} from './nativeAgentRoster.js';

type Send = (message: Record<string, unknown>) => void;

/** How many recent calls a snapshot carries. */
export const CALL_LOG_SNAPSHOT_LIMIT = 200;

/** Roster + recent call log for one client. The call log is an empty list
 *  (not an error) when storage is unavailable — the office still renders. */
export function sendObservationSnapshot(send: Send): void {
  send(rosterMessage(scanNativeAgentRosterSnapshot()));
  const storage = getOfficeStorage();
  if (!storage) {
    send({ type: 'agentCallLogSnapshot', calls: [] });
    return;
  }
  void storage.callLog
    .listRecent(CALL_LOG_SNAPSHOT_LIMIT)
    .then((calls) => send({ type: 'agentCallLogSnapshot', calls }))
    .catch((err: unknown) => {
      console.error('[Agent Office] Call log: failed to load snapshot:', err);
      send({ type: 'agentCallLogSnapshot', calls: [] });
    });
}

export function handleSetDiscoveryConfig(
  msg: Record<string, unknown>,
  send: Send,
  store: AgentStateStore,
  privileged: boolean,
): void {
  if (!privileged) {
    send({
      type: 'discoveryConfigResult',
      ok: false,
      error: 'not authorized: changing discovery sources requires the server token',
    });
    return;
  }
  try {
    const saved = saveDiscoveryConfig(normalizeDiscoveryConfig(msg['config']));
    send({ type: 'discoveryConfigResult', ok: true, config: saved });
    broadcastNativeAgentRoster(store);
  } catch (error) {
    send({
      type: 'discoveryConfigResult',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
