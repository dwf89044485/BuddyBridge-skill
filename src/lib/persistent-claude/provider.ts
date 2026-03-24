/**
 * PersistentClaudeProvider — LLMProvider backed by a persistent Claude CLI subprocess.
 *
 * Uses --input-format stream-json to keep the CLI alive across messages,
 * eliminating per-message process startup and resume overhead.
 *
 * Falls back to SDKLLMProvider (query() mode) on failure.
 */

import type { LLMProvider, StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';
import type { PendingPermissions } from '../../permission-gateway.js';
import { ProcessPool } from './process-pool.js';
import { resolvePersistentCliPath } from './process.js';
import type { FallbackTracker } from './types.js';
import { DEFAULT_POOL_CONFIG } from './types.js';

// ── Singleton pool ─────────────────────────────────────────────

let globalPool: ProcessPool | null = null;

function getPool(): ProcessPool {
  if (!globalPool) {
    globalPool = new ProcessPool(DEFAULT_POOL_CONFIG);
    globalPool.startGc();
  }
  return globalPool;
}

// ── Fallback tracker ───────────────────────────────────────────

let fallbackTracker: FallbackTracker = {
  globalDisabled: process.env.CTI_PERSISTENT_CLAUDE === '0',
  sessionRetries: new Map(),
};

function shouldUsePersistent(sessionId: string): boolean {
  if (fallbackTracker.globalDisabled) return false;

  const entry = fallbackTracker.sessionRetries.get(sessionId);
  if (entry && entry.count >= 3 && Date.now() < entry.disabledUntil) {
    return false;
  }
  return true;
}

function recordFailure(sessionId: string): void {
  const entry = fallbackTracker.sessionRetries.get(sessionId) || { count: 0, disabledUntil: 0 };
  entry.count++;
  if (entry.count >= 3) {
    entry.disabledUntil = Date.now() + 5 * 60 * 1000; // 5 minutes
    console.warn(`[persistent-claude] Session ${sessionId} disabled for 5 min after ${entry.count} failures`);
  }
  fallbackTracker.sessionRetries.set(sessionId, entry);
}

function recordSuccess(sessionId: string): void {
  fallbackTracker.sessionRetries.delete(sessionId);
}

// ── PersistentClaudeProvider ───────────────────────────────────

export class PersistentClaudeProvider implements LLMProvider {
  private pendingPerms: PendingPermissions;
  private cliPath: string | undefined;

  constructor(pendingPerms: PendingPermissions, cliPath?: string) {
    this.pendingPerms = pendingPerms;
    this.cliPath = cliPath;
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const sessionId = params.sessionId;
    const pendingPerms = this.pendingPerms;
    const cliPath = this.cliPath;

    // Check if persistent mode is available for this session
    if (!shouldUsePersistent(sessionId)) {
      console.log('[persistent-claude] Fallback: session disabled or globally off');
      return new ReadableStream<string>({
        async start(controller) {
          try {
            const { SDKLLMProvider } = await import('../../llm-provider.js');
            const fallback = new SDKLLMProvider(pendingPerms, cliPath);
            const stream = fallback.streamChat(params);
            const reader = stream.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              controller.enqueue(value);
            }
            controller.close();
          } catch (err) {
            try {
              controller.enqueue(
                `data: ${JSON.stringify({ type: 'error', data: JSON.stringify({ error: (err as Error).message }) })}\n`,
              );
            } catch { /* controller closed */ }
            try { controller.close(); } catch { /* already closed */ }
          }
        },
      });
    }

    return new ReadableStream<string>({
      async start(controller) {
        const pool = getPool();

        try {
          // Get or create a persistent process
          const proc = await pool.connect(sessionId, {
            cliPath,
            cwd: params.workingDirectory,
            permissionMode: params.permissionMode as string | undefined,
            model: params.model,
            systemPrompt: params.systemPrompt,
            resumeSessionId: params.sdkSessionId || undefined,
          });

          // Wire up permission callback
          proc.onPermissionRequest = async (toolName, input, requestId) => {
            // Emit permission_request SSE event to bridge
            controller.enqueue(
              `data: ${JSON.stringify({
                type: 'permission_request',
                data: JSON.stringify({
                  permissionRequestId: requestId,
                  toolName,
                  toolInput: input,
                  suggestions: [],
                }),
              })}\n`,
            );

            // Wait for IM user response via pendingPerms
            try {
              const result = await pendingPerms.waitFor(requestId);
              const behavior = result.behavior === 'allow' ? 'allow' : 'deny';
              return { behavior, updatedInput: input };
            } catch {
              return { behavior: 'deny' };
            }
          };

          // Set up pending response for this request
          proc.setPendingResponse({
            controller,
            resolve: () => { /* stream continues until result */ },
            reject: (err: Error) => {
              console.error('[persistent-claude] Pending response rejected:', err.message);
              try {
                controller.enqueue(
                  `data: ${JSON.stringify({ type: 'error', data: JSON.stringify({ error: err.message }) })}\n`,
                );
              } catch { /* controller may be closed */ }
              try { controller.close(); } catch { /* already closed */ }
            },
          });

          // Send the user prompt
          const prompt = params.prompt || '';
          if (prompt) {
            proc.sendPrompt(prompt);
          }

          // Handle abort
          if (params.abortController) {
            params.abortController.signal.addEventListener('abort', () => {
              console.log('[persistent-claude] Abort received, sending interrupt');
              proc.interrupt().catch(() => {
                try { controller.close(); } catch { /* already closed */ }
              });
            }, { once: true });
          }

          // Send keep_alive periodically to prevent timeout
          const keepAliveTimer = setInterval(() => {
            try {
              if (proc.isAlive && proc.state === 'ready') {
                controller.enqueue(`data: ${JSON.stringify({ type: 'keep_alive', data: '' })}\n`);
              }
            } catch { /* controller closed */ }
          }, 30_000);

          // Wait for result
          await new Promise<void>((resolve) => {
            const pending = proc.pendingResponse;
            if (pending) {
              const origResolve = pending.resolve;
              pending.resolve = () => {
                clearInterval(keepAliveTimer);
                origResolve();
                resolve();
              };
            } else {
              clearInterval(keepAliveTimer);
              resolve();
            }
          });

          recordSuccess(sessionId);
          console.log(`[persistent-claude] Stream complete for session ${sessionId}`);
        } catch (err) {
          console.error('[persistent-claude] Error, falling back:', (err as Error).message);
          recordFailure(sessionId);

          try {
            const { SDKLLMProvider } = await import('../../llm-provider.js');
            const fallback = new SDKLLMProvider(pendingPerms, cliPath);
            const fallbackStream = fallback.streamChat(params);
            const reader = fallbackStream.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              controller.enqueue(value);
            }
            controller.close();
          } catch (fallbackErr) {
            console.error('[persistent-claude] Fallback also failed:', (fallbackErr as Error).message);
            try {
              controller.enqueue(
                `data: ${JSON.stringify({
                  type: 'error',
                  data: JSON.stringify({
                    error: `Both persistent and fallback failed. Persistent: ${(err as Error).message}. Fallback: ${(fallbackErr as Error).message}`,
                  }),
                })}\n`,
              );
            } catch { /* controller closed */ }
            try { controller.close(); } catch { /* already closed */ }
          }
        }
      },
    });
  }
}

