import { execSync } from 'node:child_process';
import type { LLMProvider, StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';
import type { PendingPermissions } from '../../permission-gateway.js';
import { ProcessPool } from '../persistent-claude/process-pool.js';
import { DEFAULT_POOL_CONFIG, type FallbackTracker } from '../persistent-claude/types.js';
import { resolveCodeBuddyCliPath, preflightCodeBuddyCheck } from '../../codebuddy-provider.js';
import { appendLocalAttachmentSystemNote, splitLocalAttachments } from '../../file-attachment-prompt.js';

const SUPPORTED_IMAGE_TYPES = new Set<string>([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
]);

let globalPool: ProcessPool | null = null;

function getPool(): ProcessPool {
  if (!globalPool) {
    globalPool = new ProcessPool(DEFAULT_POOL_CONFIG);
    globalPool.startGc();
  }
  return globalPool;
}

let fallbackTracker: FallbackTracker = {
  globalDisabled: process.env.CTI_PERSISTENT_CODEBUDDY === '0',
  sessionRetries: new Map(),
};

function shouldUsePersistent(sessionId: string): boolean {
  if (fallbackTracker.globalDisabled) return false;
  const entry = fallbackTracker.sessionRetries.get(sessionId);
  if (entry && entry.count >= 3 && Date.now() < entry.disabledUntil) return false;
  return true;
}

function recordFailure(sessionId: string): void {
  const entry = fallbackTracker.sessionRetries.get(sessionId) || { count: 0, disabledUntil: 0 };
  entry.count++;
  if (entry.count >= 3) {
    entry.disabledUntil = Date.now() + 5 * 60 * 1000;
    console.warn(`[persistent-codebuddy] Session ${sessionId} disabled for 5 min after ${entry.count} failures`);
  }
  fallbackTracker.sessionRetries.set(sessionId, entry);
}

function recordSuccess(sessionId: string): void {
  fallbackTracker.sessionRetries.delete(sessionId);
}

function buildMultimodalContent(params: StreamChatParams): unknown[] {
  const imageFiles = (params.files || []).filter((file) => SUPPORTED_IMAGE_TYPES.has(file.type));
  const nonImageFiles = (params.files || []).filter((file) => !SUPPORTED_IMAGE_TYPES.has(file.type));
  const { accessibleFiles, inaccessibleFiles } = splitLocalAttachments(nonImageFiles);

  const text = accessibleFiles.length > 0 || inaccessibleFiles.length > 0
    ? appendLocalAttachmentSystemNote(params.prompt, nonImageFiles)
    : params.prompt;

  const contentBlocks: unknown[] = [];
  for (const file of imageFiles) {
    contentBlocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: (file.type === 'image/jpg' ? 'image/jpeg' : file.type) as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
        data: file.data,
      },
    });
  }

  if (text.trim()) {
    contentBlocks.push({ type: 'text', text });
  }

  return contentBlocks;
}

export class PersistentCodeBuddyProvider implements LLMProvider {
  constructor(
    private pendingPerms: PendingPermissions,
    private cliPath?: string,
    private autoApprove = false,
  ) {}

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const sessionId = params.sessionId;
    const pendingPerms = this.pendingPerms;
    const cliPath = this.cliPath;
    const autoApprove = this.autoApprove;

