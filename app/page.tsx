'use client';

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { UIMessage } from 'ai';
import Header from '@/components/Header';
import AgentLog from '@/components/AgentLog';
import Composer from '@/components/Composer';
import Workspace from '@/components/Workspace';
import type { ProviderName, TouchedFile, MCPServerConfig, PlanStep, ApiKeys } from '@/lib/types';
import type { MCPServerMeta } from '@/lib/mcp';

function newSessionId() { return crypto.randomUUID(); }

// AI SDK v6 sends tool parts in two possible formats:
//   DynamicToolUIPart — type: 'dynamic-tool', toolName field
//   Static ToolUIPart — type: 'tool-{toolName}' (no separate toolName field)
// Both must be handled.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getToolName(part: any): string | null {
  if (part.type === 'dynamic-tool') return part.toolName ?? null;
  if (typeof part.type === 'string' && part.type.startsWith('tool-')) return part.type.slice(5);
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getToolOutput(part: any): Record<string, unknown> | null {
  if (part.state !== 'output-available') return null;
  return part.output as Record<string, unknown> ?? null;
}

function usePreviewUrl(messages: UIMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const part of messages[i].parts ?? []) {
      if (getToolName(part) === 'expose_port') {
        const out = getToolOutput(part);
        if (out?.url) return out.url as string;
      }
    }
  }
  return null;
}

function usePlaywrightVisualUrl(messages: UIMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const part of messages[i].parts ?? []) {
      if (getToolName(part) === 'run_playwright_test') {
        const out = getToolOutput(part);
        if (typeof out?.streamUrl === 'string') return out.streamUrl;
      }
    }
  }
  return null;
}

function usePlan(messages: UIMessage[]): PlanStep[] {
  // The latest update_plan call wins — each call replaces the whole plan.
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i].parts ?? [];
    for (let j = parts.length - 1; j >= 0; j--) {
      if (getToolName(parts[j]) === 'update_plan') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const input = (parts[j] as any).input as { steps?: PlanStep[] } | undefined;
        if (input?.steps?.length) return input.steps;
      }
    }
  }
  return [];
}

function useTouchedFiles(messages: UIMessage[]): TouchedFile[] {
  // Use a Map keyed by path so the last write/edit on a file wins.
  const map = new Map<string, TouchedFile>();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const part of m.parts ?? []) {
      const name = getToolName(part);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const input = (part as any).input as Record<string, unknown> | undefined;
      if (!input?.path) continue;
      const path = input.path as string;
      if (name === 'write_file') {
        map.set(path, { path, op: 'write', content: input.content as string });
      } else if (name === 'apply_edit') {
        map.set(path, { path, op: 'edit', search: input.search as string, replace: input.replace as string });
      } else if (name === 'apply_edit_smart') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const output = (part as any).output as Record<string, unknown> | undefined;
        map.set(path, {
          path, op: 'smart',
          edit: input.edit as string,
          model: output?.model as string | undefined,
          linesChanged: output?.linesChanged as number | undefined,
          updatedLines: output?.updatedLines as number | undefined,
        });
      }
    }
  }
  return Array.from(map.values());
}

function useSandboxUp(messages: UIMessage[]): boolean {
  return messages.some(m =>
    m.role === 'assistant' && m.parts?.some(p => getToolName(p) !== null)
  );
}

function normalizeRepoUrl(repo: string): string {
  const trimmed = repo.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  if (trimmed.includes('/')) {
    return trimmed.includes('.') ? `https://${trimmed}` : `https://github.com/${trimmed}`;
  }
  return trimmed;
}

