/**
 * Quick smoke test for PersistentClaudeProvider.
 *
 * Usage: CTI_RUNTIME=persistent-claude bun run src/__tests__/persistent-smoke.ts
 */

import { PersistentClaudeProvider, preflightPersistentCheck } from '../lib/persistent-claude/provider.js';

// Minimal PendingPermissions stub
class StubPendingPerms {
  private resolvers = new Map<string, (v: unknown) => void>();

  async waitFor(id: string): Promise<{ behavior: 'allow' | 'deny'; message?: string }> {
    // Auto-allow all permissions for testing
    return { behavior: 'allow' };
  }

  resolve(_id: string, _resolution: { behavior: 'allow' | 'deny'; message?: string }): void {}
  denyAll(): void {}
}

async function main() {
  console.log('=== PersistentClaudeProvider Smoke Test ===\n');

  // 1. Preflight
  console.log('1. Preflight check...');
  const check = preflightPersistentCheck();
  console.log(`   Result: ${JSON.stringify(check)}`);
  if (!check.ok) {
    console.error(`   SKIP: ${check.error}`);
    process.exit(0);
  }
  console.log(`   CLI: ${check.cliPath} (${check.version})\n`);

  // 2. Create provider
  console.log('2. Creating provider...');
  const pendingPerms = new StubPendingPerms() as unknown as import('../permission-gateway.js').PendingPermissions;
  const provider = new PersistentClaudeProvider(pendingPerms, check.cliPath);
  console.log('   OK\n');

  // 3. First message
  console.log('3. Sending first message: "Say hello in 5 words"');
  const start1 = Date.now();
  const stream1 = provider.streamChat({
    prompt: 'Say hello in exactly 5 words.',
    sessionId: 'test-session-001',
    permissionMode: 'default',
    workingDirectory: process.cwd(),
  });

  const reader1 = stream1.getReader();
  let fullOutput1 = '';
  while (true) {
    const { done, value } = await reader1.read();
    if (done) break;
    if (value) {
      fullOutput1 += value;
      // Print non-keepalive events
      if (!value.includes('keep_alive')) {
        process.stdout.write(value);
      }
    }
  }
  const elapsed1 = Date.now() - start1;
  console.log(`\n   First message completed in ${elapsed1}ms\n`);

  // 4. Second message (should reuse process)
  console.log('4. Sending second message: "What is 2+2?"');
  const start2 = Date.now();
  const stream2 = provider.streamChat({
    prompt: 'What is 2+2? Reply with just the number.',
    sessionId: 'test-session-001',
    permissionMode: 'default',
    workingDirectory: process.cwd(),
  });

  const reader2 = stream2.getReader();
  let fullOutput2 = '';
  while (true) {
    const { done, value } = await reader2.read();
    if (done) break;
    if (value) {
      fullOutput2 += value;
      if (!value.includes('keep_alive')) {
        process.stdout.write(value);
      }
    }
  }
  const elapsed2 = Date.now() - start2;
  console.log(`\n   Second message completed in ${elapsed2}ms\n`);

  // 5. Summary
  console.log('=== Results ===');
  console.log(`   First message:  ${elapsed1}ms`);
  console.log(`   Second message: ${elapsed2}ms`);
  console.log(`   Speedup:        ${((elapsed1 - elapsed2) / elapsed1 * 100).toFixed(0)}% faster`);

  // Check if second was faster
  if (elapsed2 < elapsed1 * 0.7) {
    console.log('\n   PASS: Second message significantly faster (process reuse confirmed)');
  } else if (elapsed2 < elapsed1) {
    console.log('\n   PARTIAL: Second message faster, but not dramatically');
  } else {
    console.log('\n   WARNING: Second message was not faster. Process may not have been reused.');
  }

  // Cleanup
  console.log('\n6. Shutting down...');
  const { shutdownPersistentPool } = await import('../lib/persistent-claude/provider.js');
  await shutdownPersistentPool();
  console.log('   Done.');
}

main().catch((err) => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
