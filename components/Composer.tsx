'use client';

import Icon from './Icon';

interface Props {
  repo: string;
  setRepo: (v: string) => void;
  task: string;
  setTask: (v: string) => void;
  running: boolean;
  onRun: () => void;
  onStop: () => void;
}

export default function Composer({ repo, setRepo, task, setTask, running, onRun, onStop }: Props) {
  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onRun(); }
  }

  return (
    <div className="composer">
      <div className="composer-box">
        <div className="composer-repo">
          <Icon name="github" size={14} />
          <input
            value={repo}
            onChange={e => setRepo(e.target.value)}
            placeholder="github.com/owner/repo"
            spellCheck={false}
          />
          <Icon name="branch" size={13} style={{ color: 'var(--fg-faint)' }} />
          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--fg-faint)' }}>main</span>
        </div>
        <textarea
          value={task}
          onChange={e => setTask(e.target.value)}
          onKeyDown={onKey}
          rows={2}
          placeholder="Describe the task — e.g. add a /health endpoint and a test for it"
        />
        <div className="composer-foot">
          <span className="composer-hint"><kbd>Cmd</kbd> <kbd>Enter</kbd> to run</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 9 }}>
            {running && (
              <button className="btn ghost" onClick={onStop} title="Stop agent">
                <Icon name="x" size={14} />Stop
              </button>
            )}
            <button className="btn" onClick={onRun} disabled={running || (!repo.trim() && !task.trim())}>
              {running
                ? <><span className="tc-status" style={{ width: 12, height: 12 }}><span className="spin" style={{ width: 12, height: 12 }} /></span>Running</>
                : <><Icon name="send" size={14} />Run task</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
