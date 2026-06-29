import type { UIMessage } from 'ai';
export type { UIMessage };

export type ProviderName = 'anthropic' | 'openai' | 'google' | 'cerebras';

// Bring-your-own-key: keys supplied per-request by the client (entered in the UI and
// stored in the visitor's browser). They take precedence over server env vars, letting a
// public deployment run on the visitor's own credentials. Never persisted or logged
// server-side.
export interface ApiKeys {
  e2b?: string;
  anthropic?: string;
  openai?: string;
  google?: string;
  cerebras?: string;
}

export type PlanStepStatus = 'pending' | 'in_progress' | 'done';

export interface PlanStep {
  title: string;
  status: PlanStepStatus;
}

export interface MCPServerConfig {
  name: string;
  url: string;
  auth?: string;
  description?: string;
}

export interface TouchedFile {
  path: string;
  op: 'write' | 'edit' | 'smart';
  content?: string;       // write_file: full content written
  search?: string;        // apply_edit: string replaced
  replace?: string;       // apply_edit: replacement string
  edit?: string;          // apply_edit_smart: edit instruction
  model?: string;         // apply_edit_smart: fast model used
  linesChanged?: number;  // apply_edit_smart: |updatedLines - originalLines|
  updatedLines?: number;  // apply_edit_smart: total lines after edit
}

export interface AgentRequest {
  messages: UIMessage[];
  sessionId: string;
  provider?: ProviderName;
  model?: string;
  mcpServers?: MCPServerConfig[];
  keys?: ApiKeys;
}
