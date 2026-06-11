import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the MCP client wrapper so these tests exercise the route contract only — no real
// SSE connection. The SSRF guard (isSafeSSEUrl) and auth regex (SAFE_AUTH) are the real
// implementations from lib/mcp, so validation behaviour is covered end-to-end here.
vi.mock('@/lib/mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mcp')>();
  return { ...actual, listServerTools: vi.fn(), getEnvServerConfig: vi.fn() };
});

import { POST } from './route';
import { listServerTools, getEnvServerConfig } from '@/lib/mcp';

function req(body: unknown): Request {
  return new Request('http://localhost/api/mcp/tools', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => vi.clearAllMocks());

describe('POST /api/mcp/tools', () => {
  it('returns the tools a server exposes', async () => {
    const tools = [
      { name: 'linear_create_issue', description: 'Create an issue' },
      { name: 'linear_list_issues', description: 'List issues' },
    ];
    vi.mocked(listServerTools).mockResolvedValue(tools);

    const res = await POST(req({ name: 'linear', url: 'https://mcp.linear.app/sse', auth: 'Bearer lin_api_x' }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ tools });
    expect(listServerTools).toHaveBeenCalledWith({
      name: 'linear',
      url: 'https://mcp.linear.app/sse',
      auth: 'Bearer lin_api_x',
    });
  });

  it('lists tools for a name-only (env) server, resolving its config server-side', async () => {
    vi.mocked(getEnvServerConfig).mockReturnValue({
      name: 'linear',
      url: 'https://mcp.linear.app/sse',
      auth: 'Bearer lin_api_env_secret',
    });
    vi.mocked(listServerTools).mockResolvedValue([{ name: 'linear_list_issues', description: '' }]);

    const res = await POST(req({ name: 'linear' }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ tools: [{ name: 'linear_list_issues', description: '' }] });
    // The client never supplied a URL/auth — the route used the env-resolved config.
    expect(getEnvServerConfig).toHaveBeenCalledWith('linear');
    expect(listServerTools).toHaveBeenCalledWith({
      name: 'linear',
      url: 'https://mcp.linear.app/sse',
      auth: 'Bearer lin_api_env_secret',
    });
  });

  it('rejects a name-only request for an unknown (non-env) server with 400', async () => {
    vi.mocked(getEnvServerConfig).mockReturnValue(undefined);
    const res = await POST(req({ name: 'nope' }));
    expect(res.status).toBe(400);
    expect(listServerTools).not.toHaveBeenCalled();
  });

  it('rejects an internal/metadata host (SSRF) with 400', async () => {
    const res = await POST(req({ name: 'evil', url: 'http://169.254.169.254/latest/meta-data' }));
    expect(res.status).toBe(400);
    expect(listServerTools).not.toHaveBeenCalled();
  });

  it('rejects a malformed auth header with 400', async () => {
    const res = await POST(req({ name: 'x', url: 'https://mcp.example.com/sse', auth: 'token-without-scheme' }));
    expect(res.status).toBe(400);
    expect(listServerTools).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON with 400', async () => {
    const bad = new Request('http://localhost/api/mcp/tools', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    const res = await POST(bad);
    expect(res.status).toBe(400);
    expect(listServerTools).not.toHaveBeenCalled();
  });

  it('surfaces a connection failure as 502 without leaking the error detail', async () => {
    vi.mocked(listServerTools).mockRejectedValue(new Error('Authorization: Bearer secret-token leaked'));
    const res = await POST(req({ name: 'x', url: 'https://mcp.example.com/sse' }));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('Could not connect to server');
    expect(JSON.stringify(body)).not.toContain('secret-token');
  });
});
