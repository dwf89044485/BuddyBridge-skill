import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRuntime } from '../config.js';

describe('runtime chain semantics', () => {
  it('normalizes codebuddy-family values to codebuddy runtime', () => {
    assert.equal(normalizeRuntime('codebuddy'), 'codebuddy');
    assert.equal(normalizeRuntime('codebuddysdk'), 'codebuddy');
    assert.equal(normalizeRuntime('auto'), 'codebuddy');
  });

  it('normalizes claude-family values to claude runtime', () => {
    assert.equal(normalizeRuntime('claude'), 'claude');
    assert.equal(normalizeRuntime('persistent-claude'), 'claude');
  });

  it('keeps codex runtime unchanged', () => {
    assert.equal(normalizeRuntime('codex'), 'codex');
  });
});
