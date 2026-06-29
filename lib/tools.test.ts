import { describe, it, expect } from 'vitest';
import type { Sandbox } from 'e2b';
import { makeTools } from './tools';

// request_approval is the agent's "stop and ask the user" gate. If its input schema is too
// strict, a model that returns, say, five options (instead of the suggested 2-3) fails schema
// validation — which surfaces to the user as a broken, un-actionable approval card. These tests
// pin the deliberately-generous bounds so that regression can't sneak back in.

const tools = makeTools({} as unknown as Sandbox);
// The zod schema we passed to tool() is preserved as .inputSchema.
const schema = (tools.request_approval as { inputSchema: { safeParse: (v: unknown) => { success: boolean } } }).inputSchema;
const runPlaywrightSchema = (tools.run_playwright_test as { inputSchema: { safeParse: (v: unknown) => { success: boolean } } }).inputSchema;

describe('request_approval input schema — accepts realistic model output', () => {
  it('accepts the suggested 2-3 options', () => {
    expect(schema.safeParse({ summary: 'Implement the endpoint', options: ['Do A', 'Do B', 'Do C'] }).success).toBe(true);
  });

  it('accepts a single option (model proposes one path)', () => {
    expect(schema.safeParse({ summary: 'Proceed?', options: ['Implement as described'] }).success).toBe(true);
  });

  it('accepts more than three options (model lists plan steps as options)', () => {
    expect(schema.safeParse({ summary: 's', options: ['a', 'b', 'c', 'd', 'e'] }).success).toBe(true);
  });

  it('accepts a long, detailed summary', () => {
    expect(schema.safeParse({ summary: 'x'.repeat(2000), options: ['a', 'b'] }).success).toBe(true);
  });

  it('accepts a long option description', () => {
    expect(schema.safeParse({ summary: 's', options: ['Implement '.repeat(30).trim()] }).success).toBe(true);
  });
});

describe('request_approval input schema — still rejects genuinely empty calls', () => {
  it('rejects an empty options array', () => {
    expect(schema.safeParse({ summary: 's', options: [] }).success).toBe(false);
  });

  it('rejects a missing summary', () => {
    expect(schema.safeParse({ options: ['a', 'b'] }).success).toBe(false);
  });

  it('rejects empty-string options', () => {
    expect(schema.safeParse({ summary: 's', options: [''] }).success).toBe(false);
  });
});

describe('run_playwright_test input schema', () => {
  it('accepts visual runs for streamed browser replay', () => {
    expect(runPlaywrightSchema.safeParse({
      testCode: "import { test } from '@playwright/test';\ntest('x', async ({ page }) => { await page.goto('https://example.com'); });",
      baseUrl: 'https://example.com',
      visual: true,
    }).success).toBe(true);
  });
});
