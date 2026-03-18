import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { JsonFileStore } from '../store.js';
import { CTI_HOME } from '../config.js';
import { initBridgeContext } from 'claude-to-im/src/lib/bridge/context.js';
import { _testOnly } from 'claude-to-im/src/lib/bridge/bridge-manager.js';
import { processMessage } from 'claude-to-im/src/lib/bridge/conversation-engine.js';
import type { BridgeStore, LLMProvider, LifecycleHooks, PermissionGateway, StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';
import type { InboundMessage, OutboundMessage, SendResult } from 'claude-to-im/src/lib/bridge/types.js';
import { BaseChannelAdapter } from 'claude-to-im/src/lib/bridge/channel-adapter.js';

const DATA_DIR = path.join(CTI_HOME, 'data');

function makeSettings(): Map<string, string> {
  return new Map([
    ['remote_bridge_enabled', 'true'],
    ['bridge_default_work_dir', '/tmp/test-cwd'],
    ['bridge_default_model', 'test-model'],
    ['bridge_default_mode', 'code'],
  ]);
}

class FakeAdapter extends BaseChannelAdapter {
  readonly channelType = 'discord';
  readonly sent: OutboundMessage[] = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  isRunning(): boolean { return true; }
  async consumeOne(): Promise<InboundMessage | null> { return null; }
  async send(message: OutboundMessage): Promise<SendResult> {
    this.sent.push(message);
    return { ok: true, messageId: `sent-${this.sent.length}` };
  }
  validateConfig(): string | null { return null; }
  isAuthorized(): boolean { return true; }
}

function makeContext(store: BridgeStore): {
  store: BridgeStore;
  llm: LLMProvider;
  permissions: PermissionGateway;
  lifecycle: LifecycleHooks;
} {
  return {
    store,
    llm: {
      streamChat(): ReadableStream<string> {
        throw new Error('streamChat should not be called in /prompt command tests');
      },
    },
    permissions: {
      resolvePendingPermission(): boolean {
        return false;
      },
    },
    lifecycle: {},
  };
}

function makeMessage(text: string): InboundMessage {
  return {
    messageId: 'msg-1',
    address: {
      channelType: 'discord',
      chatId: 'thread-1',
      userId: 'user-1',
      displayName: 'Tester',
      scopeChain: [
        { kind: 'guild', id: 'guild-1' },
        { kind: 'channel', id: 'channel-1' },
        { kind: 'thread', id: 'thread-1' },
      ],
    },
    text,
    timestamp: Date.now(),
  };
}

describe('/prompt command', { concurrency: false }, () => {
  beforeEach(() => {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });
  });

  it('sets and shows the prompt for the active scope in the overview', async () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext(makeContext(store));
    const adapter = new FakeAdapter();

    await _testOnly.handleMessage(adapter, makeMessage('/prompt set Thread prompt rules'));
    assert.equal(store.getScopedSystemPrompt('discord:thread:thread-1')?.prompt, 'Thread prompt rules');
    assert.match(adapter.sent[0].text, /已保存当前作用域 Prompt/);
    assert.match(adapter.sent[0].text, /discord:thread:thread-1/);

    await _testOnly.handleMessage(adapter, makeMessage('/prompt'));
    assert.match(adapter.sent[1].text, /当前作用域/);
    assert.match(adapter.sent[1].text, /Thread prompt rules/);
  });

  it('shows inherited scopes in order', async () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext(makeContext(store));
    const adapter = new FakeAdapter();

    await _testOnly.handleMessage(adapter, makeMessage('/prompt'));

    const text = adapter.sent[0].text;
    assert.match(text, /1\. <code>global<\/code>/);
    assert.match(text, /2\. <code>platform:discord<\/code>/);
    assert.match(text, /3\. <code>discord:guild:guild-1<\/code>/);
    assert.match(text, /4\. <code>discord:channel:channel-1<\/code>/);
    assert.match(text, /5\. <code>discord:thread:thread-1<\/code>/);
  });

  it('clears the prompt for the active scope', async () => {
    const store = new JsonFileStore(makeSettings());
    store.upsertScopedSystemPrompt({
      scopeKey: 'discord:thread:thread-1',
      channelType: 'discord',
      scopeType: 'thread',
      prompt: 'Thread prompt rules',
    });
    initBridgeContext(makeContext(store));
    const adapter = new FakeAdapter();

    await _testOnly.handleMessage(adapter, makeMessage('/prompt clear'));

    assert.equal(store.getScopedSystemPrompt('discord:thread:thread-1'), null);
    assert.match(adapter.sent[0].text, /已清空当前作用域 Prompt/);
    assert.match(adapter.sent[0].text, /discord:thread:thread-1/);
  });

  it('returns usage when /prompt set has no text', async () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext(makeContext(store));
    const adapter = new FakeAdapter();

    await _testOnly.handleMessage(adapter, makeMessage('/prompt set'));

    assert.match(adapter.sent[0].text, /未设置 Prompt 内容/);
    assert.match(adapter.sent[0].text, /请在 <code>\/prompt set<\/code> 后面直接写要设置的提示词/);
    assert.match(adapter.sent[0].text, /示例：<code>\/prompt set 请在每次回复结尾加上🐢<\/code>/);
  });

  it('returns clear guidance when /prompt subcommand is invalid', async () => {
    const store = new JsonFileStore(makeSettings());
    initBridgeContext(makeContext(store));
    const adapter = new FakeAdapter();

    await _testOnly.handleMessage(adapter, makeMessage('/prompt nope'));

    assert.match(adapter.sent[0].text, /未识别的 \/prompt 子命令/);
    assert.match(adapter.sent[0].text, /<code>nope<\/code>/);
    assert.match(adapter.sent[0].text, /当前仅支持 <code>\/prompt<\/code>、<code>\/prompt set<\/code>、<code>\/prompt clear<\/code>/);
  });

  it('builds a layered effective prompt with clearer scope separation', async () => {
    const store = new JsonFileStore(makeSettings());
    const session = store.createSession('test', 'test-model', '你是默认系统提示', '/tmp/test-cwd');
    const binding = store.upsertChannelBinding({
      channelType: 'discord',
      chatId: 'thread-1',
      scopeKey: 'discord:thread:thread-1',
      scopeChain: [
        { kind: 'guild', id: 'guild-1' },
        { kind: 'channel', id: 'channel-1' },
        { kind: 'thread', id: 'thread-1' },
      ],
      codepilotSessionId: session.id,
      workingDirectory: '/tmp/test-cwd',
      model: 'test-model',
    });

    store.upsertScopedSystemPrompt({
      scopeKey: 'global',
      channelType: 'global',
      scopeType: 'global',
      prompt: '全局要求A',
    });
    store.upsertScopedSystemPrompt({
      scopeKey: 'platform:discord',
      channelType: 'discord',
      scopeType: 'platform',
      prompt: '平台要求B',
    });
    store.upsertScopedSystemPrompt({
      scopeKey: 'discord:channel:channel-1',
      channelType: 'discord',
      scopeType: 'channel',
      prompt: '频道要求C',
    });
    store.upsertScopedSystemPrompt({
      scopeKey: 'discord:thread:thread-1',
      channelType: 'discord',
      scopeType: 'thread',
      prompt: '子区要求D',
    });

    let capturedParams: StreamChatParams | undefined;
    initBridgeContext({
      store,
      llm: {
        streamChat(params: StreamChatParams): ReadableStream<string> {
          capturedParams = params;
          return new ReadableStream<string>({
            start(controller) {
              controller.enqueue('data: {"type":"text","data":"ok"}\n');
              controller.enqueue('data: {"type":"result","data":"{\"usage\":{\"input_tokens\":1,\"output_tokens\":1},\"is_error\":false}"}\n');
              controller.close();
            },
          });
        },
      },
      permissions: {
        resolvePendingPermission(): boolean {
          return false;
        },
      },
      lifecycle: {},
    });

    const result = await processMessage(binding, '嗨');

    assert.equal(result.responseText, 'ok');
    assert.ok(capturedParams?.systemPrompt);
    assert.match(capturedParams!.systemPrompt!, /你是默认系统提示/);
    assert.match(capturedParams!.systemPrompt!, /以下是当前消息命中的分层规则/);
    assert.match(capturedParams!.systemPrompt!, /【全局规则】\n全局要求A/);
    assert.match(capturedParams!.systemPrompt!, /【平台规则（discord）】\n平台要求B/);
    assert.match(capturedParams!.systemPrompt!, /【频道规则（channel-1）】\n频道要求C/);
    assert.match(capturedParams!.systemPrompt!, /【子区规则（thread-1）】\n子区要求D/);

    const globalIndex = capturedParams!.systemPrompt!.indexOf('【全局规则】');
    const platformIndex = capturedParams!.systemPrompt!.indexOf('【平台规则（discord）】');
    const channelIndex = capturedParams!.systemPrompt!.indexOf('【频道规则（channel-1）】');
    const threadIndex = capturedParams!.systemPrompt!.indexOf('【子区规则（thread-1）】');

    assert.ok(globalIndex >= 0 && platformIndex > globalIndex);
    assert.ok(channelIndex > platformIndex);
    assert.ok(threadIndex > channelIndex);
    assert.match(capturedParams!.systemPrompt!, /如果不同层级存在冲突，以更具体、位置更靠后的规则为准/);
  });
});