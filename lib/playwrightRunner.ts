import { Sandbox } from 'e2b';
import { assertSafeHttpUrl, shellQuote } from './preview';

const DEFAULT_TEMPLATE = 'qualitymax-playwright';
const REMOTE_DIR = '/home/user/qmax-playwright';
const DEFAULT_TIMEOUT_SECONDS = 180;
const MAX_TIMEOUT_SECONDS = 300;

export interface PlaywrightRunResult {
  success: boolean;
  status: 'passed' | 'failed' | 'error';
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  totalTests: number;
  durationSeconds: number;
  testOutput: string;
  testErrors: string;
  errorMessage: string | null;
  framework: 'playwright';
  template: string;
}

function resultError(message: string, durationSeconds = 0, template = playwrightTemplate()): PlaywrightRunResult {
  return {
    success: false,
    status: 'error',
    passedTests: 0,
    failedTests: 0,
    skippedTests: 0,
    totalTests: 0,
    durationSeconds,
    testOutput: '',
    testErrors: message,
    errorMessage: message,
    framework: 'playwright',
    template,
  };
}

function playwrightTemplate(): string {
  return process.env.E2B_PLAYWRIGHT_TEMPLATE || process.env.E2B_TEMPLATE || DEFAULT_TEMPLATE;
}

function stripTypescriptTypes(code: string): string {
  return code
    .replace(/import\s+type\s+\{[^}]*\}\s+from\s+['"][^'"]*['"];?\s*/g, '')
    .replace(/(\w+)\s*:\s*(?:Page|BrowserContext|Browser|Locator|FrameLocator|APIRequestContext)\b/g, '$1');
}

export function extractPlaywrightTestCode(raw: string): string {
  let code = raw.trim();
  const fence = code.match(/```(?:ts|tsx|js|jsx|typescript|javascript)?\s*\n([\s\S]*?)\n?```/i);
  if (fence) code = fence[1].trim();
  while (code.startsWith('```')) code = code.slice(3).trim();
  while (code.endsWith('```')) code = code.slice(0, -3).trim();
  return stripTypescriptTypes(code);
}

