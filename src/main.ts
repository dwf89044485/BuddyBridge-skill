/**
 * Daemon entry point for claude-to-im-skill.
 *
 * Assembles all DI implementations and starts the bridge.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { initBridgeContext } from 'claude-to-im/src/lib/bridge/context.js';
import * as bridgeManager from 'claude-to-im/src/lib/bridge/bridge-manager.js';
// Side-effect import to trigger adapter self-registration
import 'claude-to-im/src/lib/bridge/adapters/index.js';
import './adapters/weixin-adapter.js';

import type { LLMProvider } from 'claude-to-im/src/lib/bridge/host.js';
import { loadConfig, configToSettings, CTI_HOME } from './config.js';
import type { Config } from './config.js';
import { JsonFileStore } from './store.js';
import { SDKLLMProvider, resolveClaudeCliPath, preflightCheck } from './llm-provider.js';
import { resolveCodeBuddyCliPath, preflightCodeBuddyCheck } from './codebuddy-provider.js';
import { preflightPersistentCheck, shutdownPersistentPool } from './lib/persistent-claude/index.js';
import { PendingPermissions } from './permission-gateway.js';
import { setupLogger } from './logger.js';

const RUNTIME_DIR = path.join(CTI_HOME, 'runtime');
const STATUS_FILE = path.join(RUNTIME_DIR, 'status.json');
const PID_FILE = path.join(RUNTIME_DIR, 'bridge.pid');

/**
 * Resolve the LLM provider based on the runtime setting.
 * - 'claude' (default): uses Claude Code SDK via SDKLLMProvider
 * - 'codex': uses @openai/codex-sdk via CodexProvider
 * - 'codebuddy': uses the local CodeBuddy CLI via CodeBuddyProvider
 * - 'codebuddysdk': uses @tencent-ai/agent-sdk via CodeBuddySDKProvider
 * - 'persistent-claude': uses persistent Claude CLI subprocess (keeps process alive)
 */
