/**
 * Persistent Claude Provider — Types
 *
 * Type definitions for the persistent subprocess architecture that keeps
 * a Claude CLI process alive across multiple messages within a session.
 */

import type { ChildProcess } from 'node:child_process';

// ── Process State ──────────────────────────────────────────────

export type ProcessState =
  | 'starting'       // spawn() called, waiting for CLI to boot
  | 'handshake'      // received system/init, sending initialize control request
  | 'ready'          // handshake complete, idle, waiting for user messages
  | 'busy'           // user message sent, processing response
  | 'shutting_down'  // disconnect initiated
  | 'dead';          // process exited (normal or crash)

// ── CLI stdout message types (stream-json protocol) ────────────

/** Union of all messages the CLI can send via stdout. */
export interface CliMessage {
  type: string;
  [key: string]: unknown;
}

export interface CliSystemMessage extends CliMessage {
  type: 'system';
  subtype: string;
  session_id?: string;
  model?: string;
}

export interface CliAssistantMessage extends CliMessage {
  type: 'assistant';
  message: {
    role: 'assistant';
    content: Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
      thinking?: string;
      signature?: string;
    }>;
    model?: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export interface CliUserMessage extends CliMessage {
  type: 'user';
  message: {
    role: 'user';
    content: string | Array<unknown>;
  };
}

export interface CliResultMessage extends CliMessage {
  type: 'result';
  subtype: 'success' | 'error';
  session_id?: string;
  is_error?: boolean;
  result?: string;
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export interface CliStreamEvent extends CliMessage {
  type: 'stream_event';
  uuid?: string;
  session_id?: string;
  event: {
    type: string;
    index?: number;
    delta?: { type: string; text?: string };
    content_block?: { type: string; id?: string; name?: string; input?: unknown };
  };
}

export interface CliErrorMessage extends CliMessage {
  type: 'error';
  result?: string;
  errors?: string[];
}

// ── Control protocol (bidirectional) ───────────────────────────

export interface CliControlRequest extends CliMessage {
  type: 'control_request';
  request_id: string;
  request: {
    subtype: string;
    [key: string]: unknown;
  };
}

export interface CliControlResponse extends CliMessage {
  type: 'control_response';
  response: {
    subtype: 'success' | 'error';
    request_id: string;
    response?: Record<string, unknown>;
    error?: string;
  };
}

// ── Control request subtypes (SDK → CLI) ───────────────────────

export type SdkControlSubtype =
  | 'initialize'
  | 'interrupt'
  | 'set_permission_mode'
  | 'set_model';

// ── Control request subtypes (CLI → SDK) ───────────────────────

export type CliControlSubtype =
  | 'can_use_tool'
  | 'hook_callback'
  | 'mcp_message';

// ── Process options ────────────────────────────────────────────

export interface PersistentProcessOptions {
  cliPath: string;
  cwd?: string;
  env?: Record<string, string>;
  permissionMode?: string;
  model?: string;
  systemPrompt?: string;
  /** Session ID from a previous stream-json session to resume. */
  resumeSessionId?: string;
  abortController?: AbortController;
  /** Whether to pass --permission-prompt-tool stdio (Claude-compatible only). */
  permissionPromptTool?: boolean;
}

// ── Pending response (waiting for result after sending a prompt) ──

export interface PendingResponse {
  controller: ReadableStreamDefaultController<string>;
  resolve: () => void;
  reject: (err: Error) => void;
}

// ── Fallback tracking ──────────────────────────────────────────

export interface FallbackEntry {
  count: number;
  disabledUntil: number;
  /** If true, the failure was classified as unrecoverable (e.g. auth error). */
  unrecoverable?: boolean;
  /** The error message from the last failure, used for classification. */
  lastError?: string;
}

export interface FallbackTracker {
  globalDisabled: boolean;
  sessionRetries: Map<string, FallbackEntry>;
}

// ── Process pool config ─────────────────────────────────────────

export interface ProcessPoolConfig {
  maxProcesses: number;
  idleTimeoutMs: number;
  shutdownTimeoutMs: number;
  maxRetries: number;
}

export const DEFAULT_POOL_CONFIG: ProcessPoolConfig = {
  maxProcesses: 20,
  idleTimeoutMs: 30 * 60 * 1000,   // 30 minutes
  shutdownTimeoutMs: 5000,
  maxRetries: 3,
};