export function validatePlaywrightTest(raw: string): { ok: true; code: string } | { ok: false; error: string } {
  const code = extractPlaywrightTestCode(raw);
  if (code.length < 20) return { ok: false, error: 'Playwright test is too short.' };
  if (!/(from\s+['"]@playwright\/test['"]|require\(['"]@playwright\/test['"]\))/.test(code)) {
    return { ok: false, error: 'Playwright test must import @playwright/test.' };
  }
  if (!/\btest\s*\(/.test(code)) return { ok: false, error: 'Playwright test must contain at least one test(...) call.' };
  return { ok: true, code };
}

function buildConfig(baseUrl: string | undefined): string {
  const baseUrlLine = baseUrl ? `\n    baseURL: ${JSON.stringify(baseUrl)},` : '';
  return [
    "const { defineConfig } = require('@playwright/test');",
    'module.exports = defineConfig({',
    "  testDir: './',",
    '  timeout: 30000,',
    '  retries: 0,',
    '  workers: 1,',
    "  reporter: [['json', { outputFile: 'results.json' }], ['list']],",
    '  use: {',
    '    headless: true,' + baseUrlLine,
    '    viewport: { width: 1280, height: 720 },',
    "    screenshot: 'only-on-failure',",
    '    actionTimeout: 15000,',
    '  },',
    '});',
    '',
  ].join('\n');
}

export function parseCounts(raw: string): { passed: number; failed: number; skipped: number } {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  try {
    const data = JSON.parse(raw) as { stats?: unknown; suites?: unknown[] };
    const stats = data.stats as { expected?: unknown; flaky?: unknown; skipped?: unknown; unexpected?: unknown } | undefined;
    if (stats && [stats.expected, stats.flaky, stats.skipped, stats.unexpected].every(value => typeof value === 'number')) {
      return {
        passed: (stats.expected as number) + (stats.flaky as number),
        failed: stats.unexpected as number,
        skipped: stats.skipped as number,
      };
    }
    const walk = (suites: unknown[]) => {
      for (const suite of suites) {
        const s = suite as { specs?: unknown[]; suites?: unknown[] };
        for (const spec of s.specs || []) {
          const sp = spec as { ok?: boolean; tests?: unknown[] };
          for (const test of sp.tests || []) {
            const t = test as { status?: string; results?: Array<{ status?: string }> };
            const statuses = [
              t.status,
              Array.isArray(t.results) ? t.results.at(-1)?.status : undefined,
            ].map(status => (status || '').toLowerCase());
            if (statuses.some(status => status === 'skipped')) skipped += 1;
            else if (statuses.some(status => status === 'expected' || status === 'passed' || status === 'flaky')) passed += 1;
            else if (statuses.some(status => status === 'unexpected' || status === 'failed' || status === 'timedout' || status === 'interrupted')) failed += 1;
            else if (sp.ok === true) passed += 1;
            else failed += 1;
          }
        }
        walk(s.suites || []);
      }
    };
    walk(data.suites || []);
  } catch {}
  return { passed, failed, skipped };
}

function playwrightCommand(baseUrl: string | undefined): string {
  const env = [
    `export PLAYWRIGHT_BROWSERS_PATH=${shellQuote(process.env.PLAYWRIGHT_BROWSERS_PATH || '/ms-playwright')}`,
    'export NODE_PATH="$(npm root -g 2>/dev/null)${NODE_PATH:+:$NODE_PATH}"',
  ];
  if (baseUrl) env.push(`export BASE_URL=${shellQuote(baseUrl)}`);

  const runner = [
    "const { spawnSync } = require('node:child_process');",
    "const cli = require.resolve('@playwright/test/cli');",
    "const result = spawnSync(process.execPath, [cli, 'test', 'test.spec.js'], { stdio: 'inherit' });",
    'process.exit(result.status ?? 1);',
  ].join(' ');

  return `cd ${shellQuote(REMOTE_DIR)} && ${env.join(' && ')} && node -e ${shellQuote(runner)} || true`;
}

export async function runPlaywrightTestInE2B(input: {
  testCode: string;
  baseUrl?: string;
  timeoutSeconds?: number;
  e2bKey?: string;
}): Promise<PlaywrightRunResult> {
  const started = Date.now();
  const template = playwrightTemplate();
  const validated = validatePlaywrightTest(input.testCode);
  if (!validated.ok) return resultError(validated.error, 0, template);
  const baseUrl = input.baseUrl ? assertSafeHttpUrl(input.baseUrl) : undefined;
  const timeoutSeconds = Math.min(input.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS);
  const opts = input.e2bKey ? { apiKey: input.e2bKey } : {};
  let sandbox: Sandbox | null = null;
  try {
    sandbox = await Sandbox.create(template, { ...opts, timeoutMs: (timeoutSeconds + 30) * 1000 });
    await sandbox.commands.run(`mkdir -p ${shellQuote(REMOTE_DIR)}`, { timeoutMs: 10_000 });
    await sandbox.files.write(`${REMOTE_DIR}/test.spec.js`, validated.code);
    await sandbox.files.write(`${REMOTE_DIR}/playwright.config.js`, buildConfig(baseUrl));
    const cmd = playwrightCommand(baseUrl);
    const result = await sandbox.commands.run(cmd, { timeoutMs: timeoutSeconds * 1000 });
    const stdout = String((result as { stdout?: unknown }).stdout ?? '');
    const stderr = String((result as { stderr?: unknown }).stderr ?? '');
    let reporterRaw = stdout;
    try { reporterRaw = await sandbox.files.read(`${REMOTE_DIR}/results.json`); } catch {}
    const counts = parseCounts(reporterRaw);
    const total = counts.passed + counts.failed + counts.skipped;
    const status: PlaywrightRunResult['status'] = total === 0 ? 'error' : counts.failed > 0 ? 'failed' : 'passed';
    const errorMessage = status === 'error'
      ? 'Playwright reported 0 tests (empty spec or no matching tests)'
      : status === 'failed'
        ? (stderr.trim().split('\n').at(-1) || 'one or more tests failed')
        : null;
    return {
      success: status === 'passed',
      status,
      passedTests: counts.passed,
      failedTests: counts.failed,
      skippedTests: counts.skipped,
      totalTests: total,
      durationSeconds: Math.round(((Date.now() - started) / 1000) * 100) / 100,
      testOutput: stdout.slice(-4000),
      testErrors: stderr.slice(-4000),
      errorMessage,
      framework: 'playwright',
      template,
    };
  } catch (err) {
    return resultError(err instanceof Error ? err.message : String(err), (Date.now() - started) / 1000, template);
  } finally {
    if (sandbox) await Sandbox.kill(sandbox.sandboxId, opts).catch(() => {});
  }
}
