import { query } from '@tencent-ai/agent-sdk';
import type { Message, PermissionResult } from '@tencent-ai/agent-sdk';
import type { LLMProvider, StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';
import type { PendingPermissions } from './permission-gateway.js';

import { buildSubprocessEnv } from './llm-provider.js';
import { resolveCodeBuddyCliPath } from './codebuddy-provider.js';
import { sseEvent } from './sse-utils.js';
import { appendLocalAttachmentSystemNote, splitLocalAttachments } from './file-attachment-prompt.js';

// ── Auth/credential-error detection ──

/** Patterns indicating the CLI is not logged in. */
const CLI_AUTH_PATTERNS = [
  /not logged in/i,
  /please run \/login/i,
  /loggedIn['":\s]*false/i,
];

/**
 * Patterns indicating an API-level credential failure (wrong key, expired token, quota).
 * Specific enough to avoid matching local file permissions or generic HTTP 403s.
 */
const API_AUTH_PATTERNS = [
  /unauthorized/i,
  /invalid.*api.?key/i,
  /authentication.*failed/i,
  /does not have access/i,
  /401\b/,
];

/** Patterns indicating a quota / rate-limit issue. */
const QUOTA_PATTERNS = [
  /quota/i,
  /rate.?limit/i,
  /insufficient.*quota/i,
  /too many requests/i,
];

export type CodeBuddyAuthErrorKind = 'cli' | 'api' | 'quota' | false;

/**
 * Classify an error message as a CLI login issue, an API credential issue,
 * a quota problem, or neither.
 */
export function classifyCodeBuddyAuthError(text: string): CodeBuddyAuthErrorKind {
  if (CLI_AUTH_PATTERNS.some(re => re.test(text))) return 'cli';
  if (API_AUTH_PATTERNS.some(re => re.test(text))) return 'api';
  if (QUOTA_PATTERNS.some(re => re.test(text))) return 'quota';
  return false;
}

const CLI_AUTH_USER_MESSAGE =
  'CodeBuddy CLI is not logged in. Run `codebuddy auth login` (or check your credentials), then restart the bridge.';

const API_AUTH_USER_MESSAGE =
  'API credential error. Check your CODEBUDDY_* or API key configuration in config.env, ' +
  'or verify your account has access to the requested model.';

const QUOTA_USER_MESSAGE =
  'Usage quota exceeded or rate limited. Check your plan limits and try again later.';


const SUPPORTED_IMAGE_TYPES = new Set<string>([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
]);

function mapPermissionMode(permissionMode?: string): 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk' {
  if (permissionMode === 'acceptEdits' || permissionMode === 'plan' || permissionMode === 'dontAsk' || permissionMode === 'bypassPermissions') {
    return permissionMode;
  }
  return 'default';
}

function normalizeToolResultContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'type' in item && item.type === 'text' && 'text' in item) {
          return typeof item.text === 'string' ? item.text : JSON.stringify(item.text ?? '');
        }
        return JSON.stringify(item);
      })
      .join('\n');
  }

  if (content == null) {
    return '';
  }

  return JSON.stringify(content);
}

function buildPrompt(
  params: StreamChatParams,
): string | AsyncIterable<{ type: 'user'; message: { role: 'user'; content: unknown[] }; parent_tool_use_id: null; session_id: string }> {
  if (!params.files || params.files.length === 0) {
    return params.prompt;
  }

  const imageFiles = params.files.filter((file) => SUPPORTED_IMAGE_TYPES.has(file.type));
  const nonImageFiles = params.files.filter((file) => !SUPPORTED_IMAGE_TYPES.has(file.type));
  const { accessibleFiles, inaccessibleFiles } = splitLocalAttachments(nonImageFiles);

  const text = accessibleFiles.length > 0 || inaccessibleFiles.length > 0
    ? appendLocalAttachmentSystemNote(params.prompt, nonImageFiles)
    : params.prompt;

  if (imageFiles.length === 0) {
    return text;
  }

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

  const msg = {
    type: 'user' as const,
    message: { role: 'user' as const, content: contentBlocks },
    parent_tool_use_id: null,
    session_id: '',
  };

  return (async function* () { yield msg; })();
}

