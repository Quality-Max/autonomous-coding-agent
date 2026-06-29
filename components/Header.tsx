'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Icon from './Icon';
import PyramidLogo from './PyramidLogo';
import type { ProviderName, MCPServerConfig, ApiKeys } from '@/lib/types';
import { isSafeSSEUrl, type MCPToolInfo, type MCPServerMeta } from '@/lib/mcp';

// Per-server tool fetch state: a tool list once loaded, or a status sentinel.
type ToolState = MCPToolInfo[] | 'loading' | 'error';

const PROVIDERS = [
  {
    id: 'anthropic' as ProviderName, label: 'Anthropic', glyph: 'An',
    models: [
      { id: 'claude-opus-4-8', name: 'claude-opus-4-8', meta: 'latest' },
      { id: 'claude-sonnet-4-6', name: 'claude-sonnet-4-6', meta: 'balanced' },
      { id: 'claude-haiku-4-5-20251001', name: 'claude-haiku-4-5', meta: 'fast' },
    ],
  },
  {
    id: 'openai' as ProviderName, label: 'OpenAI', glyph: 'Oa',
    models: [
      { id: 'gpt-5', name: 'gpt-5', meta: 'latest' },
      { id: 'gpt-5-mini', name: 'gpt-5-mini', meta: 'fast' },
    ],
  },
  {
    id: 'google' as ProviderName, label: 'Google', glyph: 'Ge',
    models: [
      { id: 'gemini-3.1-pro-preview', name: 'gemini-3.1-pro', meta: 'latest' },
      { id: 'gemini-3.5-flash', name: 'gemini-3.5-flash', meta: 'fast' },
    ],
  },
  {
    id: 'cerebras' as ProviderName, label: 'Cerebras', glyph: 'Cb',
    models: [
      { id: 'gpt-oss-120b', name: 'gpt-oss-120b', meta: '~1000 tok/s' },
      { id: 'zai-glm-4.7', name: 'zai-glm-4.7', meta: 'reasoning' },
    ],
  },
];

function useClickOutside(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    function h(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [ref, onClose]);
}

