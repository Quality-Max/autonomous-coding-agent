'use client';

import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import type { TouchedFile, PlanStep } from '@/lib/types';

// Agent-produced file content is rendered into the diff preview below. React
// already escapes JSX text children (so this is not executable), but we strip
// HTML-significant characters as defense-in-depth, mirroring ToolCallCard.safeText.
function safeLine(line: string): string {
  return line.replace(/[<>&"]/g, '');
}

type PreviewMode = 'browser' | 'vnc' | 'recording';

interface Props {
  previewUrl: string | null;
  vncUrl: string | null;
  vncLoading: boolean;
  recordingUrl: string | null;
  onStartDesktop: () => void;
  touchedFiles: TouchedFile[];
  plan: PlanStep[];
  sandboxUp: boolean;
  running: boolean;
}

export default function Workspace({ previewUrl, vncUrl, vncLoading, recordingUrl, onStartDesktop, touchedFiles, plan, sandboxUp, running }: Props) {
  const [tab, setTab] = useState<'plan' | 'files' | 'preview'>('plan');
  const [mode, setMode] = useState<PreviewMode>('browser');
  const sawPreview = useRef(false);
  const sawVnc = useRef(false);
  const sawRecording = useRef(false);
  const sawFiles = useRef(false);

  useEffect(() => {
    if (touchedFiles.length > 0 && !sawFiles.current) { sawFiles.current = true; setTab('files'); }
  }, [touchedFiles.length]);
  useEffect(() => {
    if (previewUrl && !sawPreview.current) { sawPreview.current = true; setTab('preview'); }
  }, [previewUrl]);
  // A live noVNC stream is the richer view — jump to it and select it when it appears.
  useEffect(() => {
    if (vncUrl && !sawVnc.current) { sawVnc.current = true; setMode('vnc'); setTab('preview'); }
  }, [vncUrl]);
  // A recorded Playwright run is the "watch it run" payoff — jump straight to it.
  useEffect(() => {
    if (recordingUrl && !sawRecording.current) { sawRecording.current = true; setMode('recording'); setTab('preview'); }
  }, [recordingUrl]);

  // Browser/Desktop/Recording are offered once each has something to show; the Desktop toggle
  // spins up its sandbox on demand. "Open in new tab" follows the selection.
  const showPreviewToggle = !!(previewUrl || vncUrl || vncLoading || recordingUrl);
  const activeUrl = mode === 'vnc' ? vncUrl : mode === 'recording' ? recordingUrl : previewUrl;

  const planDone = plan.filter(s => s.status === 'done').length;
  const tabs = [
    { id: 'plan' as const, label: 'Plan', icon: 'list', count: plan.length ? `${planDone}/${plan.length}` : null },
    { id: 'files' as const, label: 'Files', icon: 'fileEdit', count: touchedFiles.length || null },
    { id: 'preview' as const, label: 'Preview', icon: 'eye', count: null },
  ];

  return (
    <div className="col-work">
      <div className="col-head">
        <div className="tabs">
          {tabs.map(t => (
            <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
              <Icon name={t.icon} size={14} />{t.label}
              {t.count != null && <span className="count">{t.count}</span>}
            </button>
          ))}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {tab === 'preview' && showPreviewToggle && (
            <div className="seg">
              {recordingUrl && (
                <button className={`seg-btn ${mode === 'recording' ? 'active' : ''}`}
                  onClick={() => setMode('recording')}>
                  <Icon name="eye" size={12} />Recording
                </button>
              )}
              <button className={`seg-btn ${mode === 'vnc' ? 'active' : ''}`}
                onClick={() => { setMode('vnc'); onStartDesktop(); }}>
                <Icon name="box" size={12} />Desktop
              </button>
              <button className={`seg-btn ${mode === 'browser' ? 'active' : ''}`}
                onClick={() => setMode('browser')} disabled={!previewUrl}>
                <Icon name="globe" size={12} />Browser
              </button>
            </div>
          )}
          {/* The recording is a data: URL — not meaningfully openable in a new tab, so the
              external link only shows for the live browser/desktop sources. */}
          {tab === 'preview' && activeUrl && mode !== 'recording' && (
            <a href={activeUrl} target="_blank" rel="noopener noreferrer" className="icon-btn" title="Open in new tab">
              <Icon name="external" size={14} />
            </a>
          )}
        </div>
      </div>

      <div className="work-body">
        {tab === 'plan' && <PlanView plan={plan} running={running} sandboxUp={sandboxUp} />}
        {tab === 'files' && <FilesView files={touchedFiles} />}
        {tab === 'preview' && <PreviewView mode={mode} previewUrl={previewUrl} vncUrl={vncUrl} vncLoading={vncLoading} recordingUrl={recordingUrl} />}
      </div>

      <SandboxStrip up={sandboxUp} running={running} />
    </div>
  );
}

// ---- helpers ----------------------------------------------------------------

function stripPrefix(paths: string[]): string {
  if (paths.length === 0) return '';
  const parts = paths[0].split('/');
  let prefix = '';
  for (let i = 1; i <= parts.length; i++) {
    const candidate = parts.slice(0, i).join('/') + '/';
    if (paths.every(p => p.startsWith(candidate))) prefix = candidate;
    else break;
  }
  return prefix;
}

interface TreeEntry {
  name: string;
  fullPath: string;
  isDir: boolean;
  depth: number;
  status?: 'A' | 'M' | 'S';
}

function buildTree(files: TouchedFile[]): TreeEntry[] {
  const prefix = stripPrefix(files.map(f => f.path));
  const dirs = new Set<string>();
  const entries: TreeEntry[] = [];

  for (const f of files) {
    const rel = f.path.slice(prefix.length);
    const segments = rel.split('/');
    // register all parent dirs
    for (let i = 1; i < segments.length; i++) {
      dirs.add(segments.slice(0, i).join('/'));
    }
  }

  // Sort dirs then emit tree
  const sortedDirs = Array.from(dirs).sort();
  const emitted = new Set<string>();

  function emit(relPrefix: string, depth: number) {
    // dirs at this depth
    sortedDirs
      .filter(d => {
        const p = d.split('/');
        return p.length === depth + 1 && d.startsWith(relPrefix);
      })
      .forEach(d => {
        if (emitted.has(d)) return;
        emitted.add(d);
        const name = d.split('/').pop()!;
        entries.push({ name, fullPath: prefix + d + '/', isDir: true, depth });
        emit(d + '/', depth + 1);
        // files inside this dir
        files
          .filter(f => {
            const rel = f.path.slice(prefix.length);
            const seg = rel.split('/');
            return seg.slice(0, -1).join('/') === d;
          })
          .sort((a, b) => a.path.localeCompare(b.path))
          .forEach(f => {
            const rel = f.path.slice(prefix.length);
            const name = rel.split('/').pop()!;
            entries.push({ name, fullPath: f.path, isDir: false, depth: depth + 1, status: (f.op === 'write' ? 'A' : f.op === 'smart' ? 'S' : 'M') as 'A' | 'M' | 'S' });
          });
      });
    // root-level files (depth 0 means no parent dir)
    if (depth === 0) {
      files
        .filter(f => {
          const rel = f.path.slice(prefix.length);
          return !rel.includes('/');
        })
        .sort((a, b) => a.path.localeCompare(b.path))
        .forEach(f => {
          const name = f.path.slice(prefix.length);
          entries.push({ name, fullPath: f.path, isDir: false, depth: 0, status: (f.op === 'write' ? 'A' : f.op === 'smart' ? 'S' : 'M') as 'A' | 'M' | 'S' });
        });
    }
  }

  emit('', 0);
  return entries;
}

// ---- components -------------------------------------------------------------

function FilesView({ files }: { files: TouchedFile[] }) {
  const [sel, setSel] = useState<string | null>(null);
  const selectedPath = sel ?? files[0]?.path ?? null;

  if (files.length === 0) {
    return (
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--fg-faint)' }}>
        <div style={{ textAlign: 'center' }}>
          <Icon name="fileEdit" size={26} style={{ opacity: 0.4 }} />
          <p style={{ fontFamily: 'var(--mono)', fontSize: 12, marginTop: 12 }}>No file changes yet.</p>
        </div>
      </div>
    );
  }

  const tree = buildTree(files);
  const selFile = files.find(f => f.path === selectedPath);

  return (
    <div className="files-split">
      {/* File tree */}
      <div className="file-tree">
        {tree.map((e, i) => {
          const indentClass = e.depth === 0 ? '' : e.depth === 1 ? 'indent' : 'indent2';
          if (e.isDir) {
            return (
              <div key={i} className={`tree-row ${indentClass}`}>
                <Icon name="folder" size={13} fill style={{ color: 'var(--blue)' }} />
                <span>{e.name}</span>
              </div>
            );
          }
          return (
            <div key={i} className={`tree-row ${indentClass} ${selectedPath === e.fullPath ? 'sel' : ''}`}
              onClick={() => setSel(e.fullPath)}>
              <Icon name={e.status === 'A' ? 'file' : 'fileEdit'} size={13} style={{ color: 'var(--fg-faint)' }} />
              <span>{e.name}</span>
              {e.status && (
                <span className={`tag-a ${e.status}`} style={{ marginLeft: 'auto', fontSize: 10 }}>
                  {e.status}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Diff / content view */}
      <div className="file-view">
        {selFile ? (
          <>
            <div className="file-view-head">
              <Icon name={selFile.op === 'write' ? 'file' : 'fileEdit'} size={13} />
              {selFile.path.slice(stripPrefix(files.map(f => f.path)).length)}
              <span className="stat" style={{ marginLeft: 'auto', display: 'flex', gap: 9 }}>
                {selFile.op === 'write' && selFile.content && (
                  <span style={{ color: 'var(--green)' }}>+{selFile.content.split('\n').length}</span>
                )}
                {selFile.op === 'smart' && selFile.updatedLines != null && (
                  <span style={{ color: 'var(--green)' }}>{selFile.updatedLines} lines</span>
                )}
                {selFile.op === 'edit' && selFile.search && selFile.replace && (
                  <>
                    <span style={{ color: 'var(--green)' }}>+{selFile.replace.split('\n').length}</span>
                    <span style={{ color: 'var(--red)' }}>−{selFile.search.split('\n').length}</span>
                  </>
                )}
              </span>
            </div>
            <FileDiffView file={selFile} />
          </>
        ) : (
          <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: 'var(--fg-faint)', fontFamily: 'var(--mono)', fontSize: 12 }}>
            select a file
          </div>
        )}
      </div>
    </div>
  );
}

function FileDiffView({ file }: { file: TouchedFile }) {
  if (file.op === 'smart') {
    return (
      <div style={{ padding: '14px 16px', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--fg-dim)' }}>
        <p style={{ marginBottom: 8, color: 'var(--fg-faint)' }}>Fast Apply — full file rewritten by {file.model ?? 'fast model'}</p>
        <div style={{ background: 'var(--bg-3)', borderRadius: 6, padding: '8px 12px', color: 'var(--fg-dim)', lineHeight: 1.6 }}>
          <span style={{ color: 'var(--fg-faint)' }}>edit: </span>{file.edit ?? '—'}
        </div>
        {file.updatedLines != null && (
          <p style={{ marginTop: 8, color: 'var(--fg-faint)', fontSize: 11 }}>
            Result: {file.updatedLines} lines · see the agent log for the full change
          </p>
        )}
      </div>
    );
  }

  if (file.op === 'write' && file.content) {
    const lines = file.content.split('\n');
    return (
      <div className="diff">
        {lines.map((line, i) => (
          <div key={i} className="ln add">
            <span className="gut">{i + 1}</span>
            <span className="sign">+</span>
            <span className="txt">{safeLine(line) || ' '}</span>
          </div>
        ))}
      </div>
    );
  }

  if (file.op === 'edit' && file.search != null && file.replace != null) {
    const delLines = file.search.split('\n');
    const addLines = file.replace.split('\n');
    return (
      <div className="diff">
        {delLines.map((line, i) => (
          <div key={`d${i}`} className="ln del">
            <span className="gut">{i + 1}</span>
            <span className="sign">-</span>
            <span className="txt">{safeLine(line) || ' '}</span>
          </div>
        ))}
        {addLines.map((line, i) => (
          <div key={`a${i}`} className="ln add">
            <span className="gut">{delLines.length + i + 1}</span>
            <span className="sign">+</span>
            <span className="txt">{safeLine(line) || ' '}</span>
          </div>
        ))}
      </div>
    );
  }

  return null;
}

function PlanView({ plan, running, sandboxUp }: { plan: PlanStep[]; running: boolean; sandboxUp: boolean }) {
  if (plan.length === 0) {
    return (
      <div className="plan" style={{ display: 'grid', placeItems: 'center' }}>
        <div style={{ textAlign: 'center', color: 'var(--fg-faint)' }}>
          <Icon name="list" size={26} style={{ opacity: 0.4 }} />
          <p style={{ fontFamily: 'var(--mono)', fontSize: 12, marginTop: 12, whiteSpace: 'pre-line' }}>
            {sandboxUp
              ? running ? 'Agent is planning…' : 'Session complete.'
              : 'The plan appears once\nthe agent breaks down the task.'}
          </p>
        </div>
      </div>
    );
  }

  const done = plan.filter(s => s.status === 'done').length;
  const pct = Math.round((done / plan.length) * 100);

  return (
    <div className="plan">
      <div className="plan-head">
        <Icon name="list" size={13} />
        <span>Plan</span>
        <span className="prog">{done}/{plan.length} done</span>
      </div>
      <div className="plan-bar"><i style={{ width: pct + '%' }} /></div>
      {plan.map((s, i) => (
        <div key={i} className={`todo ${s.status === 'done' ? 'done' : ''} ${s.status === 'in_progress' ? 'active' : ''}`}>
          <span className="todo-check">
            {s.status === 'done'
              ? <Icon name="check" size={12} strokeWidth={2.4} />
              : s.status === 'in_progress'
              // Spin only while the agent is actively working; once the session
              // is idle, show a static marker so a trailing step doesn't look
              // like it's still running.
              ? (running ? <span className="spin" /> : <span className="plan-dot" />)
              : null}
          </span>
          <span className="todo-text">{s.title}</span>
          <span className="todo-num">{String(i + 1).padStart(2, '0')}</span>
        </div>
      ))}
    </div>
  );
}

function PreviewView({ mode, previewUrl, vncUrl, vncLoading, recordingUrl }: {
  mode: PreviewMode;
  previewUrl: string | null;
  vncUrl: string | null;
  vncLoading: boolean;
  recordingUrl: string | null;
}) {
  if (mode === 'recording') return <RecordingView url={recordingUrl} />;
  if (mode === 'vnc') return <VncView url={vncUrl} loading={vncLoading} />;
  return <BrowserView url={previewUrl} />;
}

// Playback of a recorded Playwright run (visual=true). The src is a self-contained
// data:video/webm URL embedded in the tool result, so it plays with no extra round-trip and
// survives across server instances. Autoplay + loop so the user immediately sees the run.
function RecordingView({ url }: { url: string | null }) {
  if (!url) {
    return (
      <div className="preview-empty">
        <div className="inner">
          <div className="glyph">{'╔═══════╗\n║   ▶   ║\n╚═══════╝'}</div>
          <p>No recording yet</p>
          <div className="sub">Run a Playwright test with visual mode<br />to watch the browser actions here.</div>
        </div>
      </div>
    );
  }
  return (
    <div className="browser">
      <div className="browser-bar">
        <div className="browser-dots"><i /><i /><i /></div>
        <div className="browser-url">
          <span className="lock"><Icon name="eye" size={12} /></span>
          <span>Recorded Playwright run · video</span>
        </div>
        <span className="live" style={{ marginLeft: 'auto' }}><span className="d" />replay</span>
      </div>
      <video
        src={url}
        className="browser-frame"
        style={{ background: '#000', objectFit: 'contain' }}
        controls
        autoPlay
        loop
        muted
        playsInline
      />
    </div>
  );
}

// The noVNC stream is its own self-chromed viewer — embed it directly, full-bleed, with a
// "live" header instead of the faux address bar used for the plain page iframe. When the
// user opens Desktop before a stream exists, show a spin-up state while the sandbox boots.
function VncView({ url, loading }: { url: string | null; loading: boolean }) {
  if (!url) {
    return (
      <div className="preview-empty">
        <div className="inner">
          {loading ? (
            <>
              <span className="spin" style={{ width: 22, height: 22, display: 'inline-block' }} />
              <p style={{ marginTop: 14 }}>Starting live desktop…</p>
              <div className="sub">Booting a desktop sandbox and opening the app.</div>
            </>
          ) : (
            <>
              <div className="glyph">{'╔═══════╗\n║   ◷   ║\n╚═══════╝'}</div>
              <p>No live desktop yet</p>
              <div className="sub">Start a dev server and expose a port first,<br />then open Desktop to stream it over noVNC.</div>
            </>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="browser">
      <div className="browser-bar">
        <div className="browser-dots"><i /><i /><i /></div>
        <div className="browser-url">
          <span className="lock"><Icon name="box" size={12} /></span>
          <span>Live desktop · noVNC stream</span>
        </div>
        <span className="live" style={{ marginLeft: 'auto' }}><span className="d" />live</span>
      </div>
      {/* noVNC needs scripts to run; allow-same-origin lets the viewer reach its own
          origin's WebSocket/storage. The frame is cross-origin (e2b.app), so this grants
          no access to our origin. forms/popups aren't needed, so they're left off. */}
      <iframe
        src={url}
        className="browser-frame"
        sandbox="allow-scripts allow-same-origin"
        allow="clipboard-read; clipboard-write"
        title="Live noVNC desktop preview"
      />
    </div>
  );
}

function BrowserView({ url }: { url: string | null }) {
  if (!url) {
    return (
      <div className="preview-empty">
        <div className="inner">
          <div className="glyph">{'╔═══════╗\n║   ◷   ║\n╚═══════╝'}</div>
          <p>No preview running</p>
          <div className="sub">Ask the agent to start a dev server and expose<br />a port, or stream a live desktop over noVNC.</div>
        </div>
      </div>
    );
  }
  return (
    <div className="browser">
      <div className="browser-bar">
        <div className="browser-dots"><i /><i /><i /></div>
        <div className="browser-url">
          <span className="lock"><Icon name="globe" size={12} /></span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{url}</span>
        </div>
        <button className="icon-btn" style={{ width: 26, height: 26 }} title="Reload"
          onClick={() => {}}>
          <Icon name="refresh" size={13} />
        </button>
      </div>
      <iframe src={url} className="browser-frame" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" title="Live preview" />
    </div>
  );
}

function SandboxStrip({ up, running }: { up: boolean; running: boolean }) {
  const [uptime, setUptime] = useState(0);
  const [cpu, setCpu] = useState(4);
  const [ram, setRam] = useState(12);

  useEffect(() => {
    if (!up) {
      queueMicrotask(() => setUptime(0));
      return;
    }
    const id = setInterval(() => setUptime(u => u + 1), 1000);
    return () => clearInterval(id);
  }, [up]);

  useEffect(() => {
    const id = setInterval(() => {
      if (running) { setCpu(40 + Math.round(Math.random() * 38)); setRam(48 + Math.round(Math.random() * 22)); }
      else if (up) { setCpu(3 + Math.round(Math.random() * 8)); setRam(14 + Math.round(Math.random() * 6)); }
      else { setCpu(0); setRam(0); }
    }, 900);
    return () => clearInterval(id);
  }, [running, up]);

  const mm = String(Math.floor(uptime / 60)).padStart(2, '0');
  const ss = String(uptime % 60).padStart(2, '0');

  return (
    <div className="sbx-strip">
      <span className="grp">
        <Icon name="box" size={12} style={{ color: up ? 'var(--accent)' : 'var(--fg-ghost)' }} />
        <span className="k">SANDBOX</span>
        <span className="v">{up ? 'active' : 'not booted'}</span>
      </span>
      {up && (
        <>
          <span className="grp"><span className="k">CPU</span>
            <span className="meter"><i style={{ width: cpu + '%' }} /></span>
            <span className="v">{cpu}%</span>
          </span>
          <span className="grp"><span className="k">RAM</span>
            <span className="meter"><i style={{ width: ram + '%' }} /></span>
            <span className="v">{ram}%</span>
          </span>
          <span className="grp" style={{ marginLeft: 'auto' }}>
            <span className="k">UPTIME</span><span className="v">{mm}:{ss}</span>
          </span>
          <span className="live"><span className="d" />{running ? 'running' : 'idle'}</span>
        </>
      )}
      {!up && <span className="grp" style={{ marginLeft: 'auto', color: 'var(--fg-ghost)' }}>idle</span>}
    </div>
  );
}
