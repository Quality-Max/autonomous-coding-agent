import { generateText } from 'ai';
import type { LanguageModel } from 'ai';

const SYSTEM = `You are a precise code editor. You will receive an original file and an edit to apply.

Rules:
- Return ONLY the complete updated file content — nothing else
- No markdown fences, no explanations, no preamble, no trailing commentary
- Preserve all formatting, indentation, and coding style of the original
- Apply the minimum change needed to implement the edit
- The edit may be a code snippet, a partial diff, or a natural-language instruction`;

// Max output tokens — caps cost and prevents truncated-file writes.
const MAX_OUTPUT_TOKENS = 12_000;

// Rough token estimate used for pre-flight size checks (~4 chars per token).
const CHARS_PER_TOKEN = 4;

// Fast Apply regenerates the ENTIRE file in a single model response, so the file
// must fit inside the OUTPUT budget — not just the input context window. Anything
// larger is guaranteed to truncate, so reject it before spending a model call.
// Leave ~20% headroom for lines the edit adds.
const MAX_FILE_CHARS = Math.floor(MAX_OUTPUT_TOKENS * CHARS_PER_TOKEN * 0.8); // ~38k chars

// Secondary guard on total prompt size (file + edit) to avoid input context errors.
const MAX_INPUT_CHARS = 320_000;

// A single intended edit on a LARGE file virtually never removes more than half of it.
// If the regenerated file shrinks past this ratio, treat it as a botched rewrite (the
// small model dropped a region) rather than writing the damaged result. The line floor
// is deliberately high: on small files, halving is a normal edit (e.g. deleting a dead
// helper from a 15-line util), so the guard must only fire where a >50% drop is
// genuinely anomalous and the drastic-shrink failure mode actually occurs.
const MIN_RETAINED_LINE_RATIO = 0.5;
const SHRINK_GUARD_MIN_LINES = 40;

// Strip a single outermost markdown fence if the entire response is wrapped in one.
// Only acts when the trimmed text starts AND ends with a fence — never touches
// files that legitimately contain code fences in their body.
function stripOuterFence(text: string): string {
  const t = text.trim();
  const match = t.match(/^```[^\n]*\n([\s\S]+)\n```$/);
  // The trimmed copy is used ONLY for fence detection. On the normal (no-fence) path
  // return the text verbatim — trimming here would silently strip the file's own
  // leading/trailing whitespace, including the conventional final newline.
  return match ? match[1] : text;
}

export interface FastApplyResult {
  updated: string;
  model: string;
}

// model is resolved by the caller via resolveFastModel() in router.ts — fastApply
// never reads credential files directly.
export async function fastApply(
  originalContent: string,
  edit: string,
  model: LanguageModel,
): Promise<FastApplyResult> {
  // Reject files that cannot fit in the output budget up front — these would always
  // truncate, so failing fast saves a wasted (and billed) model call.
  if (originalContent.length > MAX_FILE_CHARS) {
    throw new Error(
      `File is too large for fast apply (${Math.round(originalContent.length / 1000)}k chars; limit ~${Math.round(MAX_FILE_CHARS / 1000)}k). Use apply_edit (exact string replace) or write_file with the complete updated content instead.`
    );
  }

  const prompt = `<original_file>\n${originalContent}\n</original_file>\n\n<edit>\n${edit}\n</edit>`;

  if (prompt.length > MAX_INPUT_CHARS) {
    throw new Error(
      `Edit is too large for fast apply (${Math.round(prompt.length / 1000)}k chars). Use write_file with the complete updated content instead.`
    );
  }

  const { text, response, finishReason } = await generateText({
    model,
    system: SYSTEM,
    prompt,
    temperature: 0,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  // Fast Apply regenerates the ENTIRE file. If the model hit the output-token cap,
  // `text` is a truncated file — writing it would silently corrupt/cut off the file
  // (the classic "applied N lines" success report on a now-broken file). Refuse it.
  if (finishReason === 'length') {
    throw new Error(
      `Fast apply output was truncated at the ${MAX_OUTPUT_TOKENS}-token limit — the file is too large to regenerate safely. Use apply_edit (exact string replace) or write_file with the complete updated content instead.`
    );
  }

  // Any non-'stop' finish (content-filter, error, other, unknown) means generation
  // ended abnormally and `text` may be a partial file. Treat it as a failure rather
  // than writing a possibly-corrupted result. ('length' is handled above with a
  // dedicated message; no tools are passed, so 'tool-calls' cannot occur.)
  if (finishReason !== 'stop') {
    throw new Error(
      `Fast apply did not complete cleanly (finishReason: ${finishReason}) — refusing to write a possibly partial file. Use apply_edit or write_file with the complete updated content instead.`
    );
  }

  const stripped = stripOuterFence(text);

  if (!stripped.trim()) {
    throw new Error('Fast apply model returned an empty response — the edit was not applied.');
  }

  // Preserve the original file's trailing-newline convention. The model may omit the
  // final newline; re-attaching it when the original had one avoids a spurious
  // "no newline at end of file" diff on every edit and keeps the no-op short-circuit
  // (updated === original, in tools.ts) working.
  const updated =
    originalContent.endsWith('\n') && !stripped.endsWith('\n') ? stripped + '\n' : stripped;

  // Defense-in-depth: even within the token budget, a small model can silently drop
  // large regions of a regenerated file. Reject a drastic shrink rather than writing
  // a damaged result; the caller can fall back to write_file for intentional deletions.
  // Counts use `updated` (what we actually write) so both sides share the same
  // trailing-newline treatment as `originalContent`.
  const originalLines = originalContent.split('\n').length;
  const updatedLines = updated.split('\n').length;
  if (
    originalLines >= SHRINK_GUARD_MIN_LINES &&
    updatedLines < originalLines * MIN_RETAINED_LINE_RATIO
  ) {
    throw new Error(
      `Fast apply produced a suspiciously short result (${originalLines} → ${updatedLines} lines) and was rejected to avoid corrupting the file. If you intended to remove this much, use write_file with the complete updated content.`
    );
  }

  return {
    updated,
    model: response.modelId ?? 'unknown',
  };
}
