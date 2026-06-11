import { createMCPClient } from '@ai-sdk/mcp';
import { z } from 'zod';
import type { ToolSet } from 'ai';
import type { MCPServerConfig } from './types';

export type { MCPServerConfig };

export interface MCPServerMeta {
  name: string;
  description: string;
}

export interface MCPToolInfo {
  name: string;
  description: string;
}

// Auth header format accepted from clients (shared with the agent route's schema).
export const SAFE_AUTH = /^(Bearer|Basic) [^\s]{1,512}$/;

// Blocks loopback, link-local (cloud metadata), and RFC-1918 ranges to prevent SSRF.
export function isSafeSSEUrl(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  const h = url.hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (h === 'localhost' || h === '0.0.0.0') return false;
  if (/^127\./.test(h)) return false;                          // loopback
  if (/^169\.254\./.test(h)) return false;                     // link-local / EC2 & Azure metadata
  if (/^100\.100\.100\./.test(h)) return false;                // Alibaba Cloud metadata
  if (/^fd00::/i.test(h) || h === '::1') return false;         // IPv6 loopback / ULA
  if (/^10\./.test(h)) return false;                           // RFC-1918 class A
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;     // RFC-1918 class B
  if (/^192\.168\./.test(h)) return false;                     // RFC-1918 class C
  return true;
}

// Picks the MCP transport for a server URL. Streamable HTTP is the current standard; the
// legacy SSE transport is deprecated and actively being shut off (Linear removed its /sse
// endpoint after 2026-04-08). We route by path: an explicit .../sse endpoint still uses SSE,
// everything else (e.g. Linear's https://mcp.linear.app/mcp) uses Streamable HTTP.
export function mcpTransportType(url: string): 'sse' | 'http' {
  let pathname: string;
  try { pathname = new URL(url).pathname; } catch { return 'http'; }
  return pathname.replace(/\/+$/, '').endsWith('/sse') ? 'sse' : 'http';
}

function mcpTransport(config: MCPServerConfig) {
  return {
    type: mcpTransportType(config.url),
    url: config.url,
    headers: config.auth ? { Authorization: config.auth } : undefined,
  };
}

// Zod schema applied to every entry in the MCP_SERVERS env var array.
// Applies the same SSRF guard as user-supplied servers in route.ts.
const EnvServerSchema = z.object({
  name: z.string().min(1).max(64),
  url: z.string().refine(isSafeSSEUrl, { message: 'URL must be a safe public http(s) endpoint' }),
  auth: z.string().optional(),
  description: z.string().optional(),
});

function resolveEnvConfigs(): MCPServerConfig[] {
  const configs: MCPServerConfig[] = [];

  if (process.env.LINEAR_API_KEY) {
    const key = process.env.LINEAR_API_KEY.trim();
    if (!key.startsWith('lin_api_')) {
      console.warn('[mcp] LINEAR_API_KEY does not match expected "lin_api_..." format — skipping');
    } else {
      configs.push({
        name: 'linear',
        url: 'https://mcp.linear.app/mcp', // Streamable HTTP; the legacy /sse endpoint was shut off after 2026-04-08
        auth: `Bearer ${key}`, // nosemgrep: llm-hardcoded-secret — key is from env var, format-validated (lin_api_ prefix), never logged
        description: 'Issues, projects, teams',
      });
    }
  }

  if (process.env.MCP_SERVERS) {
    try {
      const parsed = JSON.parse(process.env.MCP_SERVERS);
      if (!Array.isArray(parsed)) throw new Error('expected a JSON array');
      for (const item of parsed) {
        const result = EnvServerSchema.safeParse(item);
        if (result.success) {
          configs.push(result.data);
        } else {
          console.error('[mcp] Skipping invalid MCP_SERVERS entry:', result.error.flatten().fieldErrors);
        }
      }
    } catch (err) {
      console.error('[mcp] Invalid MCP_SERVERS env var —', (err as Error).message);
    }
  }

  return configs;
}

export function getConfiguredServers(): MCPServerMeta[] {
  return resolveEnvConfigs().map(c => ({ name: c.name, description: c.description ?? '' }));
}

// Resolves the full config (incl. server-side auth) for an env-configured server by name.
// Lets the introspection route list an env server's tools without the client ever holding
// the credential. Returns undefined for unknown names.
export function getEnvServerConfig(name: string): MCPServerConfig | undefined {
  return resolveEnvConfigs().find(c => c.name === name);
}

// Connects to a single server and returns the tools it exposes (name + description).
// Used by the UI to show what a connected server actually provides, rather than a
// static blurb. The connection is closed before returning.
export async function listServerTools(config: MCPServerConfig): Promise<MCPToolInfo[]> {
  const client = await createMCPClient({
    transport: mcpTransport(config),
    clientName: 'autonomous-coding-agent',
  });
  try {
    const tools = await client.tools();
    return Object.entries(tools)
      .map(([name, tool]) => ({
        name,
        description: (tool as { description?: string }).description ?? '',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    await client.close().catch(() => {});
  }
}

export async function loadMCPTools(userServers: MCPServerConfig[] = []): Promise<{
  tools: ToolSet;
  cleanup: () => Promise<void>;
}> {
  const envConfigs = resolveEnvConfigs();
  // Deduplicate: env-configured servers win; drop user entries with the same name.
  const envNames = new Set(envConfigs.map(c => c.name));
  const configs = [...envConfigs, ...userServers.filter(s => !envNames.has(s.name))];

  if (configs.length === 0) {
    return { tools: {}, cleanup: async () => {} };
  }

  const clients: Array<{ close: () => Promise<void> }> = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allTools: Record<string, any> = {};

  for (const config of configs) {
    try {
      const client = await createMCPClient({
        transport: mcpTransport(config),
        clientName: 'autonomous-coding-agent',
      });
      const tools = await client.tools();
      Object.assign(allTools, tools);
      clients.push(client);
    } catch (err) {
      // Log only the message string — the full Error object can include request headers/URL which may contain auth tokens.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[mcp] Failed to connect to "${config.name}":`, msg);
    }
  }

  let closed = false;
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    for (const client of clients) {
      await client.close().catch(() => {});
    }
  };

  return { tools: allTools, cleanup };
}
