/**
 * The agent roster: GitHub repositories merged with local definitions.
 *
 * A repository `<owner>/<repoPrefix>*` (minus excluded names) IS an agent —
 * one character, labelled "Agent" whatever file shape implements it. Its
 * invocation names come from the definitions inside the repo
 * (`.claude/agents/**.md`, `.claude/skills/<name>/SKILL.md`); a repo with no
 * definition gets one name by a fixed rule: drop the prefix, lower-case
 * (`Agent-skill-Retriever` → `skill-retriever`). Never a fuzzy match.
 *
 * Local definitions with the same name are attached to the repo entry (they
 * are how Claude Code on this machine actually runs it). Local definitions
 * no repo claims stay on the roster as their own entries.
 *
 * Pure: no network, no filesystem. The GitHub listing is fetched elsewhere
 * (server/src/githubRoster.ts) and passed in.
 */

import type {
  DefinitionKind,
  DiscoveryProblem,
  DiscoveryResult,
  NativeAgentRosterEntry,
  ResolvedIdentity,
} from './nativeAgentDiscovery.js';
import { resolveDefinition } from './nativeAgentDiscovery.js';

export interface GithubRepoDefinition {
  kind: DefinitionKind;
  name: string;
  description: string;
  /** Path inside the repository. */
  path: string;
}

export interface GithubRepoInfo {
  fullName: string;
  name: string;
  url: string;
  private: boolean;
  description?: string;
  definitions: GithubRepoDefinition[];
}

/** `Agent-skill-Retriever` with prefix `Agent-` → `skill-retriever`. */
export function derivedInvocationName(repoName: string, prefix: string): string {
  const stripped =
    prefix && repoName.toLowerCase().startsWith(prefix.toLowerCase())
      ? repoName.slice(prefix.length)
      : repoName;
  return stripped.toLowerCase();
}

export interface RosterIdentity extends ResolvedIdentity {
  /** The local definition the activity ran under, when there is one —
   *  where its project (and run records) live. */
  localEntry?: NativeAgentRosterEntry;
}

export interface MergedRoster {
  /** Shown entries: every repo agent, plus unclaimed local agents and
   *  included local skills. */
  agents: NativeAgentRosterEntry[];
  /** Local skills neither included nor claimed by a repo. */
  candidates: NativeAgentRosterEntry[];
  problems: DiscoveryProblem[];
  /** Map an observed name to exactly one shown entry, or to none. */
  resolve(name: string, kind: DefinitionKind, cwd: string | undefined): RosterIdentity;
}

export function githubKey(fullName: string): string {
  return `github:${fullName}`;
}

export function mergeRoster(
  local: DiscoveryResult,
  repos: readonly GithubRepoInfo[],
  repoPrefix: string,
): MergedRoster {
  const localAll = [...local.agents, ...local.candidates];
  const localShown = new Set(local.agents.map((e) => e.filePath));
  const problems: DiscoveryProblem[] = [...local.problems];

  interface RepoDraft {
    entry: NativeAgentRosterEntry;
    names: string[];
    /** Kind per name when the repo defines it; absent for a derived name. */
    kinds: Map<string, DefinitionKind>;
    locals: NativeAgentRosterEntry[];
  }

  const drafts: RepoDraft[] = repos.map((repo) => {
    const defined = repo.definitions.filter((d) => d.name);
    const names = defined.length
      ? [...new Set(defined.map((d) => d.name))]
      : [derivedInvocationName(repo.name, repoPrefix)];
    const kinds = new Map(defined.map((d) => [d.name, d.kind] as const));
    const locals = localAll.filter(
      (e) => names.includes(e.name) && (!kinds.has(e.name) || kinds.get(e.name) === e.kind),
    );
    const first = defined[0];
    const entry: NativeAgentRosterEntry = {
      name: names[0]!,
      description: first?.description || locals[0]?.description || repo.description || '',
      filePath: githubKey(repo.fullName),
      ambiguous: false,
      kind: first?.kind ?? locals[0]?.kind ?? 'agent',
      scope: 'github',
      ...(locals.length === 1 && locals[0]!.projectRoot
        ? { projectRoot: locals[0]!.projectRoot }
        : {}),
      repoFullName: repo.fullName,
      repoUrl: repo.url,
      repoPrivate: repo.private,
      invocationNames: names,
      ...(locals[0] ? { localFilePath: locals[0].filePath } : {}),
      observable: locals.length > 0,
    };
    if (!locals.length) {
      entry.note = `本機未找到「${names.join('、')}」的定義；在本機使用時，請在探索設定加入它的專案資料夾`;
    }
    return { entry, names, kinds, locals };
  });

  // Two repos claiming one name: neither may own that activity.
  const claims = new Map<string, RepoDraft[]>();
  for (const draft of drafts) {
    for (const name of draft.names) claims.set(name, [...(claims.get(name) ?? []), draft]);
  }
  for (const [name, claimants] of claims) {
    if (claimants.length < 2) continue;
    for (const draft of claimants) {
      draft.entry.ambiguous = true;
      draft.entry.note = `「${name}」同時對應到多個 repo，活動不會歸屬到任何一個`;
    }
    problems.push({
      filePath: claimants.map((d) => d.entry.repoFullName).join(', '),
      reason: `${claimants.length} 個 repo 都對應到名稱「${name}」`,
    });
  }

  const repoByLocalPath = new Map<string, RepoDraft>();
  /** Local files whose name several repos claim: shown by none, matched to none. */
  const contested = new Set<string>();
  for (const draft of drafts) {
    for (const l of draft.locals) {
      if (draft.entry.ambiguous) contested.add(l.filePath);
      else repoByLocalPath.set(l.filePath, draft);
    }
  }

  const unclaimed = (e: NativeAgentRosterEntry) =>
    !repoByLocalPath.has(e.filePath) && !contested.has(e.filePath);
  const agents = [...drafts.map((d) => d.entry), ...local.agents.filter(unclaimed)];
  const candidates = local.candidates.filter(unclaimed);

  function resolve(name: string, kind: DefinitionKind, cwd: string | undefined): RosterIdentity {
    const sameNameLocal = localAll.some((e) => e.kind === kind && e.name === name);
    if (sameNameLocal) {
      const res = resolveDefinition(name, kind, localAll, cwd);
      if (!res.recognized || !res.entry) return res;
      if (contested.has(res.entry.filePath)) {
        return { recognized: false, reason: 'claimed by several repos' };
      }
      const draft = repoByLocalPath.get(res.entry.filePath);
      if (draft) return { recognized: true, entry: draft.entry, localEntry: res.entry };
      if (localShown.has(res.entry.filePath)) {
        return { recognized: true, entry: res.entry, localEntry: res.entry };
      }
      return { recognized: false, reason: 'local definition not shown (skill filter)' };
    }
    // No local definition: a repo may still claim the name (e.g. its project
    // is not added to discovery on this machine).
    const owners = drafts.filter(
      (d) => d.names.includes(name) && (!d.kinds.has(name) || d.kinds.get(name) === kind),
    );
    if (owners.length === 1 && !owners[0]!.entry.ambiguous) {
      return { recognized: true, entry: owners[0]!.entry };
    }
    return {
      recognized: false,
      reason: owners.length > 1 ? 'claimed by several repos' : 'no discovered definition',
    };
  }

  return { agents, candidates, problems, resolve };
}
