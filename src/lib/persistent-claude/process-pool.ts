/**
 * ProcessPool — manages PersistentProcess instances keyed by sessionId.
 *
 * Each session gets its own CLI subprocess. The pool handles:
 * - connect/disconnect lifecycle
 * - idle timeout GC
 * - crash recovery tracking
 * - maximum process limit
 */

import type { PersistentProcessOptions } from './types.js';
import { DEFAULT_POOL_CONFIG, type ProcessPoolConfig } from './types.js';
import { PersistentProcess, resolvePersistentCliPath } from './process.js';

export class ProcessPool {
  private processes = new Map<string, PersistentProcess>();
  private gcTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private config: ProcessPoolConfig = DEFAULT_POOL_CONFIG) {}

  /**
   * Get or create a persistent process for the given session.
   */
  async connect(sessionId: string, options: Partial<PersistentProcessOptions> = {}): Promise<PersistentProcess> {
    // Check cache
    const existing = this.processes.get(sessionId);
    if (existing && existing.isAlive && existing.state === 'ready') {
      existing.lastActivityAt = Date.now();

      const targetModel = options.model?.trim();
      if (targetModel && existing.model && existing.model !== targetModel) {
        console.log(`[pool] Model changed for session ${sessionId} (${existing.model} -> ${targetModel}), reusing process and letting provider switch model`);
      }

      const stillExisting = this.processes.get(sessionId);
      if (stillExisting && stillExisting.isAlive && stillExisting.state === 'ready') {
        console.log(`[pool] Reusing existing process for session ${sessionId}`);
        return stillExisting;
      }
    }

    // Clean up dead entry if any
    if (existing) {
      console.log(`[pool] Existing process for session ${sessionId} is ${existing.state}, replacing`);
      this.processes.delete(sessionId);
    }

    // Check max processes
    if (this.processes.size >= this.config.maxProcesses) {
      // Evict the least recently active idle process
      this.evictLeastActive();
    }

    // Find CLI
    const cliPath = options?.cliPath || resolvePersistentCliPath();
    if (!cliPath) {
      throw new Error('[pool] Claude CLI not found');
    }

    // Create and connect
    const proc = new PersistentProcess(sessionId, cliPath);
    this.processes.set(sessionId, proc);

    try {
      await proc.connect(options);
    } catch (err) {
      this.processes.delete(sessionId);
      throw err;
    }

    return proc;
  }

  /**
   * Get a process without connecting.
   */
  get(sessionId: string): PersistentProcess | undefined {
    return this.processes.get(sessionId);
  }

  /**
   * Check if a session has a ready process.
   */
  isReady(sessionId: string): boolean {
    const proc = this.processes.get(sessionId);
    return !!proc && proc.isAlive && proc.state === 'ready';
  }

  /**
   * Disconnect a session's process.
   */
  async disconnect(sessionId: string): Promise<void> {
    const proc = this.processes.get(sessionId);
    if (!proc) return;
    await proc.disconnect();
    this.processes.delete(sessionId);
  }

  /**
   * Disconnect all processes.
   */
  async shutdownAll(): Promise<void> {
    const promises = Array.from(this.processes.values()).map((p) => p.disconnect().catch(() => {}));
    await Promise.all(promises);
    this.processes.clear();
    this.stopGc();
  }

  /**
   * Start the idle GC timer. Call once during startup.
   */
  startGc(): void {
    if (this.gcTimer) return;
    this.gcTimer = setInterval(() => this.runGc(), 60_000);
    // Don't prevent process exit
    if (this.gcTimer.unref) this.gcTimer.unref();
  }

  stopGc(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }

  /**
   * Get pool stats for diagnostics.
   */
  get stats() {
    let ready = 0, busy = 0, other = 0;
    for (const proc of this.processes.values()) {
      if (proc.state === 'ready') ready++;
      else if (proc.state === 'busy') busy++;
      else other++;
    }
    return { total: this.processes.size, ready, busy, other, max: this.config.maxProcesses };
  }

  // ── Internal ─────────────────────────────────────────────────

  private runGc(): void {
    const now = Date.now();
    for (const [sessionId, proc] of this.processes) {
      if (!proc.isAlive) {
        console.log(`[pool] GC: removing dead process for session ${sessionId}`);
        this.processes.delete(sessionId);
        continue;
      }
      if (proc.state === 'ready' && now - proc.lastActivityAt > this.config.idleTimeoutMs) {
        console.log(`[pool] GC: idle timeout for session ${sessionId}, disconnecting`);
        proc.disconnect().catch(() => {});
        this.processes.delete(sessionId);
      }
    }
  }

  private evictLeastActive(): void {
    let oldest: { sessionId: string; proc: PersistentProcess; lastActivity: number } | null = null;
    for (const [sessionId, proc] of this.processes) {
      if (proc.state === 'ready') {
        if (!oldest || proc.lastActivityAt < oldest.lastActivity) {
          oldest = { sessionId, proc, lastActivity: proc.lastActivityAt };
        }
      }
    }
    if (oldest) {
      console.log(`[pool] Evicting idle session ${oldest.sessionId}`);
      oldest.proc.disconnect().catch(() => {});
      this.processes.delete(oldest.sessionId);
    }
  }
}