export default function Page() {
  const [sessionId, setSessionId] = useState(newSessionId);
  const [workspaceKey, setWorkspaceKey] = useState(0);
  const [provider, setProvider] = useState<ProviderName>('google');
  const [model, setModel] = useState('gemini-3.1-pro-preview');
  const [repo, setRepo] = useState('');
  const [task, setTask] = useState('');
  const [handoffPreviewUrl, setHandoffPreviewUrl] = useState<string | null>(null);
  // #6 — Start with [] on both server and client to avoid SSR/client hydration mismatch.
  // Load from localStorage in a useEffect (client-only) after first render.
  const [mcpServers, setMCPServers] = useState<MCPServerConfig[]>([]);
  // Servers configured via env vars (e.g. LINEAR_API_KEY) — read-only, credential lives
  // server-side. Surfaced so the user can see/inspect them but not edit or disconnect them.
  const [envServers, setEnvServers] = useState<MCPServerMeta[]>([]);
  // BYOK: the visitor's own API keys, entered in the UI. Empty on the server and on first
  // render to avoid hydration mismatch; loaded from localStorage in a client-only effect.
  const [apiKeys, setApiKeys] = useState<ApiKeys>({});
  const logRef = useRef<HTMLDivElement>(null);

  // Refs for per-call body — avoids stale closure and JSON.stringify getter issues.
  const sessionIdRef = useRef(sessionId);
  const providerRef = useRef(provider);
  const modelRef = useRef(model);
  const mcpServersRef = useRef(mcpServers);
  const apiKeysRef = useRef(apiKeys);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  useEffect(() => { providerRef.current = provider; }, [provider]);
  useEffect(() => { modelRef.current = model; }, [model]);
  useEffect(() => { mcpServersRef.current = mcpServers; }, [mcpServers]);
  useEffect(() => { apiKeysRef.current = apiKeys; }, [apiKeys]);

  useEffect(() => {
    try {
      // Server metadata (name/url/description) persists across sessions.
      // Auth tokens (Bearer keys) are session-only — not written to localStorage.
      const bases = JSON.parse(localStorage.getItem('mcpServers') ?? '[]');
      const authMap: Record<string, string> = JSON.parse(sessionStorage.getItem('mcpAuth') ?? '{}');
      if (Array.isArray(bases)) {
        const restored = bases.map((s: MCPServerConfig) => ({
          ...s,
          auth: typeof authMap[s.name] === 'string' ? authMap[s.name] : undefined,
        }));
        queueMicrotask(() => setMCPServers(restored));
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetch('/api/mcp')
      .then(r => r.json())
      .then(d => { if (Array.isArray(d?.servers)) setEnvServers(d.servers); })
      .catch(() => {});
  }, []);

  // Load BYOK keys from localStorage (client-only). They never leave the browser except
  // as request bodies to this app's own API routes, which use them per-request.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('apiKeys') ?? '{}');
      if (saved && typeof saved === 'object') queueMicrotask(() => setApiKeys(saved as ApiKeys));
    } catch {}
  }, []);

  // Does THIS deployment run on its own server keys? If not (public BYOK deploy), and the
  // visitor hasn't supplied keys, the empty state nudges them to add their own.
  const [serverReady, setServerReady] = useState(true);
  useEffect(() => {
    fetch('/api/config')
      .then(r => r.json())
      .then(d => setServerReady(Boolean(d?.serverReady)))
      .catch(() => {});
  }, []);
  // Handoff from the recognition page (/recognize): a generated test arrives as a task in
  // sessionStorage. Pick it up once, prefill the composer, and clear it. The state update
  // is deferred to a microtask so it isn't a synchronous setState in the effect body.
  useEffect(() => {
    let handoff: string | null = null;
    try { handoff = sessionStorage.getItem('acaHandoffTask'); } catch {}
    if (!handoff) return;
    try { sessionStorage.removeItem('acaHandoffTask'); } catch {}
    let payload: { task: string; provider?: ProviderName; model?: string; appUrl?: string } | null = null;
    try {
      const parsed = JSON.parse(handoff) as unknown;
      if (parsed && typeof parsed === 'object') {
        const record = parsed as { task?: unknown; provider?: unknown; model?: unknown; appUrl?: unknown };
        const providerValue = record.provider;
        if (typeof record.task === 'string') {
          payload = {
            task: record.task,
            provider: providerValue === 'anthropic' || providerValue === 'openai' || providerValue === 'google' || providerValue === 'cerebras'
              ? providerValue
              : undefined,
            model: typeof record.model === 'string' ? record.model : undefined,
            appUrl: typeof record.appUrl === 'string' ? record.appUrl : undefined,
          };
        }
      }
    } catch {}
    const next = payload ?? { task: handoff };
    queueMicrotask(() => {
      setTask(next.task);
      if (next.provider) setProvider(next.provider);
      if (next.model) setModel(next.model);
      setHandoffPreviewUrl(next.appUrl || null);
    });
  }, []);

  const keysReady = Boolean(apiKeys.e2b) && Boolean(apiKeys.anthropic || apiKeys.openai || apiKeys.google || apiKeys.cerebras);
  const needsKeys = !serverReady && !keysReady;

  function handleKeysChange(keys: ApiKeys) {
    setApiKeys(keys);
    try { localStorage.setItem('apiKeys', JSON.stringify(keys)); } catch {}
  }

  function handleMCPChange(servers: MCPServerConfig[]) {
    setMCPServers(servers);
    // Persist server metadata without credentials.
    localStorage.setItem('mcpServers', JSON.stringify(
      servers.map((server) => {
        const { auth, ...rest } = server;
        void auth;
        return rest;
      })
    ));
    // Persist auth tokens in sessionStorage only (cleared on browser close).
    const authMap: Record<string, string> = {};
    for (const s of servers) { if (s.auth) authMap[s.name] = s.auth; }
    sessionStorage.setItem('mcpAuth', JSON.stringify(authMap));
  }

  // Stable transport — body is passed per sendMessage call, not here.
  const transport = useMemo(() => new DefaultChatTransport({ api: '/api/agent' }), []);

  const { messages, sendMessage, stop, status, error, setMessages } = useChat({ transport });

  const isStreaming = status === 'streaming' || status === 'submitted';
  const previewUrl = usePreviewUrl(messages);
  const activePreviewUrl = previewUrl || handoffPreviewUrl;
  const playwrightVisualUrl = usePlaywrightVisualUrl(messages);
  const touchedFiles = useTouchedFiles(messages);
  const plan = usePlan(messages);
  const sandboxUp = useSandboxUp(messages);

  // The desktop (noVNC) stream is user-initiated only: it exists once the user clicks the
  // Desktop toggle, which spins one up on demand. The agent never starts it.
  const [manualVncUrl, setManualVncUrl] = useState<string | null>(null);
  const [vncLoading, setVncLoading] = useState(false);
  const vncUrl = playwrightVisualUrl || manualVncUrl;

  // User clicked Desktop with no stream yet — open the current preview URL in a fresh
  // desktop sandbox (separate from the coding sandbox).
  async function startDesktopPreview() {
    if (vncUrl || vncLoading || !activePreviewUrl) return;
    setVncLoading(true);
    try {
      const res = await fetch('/api/preview', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionIdRef.current, url: activePreviewUrl, e2bKey: apiKeysRef.current.e2b }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.streamUrl) setManualVncUrl(data.streamUrl as string);
    } finally {
      setVncLoading(false);
    }
  }

  // Tear down every sandbox for a session (coding + desktop preview).
  function teardownSandboxes(id: string) {
    void fetch('/api/preview', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: id, e2bKey: apiKeysRef.current.e2b }),
      keepalive: true,
    }).catch(() => {});
  }

  function handleStop() {
    stop();
    teardownSandboxes(sessionIdRef.current);
  }

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, isStreaming, error]);

  function sendWithBody(text: string) {
    // Never send while a turn is in flight — the approval buttons already gate on this, but
    // guarding here too closes the double-send race for any caller (including onRespond).
    if (isStreaming) return;
    sendMessage(
      { text },
      { body: { sessionId: sessionIdRef.current, provider: providerRef.current, model: modelRef.current, mcpServers: mcpServersRef.current, keys: apiKeysRef.current } }
    );
  }

  function handleRun() {
    if (isStreaming) return;
    const repoUrl = normalizeRepoUrl(repo);
    const text = [repoUrl || null, task.trim() || null].filter(Boolean).join('\n');
    if (!text) return;
    sendWithBody(text);
    setTask('');
  }

  function handleExample(exRepo: string, exTask: string) {
    const repoUrl = normalizeRepoUrl(exRepo);
    setRepo(repoUrl);
    setTask(exTask);
    sendWithBody(`${repoUrl}\n${exTask}`);
  }

  function newSession() {
    if (isStreaming) return;
    teardownSandboxes(sessionIdRef.current);
    setMessages([]);
    setManualVncUrl(null);
    setSessionId(newSessionId());
    setWorkspaceKey(k => k + 1);
    setRepo('');
    setTask('');
    setHandoffPreviewUrl(null);
  }

  return (
    <div className="app density-regular">
      <Header
        provider={provider} model={model}
        onChange={(p, m) => { setProvider(p); setModel(m); }}
        onNew={newSession}
        running={isStreaming}
        mcpServers={mcpServers}
        envServers={envServers}
        onMCPChange={handleMCPChange}
        apiKeys={apiKeys}
        onKeysChange={handleKeysChange}
      />
      <div className="main">
        <div className="col-log">
          <div className="col-head">
            <span className="tag"><span className="br">[</span><b>AGENT LOG</b><span className="br">]</span></span>
            {messages.length > 0 && repo && (
              <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--fg-faint)', display: 'flex', alignItems: 'center', gap: 7 }}>
                {repo.replace(/^https?:\/\//, '')}
              </span>
            )}
          </div>
          <div className="log" ref={logRef}>
            <AgentLog
              messages={messages}
              isStreaming={isStreaming}
              error={error ?? undefined}
              onExample={handleExample}
              onRespond={sendWithBody}
              needsKeys={needsKeys}
            />
          </div>
          <Composer
            repo={repo} setRepo={setRepo}
            task={task} setTask={setTask}
            running={isStreaming}
            onRun={handleRun}
            onStop={handleStop}
          />
        </div>

        <Workspace
          key={workspaceKey}
          previewUrl={activePreviewUrl}
          vncUrl={vncUrl}
          vncLoading={vncLoading}
          onStartDesktop={startDesktopPreview}
          touchedFiles={touchedFiles}
          plan={plan}
          sandboxUp={sandboxUp}
          running={isStreaming}
        />
      </div>
    </div>
  );
}
