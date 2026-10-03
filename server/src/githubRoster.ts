/**
 * Read-only GitHub listing of agent repositories (`<owner>/<repoPrefix>*`).
 *
 * What Office does with GitHub, and only this:
 *  - lists the account's repositories (GET /user/repos with a token,
 *    GET /users/<owner>/repos without),
 *  - for each agent repo, reads the file tree of its default branch and the
 *    front matter of `.claude/agents/**.md` and `.claude/skills/<name>/SKILL.md`
 *    — name and description only — to learn the names activity runs under.
 *
 * No writes, no clone, no install, no sync. The token is kept in Office's
 * own data root (`~/.agent-office/github-token`), sent only to
 * api.github.com, never logged and never sent to a client. The last good
 * listing is cached (`~/.agent-office/github-roster.json`) so the roster
 * survives offline and restarts; a failed sync keeps the cache and reports
 * the error instead of emptying the office.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  DefinitionKind,
  GithubDiscoveryConfig,
  GithubRepoDefinition,
  GithubRepoInfo,
} from '../../storage/src/index.js';
import { parseNativeAgentFile, parseSkillFile } from '../../storage/src/index.js';
import { getOfficeDataRoot } from './control/observationStorage.js';

export const GITHUB_API = 'https://api.github.com';
export const GITHUB_SYNC_INTERVAL_MS = 10 * 60 * 1000;
export const GITHUB_TOKEN_ENV = 'AGENT_OFFICE_GITHUB_TOKEN';
const TOKEN_FILE = 'github-token';
const CACHE_FILE = 'github-roster.json';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REPOS = 100;
const MAX_DEFINITIONS_PER_REPO = 20;
const MAX_LIST_PAGES = 5;

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface GithubSyncStatus {
  tokenSet: boolean;
  /** The token comes from the environment and cannot be cleared from the UI. */
  tokenFromEnv: boolean;
  owner?: string;
  lastSyncAt?: string;
  repoCount: number;
  error?: string;
}

interface CacheFile {
  owner: string;
  repoPrefix: string;
  fetchedAt: string;
  repos: GithubRepoInfo[];
}

// ── Token ──────────────────────────────────────────────────────────

function tokenPath(): string {
  return path.join(getOfficeDataRoot(), TOKEN_FILE);
}

export function readGithubToken(): { token?: string; fromEnv: boolean } {
  const env = process.env[GITHUB_TOKEN_ENV]?.trim();
  if (env) return { token: env, fromEnv: true };
  try {
    const token = fs.readFileSync(tokenPath(), 'utf8').trim();
    return token ? { token, fromEnv: false } : { fromEnv: false };
  } catch {
    return { fromEnv: false };
  }
}

/** Store (or, with an empty string, remove) the token. Owner-only mode on
 *  POSIX; on Windows the file inherits the user profile's ACL. */
