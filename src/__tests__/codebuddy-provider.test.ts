import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { _testOnly } from '../codebuddy-provider.js';

describe('CodeBuddyProvider helpers', () => {
  it('appends layered system prompt via CLI flag', () => {
    const args = _testOnly.buildArgs({
      prompt: '用户问题',
      sessionId: 'session-1',
      permissionMode: 'acceptEdits',
      model: 'codebuddy-model',
      systemPrompt: '【频道规则】\n结尾带🐢',
    });

    const appendIndex = args.indexOf('--append-system-prompt');
    assert.ok(appendIndex >= 0, 'Should include --append-system-prompt');
    assert.equal(args[appendIndex + 1], '【频道规则】\n结尾带🐢');
    assert.equal(args.at(-1), '用户问题');
  });

  it('omits append flag when system prompt is empty', () => {
    const args = _testOnly.buildArgs({
      prompt: '用户问题',
      sessionId: 'session-2',
      systemPrompt: '   ',
    });

    assert.equal(args.includes('--append-system-prompt'), false);
  });

  it('requires append-system-prompt support in preflight flags', () => {
    assert.ok(_testOnly.requiredFlags.includes('--append-system-prompt'));
  });

  it('appends local attachment file instructions into the prompt', () => {
    const prompt = _testOnly.buildPrompt({
      prompt: '请分析附件',
      sessionId: 'session-3',
      files: [{
        id: 'file-1',
        name: '需求文档.pdf',
        type: 'application/pdf',
        size: 12,
        data: 'cGRm',
        filePath: '/tmp/uploads/需求文档.pdf',
      }],
    });

    assert.equal(
      prompt,
      '请分析附件\n\n[System note: The user attached 1 file(s) that have been saved into the working directory for you.]\nRead the relevant files directly from these local paths before answering or modifying code:\n1. 需求文档.pdf | application/pdf | 12 bytes\n   Path: "/tmp/uploads/需求文档.pdf"',
    );
  });

  it('does not append local attachment instructions for image-only attachments', () => {
    const prompt = _testOnly.buildPrompt({
      prompt: '请看这张图',
      sessionId: 'session-4',
      files: [{
        id: 'image-1',
        name: '示意图.png',
        type: 'image/png',
        size: 12,
        data: 'cG5n',
        filePath: '/tmp/uploads/示意图.png',
      }],
    });

    assert.equal(prompt, '请看这张图');
  });
});