import { describe, it, expect, afterEach } from 'vitest';
import { mcpTransportType, getEnvServerConfig } from './mcp';

// Linear shut off its legacy /sse transport (after 2026-04-08); the working endpoint is now
// Streamable HTTP at /mcp. These tests pin the transport-selection rule and the Linear default
// so the deprecated transport can't sneak back in.

describe('mcpTransportType — routes by URL path', () => {
  it('uses Streamable HTTP for Linear\'s /mcp endpoint', () => {
    expect(mcpTransportType('https://mcp.linear.app/mcp')).toBe('http');
  });

  it('uses SSE only for an explicit /sse endpoint', () => {
    expect(mcpTransportType('https://mcp.linear.app/sse')).toBe('sse');
    expect(mcpTransportType('https://example.com/sse/')).toBe('sse');       // trailing slash
    expect(mcpTransportType('https://example.com/v1/sse?token=x')).toBe('sse'); // query string
  });

  it('defaults to Streamable HTTP for non-/sse paths', () => {
    expect(mcpTransportType('https://example.com/mcp')).toBe('http');
    expect(mcpTransportType('https://example.com/')).toBe('http');
    expect(mcpTransportType('https://example.com/path/ssefoo')).toBe('http'); // not a /sse segment
  });

  it('falls back to Streamable HTTP for an unparseable URL', () => {
    expect(mcpTransportType('not a url')).toBe('http');
  });
});

describe('Linear env server default', () => {
  afterEach(() => { delete process.env.LINEAR_API_KEY; });

  it('points the built-in Linear server at the Streamable HTTP /mcp endpoint', () => {
    process.env.LINEAR_API_KEY = 'lin_api_testkey';
    const linear = getEnvServerConfig('linear');
    expect(linear?.url).toBe('https://mcp.linear.app/mcp');
    expect(mcpTransportType(linear!.url)).toBe('http');
  });
});
