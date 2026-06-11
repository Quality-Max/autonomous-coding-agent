import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// Mock the sandbox-touching modules so these tests exercise the route contract only —
// no E2B network calls. The real SSRF validation lives in startLivePreview and is covered
// by lib/preview.test.ts; here we assert the HTTP behaviour around it.
vi.mock('@/lib/preview', () => ({
  startLivePreview: vi.fn(),
  killPreviewSandbox: vi.fn(),
}));
vi.mock('@/lib/sandbox', () => ({
  killSandbox: vi.fn(),
}));

import { POST, DELETE } from './route';
import { startLivePreview, killPreviewSandbox } from '@/lib/preview';
import { killSandbox } from '@/lib/sandbox';

function req(method: string, body: unknown): NextRequest {
  return new Request('http://localhost/api/preview', {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as unknown as NextRequest;
}

beforeEach(() => vi.clearAllMocks());

describe('POST /api/preview', () => {
  it('spins up a preview and returns the stream URL', async () => {
    vi.mocked(startLivePreview).mockResolvedValue({ streamUrl: 'https://6080-x.e2b.app/vnc.html' });
    const res = await POST(req('POST', { sessionId: 's1', url: 'https://8000-x.e2b.app/' }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ streamUrl: 'https://6080-x.e2b.app/vnc.html' });
    expect(startLivePreview).toHaveBeenCalledWith('s1', 'https://8000-x.e2b.app/', undefined);
  });

  it('forwards the BYOK e2bKey to startLivePreview', async () => {
    vi.mocked(startLivePreview).mockResolvedValue({ streamUrl: 'https://6080-x.e2b.app/vnc.html' });
    const res = await POST(req('POST', { sessionId: 's1', url: 'https://8000-x.e2b.app/', e2bKey: 'e2b_byok' }));
    expect(res.status).toBe(200);
    expect(startLivePreview).toHaveBeenCalledWith('s1', 'https://8000-x.e2b.app/', 'e2b_byok');
  });

  it('rejects a missing url with 400 and never touches the sandbox', async () => {
    const res = await POST(req('POST', { sessionId: 's1' }));
    expect(res.status).toBe(400);
    expect(startLivePreview).not.toHaveBeenCalled();
  });

  it('rejects a non-URL string with 400', async () => {
    const res = await POST(req('POST', { sessionId: 's1', url: 'not-a-url' }));
    expect(res.status).toBe(400);
    expect(startLivePreview).not.toHaveBeenCalled();
  });

  it('surfaces a validation/boot failure as 502', async () => {
    vi.mocked(startLivePreview).mockRejectedValue(
      new Error('Preview URL must point at a public hostname, got: localhost'),
    );
    const res = await POST(req('POST', { sessionId: 's1', url: 'https://example.com/' }));
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringMatching(/public hostname/) });
  });
});

describe('DELETE /api/preview', () => {
  it('tears down both the coding and preview sandboxes', async () => {
    const res = await DELETE(req('DELETE', { sessionId: 's1' }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(killSandbox).toHaveBeenCalledWith('s1', undefined);
    expect(killPreviewSandbox).toHaveBeenCalledWith('s1', undefined);
  });

  it('forwards the BYOK e2bKey when tearing down', async () => {
    const res = await DELETE(req('DELETE', { sessionId: 's1', e2bKey: 'e2b_byok' }));
    expect(res.status).toBe(200);
    expect(killSandbox).toHaveBeenCalledWith('s1', 'e2b_byok');
    expect(killPreviewSandbox).toHaveBeenCalledWith('s1', 'e2b_byok');
  });

  it('rejects a missing sessionId with 400 and kills nothing', async () => {
    const res = await DELETE(req('DELETE', {}));
    expect(res.status).toBe(400);
    expect(killSandbox).not.toHaveBeenCalled();
    expect(killPreviewSandbox).not.toHaveBeenCalled();
  });
});
