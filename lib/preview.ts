import { Sandbox as DesktopSandbox } from '@e2b/desktop';

// Live previews run in a DEDICATED desktop sandbox — separate from the coding sandbox.
// The coding sandbox keeps editing files and running the dev server; this sandbox just
// opens a real browser pointed at the app and streams its screen over noVNC. That keeps
// the heavy GUI/VNC workload off the coding sandbox and lets the preview survive while
// the agent keeps working.
//
// Per-process registry: sessionId → { id, authKey }. Like the coding-sandbox registry it
// resets on cold starts; a cold start just spins up a fresh preview sandbox (the orphaned
// one times out on its own).
const registry = new Map<string, { id: string; authKey: string }>();

// Match the coding sandbox's 10-minute idle timeout, refreshed on every preview call.
const TIMEOUT_MS = 10 * 60 * 1000;

// Chrome is preinstalled in E2B's `desktop` template (alongside firefox, vscode).
const BROWSER = 'google-chrome-stable';

/**
 * Open `targetUrl` in a real browser inside a streamed desktop sandbox and return an
 * embeddable noVNC URL. Reuses the session's existing preview sandbox when possible —
 * subsequent calls just navigate the already-streaming browser to the new URL.
 */
export async function startLivePreview(
  sessionId: string,
  targetUrl: string,
  apiKey?: string,
): Promise<{ streamUrl: string }> {
  const safeUrl = assertSafeHttpUrl(targetUrl);
  const opts = apiKey ? { apiKey } : {};

  const existing = registry.get(sessionId);
  if (existing) {
    try {
      const desktop = await DesktopSandbox.connect(existing.id, opts);
      await desktop.setTimeout(TIMEOUT_MS);
      await openInBrowser(desktop, safeUrl);
      return { streamUrl: streamUrl(desktop, existing.authKey) };
    } catch {
      // Sandbox died or is unreachable — fall through and create a fresh one.
      registry.delete(sessionId);
    }
  }

  const desktop = await DesktopSandbox.create({ ...opts, timeoutMs: TIMEOUT_MS });
  // requireAuth gates the stream behind an auto-generated key so the (per-session,
  // time-limited) stream URL isn't usable by anyone who merely guesses the host.
  await desktop.stream.start({ requireAuth: true });
  const authKey = desktop.stream.getAuthKey();
  registry.set(sessionId, { id: desktop.sandboxId, authKey });
  await openInBrowser(desktop, safeUrl);
  return { streamUrl: streamUrl(desktop, authKey) };
}

// Validate the preview target before it reaches a browser/shell. Rejects non-http(s)
// schemes (file:, javascript:, data:) and points at a public host only. The navigation
// itself happens inside an isolated desktop sandbox (not our server), but blocking
// loopback/private/link-local targets is cheap defense-in-depth — and previewing a private
// address from a separate sandbox is meaningless anyway. Literal-address check only; we
// don't resolve DNS, which is proportionate given the isolated-VM execution context.
// Exported for unit testing; `startLivePreview` is the only production caller.
export function assertSafeHttpUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid preview URL: ${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Preview URL must use http(s), got: ${parsed.protocol}`);
  }
  if (isDisallowedHost(parsed.hostname)) {
    throw new Error(`Preview URL must point at a public hostname, got: ${parsed.hostname}`);
  }
  return raw;
}

// Preview targets are expected to be public hostnames (e.g. <port>-<id>.e2b.app, or any
// public site). We reject loopback/`.local` names AND every IP literal — refusing raw IPs
// outright closes private-range access together with the octal/hex/decimal/IPv6 notation
// bypasses (0177.0.0.1, 0x7f.0.0.1, 2130706433, [::1], …) in one rule, with no per-range
// math. new URL() already canonicalises every IPv4 notation to dotted-decimal before we
// see it, so the literal check below is the final gate. DNS rebinding is out of scope: the
// URL is navigated by the isolated desktop sandbox, not fetched by our server, so there is
// no server-side SSRF vector to rebind.
function isDisallowedHost(hostname: string): boolean {
  // Strip a trailing FQDN-root dot so "localhost." / "app.local." can't slip past the
  // name checks (URL.hostname keeps it for non-IP names).
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host.startsWith('[') && host.endsWith(']')) return true; // any IPv6 literal
  if (isIpv4Literal(host)) return true;                        // any IPv4 notation
  return false;
}

// True if `host` is an IPv4 address in any notation a resolver would accept — dotted
// decimal/octal/hex (a.b.c.d and the short a, a.b, a.b.c forms) or a bare 32-bit number.
// Real hostnames have at least one non-numeric label, so they never match.
function isIpv4Literal(host: string): boolean {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4) return false;
  return parts.every(p =>
    /^0x[0-9a-f]+$/.test(p) ||  // hex   (0x7f)
    /^0[0-7]*$/.test(p) ||      // octal (0177, 0)
    /^[1-9][0-9]*$/.test(p),    // decimal
  );
}

// Open a URL in the desktop's browser. We invoke the Chrome binary directly rather than
// via the SDK's desktop.launch()/open() (which use `gtk-launch`/`xdg-open`): Chrome's
// .desktop entry has no %U field code, so those paths silently DROP the URL and just open
// a blank browser. Passing the URL as a real argv argument navigates reliably; if Chrome
// is already running it opens in a new tab. The URL is single-quoted so shell
// metacharacters can't break out of the argument (BROWSER is a fixed constant, not input).
// DISPLAY points at the streamed X session so the window renders on the desktop;
// --start-maximized makes the window fill the viewport so the stream looks clean.
async function openInBrowser(desktop: DesktopSandbox, url: string): Promise<void> {
  const display = desktop.display || ':0';
  await desktop.commands.run(
    `DISPLAY=${display} ${BROWSER} --no-first-run --no-default-browser-check --start-maximized ${shellQuote(url)}`,
    { background: true, timeoutMs: 0 },
  );
}

// Exported for unit testing; used by openInBrowser to neutralise shell metacharacters.
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function killPreviewSandbox(sessionId: string, apiKey?: string): Promise<void> {
  const entry = registry.get(sessionId);
  if (!entry) return;
  registry.delete(sessionId);
  try {
    await DesktopSandbox.kill(entry.id, apiKey ? { apiKey } : undefined);
  } catch {
    // Already dead or unreachable — that's fine.
  }
}

function streamUrl(desktop: DesktopSandbox, authKey: string): string {
  // autoConnect: connect without a click; resize 'scale' fits the desktop to the iframe;
  // viewOnly stays false so the user can interact with the previewed app.
  return desktop.stream.getUrl({ authKey, autoConnect: true, resize: 'scale', viewOnly: false });
}
