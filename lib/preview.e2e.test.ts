import { describe, it, expect, afterAll } from 'vitest';
import { startLivePreview, killPreviewSandbox } from './preview';

// Real end-to-end against E2B: boots a desktop sandbox, starts the noVNC stream, and tears
// it down. It costs a (short-lived) sandbox and needs network, so it only runs when
// E2B_API_KEY is set — CI without the key skips it, keeping the default suite deterministic.
const LIVE = Boolean(process.env.E2B_API_KEY);

describe.skipIf(!LIVE)('startLivePreview (live E2B)', () => {
  const sessionId = `vitest-e2e-${process.pid}-${Math.random().toString(36).slice(2)}`;

  afterAll(async () => {
    await killPreviewSandbox(sessionId);
  });

  it('boots a desktop sandbox and returns an embeddable noVNC URL', async () => {
    const { streamUrl } = await startLivePreview(sessionId, 'https://example.com/');
    expect(streamUrl).toMatch(/^https:\/\/6080-[a-z0-9]+\.e2b\.app\/vnc\.html/);
    expect(streamUrl).toContain('autoconnect=true');
  }, 90_000);

  it('rejects a private target before booting anything', async () => {
    await expect(startLivePreview(sessionId, 'http://localhost:3000/')).rejects.toThrow(/public hostname/);
  });
});