export function writeGithubToken(token: string): void {
  const file = tokenPath();
  const trimmed = token.trim();
  if (!trimmed) {
    fs.rmSync(file, { force: true });
    return;
  }
  if (!/^[\x21-\x7e]{10,255}$/.test(trimmed)) {
    throw new Error('這看起來不是 GitHub token');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${trimmed}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ── Cache ──────────────────────────────────────────────────────────

function cachePath(): string {
  return path.join(getOfficeDataRoot(), CACHE_FILE);
}

function readCache(): CacheFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(), 'utf8')) as CacheFile;
    return Array.isArray(parsed.repos) ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(cache: CacheFile): void {
  const file = cachePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

// ── Fetch ──────────────────────────────────────────────────────────

class GithubError extends Error {}

function describeStatus(status: number): string {
  if (status === 401) return 'GitHub token 無效或已過期';
  if (status === 403) return 'GitHub 拒絕存取（權限不足或已達速率上限）';
  if (status === 404) return '找不到該 GitHub 帳號或 repo';
  return `GitHub 回應 ${status}`;
}

async function getJson(fetchImpl: FetchLike, url: string, token?: string): Promise<unknown> {
  const res = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'agent-office',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new GithubError(describeStatus(res.status));
  return res.json();
}

async function getRaw(fetchImpl: FetchLike, url: string, token?: string): Promise<string | null> {
  const res = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github.raw',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'agent-office',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return res.ok ? res.text() : null;
}

interface RawRepo {
  name?: unknown;
  full_name?: unknown;
  html_url?: unknown;
  private?: unknown;
  description?: unknown;
  default_branch?: unknown;
  archived?: unknown;
  owner?: { login?: unknown };
}

function isAgentRepo(repo: RawRepo, owner: string, config: GithubDiscoveryConfig): boolean {
  const name = typeof repo.name === 'string' ? repo.name : '';
  const login = typeof repo.owner?.login === 'string' ? repo.owner.login : '';
  return (
    !!name &&
    login.toLowerCase() === owner.toLowerCase() &&
    name.toLowerCase().startsWith(config.repoPrefix.toLowerCase()) &&
    !config.exclude.some((x) => x.toLowerCase() === name.toLowerCase()) &&
    repo.archived !== true
  );
}

/** `.claude/agents/**.md` → agent; `.claude/skills/<name>/SKILL.md` → skill. */
function definitionPaths(paths: string[]): Array<{ path: string; kind: DefinitionKind }> {
  const out: Array<{ path: string; kind: DefinitionKind }> = [];
  for (const p of paths) {
    if (/^\.claude\/agents\/.+\.md$/i.test(p)) out.push({ path: p, kind: 'agent' });
    else if (/^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(p)) out.push({ path: p, kind: 'skill' });
  }
  return out.slice(0, MAX_DEFINITIONS_PER_REPO);
}

async function readRepoDefinitions(
  fetchImpl: FetchLike,
  fullName: string,
  branch: string,
  token?: string,
): Promise<GithubRepoDefinition[]> {
  let tree: unknown;
  try {
    tree = await getJson(
      fetchImpl,
      `${GITHUB_API}/repos/${fullName}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
      token,
    );
  } catch {
    return []; // empty repo (409) or unreadable tree: no definitions
  }
  const entries = (tree as { tree?: Array<{ path?: unknown; type?: unknown }> }).tree ?? [];
  const paths = entries
    .filter((e) => e.type === 'blob' && typeof e.path === 'string')
    .map((e) => e.path as string);
  const defs: GithubRepoDefinition[] = [];
  for (const { path: p, kind } of definitionPaths(paths)) {
    const text = await getRaw(
      fetchImpl,
      `${GITHUB_API}/repos/${fullName}/contents/${p.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`,
      token,
    );
    if (text === null) continue;
    const parsed =
      kind === 'agent' ? parseNativeAgentFile(text) : parseSkillFile(text, p.split('/')[2]!);
    if (!parsed.ok) continue;
    defs.push({
      kind,
      name: parsed.agent.fields.name,
      description: parsed.agent.fields.description,
      path: p,
    });
  }
  return defs;
}

export async function fetchGithubRoster(
  config: GithubDiscoveryConfig,
  token: string | undefined,
  fetchImpl: FetchLike,
): Promise<{ owner: string; repos: GithubRepoInfo[] }> {
  let owner = config.owner.trim();
  if (!owner) {
    if (!token) throw new GithubError('請設定 GitHub 帳號或 token');
    const me = (await getJson(fetchImpl, `${GITHUB_API}/user`, token)) as { login?: unknown };
    if (typeof me.login !== 'string') throw new GithubError('無法取得 token 所屬的 GitHub 帳號');
    owner = me.login;
  }
  const listed: RawRepo[] = [];
  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const url = token
      ? `${GITHUB_API}/user/repos?per_page=100&page=${page}&affiliation=owner,collaborator,organization_member`
      : `${GITHUB_API}/users/${encodeURIComponent(owner)}/repos?per_page=100&page=${page}&type=owner`;
    const batch = (await getJson(fetchImpl, url, token)) as RawRepo[];
    if (!Array.isArray(batch)) throw new GithubError('GitHub 回傳格式不正確');
    listed.push(...batch);
    if (batch.length < 100) break;
  }
  const agentRepos = listed.filter((r) => isAgentRepo(r, owner, config)).slice(0, MAX_REPOS);
  const repos: GithubRepoInfo[] = [];
  for (const r of agentRepos) {
    const fullName = String(r.full_name);
    const branch = typeof r.default_branch === 'string' ? r.default_branch : 'main';
    repos.push({
      fullName,
      name: String(r.name),
      url: typeof r.html_url === 'string' ? r.html_url : `https://github.com/${fullName}`,
      private: r.private === true,
      ...(typeof r.description === 'string' && r.description ? { description: r.description } : {}),
      definitions: await readRepoDefinitions(fetchImpl, fullName, branch, token),
    });
  }
  repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
  return { owner, repos };
}

// ── Sync state ─────────────────────────────────────────────────────

let current: { repos: GithubRepoInfo[]; owner?: string; lastSyncAt?: string; error?: string } = {
  repos: [],
};
let loadedFromCache = false;
let inFlight: Promise<void> | null = null;

function loadCacheOnce(config: GithubDiscoveryConfig): void {
  if (loadedFromCache) return;
  loadedFromCache = true;
  const cache = readCache();
  if (cache && cache.repoPrefix === config.repoPrefix) {
    current = { repos: cache.repos, owner: cache.owner, lastSyncAt: cache.fetchedAt };
  }
}

/** Agent repos to merge into the roster: the live result, else the cache. */
export function getGithubRepos(config: GithubDiscoveryConfig): GithubRepoInfo[] {
  if (!config.enabled) return [];
  loadCacheOnce(config);
  return current.repos.filter(
    (r) => !config.exclude.some((x) => x.toLowerCase() === r.name.toLowerCase()),
  );
}

export function getGithubStatus(config: GithubDiscoveryConfig): GithubSyncStatus {
  const { token, fromEnv } = readGithubToken();
  return {
    tokenSet: !!token,
    tokenFromEnv: fromEnv,
    ...(current.owner ? { owner: current.owner } : {}),
    ...(current.lastSyncAt ? { lastSyncAt: current.lastSyncAt } : {}),
    repoCount: config.enabled ? getGithubRepos(config).length : 0,
    ...(current.error ? { error: current.error } : {}),
  };
}

/** Sync now. Concurrent calls share one request. A failure keeps the last
 *  good listing and records the error. */
export function syncGithubRoster(
  config: GithubDiscoveryConfig,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<void> {
  if (!config.enabled) return Promise.resolve();
  if (inFlight) return inFlight;
  loadCacheOnce(config);
  const { token } = readGithubToken();
  inFlight = fetchGithubRoster(config, token, fetchImpl)
    .then(({ owner, repos }) => {
      const fetchedAt = new Date().toISOString();
      current = { repos, owner, lastSyncAt: fetchedAt };
      try {
        writeCache({ owner, repoPrefix: config.repoPrefix, fetchedAt, repos });
      } catch (error) {
        console.warn('[Agent Office] Could not cache the GitHub roster:', error);
      }
    })
    .catch((error: unknown) => {
      const message =
        error instanceof GithubError
          ? error.message
          : `無法連線 GitHub（${error instanceof Error ? error.message : String(error)}）`;
      current = { ...current, error: message };
      console.warn(`[Agent Office] GitHub roster sync failed: ${message}`);
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Forget in-memory state (tests, data-root changes). */
export function resetGithubRoster(): void {
  current = { repos: [] };
  loadedFromCache = false;
  inFlight = null;
}