function ProviderPicker({ provider, model, onChange }: {
  provider: ProviderName; model: string;
  onChange: (p: ProviderName, m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false));

  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button className={`pill ${open ? 'active' : ''}`} onClick={() => setOpen(o => !o)}>
        <span className="dot" style={{ background: 'var(--accent)' }} />
        <span style={{ color: 'var(--fg)' }}>{model}</span>
        <Icon name="chevron" size={12} style={{ transform: 'rotate(90deg)', opacity: 0.5 }} />
      </button>
      {open && (
        <div className="menu" style={{ minWidth: 264 }}>
          {PROVIDERS.map(p => (
            <div key={p.id}>
              <div className="menu-label">{p.label}</div>
              {p.models.map(m => {
                const sel = provider === p.id && model === m.id;
                return (
                  <div key={m.id} className={`menu-item ${sel ? 'sel' : ''}`}
                    onClick={() => { onChange(p.id, m.id); setOpen(false); }}>
                    <span className="lead" style={{ borderRadius: 5, background: 'var(--bg-3)', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700, color: 'var(--fg-dim)' }}>
                      {p.glyph}
                    </span>
                    <span className="name">{m.name}</span>
                    <span className="meta">{m.meta}</span>
                    <span className="check"><Icon name="check" size={13} strokeWidth={2.4} /></span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function McpMenu({ servers, envServers, onServersChange }: {
  servers: MCPServerConfig[];
  envServers: MCPServerMeta[];
  onServersChange: (s: MCPServerConfig[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'list' | 'add'>('list');
  const [addType, setAddType] = useState<'linear' | 'custom'>('linear');
  const [apiKey, setApiKey] = useState('');
  const [customName, setCustomName] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [customAuth, setCustomAuth] = useState('');
  const [err, setErr] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [toolState, setToolState] = useState<Record<string, ToolState>>({});
  const ref = useRef<HTMLDivElement>(null);

  useClickOutside(ref, () => setOpen(false));

  // Expand a server row and lazily fetch the tools it exposes (cached per server name).
  // Env servers carry no url/auth here — the route resolves their config server-side.
  async function toggleTools(s: { name: string; url?: string; auth?: string }) {
    const next = expanded === s.name ? null : s.name;
    setExpanded(next);
    if (next === null || toolState[s.name]) return;

    setToolState(prev => ({ ...prev, [s.name]: 'loading' }));
    try {
      const res = await fetch('/api/mcp/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: s.name, url: s.url, auth: s.auth }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'failed');
      setToolState(prev => ({ ...prev, [s.name]: data.tools as MCPToolInfo[] }));
    } catch {
      setToolState(prev => ({ ...prev, [s.name]: 'error' }));
    }
  }

  useEffect(() => {
    if (!open) {
      setView('list');
      setApiKey('');
      setCustomName('');
      setCustomUrl('');
      setCustomAuth('');
      setAddType('linear');
      setErr('');
      setExpanded(null);
    }
  }, [open]);

  // A name is taken if a user server or an env-configured server already uses it.
  const nameTaken = (name: string) =>
    servers.some(s => s.name === name) || envServers.some(e => e.name === name);

  function handleConnect() {
    setErr('');
    if (addType === 'linear') {
      const key = apiKey.trim();
      if (!key) { setErr('API key is required'); return; }
      const name = 'linear';
      if (nameTaken(name)) {
        setErr('Linear is already connected');
        return;
      }
      onServersChange([...servers, {
        name,
        url: 'https://mcp.linear.app/mcp', // Streamable HTTP; the legacy /sse endpoint was shut off after 2026-04-08
        auth: `Bearer ${key}`,
        description: 'Issues, projects, teams',
      }]);
    } else {
      const name = customName.trim();
      const url = customUrl.trim();
      if (!name) { setErr('Name is required'); return; }
      if (!url) { setErr('URL is required'); return; }
      // #4 — Validate scheme and block internal/metadata hosts (SSRF prevention).
      if (!isSafeSSEUrl(url)) {
        setErr('URL must be a public https:// or http:// address');
        return;
      }
      if (nameTaken(name)) {
        setErr(`"${name}" is already connected`);
        return;
      }
      onServersChange([...servers, {
        name,
        url,
        auth: customAuth.trim() || undefined,
        description: '',
      }]);
    }
    // #8 — Reset form fields immediately so they don't linger if the user reopens
    // the add view without closing the menu first.
    setView('list');
    setApiKey('');
    setCustomName('');
    setCustomUrl('');
    setCustomAuth('');
  }

  function handleRemove(name: string) {
    onServersChange(servers.filter(s => s.name !== name));
    if (expanded === name) setExpanded(null);
    // Drop cached tools so a future reconnect re-introspects with fresh credentials.
    setToolState(prev => {
      const rest = { ...prev };
      delete rest[name];
      return rest;
    });
  }

  // Env servers win on name collisions (mirrors the agent route's dedupe), so drop any
  // user entry that shadows one. Env rows render first and are read-only.
  const userServers = servers.filter(s => !envServers.some(e => e.name === s.name));
  const count = envServers.length + userServers.length;

  // The expandable tool list, shared by env and user rows.
  function toolsPanel(name: string) {
    const tools = toolState[name];
    if (expanded !== name) return null;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '2px 9px 8px 30px' }}>
        {tools === 'loading' && (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--fg-faint)' }}>Loading tools…</span>
        )}
        {tools === 'error' && (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red, #f87171)' }}>Couldn’t load tools</span>
        )}
        {Array.isArray(tools) && tools.length === 0 && (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--fg-faint)' }}>No tools exposed</span>
        )}
        {Array.isArray(tools) && tools.map(t => (
          <span
            key={t.name}
            title={t.description}
            style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--fg-dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            {t.name}
          </span>
        ))}
      </div>
    );
  }

  // A connected-server row. `env` rows show an "env" badge and omit the disconnect button.
  function serverRow(s: { name: string; description?: string; url?: string; auth?: string }, env: boolean) {
    const isOpen = expanded === s.name;
    return (
      <div key={s.name}>
        <div
          className="menu-item"
          style={{ alignItems: 'flex-start', cursor: 'pointer' }}
          onClick={() => toggleTools(s)}
          title="Show tools"
        >
          <span className="lead" style={{ marginTop: 3 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--green)', boxShadow: '0 0 6px var(--green)', display: 'block' }} />
          </span>
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--fg)' }}>{s.name}</span>
              {env && (
                <span style={{ fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--fg-faint)', border: '1px solid var(--line)', borderRadius: 3, padding: '0 4px', lineHeight: '14px' }}>
                  env
                </span>
              )}
              <Icon name="chevron" size={11} style={{ transform: isOpen ? 'rotate(90deg)' : 'none', opacity: 0.4, transition: 'transform .12s' }} />
            </span>
            {s.description && <span style={{ fontSize: 11, color: 'var(--fg-faint)' }}>{s.description}</span>}
          </span>
          {!env && (
            <button
              onClick={e => { e.stopPropagation(); handleRemove(s.name); }}
              title="Disconnect"
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--fg-ghost)', marginTop: 1, borderRadius: 3, lineHeight: 1, transition: 'color .12s' }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--fg-dim)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--fg-ghost)')}
            >
              <Icon name="x" size={13} />
            </button>
          )}
        </div>
        {toolsPanel(s.name)}
      </div>
    );
  }

  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button className={`pill ${open ? 'active' : ''}`} onClick={() => setOpen(o => !o)}>
        <Icon name="server" size={13} />
        <span>MCP</span>
        <span style={{ color: count > 0 ? 'var(--accent-bright)' : 'var(--fg-faint)', fontSize: 11 }}>{count}</span>
      </button>

      {open && view === 'list' && (
        <div className="menu" style={{ minWidth: 290 }}>
          <div className="menu-label">MCP Servers · {count} connected</div>

          {count === 0 ? (
            <div className="menu-item" style={{ pointerEvents: 'none', padding: '10px 9px' }}>
              <span style={{ fontSize: 12, color: 'var(--fg-faint)' }}>No servers connected yet</span>
            </div>
          ) : (
            <>
              {envServers.map(s => serverRow(s, true))}
              {userServers.map(s => serverRow(s, false))}
            </>
          )}

          <div className="menu-sep" />
          <div className="menu-item" onClick={() => setView('add')}>
            <span className="lead"><Icon name="plus" size={14} /></span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>Add server</span>
          </div>
        </div>
      )}

      {open && view === 'add' && (
        <div className="menu" style={{ minWidth: 290, padding: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <button
              onClick={() => setView('list')}
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--fg-faint)', borderRadius: 3, lineHeight: 1 }}
            >
              <Icon name="chevron" size={13} style={{ transform: 'rotate(180deg)' }} />
            </button>
            <span className="menu-label" style={{ padding: 0, margin: 0 }}>Add MCP Server</span>
          </div>

          {/* Server type tabs */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
            <button className={`mcp-tab ${addType === 'linear' ? 'active' : ''}`}
              onClick={() => { setAddType('linear'); setErr(''); }}>
              Linear
            </button>
            <button className={`mcp-tab ${addType === 'custom' ? 'active' : ''}`}
              onClick={() => { setAddType('custom'); setErr(''); }}>
              Custom
            </button>
          </div>

          {addType === 'linear' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 1.2, textTransform: 'uppercase', color: 'var(--fg-faint)' }}>
                Linear API Key
              </label>
              <input
                className="mcp-input"
                type="password"
                placeholder="lin_api_..."
                value={apiKey}
                onChange={e => { setApiKey(e.target.value); setErr(''); }}
                onKeyDown={e => e.key === 'Enter' && handleConnect()}
                autoFocus
              />
              <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--fg-faint)', lineHeight: 1.5 }}>
                Settings → API → Personal API keys
              </span>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <label style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 1.2, textTransform: 'uppercase', color: 'var(--fg-faint)' }}>Name</label>
                <input className="mcp-input" placeholder="my-server" value={customName}
                  onChange={e => { setCustomName(e.target.value); setErr(''); }} autoFocus />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <label style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 1.2, textTransform: 'uppercase', color: 'var(--fg-faint)' }}>Server URL</label>
                <input className="mcp-input" placeholder="https://…/mcp" value={customUrl}
                  onChange={e => { setCustomUrl(e.target.value); setErr(''); }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <label style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 1.2, textTransform: 'uppercase', color: 'var(--fg-faint)' }}>Auth header <span style={{ opacity: 0.5 }}>(optional)</span></label>
                <input className="mcp-input" placeholder="Bearer …" value={customAuth}
                  onChange={e => { setCustomAuth(e.target.value); setErr(''); }}
                  onKeyDown={e => e.key === 'Enter' && handleConnect()} />
              </div>
            </div>
          )}

          {/* nosemgrep: llm-xss-unescaped-output — {err} renders as a text node; React auto-escapes JSX interpolations, no dangerouslySetInnerHTML */}
          {err && (
            <div style={{ marginTop: 8, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--red, #f87171)' }}>{err}</div>
          )}

          <div style={{ display: 'flex', gap: 7, marginTop: 12 }}>
            <button className="pill" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setView('list')}>
              Cancel
            </button>
            <button
              className="pill"
              style={{ flex: 1, justifyContent: 'center', background: 'var(--accent)', borderColor: 'var(--accent)', color: '#000' }}
              onClick={handleConnect}
            >
              Connect
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const KEY_FIELDS: { id: keyof ApiKeys; label: string; placeholder: string; help: string }[] = [
  { id: 'e2b', label: 'E2B', placeholder: 'e2b_…', help: 'required · e2b.dev' },
  { id: 'anthropic', label: 'Anthropic', placeholder: 'sk-ant-…', help: 'Claude' },
  { id: 'openai', label: 'OpenAI', placeholder: 'sk-…', help: 'GPT' },
  { id: 'google', label: 'Google', placeholder: 'AIza…', help: 'Gemini' },
  { id: 'cerebras', label: 'Cerebras', placeholder: 'csk-…', help: 'gpt-oss / Gemma 4' },
];

// Bring-your-own-key panel. Keys live only in the visitor's browser (localStorage) and are
// sent with each request so a public deployment runs on the visitor's own accounts.
function KeysMenu({ apiKeys, onKeysChange }: { apiKeys: ApiKeys; onKeysChange: (k: ApiKeys) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setOpen(false));
  const [draft, setDraft] = useState<ApiKeys>(apiKeys);
  useEffect(() => { if (open) setDraft(apiKeys); }, [open, apiKeys]);

  const count = KEY_FIELDS.filter(f => (apiKeys[f.id] ?? '').trim()).length;

  function save() {
    const cleaned: ApiKeys = {};
    for (const f of KEY_FIELDS) {
      const v = (draft[f.id] ?? '').trim();
      if (v) cleaned[f.id] = v;
    }
    onKeysChange(cleaned);
    setOpen(false);
  }
  function clearAll() { setDraft({}); onKeysChange({}); setOpen(false); }

  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button className={`pill ${open ? 'active' : ''}`} onClick={() => setOpen(o => !o)} title="API keys — stored only in your browser">
        <Icon name="key" size={13} />
        <span>Keys</span>
        <span style={{ color: count > 0 ? 'var(--accent-bright)' : 'var(--fg-faint)', fontSize: 11 }}>{count}</span>
      </button>

      {open && (
        <div className="menu" style={{ minWidth: 300, padding: 10 }}>
          <div className="menu-label" style={{ padding: '0 0 4px' }}>Your API keys</div>
          <p style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--fg-faint)', margin: '0 0 10px' }}>
            Stored only in this browser and sent with your requests to run on your own
            accounts. Never saved or logged on the server.
          </p>
          {KEY_FIELDS.map(f => (
            <div key={f.id} style={{ marginBottom: 8 }}>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--fg-faint)', marginBottom: 3 }}>
                <span>{f.label}</span><span style={{ textTransform: 'none', letterSpacing: 0 }}>{f.help}</span>
              </label>
              <input
                className="mcp-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={f.placeholder}
                value={draft[f.id] ?? ''}
                onChange={e => setDraft(d => ({ ...d, [f.id]: e.target.value }))}
              />
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button className="btn" style={{ height: 32, flex: 1 }} onClick={save}>Save</button>
            <button className="btn ghost" style={{ height: 32 }} onClick={clearAll} disabled={count === 0}>Clear</button>
          </div>
        </div>
      )}
    </div>
  );
}

interface HeaderProps {
  provider: ProviderName;
  model: string;
  onChange: (p: ProviderName, m: string) => void;
  onNew: () => void;
  running: boolean;
  mcpServers: MCPServerConfig[];
  envServers: MCPServerMeta[];
  onMCPChange: (servers: MCPServerConfig[]) => void;
  apiKeys: ApiKeys;
  onKeysChange: (keys: ApiKeys) => void;
}

export default function Header({ provider, model, onChange, onNew, running, mcpServers, envServers, onMCPChange, apiKeys, onKeysChange }: HeaderProps) {
  return (
    <header className="hdr">
      <div className="brand">
        <PyramidLogo size={26} className="brand-logo" />
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1 }}>
          <span className="brand-name"><b>QualityMax</b> · agent</span>
        </div>
      </div>

      <span style={{ width: 1, height: 22, background: 'var(--line)' }} />
      <span className="tag">
        <span className="br">[</span>
        <b style={{ color: running ? 'var(--accent-bright)' : 'var(--fg-dim)' }}>
          {running ? 'EXECUTING' : 'READY'}
        </b>
        <span className="br">]</span>
      </span>

      <div className="hdr-spacer" />

      <Link href="/recognize" className="pill" style={{ textDecoration: 'none' }} title="Cerebras × Gemma 4 vision recognition">
        <Icon name="eye" size={13} />Recognize
      </Link>
      <KeysMenu apiKeys={apiKeys} onKeysChange={onKeysChange} />
      <McpMenu servers={mcpServers} envServers={envServers} onServersChange={onMCPChange} />
      <ProviderPicker provider={provider} model={model} onChange={onChange} />
      <button className="icon-btn" title="New session" onClick={onNew}>
        <Icon name="plus" size={15} />
      </button>
    </header>
  );
}
