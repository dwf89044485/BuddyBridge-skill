# Troubleshooting

## Bridge won't start

**Symptoms**: `/claude-to-im start` fails or daemon exits immediately.

**Steps**:

1. Run `/claude-to-im doctor` to identify the issue
2. Check that Node.js >= 20 is installed: `node --version`
3. Check that Claude Code CLI is available: `claude --version`
4. Verify config exists: `ls -la ~/.claude-to-im/config.env`
5. Check logs for startup errors: `/claude-to-im logs`

**Common causes**:
- Missing or invalid config.env -- run `/claude-to-im setup`
- Node.js not found or wrong version -- install Node.js >= 20
- Port or resource conflict -- check if another instance is running with `/claude-to-im status`

## Duplicate daemon instances

**Symptoms**: restart appears to succeed, but messages still behave like old code; logs look inconsistent; multiple bridge processes exist at the same time.

**Root cause**:
- On Linux, older supervisor logic relied too heavily on `~/.claude-to-im/runtime/bridge.pid`
- If that PID file became stale, was missing, or the daemon had been started outside the normal command path, `/claude-to-im start` could incorrectly assume nothing was running and launch another instance
- Once two bridge daemons are alive, incoming messages may be handled by the older process, making recent code changes appear ineffective

**Recommended restart procedure**:
1. Run `/claude-to-im stop`
2. Run `/claude-to-im start`
3. Run `/claude-to-im status` and confirm there is exactly one running bridge
4. If behavior still looks old, inspect recent logs with `/claude-to-im logs 200`

**Current safeguard**:
- The Linux supervisor now checks the real process list for `dist/daemon.mjs`, not just the PID file
- `stop` now terminates all matching bridge daemon processes before clearing the PID file
- This means `stop` + `start` is the preferred explicit restart flow, and `start` is now much less likely to create duplicate instances even if the PID file is wrong

## Local core changes not taking effect

**Symptoms**: You changed files in `../BuddyBridge`, but bridge behavior still looks old.

**Root cause**:
- `BuddyBridge-skill` defaults to a GitHub dependency (`github:dwf89044485/BuddyBridge`)
- If you did not switch to local dependency mode, the running daemon won't consume your local core edits

**Fix**:

1. In `BuddyBridge-skill`, switch dependency to local core:
   ```bash
   npm run core:local:install
   ```
2. Verify source mode:
   ```bash
   npm run core:status
   ```
   Make sure it reports `Active mode: local`
3. Restart daemon to reload bundle and runtime:
   ```bash
   /claude-to-im stop
   /claude-to-im start
   ```

**Release reminder**:
- Before publishing the skill, switch back to fork dependency:
  ```bash
  npm run core:fork:install
  ```

## Messages not received

**Symptoms**: Bot is online but doesn't respond to messages.

**Steps**:

1. Verify the bot token is valid: `/claude-to-im doctor`
2. Check allowed user IDs in config -- if set, only listed users can interact
3. For Telegram: ensure you've sent `/start` to the bot first
4. For Discord: verify the bot has been invited to the server with message read permissions
5. For Feishu: confirm the app has been approved and event subscriptions are configured
6. Check logs for incoming message events: `/claude-to-im logs 200`

## Permission timeout

**Symptoms**: Claude Code session starts but times out waiting for tool approval.

**Steps**:

1. The bridge runs Claude Code in non-interactive mode; ensure your Claude Code configuration allows the necessary tools
2. Consider using `--allowedTools` in your configuration to pre-approve common tools
3. Check network connectivity if the timeout occurs during API calls

## High memory usage

**Symptoms**: The daemon process consumes increasing memory over time.

**Steps**:

1. Check current memory usage: `/claude-to-im status`
2. Restart the daemon to reset memory:
   ```
   /claude-to-im stop
   /claude-to-im start
   ```
3. If the issue persists, check how many concurrent sessions are active -- each Claude Code session consumes memory
4. Review logs for error loops that may cause memory leaks

## Stale PID file

**Symptoms**: Status shows "running" but the process doesn't exist, or start refuses because it thinks a daemon is already running.

The daemon management script (`daemon.sh`) handles stale PID files automatically. If you still encounter issues:

1. Run `/claude-to-im stop` -- it will clean up the stale PID file
2. If stop also fails, manually remove the PID file:
   ```bash
   rm ~/.claude-to-im/runtime/bridge.pid
   ```
3. Run `/claude-to-im start` to launch a fresh instance
