/**
 * Automatic, read-only discovery of the Claude Code agents and skills Office
 * can observe (docs/observation.md §Discovery).
 *
 * Sources, in the scopes Claude Code itself uses:
 *
 *   user     `<claudeHome>/agents/**\/*.md`, `<claudeHome>/skills/<name>/SKILL.md`
 *   project  `<root>/.claude/agents/**\/*.md`, `<root>/.claude/skills/<name>/SKILL.md`
 *            for every project root the person configured in Office.
 *
 * Every agent definition found is shown. A skill is shown only when the
 * Office discovery config includes it (`skillInclude`) — most skills are
 * helpers, not something a person wants as a character. Hidden skills are
 * still returned as candidates so the person can pick them.
 *
 * Nothing here writes, creates a directory, or follows anything but the
 * definition files' own front matter (name, description). A missing source
 * directory is reported as "not found", never created. A file that cannot
 * be parsed is reported as a problem, never guessed at.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseNativeAgentFile, parseSkillFile } from './nativeAgentFile.js';

export type DefinitionKind = 'agent' | 'skill';
/** `github`: an entry that comes from the GitHub repo list (agentRoster.ts). */
export type DiscoveryScope = 'user' | 'project' | 'github';

/** Which GitHub repositories are agents: `<owner>/<repoPrefix>*`, minus `exclude`. */
export interface GithubDiscoveryConfig {
  enabled: boolean;
  /** Repository owner. Empty = the account the token belongs to. */
  owner: string;
  repoPrefix: string;
  /** Repository names (not full names) that are not agents, e.g. Office itself. */
  exclude: string[];
}

/** Office's own discovery settings — not an agent definition. */
export interface DiscoveryConfig {
  /** Scan `<claudeHome>/agents`. */
  includeUserAgents: boolean;
  /** Scan `<claudeHome>/skills` (as candidates; see `skillInclude`). */
  includeUserSkills: boolean;
  /** Local project roots whose `.claude/agents` and `.claude/skills` are scanned. */
  projectRoots: string[];
  /** Local skill names (exact, or with `*` wildcards) shown as agents when
   *  no GitHub repo already claims them. */
  skillInclude: string[];
  github: GithubDiscoveryConfig;
}

export const DEFAULT_DISCOVERY_CONFIG: DiscoveryConfig = {
  includeUserAgents: true,
  includeUserSkills: true,
  projectRoots: [],
  // The first skill workflow Office observes; editable in the Agent panel.
  skillInclude: ['figma-ui'],
  github: { enabled: true, owner: '', repoPrefix: 'Agent-', exclude: ['Agent-office'] },
};

export interface DiscoverySource {
  kind: DefinitionKind;
  scope: DiscoveryScope;
  /** The directory scanned. */
  root: string;
  /** For project scope: the configured project root it belongs to. */
  projectRoot?: string;
  exists: boolean;
}

/**
 * One parseable definition. `ambiguous` is set when another definition of
 * the same kind and name exists in the same source directory — Claude Code
 * could then load either, so it is never treated as a resolvable identity.
 */
export interface NativeAgentRosterEntry {
  name: string;
  description: string;
  filePath: string;
  ambiguous: boolean;
  kind: DefinitionKind;
  scope: DiscoveryScope;
  projectRoot?: string;
  /** GitHub entries: the repository this agent is. */
  repoFullName?: string;
  repoUrl?: string;
  repoPrivate?: boolean;
  /** Names activity is matched by (`subagent_type`, `/name`). */
  invocationNames?: string[];
  /** GitHub entries: the local definition file the repo was matched to. */
  localFilePath?: string;
  /** False when no local definition was found, so Claude Code on this
   *  machine cannot run it under these names. */
  observable?: boolean;
  /** Why the entry is not (fully) observable, or is ambiguous. */
  note?: string;
}

export interface DiscoveryProblem {
  filePath: string;
  reason: string;
}

