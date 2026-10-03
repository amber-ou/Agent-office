/**
 * Agent Office observation storage.
 *
 * Two things live here, both read-mostly:
 *
 *   call log   observed Claude Code agent activity, in `~/.agent-office/agent-office.db`
 *   discovery  read-only scan of Claude Code agent / skill definition files
 *
 * The data root `~/.agent-office/` is deliberately separate from upstream's
 * `~/.pixel-agents/`. Office never writes into `~/.claude` or into any
 * agent's own directory.
 */

export type {
  AgentCall,
  AgentCallKind,
  AgentCallLogStore,
  AgentCallStatus,
  AgentCallUsage,
  AnnotateAgentCallInput,
  EndAgentCallInput,
  EvidenceSource,
  MarkStatusOptions,
  StartAgentCallInput,
  Timestamp,
} from './callLog.js';
export { ACTIVITY_SUMMARY_MAX, OPEN_CALL_STATUSES, summarizeActivity } from './callLog.js';
export type {
  DefinitionKind,
  DiscoveryConfig,
  DiscoveryProblem,
  DiscoveryResult,
  DiscoveryScope,
  DiscoverySource,
  NativeAgentRosterEntry,
  ResolvedIdentity,
} from './files/nativeAgentDiscovery.js';
export {
  DEFAULT_DISCOVERY_CONFIG,
  discoverDefinitions,
  discoverNativeAgents,
  discoverySources,
  matchesSkillPattern,
  resolveDefinition,
} from './files/nativeAgentDiscovery.js';
export type {
  NativeAgentFields,
  NativeAgentParseError,
  NativeAgentParseResult,
  ParsedNativeAgent,
} from './files/nativeAgentFile.js';
export {
  hasConflictMarkers,
  parseNativeAgentFile,
  parseSkillFile,
} from './files/nativeAgentFile.js';
export type { ObservationStorage, OpenObservationStorageOptions } from './sqlite/index.js';
export {
  DATABASE_FILE_NAME,
  DEFAULT_DATA_DIR_NAME,
  defaultDataRoot,
  LATEST_SCHEMA_VERSION,
  migrate,
  MIGRATIONS,
  openObservationStorage,
  SqliteAgentCallLogStore,
  SqliteDatabase,
} from './sqlite/index.js';
export type { Migration } from './sqlite/migrations.js';
