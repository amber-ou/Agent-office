/**
 * Office's own discovery settings: which local sources to scan for Claude
 * Code agents and skills, and which skills to show as agents.
 *
 * Stored at `~/.agent-office/discovery.json` — Office's data root, never
 * `~/.claude`. Editing it changes only what Office LOOKS at; it never
 * creates, edits or registers an agent.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { DiscoveryConfig } from '../../../storage/src/index.js';
import { DEFAULT_DISCOVERY_CONFIG } from '../../../storage/src/index.js';
import { getOfficeDataRoot } from './observationStorage.js';

export const DISCOVERY_CONFIG_FILE_NAME = 'discovery.json';
/** Hard caps, so a hostile or broken file cannot make the scan unbounded. */
const MAX_PROJECT_ROOTS = 50;
const MAX_SKILL_PATTERNS = 100;
const MAX_ENTRY_LENGTH = 1024;

export function discoveryConfigPath(): string {
  return path.join(getOfficeDataRoot(), DISCOVERY_CONFIG_FILE_NAME);
}

function stringList(value: unknown, max: number): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > MAX_ENTRY_LENGTH || out.includes(trimmed)) continue;
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}

/** Validate untrusted input (file contents or a client message). Unknown
 *  fields are dropped; a missing field keeps `base`'s value. */
export function normalizeDiscoveryConfig(
  raw: unknown,
  base: DiscoveryConfig = DEFAULT_DISCOVERY_CONFIG,
): DiscoveryConfig {
  const obj =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const projectRoots = stringList(obj['projectRoots'], MAX_PROJECT_ROOTS)?.filter((p) =>
    path.isAbsolute(p),
  );
  return {
    includeUserAgents:
      typeof obj['includeUserAgents'] === 'boolean'
        ? obj['includeUserAgents']
        : base.includeUserAgents,
    includeUserSkills:
      typeof obj['includeUserSkills'] === 'boolean'
        ? obj['includeUserSkills']
        : base.includeUserSkills,
    projectRoots: projectRoots ?? [...base.projectRoots],
    skillInclude: stringList(obj['skillInclude'], MAX_SKILL_PATTERNS) ?? [...base.skillInclude],
  };
}

/** Read the config. A missing file is the defaults; an unreadable or
 *  malformed one is the defaults plus a logged warning — never a crash. */
export function loadDiscoveryConfig(): DiscoveryConfig {
  const file = discoveryConfigPath();
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return normalizeDiscoveryConfig({});
  }
  try {
    return normalizeDiscoveryConfig(JSON.parse(text));
  } catch (error) {
    console.warn(
      `[Agent Office] ${file} is not valid JSON (${
        error instanceof Error ? error.message : String(error)
      }); using default discovery settings.`,
    );
    return normalizeDiscoveryConfig({});
  }
}

/** Atomic write (tmp + rename) into Office's own data root. */
export function saveDiscoveryConfig(config: DiscoveryConfig): DiscoveryConfig {
  const normalized = normalizeDiscoveryConfig(config);
  const file = discoveryConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return normalized;
}
