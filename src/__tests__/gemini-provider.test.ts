import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGeminiArgs,
  buildGeminiPromptText,
  isGeminiModelName,
  normalizeGeminiToolName,
  shouldRetryFreshGeminiSession,
} from '../gemini-provider.js';

describe('GeminiProvider helpers', () => {
  afterEach(() => {
    delete process.env.CTI_GEMINI_PROMPT_PREAMBLE_FILE;
    delete process.env.CTI_CODEX_PROMPT_PREAMBLE_FILE;
    delete process.env.CTI_MATLAB_BRIDGE_PATH;
    delete process.env.CTI_GEMINI_ADDITIONAL_DIRECTORIES;
  });

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

  it('prepends prompt preamble and session instructions', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-gemini-preamble-'));
    try {
      const preambleFile = path.join(tempDir, 'preamble.md');
      fs.writeFileSync(preambleFile, 'Use `{{CTI_MATLAB_BRIDGE_PATH}}` only.');
      process.env.CTI_GEMINI_PROMPT_PREAMBLE_FILE = preambleFile;
      process.env.CTI_MATLAB_BRIDGE_PATH = '/tmp/matlab-bridge.sh';

      assert.equal(
        buildGeminiPromptText('Run the check.', 'Stay concise.'),
        'Use `/tmp/matlab-bridge.sh` only.\n\nSession instructions:\nStay concise.\n\nRun the check.'
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('builds gemini args with include directories and strips stale foreign resume sessions', () => {
    process.env.CTI_GEMINI_ADDITIONAL_DIRECTORIES = '/tmp/one,/tmp/two';

    const params = {
      prompt: 'hello',
      model: 'gemini-3.1-pro-preview',
      workingDirectory: '/tmp/work',
      sdkSessionId: 'old-session-id',
      systemPrompt: 'Be concise.',
    } as const;
    const staleModelParams = {
      prompt: 'hello',
      model: 'claude-sonnet-4-6',
      workingDirectory: '/tmp/work',
      sdkSessionId: 'old-session-id',
      systemPrompt: undefined,
    } as const;

    assert.deepEqual(buildGeminiArgs(params), [
      '-p', 'Session instructions:\nBe concise.\n\nhello', '--yolo', '-o', 'stream-json',
      '-m', 'gemini-3.1-pro-preview',
      '--include-directories', '/tmp/work',
      '--include-directories', '/tmp/one',
      '--include-directories', '/tmp/two',
      '--resume', 'old-session-id',
    ]);

    assert.deepEqual(buildGeminiArgs(params, { resumeSessionId: undefined }), [
      '-p', 'Session instructions:\nBe concise.\n\nhello', '--yolo', '-o', 'stream-json',
      '-m', 'gemini-3.1-pro-preview',
      '--include-directories', '/tmp/work',
      '--include-directories', '/tmp/one',
      '--include-directories', '/tmp/two',
    ]);

    assert.deepEqual(buildGeminiArgs(staleModelParams), [
      '-p', 'hello', '--yolo', '-o', 'stream-json',
      '--include-directories', '/tmp/work',
      '--include-directories', '/tmp/one',
      '--include-directories', '/tmp/two',
    ]);
  });
});
