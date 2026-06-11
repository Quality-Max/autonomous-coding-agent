'use client';

import type { UIMessage, DynamicToolUIPart } from 'ai';
import Icon from './Icon';
import ScrambleText from './ScrambleText';
import ToolCallCard from './ToolCallCard';

const EXAMPLES = [
  { repo: 'acme/storefront', task: 'Add a GET /health endpoint that returns status, uptime, and the current git SHA. Add a Vitest test that hits it.' },
  { repo: 'vercel/next.js', task: 'Find and fix the flaky test in the app-router e2e suite.' },
  { repo: 'supabase/supabase', task: 'Add rate limiting middleware to the edge functions and document it.' },
];

const ASCII = `       ╔═══════════════════════╗
   ╔═══╣  Q u a l i t y M a x  ╠═══╗
   ║   ╚═══════════════════════╝   ║
   ║    ▸ sandbox.create()         ║
   ╚═══════════════════════════════╝`;

interface Props {
  messages: UIMessage[];
  isStreaming: boolean;
  error?: Error;
  onExample: (repo: string, task: string) => void;
  // Sends a message on the user's behalf — used by the approval card's option buttons.
  onRespond: (text: string) => void;
}

export default function AgentLog({ messages, isStreaming, error, onExample, onRespond }: Props) {
  if (messages.length === 0 && !error) {
    return (
      <div className="empty dotgrid">
        <div className="asciiwrap"><div className="ascii-art">{ASCII}</div></div>
        <div className="empty-inner">
          <div className="empty-badge"><span className="dot" />SANDBOX READY · 80MS COLD START</div>
          <h1>AUTONOMOUS<br /><ScrambleText className="scramble" text="CODING AGENT" /></h1>
          <p>Paste a repository and describe a task. The agent clones it into a secure cloud sandbox, plans, runs commands, edits files, and streams every step back to you.</p>
          <div className="chip-row">
            {EXAMPLES.map((ex, i) => (
              <button key={i} className="chip" onClick={() => onExample(ex.repo, ex.task)}>
                <span className="arrow">▸</span>{ex.repo}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="log-inner">
      {messages.map((msg, i) => (
        <MessageRow
          key={msg.id ?? i}
          message={msg}
          onRespond={onRespond}
          // Only the latest message's approval card is actionable, and only once the run has
          // stopped — answering an old request, or one mid-stream, would be incoherent.
          interactive={i === messages.length - 1 && !isStreaming}
        />
      ))}

      {isStreaming && (
        <div className="msg-agent enter">
          <div className="agent-avatar"><Icon name="agent" size={14} /></div>
          <div className="msg-body">
            <div className="thinking">
              <span className="bar"><i /><i /><i /></span>thinking…
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="err-banner enter">
          <Icon name="x" size={14} />
          {extractErrorMessage(error)}
        </div>
      )}
    </div>
  );
}

function extractErrorMessage(error: Error): string {
  const raw = error.message ?? String(error);
  const m = raw.match(/"message"\s*:\s*"([^"]+)"/);
  return m ? m[1] : raw;
}

// Handle both DynamicToolUIPart (type:'dynamic-tool') and static ToolUIPart (type:'tool-{name}')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isToolPart(part: any): boolean {
  return part.type === 'dynamic-tool' || (typeof part.type === 'string' && part.type.startsWith('tool-'));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toDynamicTool(part: any): DynamicToolUIPart {
  if (part.type === 'dynamic-tool') return part as DynamicToolUIPart;
  // Wrap static ToolUIPart as DynamicToolUIPart shape for the card renderer
  const toolName = (part.type as string).slice(5);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = part as any;
  return { ...p, type: 'dynamic-tool', toolName } as DynamicToolUIPart;
}

function renderInline(text: string) {
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((p, i) =>
    p.startsWith('`') && p.endsWith('`')
      ? <span key={i} className="mono">{p.slice(1, -1)}</span>
      : <span key={i}>{p}</span>
  );
}

function MessageRow({ message, onRespond, interactive }: { message: UIMessage; onRespond: (text: string) => void; interactive: boolean }) {
  if (message.role === 'user') {
    const text = message.parts.filter(p => p.type === 'text').map(p => p.text).join('');
    const repoMatch = text.match(/^(https?:\/\/\S+|[\w.-]+\/[\w.-]+)\s*\n?/);
    const repo = repoMatch ? repoMatch[1].replace(/^https?:\/\//, '') : null;
    const taskText = repo ? text.slice(repoMatch![0].length).trim() : text;

    return (
      <div className="msg-user enter">
        {repo && <div className="repo"><Icon name="github" size={12} />{repo}</div>}
        {taskText}
      </div>
    );
  }

  return (
    <div className="msg-agent enter">
      <div className="agent-avatar"><Icon name="agent" size={14} /></div>
      <div className="msg-body">
        {message.parts?.map((part, i) => {
          if (part.type === 'text' && part.text) {
            return (
              <div key={i} className="msg-text" style={{ whiteSpace: 'pre-wrap' }}>
                {renderInline(part.text)}
              </div>
            );
          }
          if (isToolPart(part)) {
            return <ToolCallCard key={i} part={toDynamicTool(part)} onRespond={onRespond} interactive={interactive} />;
          }
          return null;
        })}
      </div>
    </div>
  );
}
