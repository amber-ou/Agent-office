/**
 * GitHub agent repos merged with local definitions: one Agent per repo,
 * names from the repo's definitions or derived from its name, local files
 * attached by exact name, unclaimed local agents kept, and no fuzzy match.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DiscoveryConfig, GithubRepoInfo } from '../src/index.js';
import {
  DEFAULT_DISCOVERY_CONFIG,
  derivedInvocationName,
  discoverDefinitions,
  mergeRoster,
} from '../src/index.js';

let root: string;
let home: string;
let figmaProject: string;

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
const def = (name: string) => `---\nname: ${name}\ndescription: ${name} desc\n---\nBody\n`;

const figmaRepo: GithubRepoInfo = {
  fullName: 'amber-ou/Agent-Figma-UI-agent',
  name: 'Agent-Figma-UI-agent',
  url: 'https://github.com/amber-ou/Agent-Figma-UI-agent',
  private: false,
  definitions: [
    {
      kind: 'skill',
      name: 'figma-ui',
      description: 'Figma UI',
      path: '.claude/skills/figma-ui/SKILL.md',
    },
  ],
};
const retrieverRepo: GithubRepoInfo = {
  fullName: 'amber-ou/Agent-skill-Retriever',
  name: 'Agent-skill-Retriever',
  url: 'https://github.com/amber-ou/Agent-skill-Retriever',
  private: true,
  definitions: [],
};

function local(overrides: Partial<DiscoveryConfig> = {}) {
  return discoverDefinitions(home, {
    ...DEFAULT_DISCOVERY_CONFIG,
    projectRoots: [figmaProject],
    skillInclude: [],
    ...overrides,
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-roster-'));
  home = path.join(root, '.claude');
  figmaProject = path.join(root, 'Agent-Figma-UI-agent');
  write(path.join(home, 'agents', 'skill-retriever.md'), def('skill-retriever'));
  write(path.join(home, 'agents', 'reviewer.md'), def('reviewer'));
  write(path.join(home, 'skills', 'helper', 'SKILL.md'), def('helper'));
  write(path.join(figmaProject, '.claude', 'skills', 'figma-ui', 'SKILL.md'), def('figma-ui'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('derivedInvocationName', () => {
  it('drops the prefix and lower-cases', () => {
    expect(derivedInvocationName('Agent-skill-Retriever', 'Agent-')).toBe('skill-retriever');
    expect(derivedInvocationName('agent-Foo', 'Agent-')).toBe('foo');
    expect(derivedInvocationName('Other', 'Agent-')).toBe('other');
  });
});

describe('mergeRoster', () => {
  it('shows one Agent per repo and attaches local definitions by exact name', () => {
    const roster = mergeRoster(local(), [figmaRepo, retrieverRepo], 'Agent-');
    const keys = roster.agents.map((a) => a.filePath).sort();
    // Both repos, plus the local agent no repo claims; the claimed local
    // files do not appear a second time.
    expect(keys).toEqual(
      [
        'github:amber-ou/Agent-Figma-UI-agent',
        'github:amber-ou/Agent-skill-Retriever',
        path.join(home, 'agents', 'reviewer.md'),
      ].sort(),
    );
    const figma = roster.agents.find((a) => a.repoFullName === figmaRepo.fullName)!;
    expect(figma).toMatchObject({
      name: 'figma-ui',
      scope: 'github',
      invocationNames: ['figma-ui'],
      observable: true,
      localFilePath: path.join(figmaProject, '.claude', 'skills', 'figma-ui', 'SKILL.md'),
      projectRoot: path.resolve(figmaProject),
    });
    const retriever = roster.agents.find((a) => a.repoFullName === retrieverRepo.fullName)!;
    expect(retriever).toMatchObject({
      name: 'skill-retriever',
      invocationNames: ['skill-retriever'],
      repoPrivate: true,
      observable: true,
      localFilePath: path.join(home, 'agents', 'skill-retriever.md'),
    });
  });

  it('needs no skill filter for a repo-claimed skill, and keeps helper skills out', () => {
    const roster = mergeRoster(local({ skillInclude: [] }), [figmaRepo], 'Agent-');
    expect(roster.agents.some((a) => a.name === 'figma-ui')).toBe(true);
    expect(roster.agents.some((a) => a.name === 'helper')).toBe(false);
    expect(roster.candidates.map((c) => c.name)).toEqual(['helper']);
  });

  it('resolves activity to the repo entry, wherever the local file lives', () => {
    const roster = mergeRoster(local(), [figmaRepo, retrieverRepo], 'Agent-');
    const viaAgent = roster.resolve('skill-retriever', 'agent', path.join(root, 'anywhere'));
    expect(viaAgent.entry?.filePath).toBe('github:amber-ou/Agent-skill-Retriever');
    expect(viaAgent.localEntry?.filePath).toBe(path.join(home, 'agents', 'skill-retriever.md'));
    const viaSlash = roster.resolve('figma-ui', 'skill', path.join(figmaProject, 'src'));
    expect(viaSlash.entry?.filePath).toBe('github:amber-ou/Agent-Figma-UI-agent');
    expect(viaSlash.localEntry?.projectRoot).toBe(path.resolve(figmaProject));
    // An unclaimed local agent still resolves to itself.
    expect(roster.resolve('reviewer', 'agent', undefined).entry?.filePath).toBe(
      path.join(home, 'agents', 'reviewer.md'),
    );
    // A helper skill nobody shows is not recognized.
    expect(roster.resolve('helper', 'skill', undefined).recognized).toBe(false);
  });

  it('marks a repo with no local definition, yet still matches its exact name', () => {
    const roster = mergeRoster(local({ projectRoots: [] }), [figmaRepo], 'Agent-');
    const figma = roster.agents.find((a) => a.name === 'figma-ui')!;
    expect(figma.observable).toBe(false);
    expect(figma.note).toContain('figma-ui');
    expect(roster.resolve('figma-ui', 'skill', undefined).entry?.filePath).toBe(
      'github:amber-ou/Agent-Figma-UI-agent',
    );
    // A different kind under the same name does not match a typed definition.
    expect(roster.resolve('figma-ui', 'agent', undefined).recognized).toBe(false);
  });

  it('refuses a name two repos claim', () => {
    const twin: GithubRepoInfo = {
      ...retrieverRepo,
      fullName: 'amber-ou/Agent-Skill-retriever',
      name: 'Agent-Skill-retriever',
    };
    const roster = mergeRoster(local(), [retrieverRepo, twin], 'Agent-');
    const both = roster.agents.filter((a) => a.repoFullName?.toLowerCase().includes('retriever'));
    expect(both).toHaveLength(2);
    expect(both.every((a) => a.ambiguous)).toBe(true);
    expect(roster.resolve('skill-retriever', 'agent', undefined).recognized).toBe(false);
    // The contested local file does not become a character of its own either.
    expect(roster.agents.some((a) => a.filePath.endsWith('skill-retriever.md'))).toBe(false);
    expect(roster.problems.some((p) => p.reason.includes('skill-retriever'))).toBe(true);
  });

  it('never matches by similarity', () => {
    const near: GithubRepoInfo = {
      ...retrieverRepo,
      fullName: 'amber-ou/Agent-skill-Retrievers',
      name: 'Agent-skill-Retrievers',
    };
    const roster = mergeRoster(local(), [near], 'Agent-');
    const entry = roster.agents.find((a) => a.repoFullName === near.fullName)!;
    expect(entry.observable).toBe(false);
    expect(entry.invocationNames).toEqual(['skill-retrievers']);
    expect(
      roster.agents.some((a) => a.filePath === path.join(home, 'agents', 'skill-retriever.md')),
    ).toBe(true);
  });
});