    if (!shouldUsePersistent(sessionId)) {
      console.log('[persistent-codebuddy] Fallback: session disabled or globally off');
      return new ReadableStream<string>({
        async start(controller) {
          try {
            const { CodeBuddySDKProvider } = await import('../../codebuddysdk-provider.js');
            const fallback = new CodeBuddySDKProvider(pendingPerms, cliPath, autoApprove);
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
            } catch { /* ignore */ }
            try { controller.close(); } catch { /* ignore */ }
          }
        },
      });
    }

    return new ReadableStream<string>({
      async start(controller) {
        const pool = getPool();

        try {
          let proc = await pool.connect(sessionId, {
            cliPath,
            cwd: params.workingDirectory,
            permissionMode: params.permissionMode as string | undefined,
            model: params.model,
            systemPrompt: params.systemPrompt,
            resumeSessionId: params.sdkSessionId || undefined,
            permissionPromptTool: false,
          });

          const targetModel = params.model?.trim();
          if (targetModel && proc.model && proc.model !== targetModel) {
            console.log(`[persistent-codebuddy] Model changed (${proc.model} -> ${targetModel}), recreating process`);
            await pool.disconnect(sessionId).catch(() => {});
            proc = await pool.connect(sessionId, {
              cliPath,
              cwd: params.workingDirectory,
              permissionMode: params.permissionMode as string | undefined,
              model: params.model,
              systemPrompt: params.systemPrompt,
              resumeSessionId: params.sdkSessionId || undefined,
              permissionPromptTool: false,
            });
          }

          proc.onPermissionRequest = async (toolName, input, requestId) => {
            if (autoApprove) {
              return { behavior: 'allow', updatedInput: input };
            }

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

            try {
              const result = await pendingPerms.waitFor(requestId);
              const behavior = result.behavior === 'allow' ? 'allow' : 'deny';
              return { behavior, updatedInput: input };
            } catch {
              return { behavior: 'deny' };
            }
          };

          proc.setPendingResponse({
            controller,
            resolve: () => { /* close in hook */ },
            reject: (err: Error) => {
              console.error('[persistent-codebuddy] Pending response rejected:', err.message);
              try {
                controller.enqueue(
                  `data: ${JSON.stringify({ type: 'error', data: JSON.stringify({ error: err.message }) })}\n`,
                );
              } catch { /* ignore */ }
              try { controller.close(); } catch { /* ignore */ }
            },
          });

          if (params.files && params.files.length > 0) {
            proc.sendUserMessage(buildMultimodalContent(params));
          } else {
            proc.sendPrompt(params.prompt || '');
          }

          if (params.abortController) {
            params.abortController.signal.addEventListener('abort', () => {
              proc.interrupt().catch(() => {
                try { controller.close(); } catch { /* ignore */ }
              });
            }, { once: true });
          }

          const keepAliveTimer = setInterval(() => {
            try {
              if (proc.isAlive && proc.state === 'ready') {
                controller.enqueue(`data: ${JSON.stringify({ type: 'keep_alive', data: '' })}\n`);
              }
            } catch { /* ignore */ }
          }, 30_000);

          await new Promise<void>((resolve) => {
            const pending = proc.pendingResponse;
            if (pending) {
              const origResolve = pending.resolve;
              pending.resolve = () => {
                clearInterval(keepAliveTimer);
                origResolve();
                try { controller.close(); } catch { /* ignore */ }
                resolve();
              };
            } else {
              clearInterval(keepAliveTimer);
              try { controller.close(); } catch { /* ignore */ }
              resolve();
            }
          });

          recordSuccess(sessionId);
          console.log(`[persistent-codebuddy] Stream complete for session ${sessionId}`);
        } catch (err) {
          console.error('[persistent-codebuddy] Error, falling back:', (err as Error).message);
          recordFailure(sessionId);
          try {
            const { CodeBuddySDKProvider } = await import('../../codebuddysdk-provider.js');
            const fallback = new CodeBuddySDKProvider(pendingPerms, cliPath, autoApprove);
            const stream = fallback.streamChat(params);
            const reader = stream.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              controller.enqueue(value);
            }
            controller.close();
          } catch (fallbackErr) {
            try {
              controller.enqueue(
                `data: ${JSON.stringify({
                  type: 'error',
                  data: JSON.stringify({
                    error: `Both persistent and fallback failed. Persistent: ${(err as Error).message}. Fallback: ${(fallbackErr as Error).message}`,
                  }),
                })}\n`,
              );
            } catch { /* ignore */ }
            try { controller.close(); } catch { /* ignore */ }
          }
        }
      },
    });
  }
}

export interface PreflightResult {
  ok: boolean;
  cliPath?: string;
  version?: string;
  error?: string;
}

export function preflightPersistentCodeBuddyCheck(cliPath?: string): PreflightResult {
  const path = cliPath || resolveCodeBuddyCliPath();
  if (!path) return { ok: false, error: 'CodeBuddy CLI not found' };

  const check = preflightCodeBuddyCheck(path);
  if (!check.ok) {
    return { ok: false, cliPath: path, error: check.error };
  }

  try {
    const env = { ...process.env } as Record<string, string>;
    delete env.NODE_OPTIONS;
    const help = execSync(`"${path}" --help 2>&1`, {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 30000,
      env,
    }).toString();

    const hasInput = help.includes('--input-format');
    const hasOutput = help.includes('--output-format');
    if (!hasInput || !hasOutput) {
      return {
        ok: false,
        cliPath: path,
        error: `CodeBuddy CLI at "${path}" missing required flags (--input-format, --output-format).`,
      };
    }

    return { ok: true, cliPath: path, version: check.version };
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes('ETIMEDOUT')) {
      // Some builds may block on --help; trust base preflight and proceed.
      return { ok: true, cliPath: path, version: check.version };
    }
    return { ok: false, cliPath: path, error: msg };
  }
}

export async function shutdownPersistentCodeBuddyPool(): Promise<void> {
  if (globalPool) {
    await globalPool.shutdownAll();
    globalPool = null;
  }
}
