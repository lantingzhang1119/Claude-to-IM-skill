import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGeminiArgs,
  isGeminiModelName,
  normalizeGeminiToolName,
  shouldRetryFreshGeminiSession,
} from '../gemini-provider.js';

describe('GeminiProvider helpers', () => {
  it('maps file edit tools to Edit', () => {
    assert.equal(normalizeGeminiToolName('edit_file'), 'Edit');
    assert.equal(normalizeGeminiToolName('write_file'), 'Edit');
    assert.equal(normalizeGeminiToolName('replace_file_content'), 'Edit');
    assert.equal(normalizeGeminiToolName('multi_replace_file_content'), 'Edit');
  });

  it('maps non-edit tools to Bash', () => {
    assert.equal(normalizeGeminiToolName('search_web'), 'Bash');
    assert.equal(normalizeGeminiToolName('read_url_content'), 'Bash');
    assert.equal(normalizeGeminiToolName(undefined), 'Bash');
  });

  it('detects invalid resume session errors', () => {
    const stderr = 'Error resuming session: Invalid session identifier "019cc753-0bba-7130-80fb-404fc3540d99".';
    assert.equal(shouldRetryFreshGeminiSession(stderr), true);
    assert.equal(shouldRetryFreshGeminiSession('network timeout'), false);
  });

  it('recognizes gemini model names only', () => {
    assert.equal(isGeminiModelName('gemini-3.1-pro-preview'), true);
    assert.equal(isGeminiModelName('auto-gemini-3'), true);
    assert.equal(isGeminiModelName('google/gemini-2.5-flash'), true);
    assert.equal(isGeminiModelName('claude-sonnet-4-6'), false);
    assert.equal(isGeminiModelName('gpt-5.3-codex'), false);
  });

  it('builds gemini args and strips resume on retry', () => {
    const params = {
      prompt: 'hello',
      model: 'gemini-3.1-pro-preview',
      workingDirectory: '/tmp/work',
      sdkSessionId: 'old-session-id',
    } as const;
    const staleModelParams = {
      prompt: 'hello',
      model: 'claude-sonnet-4-6',
      workingDirectory: '/tmp/work',
      sdkSessionId: 'old-session-id',
    } as const;

    assert.deepEqual(buildGeminiArgs(params), [
      '-p', 'hello', '--yolo', '-o', 'stream-json',
      '-m', 'gemini-3.1-pro-preview',
      '--include-directories', '/tmp/work',
      '--resume', 'old-session-id',
    ]);

    assert.deepEqual(buildGeminiArgs(params, { resumeSessionId: undefined }), [
      '-p', 'hello', '--yolo', '-o', 'stream-json',
      '-m', 'gemini-3.1-pro-preview',
      '--include-directories', '/tmp/work',
    ]);

    assert.deepEqual(buildGeminiArgs(staleModelParams), [
      '-p', 'hello', '--yolo', '-o', 'stream-json',
      '--include-directories', '/tmp/work',
      '--resume', 'old-session-id',
    ]);
  });
});
