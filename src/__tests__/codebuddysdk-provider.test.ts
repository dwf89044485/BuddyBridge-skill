import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { _testOnly } from '../codebuddysdk-provider.js';

function makeFile(type: string, data = 'ZmFrZQ==', name = 'file.bin') {
  return {
    id: `${name}-${type}`,
    type,
    data,
    name,
    size: Buffer.from(data, 'base64').length,
    filePath: `/tmp/uploads/${name}`,
  };
}

describe('CodeBuddySDKProvider buildPrompt', () => {
  it('returns plain string when no attachments are present', () => {
    const prompt = _testOnly.buildPrompt({
      prompt: '请分析这段代码',
      sessionId: 'session-1',
    });

    assert.equal(prompt, '请分析这段代码');
  });

  it('builds async iterable multimodal prompt for text plus one image', async () => {
    const prompt = _testOnly.buildPrompt({
      prompt: '请描述这张图片',
      sessionId: 'session-2',
      files: [makeFile('image/png', 'cG5n', 'demo.png')],
    });

    assert.equal(typeof prompt, 'object');
    assert.ok(prompt);
    assert.ok(Symbol.asyncIterator in (prompt as object));

    const messages: unknown[] = [];
    for await (const item of prompt as AsyncIterable<unknown>) {
      messages.push(item);
    }

    assert.equal(messages.length, 1);
    const message = messages[0] as {
      type: string;
      message: { role: string; content: Array<Record<string, unknown>> };
      parent_tool_use_id: null;
      session_id: string;
    };

    assert.equal(message.type, 'user');
    assert.equal(message.message.role, 'user');
    assert.equal(message.parent_tool_use_id, null);
    assert.equal(message.session_id, '');
    assert.equal(message.message.content.length, 2);
    assert.deepEqual(message.message.content[0], {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: 'cG5n',
      },
    });
    assert.deepEqual(message.message.content[1], {
      type: 'text',
      text: '请描述这张图片',
    });
  });

  it('normalizes image/jpg to image/jpeg', async () => {
    const prompt = _testOnly.buildPrompt({
      prompt: '看看这张 JPG 图片',
      sessionId: 'session-3',
      files: [makeFile('image/jpg', 'anBn', 'demo.jpg')],
    });

    const messages: unknown[] = [];
    for await (const item of prompt as AsyncIterable<unknown>) {
      messages.push(item);
    }

    const message = messages[0] as {
      message: { content: Array<Record<string, unknown>> };
    };
    assert.deepEqual(message.message.content[0], {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: 'anBn',
      },
    });
  });

  it('includes multiple images and appends local file instructions for non-image attachments', async () => {
    const prompt = _testOnly.buildPrompt({
      prompt: '请同时分析这些附件',
      sessionId: 'session-4',
      files: [
        makeFile('image/png', 'cG5n', 'a.png'),
        makeFile('application/pdf', 'cGRm', 'a.pdf'),
        makeFile('image/webp', 'd2VicA==', 'b.webp'),
      ],
    });

    const messages: unknown[] = [];
    for await (const item of prompt as AsyncIterable<unknown>) {
      messages.push(item);
    }

    const message = messages[0] as {
      message: { content: Array<Record<string, unknown>> };
    };
    assert.equal(message.message.content.length, 3);
    assert.deepEqual(message.message.content[0], {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: 'cG5n',
      },
    });
    assert.deepEqual(message.message.content[1], {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/webp',
        data: 'd2VicA==',
      },
    });
    assert.deepEqual(message.message.content[2], {
      type: 'text',
      text: '请同时分析这些附件\n\n[System note: The user attached 1 file(s) that have been saved into the working directory for you.]\nRead the relevant files directly from these local paths before answering or modifying code:\n1. a.pdf | application/pdf | 3 bytes\n   Path: "/tmp/uploads/a.pdf"',
    });
  });

  it('returns text with local file instructions when only non-image attachments are present', () => {
    const prompt = _testOnly.buildPrompt({
      prompt: '请总结这个文件',
      sessionId: 'session-5',
      files: [
        makeFile('application/pdf', 'cGRm', 'a.pdf'),
        makeFile('text/plain', 'dHh0', 'a.txt'),
      ],
    });

    assert.equal(
      prompt,
      '请总结这个文件\n\n[System note: The user attached 2 file(s) that have been saved into the working directory for you.]\nRead the relevant files directly from these local paths before answering or modifying code:\n1. a.pdf | application/pdf | 3 bytes\n   Path: "/tmp/uploads/a.pdf"\n2. a.txt | text/plain | 3 bytes\n   Path: "/tmp/uploads/a.txt"',
    );
  });

  it('keeps local file instructions without leading blank line when prompt text is empty', () => {
    const prompt = _testOnly.buildPrompt({
      prompt: '   ',
      sessionId: 'session-6',
      files: [makeFile('application/pdf', 'cGRm', 'a.pdf')],
    });

    assert.equal(
      prompt,
      '   [System note: The user attached 1 file(s) that have been saved into the working directory for you.]\nRead the relevant files directly from these local paths before answering or modifying code:\n1. a.pdf | application/pdf | 3 bytes\n   Path: "/tmp/uploads/a.pdf"',
    );
  });

  it('falls back to inaccessible attachment note when file path is missing', () => {
    const prompt = _testOnly.buildPrompt({
      prompt: '请总结这个文件',
      sessionId: 'session-7',
      files: [{ ...makeFile('application/pdf', 'cGRm', 'a.pdf'), filePath: undefined }],
    });

    assert.equal(
      prompt,
      '请总结这个文件\n\n[System note: 1 attachment(s) could not be written to a local path, so inspect them only if their content is already present elsewhere in the conversation.]',
    );
  });
});

describe('classifyCodeBuddyAuthError', () => {
  const { classifyCodeBuddyAuthError } = _testOnly;

  it('returns "cli" for not-logged-in patterns', () => {
    assert.equal(classifyCodeBuddyAuthError('Error: not logged in. Please run /login'), 'cli');
    assert.equal(classifyCodeBuddyAuthError('Error: loggedIn false'), 'cli');
    assert.equal(classifyCodeBuddyAuthError("please run '/login' to authenticate"), 'cli');
  });

  it('returns "api" for credential/permission patterns', () => {
    assert.equal(classifyCodeBuddyAuthError('unauthorized: invalid API key'), 'api');
    assert.equal(classifyCodeBuddyAuthError('Authentication failed for request'), 'api');
    assert.equal(classifyCodeBuddyAuthError('Your organization does not have access'), 'api');
    assert.equal(classifyCodeBuddyAuthError('HTTP 401 Unauthorized'), 'api');
  });

  it('returns "quota" for rate-limit/quota patterns', () => {
    assert.equal(classifyCodeBuddyAuthError('quota exceeded for this model'), 'quota');
    assert.equal(classifyCodeBuddyAuthError('rate limit: too many requests'), 'quota');
    assert.equal(classifyCodeBuddyAuthError('Insufficient quota remaining'), 'quota');
    assert.equal(classifyCodeBuddyAuthError('Error: too many requests'), 'quota');
  });

  it('returns false for non-auth errors', () => {
    assert.equal(classifyCodeBuddyAuthError('file not found: /tmp/foo.ts'), false);
    assert.equal(classifyCodeBuddyAuthError('process exited with code 1'), false);
    assert.equal(classifyCodeBuddyAuthError(''), false);
  });
});