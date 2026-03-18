import { query } from '@tencent-ai/agent-sdk';
import type { Message, PermissionResult } from '@tencent-ai/agent-sdk';
import type { LLMProvider, StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';
import type { PendingPermissions } from './permission-gateway.js';

import { buildSubprocessEnv } from './llm-provider.js';
import { resolveCodeBuddyCliPath } from './codebuddy-provider.js';
import { sseEvent } from './sse-utils.js';
import { appendLocalAttachmentSystemNote, splitLocalAttachments } from './file-attachment-prompt.js';

type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

const SUPPORTED_IMAGE_TYPES = new Set<string>([
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp',
]);

function mapPermissionMode(permissionMode?: string): 'default' | 'acceptEdits' | 'plan' | 'dontAsk' {
  if (permissionMode === 'acceptEdits' || permissionMode === 'plan' || permissionMode === 'dontAsk') {
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
        media_type: (file.type === 'image/jpg' ? 'image/jpeg' : file.type) as ImageMediaType,
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
  hasReceivedResult: boolean;
  lastAssistantText: string;
}

export class CodeBuddySDKProvider implements LLMProvider {
  constructor(private pendingPerms: PendingPermissions, private cliPath?: string, private autoApprove = false) {}

  streamChat(params: StreamChatParams): ReadableStream<string> {
    const pendingPerms = this.pendingPerms;
    const autoApprove = this.autoApprove;
    const cliPath = this.cliPath || resolveCodeBuddyCliPath();

    return new ReadableStream<string>({
      start(controller) {
        (async () => {
          const MAX_STDERR = 4096;
          let stderrBuf = '';
          const state: CodeBuddySDKStreamState = {
            hasReceivedResult: false,
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
            if (state.hasReceivedResult && isTransportExit) {
              controller.close();
              return;
            }

            if (state.lastAssistantText && !isTransportExit) {
              controller.enqueue(sseEvent('error', state.lastAssistantText));
              controller.close();
              return;
            }

            if (isTransportExit && stderrBuf.trim()) {
              controller.enqueue(
                sseEvent('error', `${message}\n\nCLI stderr:\n${stderrBuf.trim().slice(-1024)}`),
              );
            } else {
              controller.enqueue(sseEvent('error', message));
            }
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
};