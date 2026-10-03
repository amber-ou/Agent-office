/**
 * Lifecycle facts the runtime knows and the call log needs, passed one way
 * (runtime → observer). Kept out of agentRuntime.ts so the runtime does not
 * import the call log, and out of AgentEvent, which stays CLI-agnostic.
 */

export interface TeammateDeparture {
  /** Claude session id of the teammate's lead. */
  leadSessionId: string;
  /** The teammate's own name (`agentName`). */
  teammateName?: string;
  /** For a sidecar-backed background teammate: the lead's spawn tool_use id. */
  spawnToolUseId?: string;
  /** Why the runtime removed it: 'team-config' (the team config marked it
   *  inactive or gone), 'hooks' (its own session ended), 'background-complete'
   *  (a queue-operation completion), 'team-switch' (its team was superseded). */
  source: string;
}

let teammateDepartureObserver: ((departure: TeammateDeparture) => void) | null = null;

export function setTeammateDepartureObserver(
  observer: ((departure: TeammateDeparture) => void) | null,
): void {
  teammateDepartureObserver = observer;
}

export function notifyTeammateDeparture(departure: TeammateDeparture): void {
  try {
    teammateDepartureObserver?.(departure);
  } catch (error) {
    // Observation must never break the runtime's own cleanup.
    console.error('[Agent Office] Teammate departure observer failed:', error);
  }
}