export interface DiscoveryResult {
  /** Shown definitions: every agent, plus skills the config includes. */
  agents: NativeAgentRosterEntry[];
  /** Skills found but not included — offered to the person, not shown. */
  candidates: NativeAgentRosterEntry[];
  sources: DiscoverySource[];
  problems: DiscoveryProblem[];
}

function direntDir(entry: fs.Dirent, fallback: string): string {
  // Node <22 sets `.path` instead of `.parentPath` for the same value.
  return (
    (entry as fs.Dirent & { parentPath?: string; path?: string }).parentPath ??
    (entry as fs.Dirent & { path?: string }).path ??
    fallback
  );
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function readText(filePath: string, problems: DiscoveryProblem[]): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    problems.push({
      filePath,
      reason: `unreadable: ${error instanceof Error ? error.message : String(error)}`,
    });
    return null;
  }
}

type Found = Omit<NativeAgentRosterEntry, 'ambiguous'>;

function scanAgents(source: DiscoverySource, problems: DiscoveryProblem[]): Found[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(source.root, { withFileTypes: true, recursive: true });
  } catch {
    return [];
  }
  const found: Found[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const filePath = path.join(direntDir(entry, source.root), entry.name);
    const text = readText(filePath, problems);
    if (text === null) continue;
    const parsed = parseNativeAgentFile(text);
    if (!parsed.ok) {
      problems.push({ filePath, reason: parsed.reason });
      continue;
    }
    found.push({
      name: parsed.agent.fields.name,
      description: parsed.agent.fields.description,
      filePath,
      kind: 'agent',
      scope: source.scope,
      ...(source.projectRoot ? { projectRoot: source.projectRoot } : {}),
    });
  }
  return found;
}