export interface CodeBuddySDKStreamState {
  /** True once a `result` message (success or error subtype) has been processed. */
  hasReceivedResult: boolean;
  /** True once any text_delta has been emitted via stream_event. */
  hasStreamedText: boolean;
  /**
   * Full text captured from the final `assistant` message.
   * NOT emitted during normal flow (stream_event deltas handle that).
   * Used by the catch block to surface business errors.
   */
  lastAssistantText: string;
}

export class CodeBuddySDKProvider implements LLMProvider {
  private cliPath: string | undefined;

  constructor(
    private pendingPerms: PendingPermissions,
    cliPath?: string,
    private autoApprove = false,
  ) {
    // Resolve CLI path once at construction time, not on every streamChat() call.
    if (!cliPath) {
      this.cliPath = resolveCodeBuddyCliPath();
    }
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const pendingPerms = this.pendingPerms;
    const autoApprove = this.autoApprove;
    const cliPath = this.cliPath;

    return new ReadableStream<string>({
      start(controller) {
        (async () => {
          const MAX_STDERR = 4096;
          let stderrBuf = '';
          const state: CodeBuddySDKStreamState = {
            hasReceivedResult: false,
            hasStreamedText: false,
            lastAssistantText: '',
          };

          try {
            if (!cliPath) {
              controller.enqueue(
                sseEvent('error', 'Cannot find the `codebuddy` CLI executable. Install CodeBuddy Code or set CTI_CODEBUDDY_EXECUTABLE=/path/to/codebuddy.'),
              );
              controller.close();
              return;
            }

            const q = query({
              prompt: buildPrompt(params) as Parameters<typeof query>[0]['prompt'],
              options: {
                cwd: params.workingDirectory,
                model: params.model,
                resume: params.sdkSessionId || undefined,
                abortController: params.abortController,
                permissionMode: mapPermissionMode(params.permissionMode),
                includePartialMessages: true,
                env: buildSubprocessEnv(),
                pathToCodebuddyCode: cliPath,
                systemPrompt: params.systemPrompt?.trim()
                  ? { append: params.systemPrompt.trim() }
                  : undefined,
                stderr: (data: string) => {
                  stderrBuf += data;
                  if (stderrBuf.length > MAX_STDERR) {
                    stderrBuf = stderrBuf.slice(-MAX_STDERR);
                  }
                },
                canUseTool: async (
                  toolName: string,
                  input: Record<string, unknown>,
                  opts: { toolUseID: string; suggestions?: unknown[] },
                ): Promise<PermissionResult> => {
                  if (autoApprove) {
                    return { behavior: 'allow', updatedInput: input };
                  }

                  controller.enqueue(
                    sseEvent('permission_request', {
                      permissionRequestId: opts.toolUseID,
                      toolName,
                      toolInput: input,
                      suggestions: opts.suggestions || [],
                    }),
                  );

                  const result = await pendingPerms.waitFor(opts.toolUseID);

                  if (result.behavior === 'allow') {
                    return {
                      behavior: 'allow',
                      updatedInput: input,
                      toolUseID: opts.toolUseID,
                    };
                  }

                  return {
                    behavior: 'deny',
                    message: result.message || 'Denied by user',
                    toolUseID: opts.toolUseID,
                  };
                },
              },
            });

            for await (const msg of q) {
              handleMessage(msg, controller, state);
            }

            controller.close();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error('[codebuddysdk-provider] SDK query error:', error instanceof Error ? error.stack || error.message : error);
            if (stderrBuf) {
              console.error('[codebuddysdk-provider] stderr from CLI:', stderrBuf.trim());
            }

            const isTransportExit = message.includes('process exited with code');

            // ── Case 1: Result already received ──
            // A trailing "process exited with code 1" is transport teardown noise.
            if (state.hasReceivedResult && isTransportExit) {
              console.log('[codebuddysdk-provider] Suppressing transport error — result already received');
              controller.close();
              return;
            }

            // ── Case 2: Recognised auth/credential error in assistant text ──
            // The CLI returned an assistant message with text that matches
            // a known auth/quota error pattern. Forward as text — it's
            // more informative than the generic transport error.
            if (state.lastAssistantText && classifyCodeBuddyAuthError(state.lastAssistantText)) {
              controller.enqueue(sseEvent('text', state.lastAssistantText));
              controller.close();
              return;
            }

            // ── Case 3: Build user-facing error message ──
            const authKind = classifyCodeBuddyAuthError(message) || classifyCodeBuddyAuthError(stderrBuf);
            let userMessage: string;
            if (authKind === 'cli') {
              userMessage = CLI_AUTH_USER_MESSAGE;
            } else if (authKind === 'api') {
              userMessage = API_AUTH_USER_MESSAGE;
            } else if (authKind === 'quota') {
              userMessage = QUOTA_USER_MESSAGE;
            } else if (isTransportExit) {
              const stderrSummary = stderrBuf.trim();
              const lines = [message];
              if (stderrSummary) {
                lines.push('', 'CLI stderr:', stderrSummary.slice(-1024));
              }
              lines.push(
                '',
                'Possible causes:',
                '• CodeBuddy CLI not authenticated — check login status',
                '• API key missing or expired — check config.env',
                '• Model not available on current plan',
                '',
                'Run `/claude-to-im doctor` to diagnose.',
              );
              userMessage = lines.join('\n');
            } else {
              userMessage = message;
            }

            controller.enqueue(sseEvent('error', userMessage));
            controller.close();
          }
        })();
      },
    });
  }
}