// ── Preflight check ───────────────────────────────────────────

export interface PreflightResult {
  ok: boolean;
  cliPath?: string;
  version?: string;
  error?: string;
}

import { execSync } from 'node:child_process';

/**
 * Check if the Claude CLI supports --input-format stream-json.
 */
export function preflightPersistentCheck(cliPath?: string): PreflightResult {
  const path = cliPath || resolvePersistentCliPath();
  if (!path) {
    return { ok: false, error: 'Claude CLI not found' };
  }

  try {
    const stdout = execSync(`"${path}" --help 2>&1`, {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).toString();

    // Check for --input-format flag support
    const hasInputFormat = stdout.includes('--input-format');
    const hasStreamJson = stdout.includes('stream-json');
    const hasOutputFormat = stdout.includes('--output-format');

    if (!hasInputFormat || !hasOutputFormat || !hasStreamJson) {
      return {
        ok: false,
        cliPath: path,
        error: `Claude CLI does not support --input-format stream-json. Update Claude Code CLI.`,
      };
    }

    // Try to get version
    let version: string | undefined;
    try {
      version = execSync(`"${path}" --version 2>&1`, {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }).toString().trim().split('\n')[0];
    } catch { /* ignore */ }

    return { ok: true, cliPath: path, version };
  } catch (err) {
    return { ok: false, cliPath: path, error: (err as Error).message };
  }
}

/**
 * Shut down the global process pool. Call on app exit.
 */
export async function shutdownPersistentPool(): Promise<void> {
  if (globalPool) {
    await globalPool.shutdownAll();
    globalPool = null;
  }
}
