import { describe, expect, it } from 'vitest';
import { extractPlaywrightTestCode, parseCounts, validatePlaywrightTest } from './playwrightRunner';

describe('extractPlaywrightTestCode', () => {
  it('unwraps fenced Playwright specs', () => {
    const code = extractPlaywrightTestCode("```ts\nimport { test } from '@playwright/test';\ntest('x', () => {});\n```");
    expect(code).toContain("import { test } from '@playwright/test';");
    expect(code).not.toContain('```');
  });

  it('strips simple Playwright type annotations', () => {
    const code = extractPlaywrightTestCode("import { test } from '@playwright/test';\ntest('x', async ({ page: Page }) => {});");
    expect(code).toContain('page })');
  });
});

describe('validatePlaywrightTest', () => {
  it('accepts a minimal Playwright spec', () => {
    const result = validatePlaywrightTest("import { test } from '@playwright/test';\ntest('x', async ({ page }) => {});");
    expect(result.ok).toBe(true);
  });

  it('rejects prose without a Playwright import', () => {
    const result = validatePlaywrightTest('Click the login button and check the title.');
    expect(result.ok).toBe(false);
  });
});

describe('parseCounts', () => {
  it('uses Playwright reporter stats when present', () => {
    const counts = parseCounts(JSON.stringify({
      stats: { expected: 2, flaky: 1, skipped: 3, unexpected: 4 },
      suites: [],
    }));
    expect(counts).toEqual({ passed: 3, failed: 4, skipped: 3 });
  });

  it('falls back to suite test outcomes', () => {
    const counts = parseCounts(JSON.stringify({
      suites: [{
        specs: [{
          ok: false,
          tests: [
            { status: 'expected', results: [{ status: 'passed' }] },
            { status: 'unexpected', results: [{ status: 'failed' }] },
            { status: 'skipped', results: [] },
          ],
        }],
      }],
    }));
    expect(counts).toEqual({ passed: 1, failed: 1, skipped: 1 });
  });
});