async function resolveProvider(config: Config, pendingPerms: PendingPermissions): Promise<LLMProvider> {
  const runtime = config.runtime;

  if (runtime === 'codex') {
    const { CodexProvider } = await import('./codex-provider.js');
    return new CodexProvider(pendingPerms);
  }

  if (runtime === 'codebuddy') {
    const cliPath = resolveCodeBuddyCliPath();
    if (!cliPath) {
      console.error(
        '[claude-to-im] FATAL: Cannot find the `codebuddy` CLI executable.\n' +
        '  Tried: CTI_CODEBUDDY_EXECUTABLE env, PATH entries for `codebuddy` and `cbc`\n' +
        '  Fix: Install CodeBuddy Code or set CTI_CODEBUDDY_EXECUTABLE=/path/to/codebuddy',
      );
      process.exit(1);
    }

    const check = preflightCodeBuddyCheck(cliPath);
    if (!check.ok) {
      console.error(
        `[claude-to-im] FATAL: CodeBuddy CLI preflight check failed.\n` +
        `  Path: ${cliPath}\n` +
        `  Error: ${check.error}`,
      );
      process.exit(1);
    }

    console.log(`[claude-to-im] CodeBuddy CLI preflight OK: ${cliPath} (${check.version})`);
    const { CodeBuddyProvider } = await import('./codebuddy-provider.js');
    return new CodeBuddyProvider();
  }

  if (runtime === 'codebuddysdk') {
    const cliPath = resolveCodeBuddyCliPath();
    if (!cliPath) {
      console.error(
        '[claude-to-im] FATAL: Cannot find the `codebuddy` CLI executable.\n' +
        '  Tried: CTI_CODEBUDDY_EXECUTABLE env, PATH entries for `codebuddy` and `cbc`\n' +
        '  Fix: Install CodeBuddy Code or set CTI_CODEBUDDY_EXECUTABLE=/path/to/codebuddy',
      );
      process.exit(1);
    }

    const check = preflightCodeBuddyCheck(cliPath);
    if (!check.ok) {
      console.error(
        `[claude-to-im] FATAL: CodeBuddy SDK preflight check failed.\n` +
        `  Path: ${cliPath}\n` +
        `  Error: ${check.error}`,
      );
      process.exit(1);
    }

    console.log(`[claude-to-im] CodeBuddy SDK preflight OK: ${cliPath} (${check.version})`);
    const { CodeBuddySDKProvider } = await import('./codebuddysdk-provider.js');
    return new CodeBuddySDKProvider(pendingPerms, cliPath, config.autoApprove);
  }

  if (runtime === 'persistent-claude') {
    const check = preflightPersistentCheck();
    if (!check.ok) {
      console.error(
        `[claude-to-im] FATAL: Persistent Claude preflight check failed.\n` +
        `  Error: ${check.error}\n` +
        `  Fix: Install Claude Code CLI or set CTI_CLAUDE_CODE_EXECUTABLE=/path/to/claude`,
      );
      process.exit(1);
    }

    console.log(`[claude-to-im] Persistent Claude preflight OK: ${check.cliPath} (${check.version})`);
    const { PersistentClaudeProvider } = await import('./lib/persistent-claude/provider.js');
    return new PersistentClaudeProvider(pendingPerms, check.cliPath);
  }

  if (runtime === 'auto') {
    // Try persistent Claude first (fastest for multi-turn sessions)
    const persistentCheck = preflightPersistentCheck();
    if (persistentCheck.ok) {
      console.log(`[claude-to-im] Auto: using persistent Claude at ${persistentCheck.cliPath} (${persistentCheck.version})`);
      const { PersistentClaudeProvider } = await import('./lib/persistent-claude/provider.js');
      return new PersistentClaudeProvider(pendingPerms, persistentCheck.cliPath);
    }
    if (persistentCheck.cliPath) {
      console.warn(
        `[claude-to-im] Auto: Persistent Claude at ${persistentCheck.cliPath} failed preflight: ${persistentCheck.error}\n` +
        '  Falling through to Claude SDK.',
      );
    }

    // Fall through to Claude SDK (version-gated)
    const claudeCliPath = resolveClaudeCliPath();
    if (claudeCliPath) {
      const check = preflightCheck(claudeCliPath);
      if (check.ok) {
        console.log(`[claude-to-im] Auto: using Claude CLI at ${claudeCliPath} (${check.version})`);
        return new SDKLLMProvider(pendingPerms, claudeCliPath, config.autoApprove);
      }
      console.warn(
        `[claude-to-im] Auto: Claude CLI at ${claudeCliPath} failed preflight: ${check.error}\n` +
        '  Falling through to CodeBuddy SDK.',
      );
    } else {
      console.log('[claude-to-im] Auto: Claude CLI not found, trying CodeBuddy SDK');
    }

    const codeBuddyCliPath = resolveCodeBuddyCliPath();
    if (codeBuddyCliPath) {
      const check = preflightCodeBuddyCheck(codeBuddyCliPath);
      if (check.ok) {
        console.log(`[claude-to-im] Auto: using CodeBuddy SDK at ${codeBuddyCliPath} (${check.version})`);
        const { CodeBuddySDKProvider } = await import('./codebuddysdk-provider.js');
        return new CodeBuddySDKProvider(pendingPerms, codeBuddyCliPath, config.autoApprove);
      }
      console.warn(
        `[claude-to-im] Auto: CodeBuddy SDK at ${codeBuddyCliPath} failed preflight: ${check.error}\n` +
        '  Falling through to CodeBuddy CLI.',
      );
    } else {
      console.log('[claude-to-im] Auto: CodeBuddy CLI not found for SDK path, trying CodeBuddy CLI bridge');
    }

    if (codeBuddyCliPath) {
      const check = preflightCodeBuddyCheck(codeBuddyCliPath);
      if (check.ok) {
        console.log(`[claude-to-im] Auto: using CodeBuddy CLI at ${codeBuddyCliPath} (${check.version})`);
        const { CodeBuddyProvider } = await import('./codebuddy-provider.js');
        return new CodeBuddyProvider();
      }
      console.warn(
        `[claude-to-im] Auto: CodeBuddy CLI at ${codeBuddyCliPath} failed preflight: ${check.error}\n` +
        '  Falling back to Codex.',
      );
    } else {
      console.log('[claude-to-im] Auto: CodeBuddy CLI not found, falling back to Codex');
    }

    const { CodexProvider } = await import('./codex-provider.js');
    return new CodexProvider(pendingPerms);
  }

  // Default: claude
  const cliPath = resolveClaudeCliPath();
  if (!cliPath) {
    console.error(
      '[claude-to-im] FATAL: Cannot find the `claude` CLI executable.\n' +
      '  Tried: CTI_CLAUDE_CODE_EXECUTABLE env, /usr/local/bin/claude, /opt/homebrew/bin/claude, ~/.npm-global/bin/claude, ~/.local/bin/claude\n' +
      '  Fix: Install Claude Code CLI (https://docs.anthropic.com/en/docs/claude-code) or set CTI_CLAUDE_CODE_EXECUTABLE=/path/to/claude\n' +
      '  Or: Set CTI_RUNTIME=auto to fall back to CodeBuddy SDK, CodeBuddy CLI, or Codex instead',
    );
    process.exit(1);
  }

  // Preflight: verify the CLI can actually run in the daemon environment.
  // In claude runtime this is fatal — starting with a broken CLI would just
  // defer the error to the first user message, which is harder to diagnose.
  const check = preflightCheck(cliPath);
  if (check.ok) {
    console.log(`[claude-to-im] CLI preflight OK: ${cliPath} (${check.version})`);
  } else {
    console.error(
      `[claude-to-im] FATAL: Claude CLI preflight check failed.\n` +
      `  Path: ${cliPath}\n` +
      `  Error: ${check.error}\n` +
      `  Fix:\n` +
      `    1. Install Claude Code CLI >= 2.x: https://docs.anthropic.com/en/docs/claude-code\n` +
      `    2. Or set CTI_CLAUDE_CODE_EXECUTABLE=/path/to/correct/claude\n` +
      `    3. Or set CTI_RUNTIME=auto to fall back to CodeBuddy SDK, CodeBuddy CLI, or Codex`,
    );
    process.exit(1);
  }

  return new SDKLLMProvider(pendingPerms, cliPath, config.autoApprove);
}

