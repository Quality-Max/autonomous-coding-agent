import { Sandbox, FileType } from 'e2b';

// Per-process sandbox registry: sessionId → sandboxId.
// Resets on cold starts — the agent reconstructs context from conversation history.
const registry = new Map<string, string>();

// 10 minutes — refreshed on each reconnect AND at the start of every sandbox operation,
// so the clock resets as long as the agent is actively calling tools.
const TIMEOUT_MS = 10 * 60 * 1000;

export async function getOrCreateSandbox(sessionId: string): Promise<Sandbox> {
  const existingId = registry.get(sessionId);
  if (existingId) {
    try {
      const sandbox = await Sandbox.connect(existingId);
      await sandbox.setTimeout(TIMEOUT_MS);
      return sandbox;
    } catch {
      registry.delete(sessionId);
    }
  }
  const sandbox = await Sandbox.create({ timeoutMs: TIMEOUT_MS });
  registry.set(sessionId, sandbox.sandboxId);
  return sandbox;
}

export async function killSandbox(sessionId: string): Promise<void> {
  const sandboxId = registry.get(sessionId);
  if (!sandboxId) return;
  registry.delete(sessionId);
  try {
    await Sandbox.kill(sandboxId);
  } catch {
    // Already dead or unreachable — that's fine
  }
}

// Refresh the sandbox deadline before each operation so long multi-step agent runs
// don't hit the timeout mid-flight. Failures are silently ignored — if the sandbox is
// already dead the next operation will surface a real error.
async function refreshTimeout(sandbox: Sandbox): Promise<void> {
  try { await sandbox.setTimeout(TIMEOUT_MS); } catch { /* sandbox already dead */ }
}

export async function runCommand(
  sandbox: Sandbox,
  cmd: string,
  opts: { background?: boolean } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  await refreshTimeout(sandbox);
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const result = await sandbox.commands.run(cmd, {
    onStdout: (data: string) => { stdoutChunks.push(data); },
    onStderr: (data: string) => { stderrChunks.push(data); },
    background: opts.background,
    // Don't apply a timeout to background processes (dev servers, watchers) — they must run
    // for the lifetime of the session. Cap foreground commands at 5 minutes (package installs,
    // builds, and test suites can easily exceed 2 minutes).
    ...(opts.background ? {} : { timeoutMs: 5 * 60 * 1000 }),
  });

  return {
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join(''),
    // exitCode is undefined for background processes — report null so the UI can distinguish
    // "still running" from "exited 0".
    exitCode: opts.background ? null : (result.exitCode ?? -1),
  } as { stdout: string; stderr: string; exitCode: number | null };
}

export async function readFile(sandbox: Sandbox, path: string): Promise<string> {
  await refreshTimeout(sandbox);
  return sandbox.files.read(path);
}

export async function writeFile(sandbox: Sandbox, path: string, content: string): Promise<void> {
  await refreshTimeout(sandbox);
  await sandbox.files.write(path, content);
}

export async function listFiles(sandbox: Sandbox, path: string): Promise<string[]> {
  await refreshTimeout(sandbox);
  const entries = await sandbox.files.list(path);
  return entries.map(e => e.type === FileType.DIR ? `${e.name}/` : e.name);
}

export function getPublicUrl(sandbox: Sandbox, port: number): string {
  return `https://${sandbox.getHost(port)}`;
}
