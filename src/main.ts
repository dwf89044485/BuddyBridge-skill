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
import { preflightPersistentCodeBuddyCheck, shutdownPersistentCodeBuddyPool } from './lib/persistent-codebuddy/index.js';
import { PendingPermissions } from './permission-gateway.js';
import { setupLogger } from './logger.js';

const RUNTIME_DIR = path.join(CTI_HOME, 'runtime');
const STATUS_FILE = path.join(RUNTIME_DIR, 'status.json');
const PID_FILE = path.join(RUNTIME_DIR, 'bridge.pid');

type ResolvedProviderId = 'persistent-codebuddy' | 'codebuddysdk' | 'persistent-claude' | 'claude' | 'codex';

type PreflightResult = {
  ok: boolean;
  cliPath?: string;
  version?: string;
  error?: string;
};

interface ProviderResolution {
  llm: LLMProvider;
  configuredRuntime: Config['runtime'];
  resolvedProvider: ResolvedProviderId;
  providerChain: ResolvedProviderId[];
  usedPersistent: boolean;
  fallbackApplied: boolean;
}

function chainForRuntime(runtime: Config['runtime']): ResolvedProviderId[] {
  switch (runtime) {
    case 'codebuddy':
      return ['persistent-codebuddy', 'codebuddysdk', 'persistent-claude', 'claude', 'codex'];
    case 'claude':
      return ['persistent-claude', 'claude', 'codex'];
    case 'codex':
    default:
      return ['codex'];
  }
}

/**
 * Resolve the LLM provider based on the configured runtime.
 *
 * Product runtimes exposed to users:
 * - 'codebuddy': Persistent CodeBuddy -> CodeBuddy SDK -> Persistent Claude -> Claude -> Codex
 * - 'claude': Persistent Claude -> Claude -> Codex
 * - 'codex': Codex only
 */
