'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Icon from '@/components/Icon';
import PyramidLogo from '@/components/PyramidLogo';
import type { ApiKeys } from '@/lib/types';

// Key under which the agent page picks up a handoff task on mount (see app/page.tsx).
const HANDOFF_KEY = 'acaHandoffTask';
const HANDOFF_MODEL = 'gpt-oss-120b';

interface VisionResult {
  model: string;
  provider: string;
  ok: boolean;
  multimodal: boolean;
  sawScreenshot: boolean;
  testCode?: string;
  error?: string;
  accessPending?: boolean;
  elapsedMs: number;
  inputTokens?: number;
  outputTokens?: number;
  tokensPerSec?: number;
  costUsd?: number;
}

interface VisionResponse {
  screenshot: string;
  primary: VisionResult;
  baseline: VisionResult | null;
  error?: string;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function normalizeAppUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function Metric({ value, label, fast }: { value: string | number; label: string; fast?: boolean }) {
  return (
    <div className="rec-metric">
      <div className={`v${fast ? ' fast' : ''}`}>{value}</div>
      <div className="k">{label}</div>
    </div>
  );
}

function ResultCard({ result, kind, onSend }: { result: VisionResult; kind: 'primary' | 'baseline'; onSend: () => void }) {
  const vision = result.sawScreenshot ? 'saw screenshot' : 'text-only';
  return (
    <div className="rec-result enter">
      <div className="rec-result-head">
        <span className={`rec-chip${kind === 'baseline' ? ' base' : ''}`}>{result.model}</span>
        <span className="tag"><span className="br">[</span>{result.provider} · {vision}<span className="br">]</span></span>
      </div>
      {!result.ok ? (
        <div className="rec-note rec-warn">
          {result.accessPending
            ? `Access pending — this org can't reach ${result.model} yet. Get Gemma 4 preview access, or try gpt-oss-120b.`
            : (result.error || 'Generation failed.')}
        </div>
      ) : (
        <>
          <div className="rec-metrics">
            <Metric value={`${(result.elapsedMs / 1000).toFixed(2)}s`} label="wall time" fast />
            <Metric value={result.tokensPerSec ?? 0} label="tokens/sec" fast />
            <Metric value={result.outputTokens ?? 0} label="out tokens" />
            <Metric value={`$${(result.costUsd ?? 0).toFixed(5)}`} label="est. cost" />
          </div>
          <pre className="rec-code">{result.testCode}</pre>
          <div className="rec-actions">
            <button className="btn" onClick={onSend}>
              <Icon name="send" size={14} />Send to coding agent
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default function RecognizePage() {
  const router = useRouter();
  const [dataUri, setDataUri] = useState<string | null>(null);
  const [dataUriFromUrl, setDataUriFromUrl] = useState(false);
  const [appUrl, setAppUrl] = useState('');
  const [model, setModel] = useState('gemma-4-31b');
  const [baselineModel, setBaselineModel] = useState('');
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [resp, setResp] = useState<VisionResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const apiKeysRef = useRef<ApiKeys>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  // BYOK: read the Cerebras key the visitor entered on the agent page (same localStorage
  // slot). The server's own CEREBRAS_API_KEY is used when this is absent.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('apiKeys') ?? '{}') as ApiKeys;
      apiKeysRef.current = saved || {};
    } catch {}
  }, []);

  // Paste an image straight from the clipboard.
  useEffect(() => {
    async function onPaste(e: ClipboardEvent) {
      const file = Array.from(e.clipboardData?.items ?? [])
        .find(i => i.type.startsWith('image/'))?.getAsFile();
      if (file) {
        setDataUri(await readFileAsDataUrl(file));
        setDataUriFromUrl(false);
      }
    }
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);

  async function pickFile(file: File | undefined) {
    if (!file || !file.type.startsWith('image/')) return;
    setDataUri(await readFileAsDataUrl(file));
    setDataUriFromUrl(false);
  }

  async function generate() {
    const url = normalizeAppUrl(appUrl);
    const imageBase64 = dataUri && !dataUriFromUrl ? dataUri : undefined;
    if ((!imageBase64 && !url) || busy) return;
    setBusy(true);
    setErr(null);
    setResp(null);
    const prompt = [
      instructions.trim() || '',
    ].filter(Boolean).join('\n\n') || undefined;
    try {
      const res = await fetch('/api/vision', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          imageBase64,
          url: url || undefined,
          model,
          baselineModel: baselineModel || undefined,
          instructions: prompt,
          keys: Object.keys(apiKeysRef.current).length ? apiKeysRef.current : undefined,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setErr(data?.error || `Error ${res.status}`);
        return;
      }
      if (data?.screenshot) {
        setDataUri(data.screenshot);
        setDataUriFromUrl(data.imageSource === 'url');
      }
      setResp(data as VisionResponse);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // The handoff: take what Cerebras saw + the test it generated and pass it to the
  // autonomous coding agent as a concrete task. Same context, same provider — vision →
  // reasoning → agent in one flow.
  function sendToAgent(result: VisionResult) {
    if (!result.testCode) return;
    const url = normalizeAppUrl(appUrl);
    const task =
      `A multimodal model (${result.model}) looked at ${url ? `the app at ${url}` : 'a screenshot of the app under test'} ` +
      `and generated this Playwright test:\n\n\`\`\`\n${result.testCode}\n\`\`\`\n\n` +
      `In this repository: place the test in the correct tests directory, adapt ` +
      `imports/selectors/baseURL${url ? ` (${url})` : ''} to match the project, run the relevant tests, and ` +
      `summarize the result. Keep the change focused.`;
    try {
      sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({
        task,
        provider: 'cerebras',
        model: HANDOFF_MODEL,
      }));
    } catch {}
    router.push('/');
  }

  return (
    <div className="rec app density-regular">
      <header className="hdr">
        <PyramidLogo size={24} className="brand-logo" />
        <span className="brand-name" style={{ fontFamily: 'var(--font-display)', fontSize: 15 }}>
          <b>QualityMax</b> · recognize
        </span>
        <span className="tag" style={{ marginLeft: 6 }}>
          <span className="br">[</span>cerebras · gemma 4<span className="br">]</span>
        </span>
        <Link href="/" className="pill" style={{ marginLeft: 'auto', textDecoration: 'none' }}>
          <Icon name="agent" size={13} />Coding agent
        </Link>
      </header>

      <div className="rec-body">
        <div className="rec-wrap">
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 22, margin: '4px 0 0' }}>
            Vision recognition on Cerebras
          </h1>
          <p className="rec-lede">
            Drop a screenshot of any app. Gemma 4 on Cerebras reads the actual pixels —
            layout, modals, disabled states a DOM dump misses — and writes a Playwright
            test at the speed of thought. Then hand it straight to the coding agent.
          </p>

          <div className="rec-grid">
            <div className="rec-panel">
              <div className="rec-field">
                <label>Screenshot</label>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={e => pickFile(e.target.files?.[0])}
                />
                {dataUri ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={dataUri} alt="uploaded screenshot" className="rec-thumb"
                    onClick={() => fileInputRef.current?.click()} style={{ cursor: 'pointer' }} />
                ) : (
                  <div
                    className={`rec-drop${over ? ' over' : ''}`}
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={e => { e.preventDefault(); setOver(true); }}
                    onDragLeave={() => setOver(false)}
                    onDrop={e => { e.preventDefault(); setOver(false); void pickFile(e.dataTransfer.files?.[0]); }}
                  >
                    <Icon name="eye" size={20} style={{ color: 'var(--accent)', marginBottom: 6 }} />
                    <div>Click, drag, or paste an image</div>
                  </div>
                )}
              </div>

              <div className="rec-field">
                <label>App URL</label>
                <input
                  className="rec-input"
                  type="url"
                  value={appUrl}
                  onChange={e => setAppUrl(e.target.value)}
                  placeholder="https://your-app.example.com"
                />
              </div>

              <div className="rec-field">
                <label>Model (Cerebras)</label>
                <select className="rec-select" value={model} onChange={e => setModel(e.target.value)}>
                  <option value="gemma-4-31b">gemma-4-31b · multimodal</option>
                  <option value="gpt-oss-120b">gpt-oss-120b · text-only</option>
                  <option value="zai-glm-4.7">zai-glm-4.7 · text-only</option>
                </select>
              </div>

              <div className="rec-field">
                <label>Baseline model (optional)</label>
                <select className="rec-select" value={baselineModel} onChange={e => setBaselineModel(e.target.value)}>
                  <option value="">none</option>
                  <option value="gpt-oss-120b">gpt-oss-120b</option>
                  <option value="zai-glm-4.7">zai-glm-4.7</option>
                </select>
              </div>

              <div className="rec-field">
                <label>Instructions (optional)</label>
                <textarea
                  className="rec-textarea"
                  value={instructions}
                  onChange={e => setInstructions(e.target.value)}
                  placeholder="Override the default test-generation instruction…"
                />
              </div>

              <button className="btn" style={{ width: '100%' }} onClick={generate} disabled={(!dataUri && !appUrl.trim()) || busy}>
                {busy ? 'Running on Cerebras…' : <><Icon name="box" size={14} />Generate test</>}
              </button>
            </div>

            <div>
              {err && <div className="rec-empty rec-warn" style={{ marginBottom: 16 }}>{err}</div>}
              {!resp && !err && (
                <div className="rec-empty">
                  Enter an app URL or upload a screenshot to see the generated test, speed, and cost.
                </div>
              )}
              {resp && (
                <>
                  <ResultCard result={resp.primary} kind="primary" onSend={() => sendToAgent(resp.primary)} />
                  {resp.baseline && (
                    <ResultCard result={resp.baseline} kind="baseline" onSend={() => sendToAgent(resp.baseline!)} />
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
