import { tool } from 'ai';
import { z } from 'zod';
import type { Sandbox } from 'e2b';
import { runCommand, readFile, writeFile, listFiles, getPublicUrl } from './sandbox';
import { fastApply } from './fastApply';
import { resolveFastModel } from './router';
import type { ProviderName, ApiKeys } from './types';

export function makeTools(sandbox: Sandbox, provider?: ProviderName, keys?: ApiKeys) {
  return {
    update_plan: tool({
      description:
        'Record or update your step-by-step plan for the task. Call this FIRST — before running any command or editing any file — to lay out how you intend to approach the work. Call it again whenever the plan changes: mark a step "in_progress" when you start it and "done" when you finish, and add or revise steps as you learn more. Always pass the COMPLETE ordered list of steps; it fully replaces the previous plan.',
      inputSchema: z.object({
        steps: z
          .array(
            z.object({
              title: z.string().min(1).max(200).describe('A short, concrete description of the step'),
              status: z
                .enum(['pending', 'in_progress', 'done'])
                .describe('Current status of this step'),
            }),
          )
          .min(1)
          .max(20)
          .describe('The full ordered list of steps in the plan'),
      }),
      // No sandbox side effects — the plan is surfaced to the user from the tool input.
      execute: async (input) => {
        const done = input.steps.filter((s) => s.status === 'done').length;
        return { ok: true, total: input.steps.length, done };
      },
    }),

    request_approval: tool({
      description:
        'Pause and ask the user to confirm the approach BEFORE any substantial or mutating work: writing or editing files, running state-changing commands, installing packages, git add/commit/push, creating branches, or opening PRs. Read-only exploration (cloning, reading, listing, searching, running tests) does NOT need approval — do that first to ground your understanding. Calling this tool ENDS your turn: give a concise summary of what you intend to do and 2-3 concrete options, then wait for the user to choose. Once the user approves an approach, carry it out without re-asking for each step; only call this again to deviate significantly or to take a new irreversible action the approval did not cover.',
      // Bounds are deliberately generous. Strict caps (e.g. exactly 2-3 options) cause the
      // model's call to fail schema validation, which surfaces as a broken, un-actionable
      // approval card; the "2-3 concrete options" guidance lives in the description instead.
      inputSchema: z.object({
        summary: z
          .string()
          .min(1)
          .max(4000)
          .describe('A concise summary of what you intend to do and why, so the user can decide'),
        options: z
          .array(z.string().min(1).max(400))
          .min(1)
          .max(6)
          .describe('2-3 concrete courses of action for the user to choose from'),
      }),
      // No side effects. The question is surfaced to the user from the tool input, and the
      // turn stops here (see the request_approval stop condition in the agent route) until
      // the user replies with their choice in the next message.
      execute: async (input) => {
        return { awaiting: true, options: input.options };
      },
    }),

    run_command: tool({
      description:
        'Run a shell command in the sandbox. Returns stdout, stderr, and exit code. Use background=true for long-running processes like dev servers.',
      inputSchema: z.object({
        cmd: z.string().describe('The shell command to run'),
        background: z.boolean().optional().describe('Run in background (for servers, watchers)'),
      }),
      execute: async (input) => {
        return runCommand(sandbox, input.cmd, { background: input.background });
      },
    }),

    read_file: tool({
      description: 'Read the contents of a file in the sandbox.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the file'),
      }),
      execute: async (input) => {
        const content = await readFile(sandbox, input.path);
        return { path: input.path, content };
      },
    }),

    write_file: tool({
      description:
        'Write content to a file in the sandbox. Creates the file (and parent directories) if needed. Use apply_edit or apply_edit_smart for changes to existing files.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the file'),
        content: z.string().describe('Full file content to write'),
      }),
      execute: async (input) => {
        await writeFile(sandbox, input.path, input.content);
        return { path: input.path, bytes: input.content.length };
      },
    }),

    apply_edit: tool({
      description:
        'Apply a targeted edit to an existing file by replacing an exact string. Use when you know the exact surrounding context. Fails if the search string is not found exactly once.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the file'),
        search: z.string().describe('Exact string to find — must appear exactly once in the file'),
        replace: z.string().describe('Replacement string'),
      }),
      execute: async (input) => {
        const original = await readFile(sandbox, input.path);
        const occurrences = original.split(input.search).length - 1;
        if (occurrences === 0) {
          return { ok: false, error: `String not found in ${input.path}` };
        }
        if (occurrences > 1) {
          return { ok: false, error: `String appears ${occurrences} times in ${input.path} — make it unique before using apply_edit` };
        }
        const updated = original.replace(input.search, input.replace);
        await writeFile(sandbox, input.path, updated);
        return { ok: true, path: input.path, search: input.search, replace: input.replace };
      },
    }),

    apply_edit_smart: tool({
      description:
        'Apply a partial or approximate code edit using a fast AI model (Fast Apply). Unlike apply_edit, this does not require an exact string match — pass a code snippet or natural-language instruction and the model will merge it into the file intelligently. Ideal for complex edits, multi-location changes, or when the exact surrounding context is uncertain.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path to the file to edit'),
        edit: z.string().describe(
          'The edit to apply. Can be: a code snippet showing the change, a partial diff, or a natural-language instruction (e.g. "add error handling around the fetchUser call")',
        ),
      }),
      execute: async (input) => {
        let original: string;
        try {
          original = await readFile(sandbox, input.path);
        } catch {
          return { ok: false, error: `File not found: ${input.path}` };
        }
        if (!original.trim()) {
          return { ok: false, error: `File is empty: ${input.path} — use write_file instead` };
        }

        let updated: string;
        let model: string;
        try {
          const fastModel = resolveFastModel(provider, keys);
          ({ updated, model } = await fastApply(original, input.edit, fastModel));
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }

        // Sanity-check: if the model returned the exact same content, skip the write.
        if (updated === original) {
          return { ok: true, path: input.path, model, linesChanged: 0, noChange: true };
        }

        await writeFile(sandbox, input.path, updated);

        // Return a compact summary — NOT the full file content — to keep message state small.
        const originalLines = original.split('\n').length;
        const updatedLines = updated.split('\n').length;
        return {
          ok: true,
          path: input.path,
          model,
          linesChanged: Math.abs(updatedLines - originalLines),
          originalLines,
          updatedLines,
        };
      },
    }),

    list_files: tool({
      description: 'List files and directories at a path in the sandbox.',
      inputSchema: z.object({
        path: z.string().describe('Directory path to list'),
      }),
      execute: async (input) => {
        const entries = await listFiles(sandbox, input.path);
        return { path: input.path, entries };
      },
    }),

    expose_port: tool({
      description:
        'Get a public HTTPS URL for a port that a process inside the sandbox is listening on (e.g. a dev server on port 3000). The URL is returned so it can be shown in a live-preview iframe.',
      inputSchema: z.object({
        port: z.number().describe('Port number the in-sandbox process is listening on'),
      }),
      execute: async (input) => {
        const url = getPublicUrl(sandbox, input.port);
        return { port: input.port, url };
      },
    }),
    // Note: the live noVNC *desktop* preview is intentionally NOT an agent tool — it is
    // started only when the user clicks the Desktop toggle (POST /api/preview), so it never
    // spins up a desktop sandbox on its own. The agent's job is just to expose the port.
  };
}
