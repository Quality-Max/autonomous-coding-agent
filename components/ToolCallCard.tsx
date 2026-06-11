'use client';

import { useState } from 'react';
import type { DynamicToolUIPart } from 'ai';
import Icon from './Icon';

// Sanitize untrusted output strings before rendering.
// React auto-escapes JSX text nodes, but explicit sanitization provides
// defense-in-depth and satisfies static analysis tools.
function safeText(value: unknown, fallback = 'error'): string {
  return String(value ?? fallback).slice(0, 500).replace(/[<>&"]/g, '');
}

// Only allow https:// URLs from tool output — rejects javascript: and other schemes.
function safeUrl(value: unknown): string | null {
  const s = String(value ?? '').trim();
  return s.startsWith('https://') ? s : null;
}

const TOOL_ICONS: Record<string, string> = {
  clone_repo: 'branch', list_files: 'folder', read_file: 'file',
  write_file: 'file', apply_edit: 'fileEdit', apply_edit_smart: 'fileEdit',
  run_command: 'terminal', expose_port: 'globe', update_plan: 'list',
  request_approval: 'eye',
};

type ToolState = 'running' | 'done' | 'error';
type IO = Record<string, unknown>;

interface ToolEntry {
  toolName: string;
  state: ToolState;
  input: IO;
  output: IO | null;
}

function partToEntry(part: DynamicToolUIPart): ToolEntry {
  return {
    toolName: part.toolName,
    state: part.state === 'output-available' ? 'done'
         : part.state === 'output-error' ? 'error'
         : 'running',
    input: (part.input as IO) ?? {},
    output: part.state === 'output-available' ? (part.output as IO) : null,
  };
}

interface ToolCallCardProps {
  part: DynamicToolUIPart;
  // Present for request_approval cards the user can still act on: sends the chosen option
  // back as the next message. Omitted (or interactive=false) for past/streaming cards.
  onRespond?: (text: string) => void;
  interactive?: boolean;
}

export default function ToolCallCard({ part, onRespond, interactive }: ToolCallCardProps) {
  const entry = partToEntry(part);
  const running = entry.state === 'running';
  const err = entry.state === 'error';
  const defaultOpen = ['run_command', 'apply_edit', 'apply_edit_smart', 'clone_repo', 'update_plan', 'request_approval'].includes(entry.toolName);
  const [open, setOpen] = useState(defaultOpen);

  const argLabel = (() => {
    const i = entry.input;
    if (entry.toolName === 'run_command') return String(i.cmd ?? '');
    if (entry.toolName === 'expose_port') return ':' + String(i.port ?? '');
    if (entry.toolName === 'update_plan') {
      const n = Array.isArray(i.steps) ? i.steps.length : 0;
      return `${n} step${n === 1 ? '' : 's'}`;
    }
    if (entry.toolName === 'request_approval') return 'awaiting your decision';
    return String(i.path ?? i.repo ?? '');
  })();

  return (
    <div className={`tc enter ${running ? 'running' : ''}`}>
      <button className="tc-head" onClick={() => setOpen(o => !o)}>
        <span className="tc-status">
          {running ? <span className="spin" />
            : err ? <span className="err"><Icon name="x" size={13} /></span>
            : <span className="ok"><Icon name="check" size={13} strokeWidth={2.4} /></span>}
        </span>
        <span style={{ color: 'var(--fg-dim)', display: 'flex' }}>
          <Icon name={TOOL_ICONS[entry.toolName] || 'box'} size={13} />
        </span>
        <span className="tc-name">{entry.toolName}</span>
        <span className="tc-arg">{argLabel}</span>
        <span className="tc-meta">
          {running && <span style={{ color: 'var(--accent)' }}>running…</span>}
          <span className={`tc-chev ${open ? 'open' : ''}`}><Icon name="chevron" size={13} /></span>
        </span>
      </button>
      {open && <div className="tc-body"><ToolBody entry={entry} running={running} onRespond={onRespond} interactive={interactive} /></div>}
    </div>
  );
}

function ToolBody({ entry, running, onRespond, interactive }: { entry: ToolEntry; running: boolean; onRespond?: (text: string) => void; interactive?: boolean }) {
  const { toolName, input, output } = entry;

  if (toolName === 'request_approval') {
    // Defensive: on a malformed call the part is output-error and input may be a raw string or
    // partial object, so options/summary can be missing. Never render a blank-but-actionable card.
    const options = (Array.isArray(input.options) ? input.options : []).filter(
      (o): o is string => typeof o === 'string' && o.trim().length > 0,
    );
    const summary = typeof input.summary === 'string' ? input.summary : '';
    const errored = entry.state === 'error';
    const canAct = interactive && typeof onRespond === 'function';
    return (
      <div className="tc-approval">
        {/* Always show context — fall back to a generic line if the model omitted a summary. */}
        <div className="tc-approval-summary">{safeText(summary || 'The agent needs your approval.', '')}</div>
        {options.length > 0 && (
          <div className="tc-approval-opts">
            {options.map((opt, i) =>
              canAct ? (
                <button key={i} type="button" className="tc-approval-opt" onClick={() => onRespond!(opt)}>
                  <span className="arrow">▸</span>{safeText(opt, '')}
                </button>
              ) : (
                // Disabled <button> (not a <div>) so assistive tech announces the read-only state.
                <button key={i} type="button" disabled className="tc-approval-opt static">
                  <span className="arrow">▸</span>{safeText(opt, '')}
                </button>
              ),
            )}
          </div>
        )}
        {errored && (
          // Friendly, actionable message — the raw SDK/zod error is dev jargon, not user-facing.
          <div className="tc-approval-error">
            The agent&rsquo;s approval request was malformed — reply below and it&rsquo;ll try again.
          </div>
        )}
        {canAct && (
          <div className="tc-approval-hint">
            {options.length > 0 ? 'Pick an option, or type your own response below.' : 'Reply below to continue.'}
          </div>
        )}
      </div>
    );
  }

  if (toolName === 'update_plan') {
    const steps = (Array.isArray(input.steps) ? input.steps : []) as { title?: unknown; status?: unknown }[];
    return (
      <div className="tc-plan">
        {steps.map((s, i) => {
          const status = String(s.status ?? 'pending');
          return (
            <div key={i} className={`tc-plan-row ${status}`}>
              <span className="tc-plan-mark">
                {status === 'done' ? '✓' : status === 'in_progress' ? '▸' : '○'}
              </span>
              <span className="tc-plan-text">{safeText(s.title, '')}</span>
            </div>
          );
        })}
      </div>
    );
  }

  if (toolName === 'run_command') {
    const stdout = String(output?.stdout ?? '');
    const stderr = String(output?.stderr ?? '');
    const exitCode = output?.exitCode as number | undefined;
    const bg = input.background as boolean | undefined;
    return (
      <div className="term">
        <div className="term-cmd">
          <span className="pr">$</span>
          <span>{String(input.cmd ?? '')}</span>
          {bg && <span className="bg-tag">&amp; background</span>}
        </div>
        {running ? (
          <div className="term-out" style={{ color: 'var(--fg-faint)' }}>
            <span className="cursor-blink" />
          </div>
        ) : (
          <>
            {stdout && <div className="term-out">{stdout}</div>}
            {stderr && <div className="term-out" style={{ color: 'var(--red)' }}>{stderr}</div>}
            {exitCode === null ? (
              <div className="term-exit ok">▸ running in background</div>
            ) : exitCode !== undefined && (
              <div className={`term-exit ${exitCode === 0 ? 'ok' : 'err'}`}>
                {exitCode === 0 ? '✓' : '✗'} exit {exitCode}
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  if (toolName === 'read_file') {
    if (running) return <div className="fileblock"><pre style={{ color: 'var(--fg-faint)' }}>reading {String(input.path)}…</pre></div>;
    const content = String(output?.content ?? '');
    const lines = content.split('\n');
    return (
      <div className="fileblock">
        <pre>{lines.map((l, i) => (
          <div key={i}><span className="codeline-no">{String(i + 1).padStart(3, ' ')}  </span>{l}</div>
        ))}</pre>
      </div>
    );
  }

  if (toolName === 'write_file') {
    if (running) return <div className="written" style={{ color: 'var(--fg-faint)' }}>writing…<span className="cursor-blink" /></div>;
    return (
      <>
        <div className="diff-file">
          <Icon name="file" size={13} />{String(input.path ?? '')}
          <span className="stat"><span className="add">+{String(output?.bytes ?? '')}b</span></span>
        </div>
        <div className="written"><Icon name="check" size={13} strokeWidth={2.4} />wrote {String(output?.bytes ?? '')} bytes</div>
      </>
    );
  }

  if (toolName === 'apply_edit') {
    if (running) return <div className="written" style={{ color: 'var(--fg-faint)' }}>applying fast-edit…<span className="cursor-blink" /></div>;
    if (output?.ok === false) return <div className="written" style={{ color: 'var(--red)' }}>{safeText(output.error)}</div>;
    const search = String(input.search ?? '');
    const replace = String(input.replace ?? '');
    const searchLines = search.split('\n');
    const replaceLines = replace.split('\n');
    return (
      <>
        <div className="diff-file">
          <Icon name="fileEdit" size={13} />{String(input.path ?? '')}
          <span className="stat">
            <span className="add">+{replaceLines.length}</span>
            <span className="del">−{searchLines.length}</span>
          </span>
        </div>
        <div className="diff" style={{ maxHeight: 320, overflowY: 'auto' }}>
          {searchLines.map((l, i) => (
            <div key={`d${i}`} className="ln del">
              <span className="sign">-</span>
              <span className="txt">{l || ' '}</span>
            </div>
          ))}
          {replaceLines.map((l, i) => (
            <div key={`a${i}`} className="ln add">
              <span className="sign">+</span>
              <span className="txt">{l || ' '}</span>
            </div>
          ))}
        </div>
      </>
    );
  }

  if (toolName === 'apply_edit_smart') {
    if (running) {
      return (
        <div className="written" style={{ color: 'var(--fg-faint)' }}>
          fast apply in progress…<span className="cursor-blink" />
        </div>
      );
    }
    // Check state explicitly — output is null for error/pending states.
    const ok = entry.state === 'done' && output?.ok !== false;
    const model = output?.model ? String(output.model) : null;
    const updatedLines = typeof output?.updatedLines === 'number' ? output.updatedLines : null;
    const noChange = Boolean(output?.noChange);
    return (
      <>
        <div className="diff-file">
          <Icon name="fileEdit" size={13} />{String(input.path ?? '')}
          {ok && updatedLines !== null && (
            <span className="stat"><span className="add">{updatedLines} lines</span></span>
          )}
          {model && <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--fg-faint)' }}>via {model}</span>}
        </div>
        {ok ? (
          <div className="written">
            <Icon name="check" size={13} strokeWidth={2.4} />
            {noChange ? 'no changes needed' : `applied · ${updatedLines ?? '?'} lines`}
          </div>
        ) : (
          <div className="written" style={{ color: 'var(--red)' }}>{safeText(output?.error)}</div>
        )}
      </>
    );
  }

  if (toolName === 'list_files') {
    if (running) return <div className="filelist" style={{ color: 'var(--fg-faint)' }}>scanning…</div>;
    const entries = (output?.entries as string[]) ?? [];
    return (
      <div className="filelist">
        {entries.map((e, i) => (
          <div key={i}>
            <span className={e.endsWith('/') ? 'd' : 'f'}>
              {e.endsWith('/') ? '▸ ' : '  '}{e}
            </span>
          </div>
        ))}
      </div>
    );
  }

  if (toolName === 'expose_port') {
    if (running) return <div className="expose" style={{ color: 'var(--fg-faint)' }}>exposing port {String(input.port)}…</div>;
    return (
      <div className="expose">
        <span className="port-badge">:{String(input.port ?? '')}</span>
        {safeUrl(output?.url) ? (
          <a href={safeUrl(output?.url)!} target="_blank" rel="noopener noreferrer">
            {safeUrl(output?.url)}<Icon name="external" size={12} />
          </a>
        ) : (
          <span style={{ color: 'var(--red)' }}>invalid url</span>
        )}
      </div>
    );
  }

  return null;
}