function scanSkills(source: DiscoverySource, problems: DiscoveryProblem[]): Found[] {
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(source.root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: Found[] = [];
  for (const dir of dirs) {
    if (!dir.isDirectory() && !dir.isSymbolicLink()) continue;
    const filePath = path.join(source.root, dir.name, 'SKILL.md');
    if (!fs.existsSync(filePath)) continue;
    const text = readText(filePath, problems);
    if (text === null) continue;
    const parsed = parseSkillFile(text, dir.name);
    if (!parsed.ok) {
      problems.push({ filePath, reason: parsed.reason });
      continue;
    }
    found.push({
      name: parsed.agent.fields.name,
      description: parsed.agent.fields.description,
      filePath,
      kind: 'skill',
      scope: source.scope,
      ...(source.projectRoot ? { projectRoot: source.projectRoot } : {}),
    });
  }
  return found;
}

/** `*` matches any run of characters; everything else is literal. */
export function matchesSkillPattern(name: string, pattern: string): boolean {
  const escaped = pattern
    .trim()
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return escaped.length > 0 && new RegExp(`^${escaped}$`, 'i').test(name);
}

export function discoverySources(claudeHome: string, config: DiscoveryConfig): DiscoverySource[] {
  const sources: DiscoverySource[] = [];
  const add = (kind: DefinitionKind, scope: DiscoveryScope, root: string, projectRoot?: string) =>
    sources.push({
      kind,
      scope,
      root: path.resolve(root),
      ...(projectRoot ? { projectRoot: path.resolve(projectRoot) } : {}),
      exists: isDirectory(root),
    });
  if (config.includeUserAgents) add('agent', 'user', path.join(claudeHome, 'agents'));
  if (config.includeUserSkills) add('skill', 'user', path.join(claudeHome, 'skills'));
  const seen = new Set<string>();
  for (const projectRoot of config.projectRoots) {
    const resolved = path.resolve(projectRoot);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    add('agent', 'project', path.join(resolved, '.claude', 'agents'), resolved);
    add('skill', 'project', path.join(resolved, '.claude', 'skills'), resolved);
  }
  return sources;
}

/** Scan every configured source. Read-only and never throws. */
export function discoverDefinitions(claudeHome: string, config: DiscoveryConfig): DiscoveryResult {
  const sources = discoverySources(claudeHome, config);
  const problems: DiscoveryProblem[] = [];
  const all: NativeAgentRosterEntry[] = [];
  for (const source of sources) {
    if (!source.exists) continue;
    const found =
      source.kind === 'agent' ? scanAgents(source, problems) : scanSkills(source, problems);
    const counts = new Map<string, number>();
    for (const f of found) counts.set(f.name, (counts.get(f.name) ?? 0) + 1);
    for (const f of found) {
      const ambiguous = (counts.get(f.name) ?? 0) > 1;
      all.push({ ...f, ambiguous });
    }
    for (const [name, count] of counts) {
      if (count > 1) {
        problems.push({
          filePath: source.root,
          reason: `${count} ${source.kind} definitions declare the name "${name}" — none of them is matched to activity until the names are unique`,
        });
      }
    }
  }
  const agents: NativeAgentRosterEntry[] = [];
  const candidates: NativeAgentRosterEntry[] = [];
  for (const entry of all) {
    if (
      entry.kind === 'agent' ||
      config.skillInclude.some((p) => matchesSkillPattern(entry.name, p))
    ) {
      agents.push(entry);
    } else {
      candidates.push(entry);
    }
  }
  return { agents, candidates, sources, problems };
}

/** User-level agents only — the previous version's roster, kept for callers
 *  that need just `<root>/**\/*.md`. */
export function discoverNativeAgents(claudeAgentsRoot: string): NativeAgentRosterEntry[] {
  const problems: DiscoveryProblem[] = [];
  const source: DiscoverySource = {
    kind: 'agent',
    scope: 'user',
    root: path.resolve(claudeAgentsRoot),
    exists: isDirectory(claudeAgentsRoot),
  };
  const found = source.exists ? scanAgents(source, problems) : [];
  const counts = new Map<string, number>();
  for (const f of found) counts.set(f.name, (counts.get(f.name) ?? 0) + 1);
  return found.map((f) => ({ ...f, ambiguous: (counts.get(f.name) ?? 0) > 1 }));
}

function pathContains(root: string, target: string): boolean {
  const norm = (p: string) => {
    const resolved = path.resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const r = norm(root);
  const t = norm(target);
  return t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

export interface ResolvedIdentity {
  recognized: boolean;
  entry?: NativeAgentRosterEntry;
  /** Why it was not recognized, for diagnostics. */
  reason?: string;
}

/**
 * Resolve an observed name to exactly one shown definition, following
 * Claude Code's own precedence: a project definition (whose project root
 * contains the session's working directory) wins over a user-level one of
 * the same name. Never a guess: an ambiguous scope, or a project definition
 * with no session directory to place it, is "not recognized".
 */
export function resolveDefinition(
  name: string,
  kind: DefinitionKind,
  shown: readonly NativeAgentRosterEntry[],
  cwd: string | undefined,
): ResolvedIdentity {
  const sameName = shown.filter((e) => e.kind === kind && e.name === name);
  if (sameName.length === 0) return { recognized: false, reason: 'no discovered definition' };
  if (cwd) {
    const project = sameName.filter(
      (e) => e.scope === 'project' && e.projectRoot && pathContains(e.projectRoot, cwd),
    );
    if (project.length > 0) {
      // Nested project roots: the innermost one is the session's project.
      const depth = (e: NativeAgentRosterEntry) => path.resolve(e.projectRoot!).length;
      const innermost = Math.max(...project.map(depth));
      const winners = project.filter((e) => depth(e) === innermost);
      if (winners.length === 1 && !winners[0]!.ambiguous) {
        return { recognized: true, entry: winners[0] };
      }
      return { recognized: false, reason: 'ambiguous project definition' };
    }
  }
  const user = sameName.filter((e) => e.scope === 'user');
  if (user.length === 1 && !user[0]!.ambiguous) return { recognized: true, entry: user[0] };
  if (user.length > 1 || user.some((e) => e.ambiguous)) {
    return { recognized: false, reason: 'ambiguous user definition' };
  }
  return {
    recognized: false,
    reason: cwd
      ? 'only project definitions outside the session directory'
      : 'session directory unknown',
  };
}
