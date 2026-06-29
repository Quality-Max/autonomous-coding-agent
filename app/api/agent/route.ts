import { streamText, stepCountIs, hasToolCall, convertToModelMessages, type UIMessage } from 'ai';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getOrCreateSandbox, killSandbox } from '@/lib/sandbox';
import { killPreviewSandbox } from '@/lib/preview';
import { resolveModel } from '@/lib/router';
import { makeTools } from '@/lib/tools';
import { loadMCPTools, isSafeSSEUrl, SAFE_AUTH } from '@/lib/mcp';

export const maxDuration = 300;

const SYSTEM_PROMPT = `You are an autonomous coding agent running inside an isolated Linux sandbox.

PLAN BEFORE YOU ACT. This is mandatory:
- Your FIRST action on any task must be a call to update_plan laying out the steps you intend to take. Never run a command or edit a file before you have recorded a plan.
- Keep the plan live as you work: call update_plan again to mark the step you are starting as "in_progress" and finished steps as "done", and to add or revise steps as you learn more. Exactly one step should be "in_progress" at a time.
- Close the plan out before you finish: your LAST action in a turn must be an update_plan call that marks every completed step "done". Never end your turn with a step left "in_progress" that you have actually finished — including the final step. Write your closing summary to the user only after that final update_plan call.
- The plan is how the user follows your work — keep steps concrete and in execution order.

GET THE USER'S BUY-IN BEFORE SUBSTANTIAL WORK. This is mandatory:
- Exploration is free and encouraged: cloning a repo, reading and listing files, searching, and running read-only or test commands never need approval. Do this first so your proposal is grounded in the actual codebase.
- But BEFORE the first action that changes state or reaches outside the sandbox — writing or editing a file, running a state-changing command, installing packages, git add/commit/push, creating a branch, or opening a PR — you MUST call request_approval. Summarize what you intend to do and give 2-3 concrete options. This ENDS your turn; wait for the user's choice before proceeding.
- Do not assume the task implies permission to implement. Even when the user hands you a ticket or a clearly-scoped change, confirm the approach first — the user may want a different scope, a smaller step, or just your findings.
- Once the user picks an option, carry out that approved work without pausing on every step. Call request_approval again only to deviate significantly from what was approved, or to take a new irreversible/outward action it did not cover.

Typical workflow:
1. Call update_plan with an initial breakdown of the task (e.g. clone, explore, propose, implement, test).
2. If a repository URL is provided, clone it: run_command("git clone <url> /home/user/repo")
3. Explore the structure with list_files and read_file. Refine the plan with update_plan once you understand the codebase.
4. Call request_approval with a short summary of the change you propose and 2-3 options for how to proceed, then stop and wait for the user. Resume only after they reply.
5. Work through the approved plan, keeping statuses current. For changes to existing files, prefer:
   - apply_edit: when you know the exact surrounding context (fastest, deterministic)
   - apply_edit_smart: when the edit is complex, spans multiple locations, or the exact context is uncertain (uses a fast AI model to merge the change)
   - write_file: only for new files or complete rewrites
6. Run the project after changes to verify (tests, build, or dev server), then mark the relevant steps done.
7. If the user wants a live preview, start the dev server in the background and call expose_port to get its public URL. That URL powers the preview pane. (The user can optionally open a live noVNC desktop view of it themselves from the UI — you do not start that.)
8. Use any MCP tools available (e.g. linear_*) to fetch context from connected services when relevant.

Be concise in your reasoning. Show your work through actions and the plan, not long explanations.`;

const MCPServerSchema = z.object({
  name: z.string().min(1).max(64),
  url: z.string().refine(isSafeSSEUrl, { message: 'URL must be a safe public http(s) endpoint' }),
  auth: z.string().regex(SAFE_AUTH).optional(),
  description: z.string().max(256).optional(),
});

const AgentRequestSchema = z.object({
  sessionId: z.string().min(1).max(128),
  // Each message must at least be an object with a string `role`; extra fields (parts,
  // metadata, …) pass through and are validated again by convertToModelMessages. This
  // gives the downstream `as UIMessage[]` cast a real runtime shape guarantee.
  messages: z.array(z.looseObject({ role: z.string() })).min(1),
  provider: z.enum(['anthropic', 'openai', 'google', 'cerebras']).optional(),
  model: z.string().max(128).optional(),
  mcpServers: z.array(MCPServerSchema).max(10).optional(),
  // BYOK: the visitor's own keys, supplied per-request from the UI. Used only for this
  // request and never persisted or logged. A 512-char cap is well above any real key.
  keys: z.object({
    e2b: z.string().max(512).optional(),
    anthropic: z.string().max(512).optional(),
    openai: z.string().max(512).optional(),
    google: z.string().max(512).optional(),
    cerebras: z.string().max(512).optional(),
  }).optional(),
});

export async function POST(req: NextRequest) {
  const parsed = AgentRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request', details: parsed.error.flatten() }, { status: 400 });
  }
  const { messages, sessionId, provider, model: modelId, mcpServers, keys } = parsed.data;
  const safeMcpServers = mcpServers ?? [];

  let sandbox;
  try {
    sandbox = await getOrCreateSandbox(sessionId, keys?.e2b);
  } catch (err) {
    await killSandbox(sessionId, keys?.e2b);
    throw err;
  }

  const { tools: mcpTools, cleanup: cleanupMCP } = await loadMCPTools(safeMcpServers);

  // #1 — The abort signal may have already fired while loadMCPTools was awaiting.
  // Adding a listener to an already-aborted signal does NOT retroactively fire it.
  if (req.signal.aborted) {
    killSandbox(sessionId, keys?.e2b);
    void killPreviewSandbox(sessionId, keys?.e2b);
    await cleanupMCP();
    return NextResponse.json({ error: 'Request aborted' }, { status: 499 });
  }
  req.signal.addEventListener('abort', () => {
    killSandbox(sessionId, keys?.e2b);
    void killPreviewSandbox(sessionId, keys?.e2b);
    void cleanupMCP();
  });

  const model = resolveModel(provider, modelId, keys);
  // #3 — Sandbox tools spread last so they always win over same-named MCP tools.
  const tools = { ...mcpTools, ...makeTools(sandbox, provider, keys) };

  // #2 — Wrap in try/catch so MCP clients are closed even if streamText throws synchronously.
  try {
    const result = streamText({
      model,
      system: SYSTEM_PROMPT,
      // Zod has guaranteed each message is an object with a string `role`;
      // convertToModelMessages re-validates the full UIMessage shape at runtime. Cast via
      // unknown because the loose Zod type doesn't structurally overlap with UIMessage.
      messages: await convertToModelMessages(messages as unknown as UIMessage[]),
      tools,
      // Stop the run when the agent asks for approval — request_approval ends the turn so the
      // user can choose a course of action before any mutating work begins — or at the step cap.
      stopWhen: [stepCountIs(25), hasToolCall('request_approval')],
      onFinish: async () => { await cleanupMCP(); },
    });
    return result.toUIMessageStreamResponse();
  } catch (err) {
    await cleanupMCP();
    throw err;
  }
}
