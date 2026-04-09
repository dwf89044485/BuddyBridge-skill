/**
 * PersistentClaudeProvider — LLMProvider backed by a persistent Claude CLI subprocess.
 *
 * Uses --input-format stream-json to keep the CLI alive across messages,
 * eliminating per-message process startup and resume overhead.
 *
 * Falls back to SDKLLMProvider (query() mode) on failure.
 */

import type { LLMProvider, StreamChatParams, FileAttachment } from 'claude-to-im/src/lib/bridge/host.js';
import type { PendingPermissions } from '../../permission-gateway.js';
import { ProcessPool } from './process-pool.js';
import { resolvePersistentCliPath } from './process.js';
import type { FallbackTracker, FallbackEntry } from './types.js';
import { DEFAULT_POOL_CONFIG } from './types.js';
import { classifyAuthError } from '../../llm-provider.js';

// ── Image support ───────────────────────────────────────────────

const SUPPORTED_IMAGE_TYPES = new Set<string>([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
]);

type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

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

/**
 * Lightweight health check: can the CLI start at all?
 * Used to decide whether to lift a disabled session back to persistent mode.
 */
function cliHealthCheck(): boolean {
  const cliPath = resolvePersistentCliPath();
  if (!cliPath) return false;
  try {
    execSync(`"${cliPath}" --version`, { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function shouldUsePersistent(sessionId: string): boolean {
  if (fallbackTracker.globalDisabled) return false;

  const entry = fallbackTracker.sessionRetries.get(sessionId);
  if (!entry) return true;

  // Still within the disabled window
  if (entry.count >= 3 && Date.now() < entry.disabledUntil) {
    // Unrecoverable error: only re-enable if the CLI passes a health check
    if (entry.unrecoverable) {
      if (cliHealthCheck()) {
        console.log(`[persistent-claude] Health check passed, re-enabling session ${sessionId}`);
        fallbackTracker.sessionRetries.delete(sessionId);
        return true;
      }
      return false;
    }
    // Recoverable error (e.g. OOM): wait for timeout as before
    return false;
  }

  // Disabled window expired — re-enable
  if (entry.count >= 3 && Date.now() >= entry.disabledUntil) {
    fallbackTracker.sessionRetries.delete(sessionId);
    return true;
  }

  return true;
}

function recordFailure(sessionId: string, err?: Error): void {
  const entry: FallbackEntry = fallbackTracker.sessionRetries.get(sessionId) || { count: 0, disabledUntil: 0 };

  const errorMsg = err?.message || '';
  const authKind = classifyAuthError(errorMsg);

  if (authKind) {
    // Unrecoverable: no point retrying until the user fixes auth
    entry.unrecoverable = true;
    entry.count = 3; // immediately hit threshold
    entry.disabledUntil = Date.now() + 60 * 60 * 1000; // 1 hour (will lift on health check)
    entry.lastError = errorMsg;
    console.warn(`[persistent-claude] Unrecoverable error (${authKind}) for session ${sessionId}, disabled until health check passes`);
  } else {
    entry.count++;
    entry.lastError = errorMsg;
    if (entry.count >= 3) {
      entry.disabledUntil = Date.now() + 5 * 60 * 1000; // 5 minutes
      console.warn(`[persistent-claude] Session ${sessionId} disabled for 5 min after ${entry.count} failures`);
    }
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
  private autoApprove: boolean;

  constructor(pendingPerms: PendingPermissions, cliPath?: string, autoApprove = false) {
    this.pendingPerms = pendingPerms;
    this.cliPath = cliPath;
    this.autoApprove = autoApprove;
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const sessionId = params.sessionId;
    const pendingPerms = this.pendingPerms;
    const cliPath = this.cliPath;
    const autoApprove = this.autoApprove;

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
            // Auto-approve if configured
            if (autoApprove) {
              return { behavior: 'allow', updatedInput: input };
            }

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

          // Handle model change mid-session
          const targetModel = params.model?.trim();
          if (targetModel && proc.model && proc.model !== targetModel) {
            console.log(`[persistent-claude] Model change detected: ${proc.model} -> ${targetModel}`);
            await proc.setModel(targetModel).catch((err) => {
              console.warn(`[persistent-claude] setModel failed: ${err.message}`);
            });
          }

          // Send the user prompt (with multimodal support)
          const imageFiles = (params.files ?? []).filter((f) => SUPPORTED_IMAGE_TYPES.has(f.type));
          if (imageFiles.length > 0) {
            // Build multimodal content blocks
            const contentBlocks: unknown[] = [];
            for (const file of imageFiles) {
              contentBlocks.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: (file.type === 'image/jpg' ? 'image/jpeg' : file.type) as ImageMediaType,
                  data: file.data,
                },
              });
            }
            const prompt = params.prompt || '';
            if (prompt.trim()) {
              contentBlocks.push({ type: 'text', text: prompt });
            }
            proc.sendUserMessage(contentBlocks);
          } else {
            const prompt = params.prompt || '';
            if (prompt) {
              proc.sendPrompt(prompt);
            }
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
                // Close the controller so the reader gets done: true
                try { controller.close(); } catch { /* already closed */ }
                resolve();
              };
            } else {
              clearInterval(keepAliveTimer);
              try { controller.close(); } catch { /* already closed */ }
              resolve();
            }
          });

          recordSuccess(sessionId);
          console.log(`[persistent-claude] Stream complete for session ${sessionId}`);
        } catch (err) {
          console.error('[persistent-claude] Error, falling back:', (err as Error).message);
          recordFailure(sessionId, err as Error);

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
 * Find a claude CLI without version gating.
 * Unlike resolveClaudeCliPath() which requires >= 2.x, this finds any
 * claude executable that supports the required stream-json flags.
 */
function resolveCliPathForPersistent(): string | undefined {
  // 1. Explicit env var
  const fromEnv = process.env.CTI_CLAUDE_CODE_EXECUTABLE;
  if (fromEnv) {
    try { execSync(`"${fromEnv}" --version`, { stdio: 'ignore', timeout: 5000 }); return fromEnv; }
    catch { /* not executable */ }
  }

  // 2. PATH discovery (claude command)
  try {
    const which = execSync('which claude', { encoding: 'utf-8', timeout: 5000 }).trim();
    if (which) return which;
  } catch { /* which not found */ }

  // 3. Well-known locations
  const candidates = [
    `${process.env.HOME}/.local/bin/claude`,
    `${process.env.HOME}/.claude/local/claude`,
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const p of candidates) {
    try { execSync(`"${p}" --version`, { stdio: 'ignore', timeout: 5000 }); return p; }
    catch { /* not found or not executable */ }
  }

  return undefined;
}

/**
 * Check if the Claude CLI supports --input-format stream-json.
 */
export function preflightPersistentCheck(cliPath?: string): PreflightResult {
  const path = cliPath || resolveCliPathForPersistent();
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
    const hasOutputFormat = stdout.includes('--output-format');

    if (!hasInputFormat || !hasOutputFormat) {
      return {
        ok: false,
        cliPath: path,
        error: `Claude CLI at "${path}" missing required flags (--input-format, --output-format).`,
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
