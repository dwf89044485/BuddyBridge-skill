/**
 * JSON file-backed BridgeStore implementation.
 *
 * Uses in-memory Maps as cache with write-through persistence
 * to JSON files in ~/.claude-to-im/data/.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  BridgeStore,
  BridgeSession,
  BridgeMessage,
  BridgeApiProvider,
  AuditLogInput,
  PermissionLinkInput,
  PermissionLinkRecord,
  OutboundRefInput,
  UpsertChannelBindingInput,
} from 'claude-to-im/src/lib/bridge/host.js';
import type {
  ChannelBinding,
  ChannelType,
} from 'claude-to-im/src/lib/bridge/types.js';
import { CTI_HOME } from './config.js';

type ScopeRef = {
  kind: string;
  id: string;
};

type ScopedSystemPrompt = {
  id: string;
  scopeKey: string;
  channelType: ChannelType | 'global';
  scopeType: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
};

type UpsertScopedSystemPromptInput = {
  scopeKey: string;
  channelType: string;
  scopeType: string;
  prompt: string;
};

const DATA_DIR = path.join(CTI_HOME, 'data');
const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
const SCOPED_PROMPTS_FILE = path.join(DATA_DIR, 'scoped-system-prompts.json');

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWrite(filePath: string, data: string): void {
  ensureDir(path.dirname(filePath));
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, filePath);
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, data: unknown): void {
  atomicWrite(filePath, JSON.stringify(data, null, 2));
}

function uuid(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

function normalizeScopeChain(scopeChain: ScopeRef[] | undefined, chatId: string): ScopeRef[] {
  if (!scopeChain || scopeChain.length === 0) {
    return [{ kind: 'chat', id: chatId }];
  }

  const normalized = scopeChain
    .filter((item) => item && item.kind && item.id)
    .map((item) => ({ kind: String(item.kind), id: String(item.id) }));

  return normalized.length > 0 ? normalized : [{ kind: 'chat', id: chatId }];
}

function buildInheritedScopeKeys(channelType: string, scopeChain: ScopeRef[], chatId: string): string[] {
  const keys = ['global', `platform:${channelType}`];

  for (const scope of scopeChain) {
    keys.push(`${channelType}:${scope.kind}:${scope.id}`);
  }

  if (scopeChain.length === 0) {
    keys.push(`${channelType}:chat:${chatId}`);
  }

  return keys;
}

function resolveBindingScope(channelType: string, chatId: string, scopeKey?: string, scopeChain?: ScopeRef[]) {
  const normalizedScopeChain = normalizeScopeChain(scopeChain, chatId);
  const inheritedKeys = buildInheritedScopeKeys(channelType, normalizedScopeChain, chatId);
  return {
    scopeChain: normalizedScopeChain,
    scopeKey: scopeKey || inheritedKeys[inheritedKeys.length - 1],
  };
}

function buildBindingStorageKey(channelType: string, chatId: string, scopeKey?: string): string {
  const resolvedScopeKey = scopeKey || resolveBindingScope(channelType, chatId).scopeKey;
  return `${channelType}:${chatId}:${resolvedScopeKey}`;
}

type DirectoryChannelEntry = {
  channelId: string;
  sessionId: string | null;
  sessionPath: string | null;
  imHistoryPath: string | null;
  parentName: string | null;
  guildName: string | null;
  isThread: boolean;
  model: string | null;
  updatedAt: string;
};

type DirectoryDocument = {
  _updated: string;
  _note: string;
  [channelType: string]: unknown;
};

function normalizeName(value?: string | null): string | null {
  const trimmed = (value || '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function sanitizeDirectoryKey(value: string): string {
  return value
    .replace(/[\n\r\t]/g, ' ')
    .replace(/[\\/]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveChannelKey(
  chatId: string,
  channelName: string | null,
  existing: Record<string, DirectoryChannelEntry>,
): string {
  const fallback = chatId.slice(-8) || chatId;
  const base = sanitizeDirectoryKey(channelName || fallback);

  if (!existing[base] || existing[base].channelId === chatId) {
    return base;
  }

  const withSuffix = `${base}_${chatId.slice(0, 8)}`;
  if (!existing[withSuffix] || existing[withSuffix].channelId === chatId) {
    return withSuffix;
  }

  let index = 2;
  while (existing[`${withSuffix}_${index}`] && existing[`${withSuffix}_${index}`].channelId !== chatId) {
    index += 1;
  }
  return `${withSuffix}_${index}`;
}

function deriveCodeBuddyProjectsDir(workingDirectory: string): string {
  const normalized = path.resolve(workingDirectory || process.cwd());
  const workspaceName = path.basename(normalized);
  const home = process.env.HOME || '/root';
  return path.join(home, '.codebuddy', 'projects', `data-${workspaceName}`);
}

interface LockEntry {
  lockId: string;
  owner: string;
  expiresAt: number;
}

export class JsonFileStore implements BridgeStore {
  private settings: Map<string, string>;
  private sessions = new Map<string, BridgeSession>();
  private bindings = new Map<string, ChannelBinding>();
  private scopedPrompts = new Map<string, ScopedSystemPrompt>();
  private messages = new Map<string, BridgeMessage[]>();
  private permissionLinks = new Map<string, PermissionLinkRecord>();
  private offsets = new Map<string, string>();
  private dedupKeys = new Map<string, number>();
  private locks = new Map<string, LockEntry>();
  private auditLog: Array<AuditLogInput & { id: string; createdAt: string }> = [];

  constructor(settingsMap: Map<string, string>) {
    this.settings = settingsMap;
    ensureDir(DATA_DIR);
    ensureDir(MESSAGES_DIR);
    this.loadAll();
  }

  private loadAll(): void {
    const sessions = readJson<Record<string, BridgeSession>>(
      path.join(DATA_DIR, 'sessions.json'),
      {},
    );
    for (const [id, s] of Object.entries(sessions)) {
      this.sessions.set(id, s);
    }

    const bindings = readJson<Record<string, ChannelBinding>>(
      path.join(DATA_DIR, 'bindings.json'),
      {},
    );
    for (const [, binding] of Object.entries(bindings)) {
      const resolved = resolveBindingScope(
        binding.channelType,
        binding.chatId,
        binding.scopeKey,
        binding.scopeChain,
      );
      const normalizedBinding: ChannelBinding = {
        ...binding,
        scopeKey: resolved.scopeKey,
        scopeChain: resolved.scopeChain,
      };
      this.bindings.set(
        buildBindingStorageKey(binding.channelType, binding.chatId, resolved.scopeKey),
        normalizedBinding,
      );
    }

    const scopedPrompts = readJson<Record<string, ScopedSystemPrompt>>(
      SCOPED_PROMPTS_FILE,
      {},
    );
    for (const [scopeKey, prompt] of Object.entries(scopedPrompts)) {
      this.scopedPrompts.set(scopeKey, prompt);
    }

    const perms = readJson<Record<string, PermissionLinkRecord>>(
      path.join(DATA_DIR, 'permissions.json'),
      {},
    );
    for (const [id, p] of Object.entries(perms)) {
      this.permissionLinks.set(id, p);
    }

    const offsets = readJson<Record<string, string>>(
      path.join(DATA_DIR, 'offsets.json'),
      {},
    );
    for (const [k, v] of Object.entries(offsets)) {
      this.offsets.set(k, v);
    }

    const dedup = readJson<Record<string, number>>(
      path.join(DATA_DIR, 'dedup.json'),
      {},
    );
    for (const [k, v] of Object.entries(dedup)) {
      this.dedupKeys.set(k, v);
    }

    this.auditLog = readJson(path.join(DATA_DIR, 'audit.json'), []);
  }

  private persistSessions(): void {
    writeJson(path.join(DATA_DIR, 'sessions.json'), Object.fromEntries(this.sessions));
  }

  private persistBindings(): void {
    writeJson(path.join(DATA_DIR, 'bindings.json'), Object.fromEntries(this.bindings));
    try {
      this.syncDirectory();
    } catch (error) {
      console.warn(
        '[claude-to-im] Failed to sync cross-channel directory:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private syncDirectory(): void {
    const bindings = Array.from(this.bindings.values());

    const preferredRoot = process.env.CTI_DIRECTORY_ROOT
      || this.settings.get('bridge_directory_root')
      || this.settings.get('bridge_default_work_dir')
      || bindings.find((item) => item.workingDirectory)?.workingDirectory
      || process.cwd();

    const sessionsDir = path.join(path.resolve(preferredRoot), '.sessions');
    ensureDir(sessionsDir);

    const directory: DirectoryDocument = {
      _updated: new Date().toISOString(),
      _note: '频道目录。AI 通过此文件查找其他频道的 session。以平台名和频道名为 key，sessionPath 和 imHistoryPath 均为绝对路径，可直接读取。',
    };

    for (const binding of bindings) {
      const channelType = binding.channelType;
      const bucket = (directory[channelType] as Record<string, DirectoryChannelEntry> | undefined) || {};

      const channelName = normalizeName(binding.channelName);
      const key = resolveChannelKey(binding.chatId, channelName, bucket);
      const effectiveSessionId = binding.sdkSessionId || binding.codepilotSessionId || null;
      const projectDir = deriveCodeBuddyProjectsDir(binding.workingDirectory || preferredRoot);

      bucket[key] = {
        channelId: binding.chatId,
        sessionId: effectiveSessionId,
        sessionPath: effectiveSessionId ? path.join(projectDir, `${effectiveSessionId}.jsonl`) : null,
        imHistoryPath: binding.codepilotSessionId
          ? path.join(MESSAGES_DIR, `${binding.codepilotSessionId}.json`)
          : null,
        parentName: normalizeName(binding.parentName),
        guildName: normalizeName(binding.guildName),
        isThread: binding.isThread ?? Boolean(binding.scopeKey?.includes(':thread:')),
        model: normalizeName(binding.model),
        updatedAt: binding.updatedAt,
      };

      directory[channelType] = bucket;
    }

    writeJson(path.join(sessionsDir, 'directory.json'), directory);
  }

  private persistScopedPrompts(): void {
    writeJson(SCOPED_PROMPTS_FILE, Object.fromEntries(this.scopedPrompts));
  }

  private persistPermissions(): void {
    writeJson(path.join(DATA_DIR, 'permissions.json'), Object.fromEntries(this.permissionLinks));
  }

  private persistOffsets(): void {
    writeJson(path.join(DATA_DIR, 'offsets.json'), Object.fromEntries(this.offsets));
  }

  private persistDedup(): void {
    writeJson(path.join(DATA_DIR, 'dedup.json'), Object.fromEntries(this.dedupKeys));
  }

  private persistAudit(): void {
    writeJson(path.join(DATA_DIR, 'audit.json'), this.auditLog);
  }

  private persistMessages(sessionId: string): void {
    const msgs = this.messages.get(sessionId) || [];
    writeJson(path.join(MESSAGES_DIR, `${sessionId}.json`), msgs);
  }

  private loadMessages(sessionId: string): BridgeMessage[] {
    if (this.messages.has(sessionId)) {
      return this.messages.get(sessionId)!;
    }
    const msgs = readJson<BridgeMessage[]>(path.join(MESSAGES_DIR, `${sessionId}.json`), []);
    this.messages.set(sessionId, msgs);
    return msgs;
  }

  getSetting(key: string): string | null {
    return this.settings.get(key) ?? null;
  }

  getChannelBinding(channelType: string, chatId: string, scopeKey?: string): ChannelBinding | null {
    return this.bindings.get(buildBindingStorageKey(channelType, chatId, scopeKey)) ?? null;
  }

  upsertChannelBinding(data: UpsertChannelBindingInput): ChannelBinding {
    const resolved = resolveBindingScope(data.channelType, data.chatId, data.scopeKey, data.scopeChain);
    const key = buildBindingStorageKey(data.channelType, data.chatId, resolved.scopeKey);
    const existing = this.bindings.get(key);

    if (existing) {
      const updated: ChannelBinding = {
        ...existing,
        channelName: data.channelName !== undefined ? normalizeName(data.channelName) : existing.channelName ?? null,
        parentName: data.parentName !== undefined ? normalizeName(data.parentName) : existing.parentName ?? null,
        guildName: data.guildName !== undefined ? normalizeName(data.guildName) : existing.guildName ?? null,
        isThread: data.isThread !== undefined ? Boolean(data.isThread) : existing.isThread ?? false,
        scopeKey: resolved.scopeKey,
        scopeChain: resolved.scopeChain,
        codepilotSessionId: data.codepilotSessionId,
        sdkSessionId: data.sdkSessionId !== undefined ? data.sdkSessionId : existing.sdkSessionId,
        workingDirectory: data.workingDirectory,
        model: data.model,
        runtime: data.runtime !== undefined ? data.runtime : existing.runtime,
        updatedAt: now(),
      };
      this.bindings.set(key, updated);
      this.persistBindings();
      return updated;
    }

    const binding: ChannelBinding = {
      id: uuid(),
      channelType: data.channelType,
      chatId: data.chatId,
      channelName: normalizeName(data.channelName),
      parentName: normalizeName(data.parentName),
      guildName: normalizeName(data.guildName),
      isThread: Boolean(data.isThread),
      scopeKey: resolved.scopeKey,
      scopeChain: resolved.scopeChain,
      codepilotSessionId: data.codepilotSessionId,
      sdkSessionId: '',
      workingDirectory: data.workingDirectory,
      model: data.model,
      mode: (this.settings.get('bridge_default_mode') as 'code' | 'plan' | 'ask') || 'code',
      runtime: data.runtime,
      active: true,
      createdAt: now(),
      updatedAt: now(),
    };
    this.bindings.set(key, binding);
    this.persistBindings();
    return binding;
  }

  updateChannelBinding(id: string, updates: Partial<ChannelBinding>): void {
    for (const [key, binding] of this.bindings) {
      if (binding.id === id) {
        this.bindings.set(key, { ...binding, ...updates, updatedAt: now() });
        this.persistBindings();
        break;
      }
    }
  }

  listChannelBindings(channelType?: ChannelType): ChannelBinding[] {
    const all = Array.from(this.bindings.values());
    if (!channelType) return all;
    return all.filter((binding) => binding.channelType === channelType);
  }

  getScopedSystemPrompt(scopeKey: string): ScopedSystemPrompt | null {
    return this.scopedPrompts.get(scopeKey) ?? null;
  }

  upsertScopedSystemPrompt(data: UpsertScopedSystemPromptInput): ScopedSystemPrompt {
    const existing = this.scopedPrompts.get(data.scopeKey);
    if (existing) {
      const updated: ScopedSystemPrompt = {
        ...existing,
        channelType: data.channelType as ChannelType | 'global',
        scopeType: data.scopeType,
        prompt: data.prompt,
        updatedAt: now(),
      };
      this.scopedPrompts.set(data.scopeKey, updated);
      this.persistScopedPrompts();
      return updated;
    }

    const prompt: ScopedSystemPrompt = {
      id: uuid(),
      scopeKey: data.scopeKey,
      channelType: data.channelType as ChannelType | 'global',
      scopeType: data.scopeType,
      prompt: data.prompt,
      createdAt: now(),
      updatedAt: now(),
    };
    this.scopedPrompts.set(data.scopeKey, prompt);
    this.persistScopedPrompts();
    return prompt;
  }

  deleteScopedSystemPrompt(scopeKey: string): boolean {
    const deleted = this.scopedPrompts.delete(scopeKey);
    if (deleted) {
      this.persistScopedPrompts();
    }
    return deleted;
  }

  listScopedSystemPrompts(channelType?: string): ScopedSystemPrompt[] {
    const all = Array.from(this.scopedPrompts.values());
    if (!channelType) return all;
    return all.filter((prompt) => prompt.channelType === channelType || prompt.channelType === 'global');
  }

  getSession(id: string): BridgeSession | null {
    return this.sessions.get(id) ?? null;
  }

  createSession(
    _name: string,
    model: string,
    systemPrompt?: string,
    cwd?: string,
    _mode?: string,
  ): BridgeSession {
    const session: BridgeSession = {
      id: uuid(),
      working_directory: cwd || this.settings.get('bridge_default_work_dir') || process.cwd(),
      model,
      system_prompt: systemPrompt,
    };
    this.sessions.set(session.id, session);
    this.persistSessions();
    return session;
  }

  updateSessionProviderId(sessionId: string, providerId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.provider_id = providerId;
      this.persistSessions();
    }
  }

  clearSessionMessages(sessionId: string): void {
    this.messages.set(sessionId, []);
    this.persistMessages(sessionId);
  }

  deleteSession(sessionId: string): boolean {
    const existed = this.sessions.has(sessionId);
    if (existed) {
      this.sessions.delete(sessionId);
      this.persistSessions();
    }
    // Also clean up messages
    this.messages.delete(sessionId);
    const msgFile = path.join(MESSAGES_DIR, `${sessionId}.json`);
    try { fs.unlinkSync(msgFile); } catch { /* file may not exist */ }
    return existed;
  }

  addMessage(sessionId: string, role: string, content: string, _usage?: string | null): void {
    const messages = this.loadMessages(sessionId);
    messages.push({ role, content });
    this.persistMessages(sessionId);
  }

  getMessages(sessionId: string, opts?: { limit?: number }): { messages: BridgeMessage[] } {
    const messages = this.loadMessages(sessionId);
    if (opts?.limit && opts.limit > 0) {
      return { messages: messages.slice(-opts.limit) };
    }
    return { messages: [...messages] };
  }

  acquireSessionLock(sessionId: string, lockId: string, owner: string, ttlSecs: number): boolean {
    const existing = this.locks.get(sessionId);
    if (existing && existing.expiresAt > Date.now()) {
      if (existing.lockId !== lockId) return false;
    }
    this.locks.set(sessionId, {
      lockId,
      owner,
      expiresAt: Date.now() + ttlSecs * 1000,
    });
    return true;
  }

  renewSessionLock(sessionId: string, lockId: string, ttlSecs: number): void {
    const lock = this.locks.get(sessionId);
    if (lock && lock.lockId === lockId) {
      lock.expiresAt = Date.now() + ttlSecs * 1000;
    }
  }

  releaseSessionLock(sessionId: string, lockId: string): void {
    const lock = this.locks.get(sessionId);
    if (lock && lock.lockId === lockId) {
      this.locks.delete(sessionId);
    }
  }

  setSessionRuntimeStatus(_sessionId: string, _status: string): void {
    // no-op for file-based store
  }

  updateSdkSessionId(sessionId: string, sdkSessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      (session as unknown as Record<string, unknown>)['sdk_session_id'] = sdkSessionId;
      this.persistSessions();
    }
    for (const [key, binding] of this.bindings) {
      if (binding.codepilotSessionId === sessionId) {
        this.bindings.set(key, { ...binding, sdkSessionId, updatedAt: now() });
      }
    }
    this.persistBindings();
  }

  updateSessionModel(sessionId: string, model: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.model = model;
      this.persistSessions();
    }
  }

  syncSdkTasks(_sessionId: string, _todos: unknown): void {
    // no-op
  }

  getProvider(_id: string): BridgeApiProvider | undefined {
    return undefined;
  }

  getDefaultProviderId(): string | null {
    return null;
  }

  insertAuditLog(entry: AuditLogInput): void {
    this.auditLog.push({
      ...entry,
      id: uuid(),
      createdAt: now(),
    });
    if (this.auditLog.length > 1000) {
      this.auditLog = this.auditLog.slice(-1000);
    }
    this.persistAudit();
  }

  checkDedup(key: string): boolean {
    const timestamp = this.dedupKeys.get(key);
    if (timestamp === undefined) return false;
    if (Date.now() - timestamp > 5 * 60 * 1000) {
      this.dedupKeys.delete(key);
      return false;
    }
    return true;
  }

  insertDedup(key: string): void {
    this.dedupKeys.set(key, Date.now());
    this.persistDedup();
  }

  cleanupExpiredDedup(): void {
    const cutoff = Date.now() - 5 * 60 * 1000;
    let changed = false;
    for (const [key, timestamp] of this.dedupKeys) {
      if (timestamp < cutoff) {
        this.dedupKeys.delete(key);
        changed = true;
      }
    }
    if (changed) this.persistDedup();
  }

  insertOutboundRef(_ref: OutboundRefInput): void {
    // no-op for file-based store
  }

  insertPermissionLink(link: PermissionLinkInput): void {
    const record: PermissionLinkRecord = {
      permissionRequestId: link.permissionRequestId,
      chatId: link.chatId,
      messageId: link.messageId,
      resolved: false,
      suggestions: link.suggestions,
    };
    this.permissionLinks.set(link.permissionRequestId, record);
    this.persistPermissions();
  }

  getPermissionLink(permissionRequestId: string): PermissionLinkRecord | null {
    return this.permissionLinks.get(permissionRequestId) ?? null;
  }

  markPermissionLinkResolved(permissionRequestId: string): boolean {
    const link = this.permissionLinks.get(permissionRequestId);
    if (!link || link.resolved) return false;
    link.resolved = true;
    this.persistPermissions();
    return true;
  }

  listPendingPermissionLinksByChat(chatId: string): PermissionLinkRecord[] {
    const result: PermissionLinkRecord[] = [];
    for (const link of this.permissionLinks.values()) {
      if (link.chatId === chatId && !link.resolved) {
        result.push(link);
      }
    }
    return result;
  }

  getChannelOffset(key: string): string {
    return this.offsets.get(key) ?? '0';
  }

  setChannelOffset(key: string, offset: string): void {
    this.offsets.set(key, offset);
    this.persistOffsets();
  }
}
