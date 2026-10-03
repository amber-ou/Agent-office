/**
 * Automatic discovery: user and project sources, agents and skills, the
 * skill filter, conflicts, problems, missing sources (reported, never
 * created), and identity resolution with Claude Code's precedence.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DiscoveryConfig } from '../src/index.js';
import {
  DEFAULT_DISCOVERY_CONFIG,
  discoverDefinitions,
  discoverNativeAgents,
  matchesSkillPattern,
  resolveDefinition,
} from '../src/index.js';

let root: string;
let home: string;
let projectA: string;
let projectB: string;

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function agentFile(name: string, description = ''): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\nBody text.\n`;
}

const config = (overrides: Partial<DiscoveryConfig> = {}): DiscoveryConfig => ({
  ...DEFAULT_DISCOVERY_CONFIG,
  projectRoots: [projectA, projectB],
  ...overrides,
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-office-discovery-'));
  home = path.join(root, 'home', '.claude');
  projectA = path.join(root, 'projects', 'a');
  projectB = path.join(root, 'projects', 'b');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('discoverDefinitions', () => {
  it('reports missing sources as not found and creates nothing', () => {
    const result = discoverDefinitions(home, config());
    expect(result.agents).toEqual([]);
    expect(result.sources.every((s) => !s.exists)).toBe(true);
    expect(fs.existsSync(home)).toBe(false);
    expect(fs.existsSync(projectA)).toBe(false);
  });

  it('finds user and project agents without any registration', () => {
    write(
      path.join(home, 'agents', 'skill-retriever.md'),
      agentFile('skill-retriever', 'Finds skills'),
    );
    write(path.join(home, 'agents', 'nested', 'deep.md'), agentFile('deep'));
    write(path.join(projectA, '.claude', 'agents', 'reviewer.md'), agentFile('reviewer'));
    const { agents } = discoverDefinitions(home, config());
    expect(agents.map((a) => `${a.scope}:${a.name}`).sort()).toEqual([
      'project:reviewer',
      'user:deep',
      'user:skill-retriever',
    ]);
    const reviewer = agents.find((a) => a.name === 'reviewer')!;
    expect(reviewer).toMatchObject({
      kind: 'agent',
      projectRoot: path.resolve(projectA),
      ambiguous: false,
    });
  });

  it('shows only included skills; the rest are candidates', () => {
    write(path.join(projectA, '.claude', 'skills', 'figma-ui', 'SKILL.md'), agentFile('figma-ui'));
    write(path.join(home, 'skills', 'helper', 'SKILL.md'), agentFile('helper'));
    // No `name` field: the directory name is the skill's name.
    write(path.join(home, 'skills', 'unnamed', 'SKILL.md'), '---\ndescription: d\n---\n');
    const result = discoverDefinitions(home, config());
    expect(result.agents.map((a) => a.name)).toEqual(['figma-ui']);
    expect(result.candidates.map((a) => a.name).sort()).toEqual(['helper', 'unnamed']);
    const widened = discoverDefinitions(home, config({ skillInclude: ['help*', 'figma-ui'] }));
    expect(widened.agents.map((a) => a.name).sort()).toEqual(['figma-ui', 'helper']);
  });

  it('marks same-name definitions in one source ambiguous and reports the conflict', () => {
    write(path.join(home, 'agents', 'one.md'), agentFile('dup'));
    write(path.join(home, 'agents', 'two.md'), agentFile('dup'));
    const result = discoverDefinitions(home, config());
    expect(result.agents.filter((a) => a.name === 'dup').every((a) => a.ambiguous)).toBe(true);
    expect(result.problems.some((p) => p.reason.includes('"dup"'))).toBe(true);
  });

  it('reports unparseable files instead of dropping them silently', () => {
    write(path.join(home, 'agents', 'notes.md'), 'just notes, no front matter');
    write(path.join(home, 'agents', 'merge.md'), '<<<<<<< HEAD\n---\nname: x\n---\n');
    const result = discoverDefinitions(home, config());
    expect(result.agents).toEqual([]);
    expect(result.problems.map((p) => path.basename(p.filePath)).sort()).toEqual([
      'merge.md',
      'notes.md',
    ]);
  });

  it('honours source toggles', () => {
    write(path.join(home, 'agents', 'a.md'), agentFile('a'));
    const result = discoverDefinitions(home, config({ includeUserAgents: false }));
    expect(result.agents).toEqual([]);
    expect(result.sources.some((s) => s.scope === 'user' && s.kind === 'agent')).toBe(false);
  });
});

describe('resolveDefinition', () => {
  beforeEach(() => {
    write(path.join(home, 'agents', 'reviewer.md'), agentFile('reviewer'));
    write(path.join(projectA, '.claude', 'agents', 'reviewer.md'), agentFile('reviewer'));
    write(path.join(projectB, '.claude', 'agents', 'only-b.md'), agentFile('only-b'));
  });

  it('prefers the project definition containing the session directory', () => {
    const { agents } = discoverDefinitions(home, config());
    const inA = resolveDefinition('reviewer', 'agent', agents, path.join(projectA, 'src'));
    expect(inA.entry?.filePath).toBe(path.join(projectA, '.claude', 'agents', 'reviewer.md'));
    const elsewhere = resolveDefinition('reviewer', 'agent', agents, path.join(root, 'other'));
    expect(elsewhere.entry?.filePath).toBe(path.join(home, 'agents', 'reviewer.md'));
  });

  it('never attributes a project definition outside its project or without a directory', () => {
    const { agents } = discoverDefinitions(home, config());
    expect(resolveDefinition('only-b', 'agent', agents, projectA).recognized).toBe(false);
    expect(resolveDefinition('only-b', 'agent', agents, undefined).recognized).toBe(false);
    expect(resolveDefinition('only-b', 'agent', agents, projectB).recognized).toBe(true);
  });

  it('refuses an ambiguous name and an unknown one', () => {
    write(path.join(home, 'agents', 'reviewer-copy.md'), agentFile('reviewer'));
    const { agents } = discoverDefinitions(home, config());
    expect(resolveDefinition('reviewer', 'agent', agents, path.join(root, 'x')).recognized).toBe(
      false,
    );
    expect(resolveDefinition('general-purpose', 'agent', agents, projectA).recognized).toBe(false);
  });

  it('does not match an agent name against a skill', () => {
    write(path.join(home, 'skills', 'reviewer', 'SKILL.md'), agentFile('reviewer'));
    const { agents } = discoverDefinitions(home, config({ skillInclude: ['*'] }));
    expect(resolveDefinition('reviewer', 'skill', agents, path.join(root, 'x')).entry?.kind).toBe(
      'skill',
    );
  });
});

describe('helpers', () => {
  it('matches skill patterns with * only', () => {
    expect(matchesSkillPattern('figma-ui', 'figma-ui')).toBe(true);
    expect(matchesSkillPattern('figma-ui', 'figma*')).toBe(true);
    expect(matchesSkillPattern('figma-ui', 'fig.a-ui')).toBe(false);
    expect(matchesSkillPattern('figma-ui', '')).toBe(false);
  });

  it('keeps the user-level roster scan', () => {
    write(path.join(home, 'agents', 'a.md'), agentFile('a'));
    expect(discoverNativeAgents(path.join(home, 'agents')).map((a) => a.name)).toEqual(['a']);
    expect(discoverNativeAgents(path.join(root, 'missing'))).toEqual([]);
  });
});
