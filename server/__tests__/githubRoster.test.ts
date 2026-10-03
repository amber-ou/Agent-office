/**
 * The read-only GitHub listing, against a fake `fetch` — no network. Covers
 * repo filtering (owner, prefix, exclude, archived), reading definitions
 * from the default branch, the token (stored in Office's data root, sent
 * only as a header, never in status), the offline cache, and a failed sync
 * keeping the last good listing.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_DISCOVERY_CONFIG } from '../../storage/src/index.js';
import { setOfficeDataRoot } from '../src/control/observationStorage.js';
import type { FetchLike } from '../src/githubRoster.js';
import {
  fetchGithubRoster,
  getGithubRepos,
  getGithubStatus,
  GITHUB_TOKEN_ENV,
  readGithubToken,
  resetGithubRoster,
  syncGithubRoster,
  writeGithubToken,
} from '../src/githubRoster.js';

const TOKEN = 'ghp_testtoken1234567890';
let dataRoot: string;
let calls: Array<{ url: string; auth?: string }>;

const repo = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  full_name: `amber-ou/${name}`,
  html_url: `https://github.com/amber-ou/${name}`,
  private: false,
  default_branch: 'main',
  owner: { login: 'amber-ou' },
  ...extra,
});

/** A tiny GitHub: three agent repos, Office itself, an unrelated repo,
 *  an archived one and someone else's. */
const routes: Record<string, unknown> = {
  'https://api.github.com/user': { login: 'amber-ou' },
  'https://api.github.com/user/repos?per_page=100&page=1&affiliation=owner,collaborator,organization_member':
    [
      repo('Agent-Figma-UI-agent'),
      repo('Agent-skill-Retriever', { private: true }),
      repo('Agent-office'),
      repo('notes'),
      repo('Agent-old', { archived: true }),
      repo('Agent-theirs', {
        owner: { login: 'someone-else' },
        full_name: 'someone-else/Agent-theirs',
      }),
    ],
  'https://api.github.com/repos/amber-ou/Agent-Figma-UI-agent/git/trees/main?recursive=1': {
    tree: [
      { path: 'README.md', type: 'blob' },
      { path: '.claude/settings.json', type: 'blob' },
      { path: '.claude/skills/figma-ui/SKILL.md', type: 'blob' },
      { path: '.claude/skills/figma-ui/references/x.md', type: 'blob' },
    ],
  },
  'https://api.github.com/repos/amber-ou/Agent-Figma-UI-agent/contents/.claude/skills/figma-ui/SKILL.md?ref=main':
    '---\nname: figma-ui\ndescription: Figma UI workflow\ndisable-model-invocation: true\n---\nBody\n',
  'https://api.github.com/repos/amber-ou/Agent-skill-Retriever/git/trees/main?recursive=1': {
    tree: [{ path: 'README.md', type: 'blob' }],
  },
};

let failing = false;
const fakeFetch: FetchLike = async (url, init) => {
  calls.push({ url, auth: init.headers['Authorization'] });
  if (failing) throw new Error('getaddrinfo ENOTFOUND api.github.com');
  if (!(url in routes))
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  const body = routes[url];
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
};

const config = { ...DEFAULT_DISCOVERY_CONFIG.github };

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-github-'));
  setOfficeDataRoot(dataRoot);
  resetGithubRoster();
  calls = [];
  failing = false;
  delete process.env[GITHUB_TOKEN_ENV];
});

afterEach(() => {
  resetGithubRoster();
  setOfficeDataRoot(undefined);
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe('fetchGithubRoster', () => {
  it('lists only the owner’s non-archived Agent-* repos, minus exclusions, with their definitions', async () => {
    const { owner, repos } = await fetchGithubRoster(config, TOKEN, fakeFetch);
    expect(owner).toBe('amber-ou');
    expect(repos.map((r) => r.name)).toEqual(['Agent-Figma-UI-agent', 'Agent-skill-Retriever']);
    expect(repos[0]!.definitions).toEqual([
      {
        kind: 'skill',
        name: 'figma-ui',
        description: 'Figma UI workflow',
        path: '.claude/skills/figma-ui/SKILL.md',
      },
    ]);
    expect(repos[1]).toMatchObject({ private: true, definitions: [] });
    // Every request carried the token as a header and went to api.github.com.
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(calls.every((c) => c.url.startsWith('https://api.github.com/'))).toBe(true);
  });

  it('uses only GET-style reads: no request writes anything', async () => {
    await fetchGithubRoster(config, TOKEN, fakeFetch);
    // FetchLike has no method/body: a write is not even expressible.
    expect(calls.length).toBeGreaterThan(0);
  });

  it('needs an owner or a token', async () => {
    await expect(fetchGithubRoster(config, undefined, fakeFetch)).rejects.toThrow('GitHub');
  });
});

describe('token', () => {
  it('is stored in Office’s data root, readable back, and cleared by an empty string', () => {
    writeGithubToken(TOKEN);
    expect(fs.readFileSync(path.join(dataRoot, 'github-token'), 'utf8').trim()).toBe(TOKEN);
    expect(readGithubToken()).toEqual({ token: TOKEN, fromEnv: false });
    writeGithubToken('');
    expect(readGithubToken().token).toBeUndefined();
  });

  it('rejects text that is not a token', () => {
    expect(() => writeGithubToken('not a token')).toThrow();
  });

  it('is never part of the status a client receives', async () => {
    writeGithubToken(TOKEN);
    await syncGithubRoster(config, fakeFetch);
    const status = getGithubStatus(config);
    expect(status).toMatchObject({
      tokenSet: true,
      tokenFromEnv: false,
      repoCount: 2,
      owner: 'amber-ou',
    });
    expect(JSON.stringify(status)).not.toContain(TOKEN);
  });

  it('prefers the environment variable', () => {
    process.env[GITHUB_TOKEN_ENV] = 'ghp_fromenvironment123';
    expect(readGithubToken()).toEqual({ token: 'ghp_fromenvironment123', fromEnv: true });
  });
});

describe('sync and cache', () => {
  it('caches the listing and serves it after a restart, offline', async () => {
    writeGithubToken(TOKEN);
    await syncGithubRoster(config, fakeFetch);
    expect(fs.existsSync(path.join(dataRoot, 'github-roster.json'))).toBe(true);
    resetGithubRoster(); // a new process
    failing = true;
    expect(getGithubRepos(config).map((r) => r.name)).toEqual([
      'Agent-Figma-UI-agent',
      'Agent-skill-Retriever',
    ]);
  });

  it('keeps the last good listing and reports the error when a sync fails', async () => {
    writeGithubToken(TOKEN);
    await syncGithubRoster(config, fakeFetch);
    failing = true;
    await syncGithubRoster(config, fakeFetch);
    expect(getGithubRepos(config)).toHaveLength(2);
    expect(getGithubStatus(config).error).toContain('無法連線 GitHub');
  });

  it('applies exclusions to a cached listing immediately, and nothing when disabled', async () => {
    writeGithubToken(TOKEN);
    await syncGithubRoster(config, fakeFetch);
    expect(
      getGithubRepos({ ...config, exclude: ['Agent-office', 'Agent-skill-Retriever'] }).map(
        (r) => r.name,
      ),
    ).toEqual(['Agent-Figma-UI-agent']);
    expect(getGithubRepos({ ...config, enabled: false })).toEqual([]);
  });
});
