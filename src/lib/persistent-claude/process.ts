/**
 * PersistentProcess — manages a single Claude CLI subprocess lifecycle.
 *
 * Uses --input-format stream-json to keep the process alive and
 * communicate via stdin/stdout NDJSON protocol.
 *
 * Based on Python claude-agent-sdk's SubprocessCLITransport + Query
 * internal architecture, adapted for Node.js.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { NdjsonParser } from './ndjson.js';
import type {
  ProcessState,
  PersistentProcessOptions,
  PendingResponse,
  CliMessage,
  CliControlRequest,
  CliControlResponse,
} from './types.js';
import { buildSubprocessEnv, resolveClaudeCliPath } from '../../llm-provider.js';

// ── Constants ──────────────────────────────────────────────────

const HANDSHAKE_TIMEOUT_MS = 15_000;
const INIT_RESPONSE_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_STDERR_BUF = 4096;

// ── PersistentProcess ──────────────────────────────────────────

export class PersistentProcess {
  readonly sessionId: string;
  readonly cliPath: string;

  // Process
  proc: ChildProcess | null = null;
  state: ProcessState = 'dead';
  createdAt = Date.now();
  lastActivityAt = Date.now();

  // SDK session info (from CLI's system/init)
  sdkSessionId: string | null = null;
  model: string | null = null;

  // Current pending response (set during busy state)
  pendingResponse: PendingResponse | null = null;

  // Control request handling (CLI → SDK)
  private controlRequestCounter = 0;

  // Handshake
  private handshakeResolve: (() => void) | null = null;
  private handshakeReject: ((err: Error) => void) | null = null;
  private initRequestId: string | null = null;

  // Streams
  private ndjson = new NdjsonParser();
  private stderrBuf = '';

  // Permission callback — set by provider
  onPermissionRequest: ((
    toolName: string,
    input: Record<string, unknown>,
    requestId: string,
  ) => Promise<{ behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown> }>) | null = null;

  constructor(sessionId: string, cliPath: string) {
    this.sessionId = sessionId;
    this.cliPath = cliPath;
  }

  // ── Lifecycle ───────────────────────────────────────────────

  /**
   * Spawn the CLI subprocess and complete the initialization handshake.
   * Resolves when the process is in 'ready' state.
   */
  async connect(options: Partial<PersistentProcessOptions>): Promise<void> {
    if (this.state !== 'dead') {
      throw new Error(`[persistent] Cannot connect: state is ${this.state}`);
    }

    this.state = 'starting';
    const cwd = options.cwd || process.cwd();
    const env = options.env || buildSubprocessEnv();

    // Strip CLAUDECODE to prevent nested session detection
    delete env.CLAUDECODE;

    // Build CLI args for stream-json bidirectional mode
    const args = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--verbose',
      '--permission-prompt-tool', 'stdio',
    ];

    if (options.permissionMode) {
      args.push('--permission-mode', options.permissionMode);
    }
    if (options.model) {
      args.push('--model', options.model);
    }

    // Spawn
    this.proc = spawn(this.cliPath, args, {
      cwd,
      env: { ...env, CLAUDE_CODE_ENTRYPOINT: 'cti-persistent' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const proc = this.proc;

    // Handle process errors
    proc.on('error', (err) => {
      console.error('[persistent] Process error:', err.message);
      this.handleCrash(err);
    });

    proc.on('exit', (code, signal) => {
      console.log(`[persistent] Process exited: code=${code} signal=${signal}`);
      this.handleCrash(new Error(`Process exited: code=${code} signal=${signal}`));
    });

    // Start reading stdout
    proc.stdout!.on('data', (chunk: Buffer) => {
      this.lastActivityAt = Date.now();
      const messages = this.ndjson.feed(chunk);
      for (const msg of messages) {
        this.handleMessage(msg as CliMessage);
      }
    });

    // Start reading stderr (diagnostic only)
    proc.stderr!.on('data', (chunk: Buffer) => {
      this.stderrBuf += chunk.toString('utf-8');
      if (this.stderrBuf.length > MAX_STDERR_BUF) {
        this.stderrBuf = this.stderrBuf.slice(-MAX_STDERR_BUF);
      }
    });

    // Wait for system/init
    this.state = 'handshake';
    await this.waitForHandshake();

    // Send initialize control request
    this.state = 'handshake'; // still in handshake
    await this.sendInitialize(options.systemPrompt);

    // If resuming a previous session, the CLI already has context.
    // The session_id from system/init is what we'll use going forward.
    this.state = 'ready';
    console.log(
      `[persistent] Ready: session=${this.sdkSessionId}, model=${this.model}, pid=${proc.pid}`,
    );
  }

  /**
   * Send a user message to the CLI via stdin.
   * Returns immediately — response arrives via stdout events.
   */
  sendPrompt(prompt: string): void {
    if (this.state !== 'ready') {
      throw new Error(`[persistent] Cannot send prompt: state is ${this.state}`);
    }
    if (!this.proc?.stdin?.writable) {
      throw new Error('[persistent] stdin is not writable');
    }

    const message = {
      type: 'user',
      message: { role: 'user', content: prompt },
      parent_tool_use_id: null,
      session_id: this.sdkSessionId || 'default',
    };

    this.proc.stdin.write(JSON.stringify(message) + '\n');
    this.state = 'busy';
    this.lastActivityAt = Date.now();
    console.log(`[persistent] Prompt sent, state → busy`);
  }

  /**
   * Send a user message with multimodal content blocks (images).
   */
  sendUserMessage(content: unknown[]): void {
    if (this.state !== 'ready') {
      throw new Error(`[persistent] Cannot send prompt: state is ${this.state}`);
    }
    if (!this.proc?.stdin?.writable) {
      throw new Error('[persistent] stdin is not writable');
    }

    const message = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: this.sdkSessionId || 'default',
    };

    this.proc.stdin.write(JSON.stringify(message) + '\n');
    this.state = 'busy';
    this.lastActivityAt = Date.now();
  }

  /**
   * Interrupt the current processing by sending an interrupt control request.
   */
  async interrupt(): Promise<void> {
    if (this.state !== 'busy') return;
    await this.sendControlRequest({ subtype: 'interrupt' });
  }

  /**
   * Change the model mid-session.
   */
  async setModel(model: string): Promise<void> {
    await this.sendControlRequest({ subtype: 'set_model', model });
  }

  /**
   * Change permission mode mid-session.
   */
  async setPermissionMode(mode: string): Promise<void> {
    await this.sendControlRequest({ subtype: 'set_permission_mode', mode });
  }

  /**
   * Gracefully disconnect: stdin EOF → wait → SIGTERM → SIGKILL.
   */
  async disconnect(): Promise<void> {
    if (this.state === 'dead' || this.state === 'shutting_down') return;

    this.state = 'shutting_down';
    this.pendingResponse = null;

    try {
      // Close stdin (send EOF)
      if (this.proc?.stdin?.writable) {
        this.proc.stdin.end();
      }

      // Wait for graceful exit
      if (this.proc?.exitCode === null) {
        await this.waitForExit(SHUTDOWN_TIMEOUT_MS);
      }
    } catch {
      // Timeout or error — force kill
    }

    if (this.proc?.exitCode === null) {
      console.log('[persistent] Graceful shutdown timed out, sending SIGTERM');
      this.proc.kill('SIGTERM');
      try {
        await this.waitForExit(2000);
      } catch {
        this.proc.kill('SIGKILL');
      }
    }

    this.state = 'dead';
    console.log('[persistent] Disconnected');
  }

  /**
   * Set the pending response controller for the current request.
   * stdout events will be forwarded to this controller.
   */
  setPendingResponse(pending: PendingResponse): void {
    this.pendingResponse = pending;
  }

  clearPendingResponse(): void {
    if (this.pendingResponse) {
      this.pendingResponse.resolve();
    }
    this.pendingResponse = null;
  }

  rejectPendingResponse(err: Error): void {
    if (this.pendingResponse) {
      this.pendingResponse.reject(err);
    }
    this.pendingResponse = null;
  }

  get isAlive(): boolean {
    return this.state !== 'dead' && this.state !== 'shutting_down'
      && this.proc?.exitCode === null;
  }

  // ── Internal: handshake ──────────────────────────────────────

  private waitForHandshake(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.handshakeResolve = resolve;
      const timer = setTimeout(() => {
        this.handshakeResolve = null;
        this.handshakeReject = null;
        reject(new Error('Handshake timeout: no system/init received'));
      }, HANDSHAKE_TIMEOUT_MS);

      // Override resolve to clear timer
      const origResolve = resolve;
      this.handshakeResolve = () => {
        clearTimeout(timer);
        origResolve();
      };
    });
  }

  private async sendInitialize(systemPrompt?: string): Promise<void> {
    const requestId = this.nextRequestId();
    this.initRequestId = requestId;

    const request: Record<string, unknown> = {
      subtype: 'initialize',
    };
    // We don't have hooks or agents in the bridge context,
    // but sending an empty initialize is required by the protocol.
    if (systemPrompt) {
      // Can't set system prompt via initialize in the current protocol.
      // It should be passed as a CLI arg during spawn.
    }

    await this.writeControlRequest(requestId, request);

    // Wait for control_response(success)
    await this.waitForControlResponse(requestId, INIT_RESPONSE_TIMEOUT_MS);
    this.initRequestId = null;
  }

  // ── Internal: control protocol ───────────────────────────────

  private nextRequestId(): string {
    return `req_${++this.controlRequestCounter}_${randomBytes(4).toString('hex')}`;
  }

  /**
   * Send a control request to the CLI and wait for the response.
   */
  private async sendControlRequest(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = this.nextRequestId();
    await this.writeControlRequest(requestId, request);
    return this.waitForControlResponse(requestId, 10_000);
  }

  private async writeControlRequest(
    requestId: string,
    request: Record<string, unknown>,
  ): Promise<void> {
    if (!this.proc?.stdin?.writable) {
      throw new Error('[persistent] Cannot write control request: stdin not writable');
    }

    const msg = {
      type: 'control_request',
      request_id: requestId,
      request,
    };

    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  private waitForControlResponse(
    requestId: string,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Control response timeout for ${requestId}`));
      }, timeoutMs);

      // Listen for the matching response
      const handler = (msg: CliMessage) => {
        if (
          msg.type === 'control_response' &&
          (msg as CliControlResponse).response?.request_id === requestId
        ) {
          clearTimeout(timer);
          this.onMessage = null;
          const resp = (msg as CliControlResponse).response;
          if (resp.subtype === 'error') {
            reject(new Error(resp.error || 'Control request failed'));
          } else {
            resolve(resp.response || {});
          }
        }
      };

      this.onMessage = handler;
    });
  }

  // ── Internal: message handler ────────────────────────────────

  /** Optional listener for specific message routing (control_response). */
  private onMessage: ((msg: CliMessage) => void) | null = null;

  private handleMessage(msg: CliMessage): void {
    // Allow specific listeners (e.g., control_response waiters) to intercept
    if (this.onMessage) {
      this.onMessage(msg);
    }

    switch (msg.type) {
      case 'system':
        this.handleSystemMessage(msg);
        break;

      case 'control_response':
        this.handleControlResponse(msg as CliControlResponse);
        break;

      case 'control_request':
        this.handleIncomingControlRequest(msg as CliControlRequest);
        break;

      case 'assistant':
      case 'user':
      case 'stream_event':
      case 'result':
      case 'error':
        // Forward to pending response controller
        if (this.pendingResponse) {
          this.forwardToPending(msg);
        }
        break;

      default:
        // Unknown message type — ignore (forward compatibility)
        break;
    }
  }

  private handleSystemMessage(msg: CliMessage): void {
    const subtype = (msg as { subtype?: string }).subtype;
    if (subtype === 'init') {
      this.sdkSessionId = (msg as { session_id?: string }).session_id || null;
      this.model = (msg as { model?: string }).model || null;
      console.log(`[persistent] system/init: session=${this.sdkSessionId}, model=${this.model}`);

      // Complete the handshake wait
      if (this.state === 'handshake' && this.handshakeResolve) {
        this.handshakeResolve();
        this.handshakeResolve = null;
        this.handshakeReject = null;
      }
    }
  }

  private handleControlResponse(msg: CliControlResponse): void {
    // If this is the init response during handshake, it's handled
    // by waitForControlResponse. Otherwise, log it.
    const reqId = msg.response?.request_id;
    if (reqId === this.initRequestId) {
      return; // Handled by sendInitialize's waitForControlResponse
    }
    if (reqId) {
      console.log(`[persistent] control_response: ${reqId} → ${msg.response?.subtype}`);
    }
  }

  private async handleIncomingControlRequest(msg: CliControlRequest): Promise<void> {
    const subtype = msg.request?.subtype;
    const requestId = msg.request_id;

    console.log(`[persistent] Incoming control_request: ${subtype} (id=${requestId})`);

    try {
      switch (subtype) {
        case 'can_use_tool': {
          if (this.onPermissionRequest) {
            const toolName = (msg.request as { tool_name?: string }).tool_name || 'unknown';
            const toolInput = (msg.request as { input?: Record<string, unknown> }).input || {};
            const result = await this.onPermissionRequest(toolName, toolInput, requestId);
            this.sendControlResponse(requestId, 'success', {
              behavior: result.behavior,
              updatedInput: result.updatedInput,
            });
          } else {
            // No permission handler — auto-deny
            this.sendControlResponse(requestId, 'success', { behavior: 'deny' });
          }
          break;
        }

        case 'hook_callback':
        case 'mcp_message':
          // Not yet implemented — acknowledge with empty success
          this.sendControlResponse(requestId, 'success', {});
          break;

        default:
          console.warn(`[persistent] Unknown control_request subtype: ${subtype}`);
          this.sendControlResponse(requestId, 'success', {});
      }
    } catch (err) {
      console.error(`[persistent] Error handling control_request ${subtype}:`, err);
      try {
        this.sendControlResponse(requestId, 'error', { error: String(err) });
      } catch {
        // If we can't even send the error response, the process is likely dead
      }
    }
  }

  private sendControlResponse(
    requestId: string,
    subtype: 'success' | 'error',
    data: Record<string, unknown>,
  ): void {
    if (!this.proc?.stdin?.writable) return;

    const msg = {
      type: 'control_response',
      response: {
        subtype,
        request_id: requestId,
        response: data,
      },
    };

    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  private forwardToPending(msg: CliMessage): void {
    if (!this.pendingResponse) return;

    // Convert CLI message to SSE format and enqueue
    const sse = cliMessageToSseString(msg);
    if (sse) {
      try {
        this.pendingResponse.controller.enqueue(sse);
      } catch {
        // Controller might be closed (abort)
      }
    }

    // Detect result → transition back to ready
    if (msg.type === 'result') {
      console.log('[persistent] Result received, state → ready');
      this.state = 'ready';
      this.lastActivityAt = Date.now();
      // Resolve the pending response — caller knows the stream is complete
      this.pendingResponse.resolve();
      this.pendingResponse = null;
    }

    // Detect error → reject
    if (msg.type === 'error') {
      const errMsg = (msg as { result?: string; errors?: string[] }).result
        || (msg as { errors?: string[] }).errors?.join('; ')
        || 'Unknown error';
      console.log(`[persistent] Error received: ${errMsg}`);
      // Don't reject on error — the result message often follows.
      // The caller will see the error SSE event.
    }
  }

  // ── Internal: crash handling ────────────────────────────────

  private handleCrash(err: Error): void {
    const prevState = this.state;
    this.state = 'dead';

    // Flush any remaining buffer
    const remaining = this.ndjson.flush();
    for (const msg of remaining) {
      this.handleMessage(msg as CliMessage);
    }

    // Reject pending response
    this.rejectPendingResponse(err || new Error('Process crashed'));

    // Clear handshake if waiting
    if (this.handshakeReject) {
      this.handshakeReject(err || new Error('Process crashed during handshake'));
      this.handshakeResolve = null;
      this.handshakeReject = null;
    }

    console.error(`[persistent] Process crashed (was ${prevState}):`, err.message);
  }

  // ── Internal: utilities ──────────────────────────────────────

  private waitForExit(timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.proc.exitCode !== null) {
        resolve();
        return;
      }

      const timer = setTimeout(() => {
        reject(new Error(`Process did not exit within ${timeoutMs}ms`));
      }, timeoutMs);

      this.proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

// ── SSE Conversion ─────────────────────────────────────────────

/**
 * Convert a CLI stream-json message to a bridge SSE string.
 * Format: `data: {"type":"<sse_type>","data":"<payload>"}\n`
 *
 * Matches the format from sse-utils.ts sseEvent() function.
 */
function cliMessageToSseString(msg: CliMessage): string | null {
  switch (msg.type) {
    case 'assistant': {
      const assistant = msg as unknown as {
        message: { content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }> };
      };
      const parts: string[] = [];
      for (const block of assistant.message.content) {
        if (block.type === 'text' && block.text) {
          parts.push(block.text);
        }
      }
      if (parts.length === 0) return null;
      return `data: ${JSON.stringify({ type: 'text', data: parts.join('') })}\n`;
    }

    case 'user': {
      const user = msg as unknown as {
        message: { content: Array<{ type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }> };
      };
      for (const block of user.message.content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          const resultContent = normalizeToolResultContent(block.content);
          return `data: ${JSON.stringify({
            type: 'tool_result',
            data: JSON.stringify({
              tool_use_id: block.tool_use_id,
              content: resultContent,
              is_error: block.is_error || false,
            }),
          })}\n`;
        }
      }
      return null;
    }

    case 'stream_event': {
      const streamEvent = msg as unknown as {
        event: {
          type: string;
          delta?: { type: string; text?: string };
          content_block?: { type: string; id?: string; name?: string; input?: unknown };
        };
      };
      const event = streamEvent.event;

      // Text delta → text SSE
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta?.text) {
        return `data: ${JSON.stringify({ type: 'text', data: event.delta.text })}\n`;
      }

      // Tool use start → tool_use SSE
      if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        return `data: ${JSON.stringify({
          type: 'tool_use',
          data: JSON.stringify({
            id: event.content_block.id || '',
            name: event.content_block.name || '',
            input: event.content_block.input || {},
          }),
        })}\n`;
      }

      return null;
    }

    case 'system': {
      const sys = msg as { subtype?: string; session_id?: string; model?: string };
      if (sys.subtype === 'init') {
        return `data: ${JSON.stringify({
          type: 'status',
          data: JSON.stringify({
            session_id: sys.session_id,
            model: sys.model,
            _internal: true,
            persistent_process: true,
          }),
        })}\n`;
      }
      return null;
    }

    case 'result': {
      const result = msg as unknown as {
        subtype: string;
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
      };
      return `data: ${JSON.stringify({
        type: result.subtype === 'success' ? 'result' : 'error',
        data: JSON.stringify({
          session_id: result.session_id,
          is_error: result.is_error,
          result: result.result || result.subtype,
          duration_ms: result.duration_ms,
          total_cost_usd: result.total_cost_usd,
          input_tokens: result.usage?.input_tokens,
          output_tokens: result.usage?.output_tokens,
          cache_read_input_tokens: result.usage?.cache_read_input_tokens,
          cache_creation_input_tokens: result.usage?.cache_creation_input_tokens,
        }),
      })}\n`;
    }

    case 'error': {
      const err = msg as { result?: string; errors?: string[] };
      return `data: ${JSON.stringify({
        type: 'error',
        data: JSON.stringify({
          error: err.result || err.errors?.join('; ') || 'Unknown error',
        }),
      })}\n`;
    }

    default:
      return null;
  }
}

/**
 * Normalize tool result content (may be string, array, or object).
 */
function normalizeToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!content) return '';
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : typeof c === 'object' && c !== null && 'text' in c ? (c as { text: string }).text : JSON.stringify(c)))
      .join('\n');
  }
  return JSON.stringify(content);
}

/**
 * Find the Claude CLI binary path.
 */
export function resolvePersistentCliPath(): string | undefined {
  return resolveClaudeCliPath();
}