async function resolveProvider(config: Config, pendingPerms: PendingPermissions): Promise<ProviderResolution> {
  const configuredRuntime = config.runtime;
  const providerChain = chainForRuntime(configuredRuntime);

  const finalize = (llm: LLMProvider, resolvedProvider: ResolvedProviderId): ProviderResolution => ({
    llm,
    configuredRuntime,
    resolvedProvider,
    providerChain,
    usedPersistent: resolvedProvider.startsWith('persistent-'),
    fallbackApplied: resolvedProvider !== providerChain[0],
  });

  const logSkip = (provider: ResolvedProviderId, reason: string): void => {
    console.warn(`[claude-to-im] ${configuredRuntime}: skipping ${provider} — ${reason}`);
  };

  let codeBuddyCliPathCache: string | null | undefined;
  let codeBuddyCheckCache: PreflightResult | null | undefined;
  let persistentCodeBuddyCheckCache: PreflightResult | null | undefined;
  let claudeCliPathCache: string | null | undefined;
  let claudeCheckCache: PreflightResult | null | undefined;
  let persistentClaudeCheckCache: PreflightResult | undefined;

  const getCodeBuddyCliPath = (): string | null => {
    if (codeBuddyCliPathCache === undefined) {
      codeBuddyCliPathCache = resolveCodeBuddyCliPath() ?? null;
    }
    return codeBuddyCliPathCache;
  };

  const getCodeBuddyCheck = (): PreflightResult | null => {
    if (codeBuddyCheckCache !== undefined) {
      return codeBuddyCheckCache;
    }
    const cliPath = getCodeBuddyCliPath();
    codeBuddyCheckCache = cliPath ? (preflightCodeBuddyCheck(cliPath) as PreflightResult) : null;
    return codeBuddyCheckCache;
  };

  const getPersistentCodeBuddyCheck = (): PreflightResult | null => {
    if (persistentCodeBuddyCheckCache !== undefined) {
      return persistentCodeBuddyCheckCache;
    }
    const cliPath = getCodeBuddyCliPath();
    persistentCodeBuddyCheckCache = cliPath ? (preflightPersistentCodeBuddyCheck(cliPath) as PreflightResult) : null;
    return persistentCodeBuddyCheckCache;
  };

  const getClaudeCliPath = (): string | null => {
    if (claudeCliPathCache === undefined) {
      claudeCliPathCache = resolveClaudeCliPath() ?? null;
    }
    return claudeCliPathCache;
  };

  const getClaudeCheck = (): PreflightResult | null => {
    if (claudeCheckCache !== undefined) {
      return claudeCheckCache;
    }
    const cliPath = getClaudeCliPath();
    claudeCheckCache = cliPath ? (preflightCheck(cliPath) as PreflightResult) : null;
    return claudeCheckCache;
  };

  const getPersistentClaudeCheck = (): PreflightResult => {
    if (!persistentClaudeCheckCache) {
      persistentClaudeCheckCache = preflightPersistentCheck() as PreflightResult;
    }
    return persistentClaudeCheckCache;
  };

  const tryPersistentCodeBuddy = async (): Promise<ProviderResolution | null> => {
    const cliPath = getCodeBuddyCliPath();
    if (!cliPath) {
      logSkip('persistent-codebuddy', 'Cannot find the `codebuddy` executable');
      return null;
    }

    const check = getCodeBuddyCheck();
    if (!check?.ok) {
      logSkip('persistent-codebuddy', check?.error ?? 'CodeBuddy preflight failed');
      return null;
    }

    if (process.env.CTI_PERSISTENT_CODEBUDDY === '0') {
      logSkip('persistent-codebuddy', 'disabled by CTI_PERSISTENT_CODEBUDDY=0');
      return null;
    }

    const persistentCheck = getPersistentCodeBuddyCheck();
    if (!persistentCheck?.ok) {
      logSkip('persistent-codebuddy', persistentCheck?.error ?? 'persistent preflight failed');
      return null;
    }

    console.log(`[claude-to-im] Using persistent CodeBuddy at ${persistentCheck.cliPath ?? cliPath} (${persistentCheck.version ?? check.version ?? 'unknown'})`);
    const { PersistentCodeBuddyProvider } = await import('./lib/persistent-codebuddy/provider.js');
    return finalize(new PersistentCodeBuddyProvider(pendingPerms, persistentCheck.cliPath ?? cliPath, config.autoApprove), 'persistent-codebuddy');
  };

  const tryCodeBuddySDK = async (): Promise<ProviderResolution | null> => {
    const cliPath = getCodeBuddyCliPath();
    if (!cliPath) {
      logSkip('codebuddysdk', 'Cannot find the `codebuddy` executable');
      return null;
    }

    const check = getCodeBuddyCheck();
    if (!check?.ok) {
      logSkip('codebuddysdk', check?.error ?? 'CodeBuddy SDK preflight failed');
      return null;
    }

    console.log(`[claude-to-im] Using CodeBuddy SDK at ${cliPath} (${check.version ?? 'unknown'})`);
    const { CodeBuddySDKProvider } = await import('./codebuddysdk-provider.js');
    return finalize(new CodeBuddySDKProvider(pendingPerms, cliPath, config.autoApprove), 'codebuddysdk');
  };

  const tryPersistentClaude = async (): Promise<ProviderResolution | null> => {
    const check = getPersistentClaudeCheck();
    if (!check.ok || !check.cliPath) {
      logSkip('persistent-claude', check.error ?? 'Persistent Claude preflight failed');
      return null;
    }

    console.log(`[claude-to-im] Using persistent Claude at ${check.cliPath} (${check.version ?? 'unknown'})`);
    const { PersistentClaudeProvider } = await import('./lib/persistent-claude/provider.js');
    return finalize(new PersistentClaudeProvider(pendingPerms, check.cliPath, config.autoApprove), 'persistent-claude');
  };

  const tryClaude = async (): Promise<ProviderResolution | null> => {
    const cliPath = getClaudeCliPath();
    if (!cliPath) {
      logSkip('claude', 'Cannot find the `claude` executable');
      return null;
    }

    const check = getClaudeCheck();
    if (!check?.ok) {
      logSkip('claude', check?.error ?? 'Claude CLI preflight failed');
      return null;
    }

    console.log(`[claude-to-im] Using Claude CLI at ${cliPath} (${check.version ?? 'unknown'})`);
    return finalize(new SDKLLMProvider(pendingPerms, cliPath, config.autoApprove), 'claude');
  };

  const useCodex = async (): Promise<ProviderResolution> => {
    console.log('[claude-to-im] Falling back to Codex');
    const { CodexProvider } = await import('./codex-provider.js');
    return finalize(new CodexProvider(pendingPerms), 'codex');
  };

  for (const candidate of providerChain) {
    switch (candidate) {
      case 'persistent-codebuddy': {
        const resolved = await tryPersistentCodeBuddy();
        if (resolved) return resolved;
        break;
      }
      case 'codebuddysdk': {
        const resolved = await tryCodeBuddySDK();
        if (resolved) return resolved;
        break;
      }
      case 'persistent-claude': {
        const resolved = await tryPersistentClaude();
        if (resolved) return resolved;
        break;
      }
      case 'claude': {
        const resolved = await tryClaude();
        if (resolved) return resolved;
        break;
      }
      case 'codex':
        return useCodex();
    }
  }

  return useCodex();
}

interface StatusInfo {
  running: boolean;
  pid?: number;
  runId?: string;
  startedAt?: string;
  channels?: string[];
  runtime?: string;
  configuredRuntime?: string;
  resolvedProvider?: ResolvedProviderId;
  providerChain?: string;
  usedPersistent?: boolean;
  fallbackApplied?: boolean;
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
  const resolution = await resolveProvider(config, pendingPerms);
  const llm = resolution.llm;
  console.log(`[claude-to-im] Runtime: ${resolution.configuredRuntime}`);
  console.log(`[claude-to-im] Resolved provider: ${resolution.resolvedProvider}`);
  console.log(`[claude-to-im] Provider chain: ${resolution.providerChain.join(' -> ')}`);

  const gateway = {
    resolvePendingPermission: (id: string, resolution: { behavior: 'allow' | 'deny'; message?: string }) =>
      pendingPerms.resolve(id, resolution),
  };

  initBridgeContext({
    store,
    llm,
    runtime: config.runtime,
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
          runtime: resolution.configuredRuntime,
          configuredRuntime: resolution.configuredRuntime,
          resolvedProvider: resolution.resolvedProvider,
          providerChain: resolution.providerChain.join(' -> '),
          usedPersistent: resolution.usedPersistent,
          fallbackApplied: resolution.fallbackApplied,
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
    await shutdownPersistentCodeBuddyPool();
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