export function handleMessage(
  msg: Message,
  controller: ReadableStreamDefaultController<string>,
  state: CodeBuddySDKStreamState,
): void {
  switch (msg.type) {
    case 'stream_event': {
      const event = msg.event;
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        controller.enqueue(sseEvent('text', event.delta.text));
        state.hasStreamedText = true;
      }
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        controller.enqueue(
          sseEvent('tool_use', {
            id: event.content_block.id,
            name: event.content_block.name,
            input: event.content_block.input ?? {},
          }),
        );
      }
      break;
    }

    case 'assistant': {
      for (const block of msg.message?.content ?? []) {
        if (block.type === 'text' && block.text) {
          state.lastAssistantText += (state.lastAssistantText ? '\n' : '') + block.text;
        }

        if (block.type === 'tool_use') {
          controller.enqueue(
            sseEvent('tool_use', {
              id: block.id,
              name: block.name,
              input: block.input ?? {},
            }),
          );
        }
      }
      break;
    }

    case 'user': {
      const content = msg.message?.content;
      const blocks = Array.isArray(content) ? content : [];
      for (const block of blocks) {
        if (typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result') {
          controller.enqueue(
            sseEvent('tool_result', {
              tool_use_id: block.tool_use_id,
              content: normalizeToolResultContent(block.content),
              is_error: block.is_error || false,
            }),
          );
        }
      }
      break;
    }

    case 'result': {
      state.hasReceivedResult = true;
      if (msg.subtype === 'success') {
        controller.enqueue(
          sseEvent('result', {
            session_id: msg.session_id,
            is_error: msg.is_error,
            usage: {
              input_tokens: msg.usage.input_tokens,
              output_tokens: msg.usage.output_tokens,
              cache_read_input_tokens: msg.usage.cache_read_input_tokens ?? 0,
              cache_creation_input_tokens: msg.usage.cache_creation_input_tokens ?? 0,
              cost_usd: msg.total_cost_usd,
            },
          }),
        );
      } else {
        controller.enqueue(sseEvent('error', msg.errors?.join('; ') || 'CodeBuddy SDK returned an error'));
      }
      break;
    }

    case 'system': {
      if (msg.subtype === 'init') {
        controller.enqueue(
          sseEvent('status', {
            session_id: msg.session_id,
            model: msg.model,
          }),
        );
      }
      break;
    }

    case 'error': {
      controller.enqueue(sseEvent('error', msg.error));
      break;
    }

    default:
      break;
  }
}

export const _testOnly = {
  buildPrompt,
  mapPermissionMode,
  normalizeToolResultContent,
  classifyCodeBuddyAuthError,
};