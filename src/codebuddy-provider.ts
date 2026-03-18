/**
 * CodeBuddy Provider — LLMProvider implementation backed by the local CodeBuddy CLI.
 *
 * Uses `codebuddy -p --output-format stream-json` to obtain NDJSON events,
 * then maps those events into the SSE stream format expected by the bridge.
 */

import { execSync, spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpathSync } from 'node:fs';

import type { LLMProvider, StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';
import { buildSubprocessEnv } from './llm-provider.js';
import { sseEvent } from './sse-utils.js';
import { appendLocalAttachmentSystemNote } from './file-attachment-prompt.js';

interface CodeBuddyEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  is_error?: boolean;
  result?: string;
  message?: {
    content?: Array<{
      type?: string;
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    }>;
  };
  usage?: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
  errors?: string[];
}

const REQUIRED_CODEBUDDY_FLAGS = ['--output-format', '--permission-mode', '--print', '--append-system-prompt'] as const;
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']);

function isExecutable(path: string): boolean {
  try {
    execSync(`"${path}" --version`, {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 5000,
      env: buildSubprocessEnv(),
    });
    return true;
  } catch {
    return false;
  }
}

function findCommand(name: string): string[] {
  try {
    const cmd = process.platform === 'win32' ? `where ${name}` : `which -a ${name}`;
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: 3000,
      env: buildSubprocessEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function normalizeExecutablePath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function resolveCodeBuddyCliPath(): string | undefined {
  const explicit = process.env.CTI_CODEBUDDY_EXECUTABLE;
  if (explicit && isExecutable(explicit)) {
    return normalizeExecutablePath(explicit);
  }

  const candidates = [...findCommand('codebuddy'), ...findCommand('cbc')];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (isExecutable(candidate)) {
      return normalizeExecutablePath(candidate);
    }
  }

  return undefined;
}

export function preflightCodeBuddyCheck(cliPath: string): { ok: boolean; version?: string; error?: string } {
  try {
    const version = execSync(`"${cliPath}" --version`, {
      encoding: 'utf-8',
      timeout: 10000,
      env: buildSubprocessEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

    const help = execSync(`"${cliPath}" --help`, {
      encoding: 'utf-8',
      timeout: 10000,
      env: buildSubprocessEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    for (const flag of REQUIRED_CODEBUDDY_FLAGS) {
      if (!help.includes(flag)) {
        return {
          ok: false,
          version,
          error: `CodeBuddy CLI is missing required flag ${flag}`,
        };
      }
    }

    return { ok: true, version };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function mapPermissionMode(permissionMode?: string): 'default' | 'acceptEdits' | 'plan' {
  if (permissionMode === 'acceptEdits' || permissionMode === 'plan') {
    return permissionMode;
  }
  return 'default';
}

function shouldRetryFreshSession(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    (lower.includes('resume') && lower.includes('session')) ||
    lower.includes('different model') ||
    lower.includes('no such session')
  );
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

function buildPrompt(params: StreamChatParams): string {
  if (!params.files || params.files.length === 0) {
    return params.prompt;
  }

  const nonImageFiles = params.files.filter((file) => !IMAGE_MIME_TYPES.has(file.type));
  if (nonImageFiles.length === 0) {
    return params.prompt;
  }

  return appendLocalAttachmentSystemNote(params.prompt, nonImageFiles);
}

function buildArgs(params: StreamChatParams, resumeSessionId?: string): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--permission-mode', mapPermissionMode(params.permissionMode)];

  if (params.model) {
    args.push('--model', params.model);
  }

  if (resumeSessionId) {
    args.push('--resume', resumeSessionId);
  }

  const systemPrompt = params.systemPrompt?.trim();
  if (systemPrompt) {
    args.push('--append-system-prompt', systemPrompt);
  }

  args.push(buildPrompt(params));
  return args;
}

export const _testOnly = {
  buildArgs,
  buildPrompt,
  mapPermissionMode,
  shouldRetryFreshSession,
  requiredFlags: REQUIRED_CODEBUDDY_FLAGS,
};

export class CodeBuddyProvider implements LLMProvider {
  streamChat(params: StreamChatParams): ReadableStream<string> {
    return new ReadableStream<string>({
      start(controller) {
        const cliPath = resolveCodeBuddyCliPath();
        if (!cliPath) {
          controller.enqueue(
            sseEvent('error', 'Cannot find the `codebuddy` CLI executable. Install CodeBuddy Code or set CTI_CODEBUDDY_EXECUTABLE=/path/to/codebuddy.'),
          );
          controller.close();
          return;
        }

        let child: ReturnType<typeof spawn> | null = null;
        let stderrBuffer = '';
        let stdoutBuffer = '';
        let closed = false;
        let hasResult = false;
        let retriedFresh = false;

        const closeController = () => {
          if (!closed) {
            closed = true;
            controller.close();
          }
        };

        const emitError = (message: string) => {
          if (!closed) {
            controller.enqueue(sseEvent('error', message));
          }
        };

        const handleEvent = (event: CodeBuddyEvent) => {
          switch (event.type) {
            case 'system': {
              if (event.subtype === 'init') {
                controller.enqueue(
                  sseEvent('status', {
                    session_id: event.session_id,
                    model: event.model,
                  }),
                );
              }
              break;
            }

            case 'assistant': {
              for (const block of event.message?.content ?? []) {
                if (block.type === 'text' && block.text) {
                  controller.enqueue(sseEvent('text', block.text));
                }

                if (block.type === 'tool_use' && block.id && block.name) {
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
              for (const block of event.message?.content ?? []) {
                if (block.type === 'tool_result' && block.tool_use_id) {
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
              hasResult = true;
              if (event.subtype === 'success') {
                controller.enqueue(
                  sseEvent('result', {
                    session_id: event.session_id,
                    is_error: event.is_error || false,
                    usage: {
                      input_tokens: event.usage?.input_tokens ?? 0,
                      output_tokens: event.usage?.output_tokens ?? 0,
                      cache_read_input_tokens: event.usage?.cache_read_input_tokens ?? 0,
                      cache_creation_input_tokens: event.usage?.cache_creation_input_tokens ?? 0,
                    },
                  }),
                );
              } else {
                emitError(event.errors?.join('; ') || event.result || 'CodeBuddy returned an error result');
              }
              break;
            }

            case 'error': {
              emitError(event.result || event.errors?.join('; ') || 'CodeBuddy returned an error event');
              break;
            }

            default:
              break;
          }
        };

        const run = (resumeSessionId?: string) => {
          stderrBuffer = '';
          stdoutBuffer = '';
          hasResult = false;

          const proc = spawn(cliPath, buildArgs(params, resumeSessionId), {
            cwd: params.workingDirectory,
            env: buildSubprocessEnv(),
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          child = proc;

          params.abortController?.signal.addEventListener('abort', () => {
            if (child && !child.killed) {
              child.kill('SIGTERM');
            }
          }, { once: true });

          proc.stdout.on('data', (chunk: Buffer) => {
            stdoutBuffer += chunk.toString('utf-8');

            while (true) {
              const newlineIndex = stdoutBuffer.indexOf('\n');
              if (newlineIndex === -1) break;
              const line = stdoutBuffer.slice(0, newlineIndex).trim();
              stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
              if (!line) continue;

              try {
                handleEvent(JSON.parse(line) as CodeBuddyEvent);
              } catch (error) {
                console.warn('[codebuddy-provider] Failed to parse NDJSON line:', line, error);
              }
            }
          });

          proc.stderr.on('data', (chunk: Buffer) => {
            stderrBuffer += chunk.toString('utf-8');
            if (stderrBuffer.length > 4096) {
              stderrBuffer = stderrBuffer.slice(-4096);
            }
          });

          proc.on('error', (error) => {
            emitError(error.message);
            closeController();
          });

          proc.on('close', (code, signal) => {
            if (closed) return;

            const trailing = stdoutBuffer.trim();
            if (trailing) {
              try {
                handleEvent(JSON.parse(trailing) as CodeBuddyEvent);
              } catch {
                // Ignore partial trailing JSON
              }
            }

            if (params.abortController?.signal.aborted) {
              closeController();
              return;
            }

            if (hasResult) {
              closeController();
              return;
            }

            const failureMessage = [
              code != null ? `CodeBuddy exited with code ${code}` : undefined,
              signal ? `signal: ${signal}` : undefined,
              stderrBuffer.trim() || undefined,
            ]
              .filter(Boolean)
              .join('\n');

            if (resumeSessionId && !retriedFresh && shouldRetryFreshSession(failureMessage)) {
              retriedFresh = true;
              run(undefined);
              return;
            }

            emitError(failureMessage || 'CodeBuddy exited before returning a result');
            closeController();
          });
        };

        run(params.sdkSessionId || undefined);
      },
    });
  }
}