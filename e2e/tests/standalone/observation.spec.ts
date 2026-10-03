import fs from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { expect, test } from '../../fixtures/standalone';
import { sendHookEvent, sessionStartStartup } from '../../helpers/hooks';
import { expectOverlayCount } from '../../helpers/office';
import { createClaudeTranscript } from '../../helpers/team';
import { setSettings } from '../../helpers/webview';

// The roster is re-scanned every 3 s (nativeAgentRoster.ts); allow a couple
// of rounds plus render slop.
const ROSTER_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 15_000;

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function append(file: string, record: Record<string, unknown>): void {
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
}

/** Every file under `dir` with its bytes — to prove the office wrote nothing. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    out[path.relative(dir, full)] = fs.readFileSync(full, 'base64');
  }
  return out;
}

async function openAgentPanel(page: Page) {
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  return page.locator('table').first();
}

test.describe('Standalone / observation', () => {
  test('discovers a new agent file and follows a delegation to it without writing agent data @area:standalone', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, {
      alwaysShowLabels: true,
      hooksEnabled: true,
      watchAllSessions: true,
      debugView: false,
    });

    // A new agent appears in Claude Code's own directory — no Office code
    // change, no registration, no "add character" form.
    const agentsDir = path.join(standalone.tmpHome, '.claude', 'agents');
    write(
      path.join(agentsDir, 'skill-retriever.md'),
      '---\nname: skill-retriever\ndescription: Finds relevant skills.\n---\nInstructions.\n',
    );
    const table = await openAgentPanel(page);
    const row = table.locator('tr', { hasText: 'skill-retriever' });
    await expect(row).toContainText('待命', { timeout: ROSTER_TIMEOUT_MS });

    // A session delegates to it: the transcript is the only evidence used.
    const sessionId = 'observe-session-1';
    const { transcriptPath } = createClaudeTranscript(
      standalone.tmpHome,
      standalone.workspaceDir,
      sessionId,
    );
    const agentSideBefore = {
      agents: snapshot(agentsDir),
      workspace: snapshot(standalone.workspaceDir),
    };
    await sendHookEvent(
      standalone.hookServerConfig,
      sessionStartStartup(sessionId, standalone.workspaceDir, transcriptPath),
    );
    append(transcriptPath, {
      type: 'assistant',
      cwd: standalone.workspaceDir,
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_observe_1',
            name: 'Agent',
            input: {
              subagent_type: 'skill-retriever',
              description: 'Find auth skills',
              prompt: 'Find auth skills\nPRIVATE-PROMPT-DETAIL',
            },
          },
        ],
      },
    });
    await expect(row).toContainText('工作中', { timeout: CALL_TIMEOUT_MS });
    await expect(row).toContainText('Find auth skills');

    // One piece of work, one character: the session's own character plus the
    // resident — the transient Subtask for the same call stays hidden.
    await expectOverlayCount(page, 2, CALL_TIMEOUT_MS);

    append(transcriptPath, {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_observe_1',
            content: [{ type: 'text', text: 'Found 3 skills.' }],
          },
        ],
      },
    });
    await expect(row).toContainText('待命', { timeout: CALL_TIMEOUT_MS });
    const history = page.locator('table').nth(1);
    await expect(history.locator('tr', { hasText: 'Find auth skills' })).toContainText('已結束');
    await expect(page.getByText('PRIVATE-PROMPT-DETAIL')).toHaveCount(0);

    // The office wrote nothing into the agent side.
    expect(snapshot(agentsDir)).toEqual(agentSideBefore.agents);
    expect(snapshot(standalone.workspaceDir)).toEqual(agentSideBefore.workspace);
    // And its own records stay in its own data root.
    expect(fs.existsSync(path.join(standalone.tmpHome, '.agent-office', 'agent-office.db'))).toBe(
      true,
    );
  });
});