interface StatusInfo {
  running: boolean;
  pid?: number;
  runId?: string;
  startedAt?: string;
  channels?: string[];
  lastExitReason?: string;
}

function writeStatus(info: StatusInfo): void {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  // Merge with existing status to preserve fields like lastExitReason
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf-8')); } catch { /* first write */ }
  const merged = { ...existing, ...info };
  const tmp = STATUS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8');
  fs.renameSync(tmp, STATUS_FILE);
}

async function main(): Promise<void> {
  const config = loadConfig();
  setupLogger();

  const runId = crypto.randomUUID();
  console.log(`[claude-to-im] Starting bridge (run_id: ${runId})`);

  const settings = configToSettings(config);
  const store = new JsonFileStore(settings);
  const pendingPerms = new PendingPermissions();
  const llm = await resolveProvider(config, pendingPerms);
  console.log(`[claude-to-im] Runtime: ${config.runtime}`);

  const gateway = {
    resolvePendingPermission: (id: string, resolution: { behavior: 'allow' | 'deny'; message?: string }) =>
      pendingPerms.resolve(id, resolution),
  };

  initBridgeContext({
    store,
    llm,
    permissions: gateway,
    lifecycle: {
      onBridgeStart: () => {
        // Write authoritative PID from the actual process (not shell $!)
        fs.mkdirSync(RUNTIME_DIR, { recursive: true });
        fs.writeFileSync(PID_FILE, String(process.pid), 'utf-8');
        writeStatus({
          running: true,
          pid: process.pid,
          runId,
          startedAt: new Date().toISOString(),
          channels: config.enabledChannels,
        });
        console.log(`[claude-to-im] Bridge started (PID: ${process.pid}, channels: ${config.enabledChannels.join(', ')})`);
      },
      onBridgeStop: () => {
        writeStatus({ running: false });
        console.log('[claude-to-im] Bridge stopped');
      },
    },
  });

  await bridgeManager.start();

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const reason = signal ? `signal: ${signal}` : 'shutdown requested';
    console.log(`[claude-to-im] Shutting down (${reason})...`);
    pendingPerms.denyAll();
    await bridgeManager.stop();
    await shutdownPersistentPool();
    writeStatus({ running: false, lastExitReason: reason });
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));

  // ── Exit diagnostics ──
  process.on('unhandledRejection', (reason) => {
    console.error('[claude-to-im] unhandledRejection:', reason instanceof Error ? reason.stack || reason.message : reason);
    writeStatus({ running: false, lastExitReason: `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}` });
  });
  process.on('uncaughtException', (err) => {
    console.error('[claude-to-im] uncaughtException:', err.stack || err.message);
    writeStatus({ running: false, lastExitReason: `uncaughtException: ${err.message}` });
    process.exit(1);
  });
  process.on('beforeExit', (code) => {
    console.log(`[claude-to-im] beforeExit (code: ${code})`);
  });
  process.on('exit', (code) => {
    console.log(`[claude-to-im] exit (code: ${code})`);
  });

  // ── Heartbeat to keep event loop alive ──
  // setInterval is ref'd by default, preventing Node from exiting
  // when the event loop would otherwise be empty.
  setInterval(() => { /* keepalive */ }, 45_000);
}

main().catch((err) => {
  console.error('[claude-to-im] Fatal error:', err instanceof Error ? err.stack || err.message : err);
  try { writeStatus({ running: false, lastExitReason: `fatal: ${err instanceof Error ? err.message : String(err)}` }); } catch { /* ignore */ }
  process.exit(1);
});