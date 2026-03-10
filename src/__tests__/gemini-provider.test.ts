import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGeminiArgs,
  buildGeminiPromptText,
  formatGeminiCliError,
  getGeminiFallbackModels,
  getGeminiStartTimeoutMs,
  isGeminiCapacityError,
  isGeminiModelName,
  isGeminiQuotaError,
  normalizeGeminiToolName,
  shouldRetryFreshGeminiSession,
  shouldRetryFreshGeminiSessionTimeout,
} from '../gemini-provider.js';

describe('GeminiProvider helpers', () => {
  afterEach(() => {
    delete process.env.CTI_GEMINI_PROMPT_PREAMBLE_FILE;
    delete process.env.CTI_CODEX_PROMPT_PREAMBLE_FILE;
    delete process.env.CTI_MATLAB_BRIDGE_PATH;
    delete process.env.CTI_GEMINI_ADDITIONAL_DIRECTORIES;
    delete process.env.CTI_GEMINI_FALLBACK_MODELS;
    delete process.env.CTI_GEMINI_START_TIMEOUT_MS;
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

  it('detects invalid or missing resume session errors', () => {
    const invalidSession = 'Error resuming session: Invalid session identifier "019cc753-0bba-7130-80fb-404fc3540d99".';
    const missingProjectSession = 'Error resuming session: No previous sessions found for this project.';
    assert.equal(shouldRetryFreshGeminiSession(invalidSession), true);
    assert.equal(shouldRetryFreshGeminiSession(missingProjectSession), true);
    assert.equal(shouldRetryFreshGeminiSession('network timeout'), false);
  });

  it('detects timeout-shaped stuck resume outcomes', () => {
    assert.equal(shouldRetryFreshGeminiSessionTimeout({
      exitCode: null,
      stderrText: 'Gemini CLI timed out waiting for model output after 20000ms',
      sawResult: false,
      sawOutput: false,
      sessionId: 'abc',
      timedOut: true,
      timeoutMs: 20000,
    }), true);

    assert.equal(shouldRetryFreshGeminiSessionTimeout({
      exitCode: null,
      stderrText: 'Gemini CLI timed out waiting for model output after 20000ms',
      sawResult: false,
      sawOutput: true,
      sessionId: 'abc',
      timedOut: true,
      timeoutMs: 20000,
    }), false);
  });

  it('recognizes gemini model names only', () => {
    assert.equal(isGeminiModelName('gemini-3.1-pro-preview'), true);
    assert.equal(isGeminiModelName('auto-gemini-3'), true);
    assert.equal(isGeminiModelName('google/gemini-2.5-flash'), true);
    assert.equal(isGeminiModelName('claude-sonnet-4-6'), false);
    assert.equal(isGeminiModelName('gpt-5.3-codex'), false);
  });

  it('reads startup timeout from env with sane fallback', () => {
    assert.equal(getGeminiStartTimeoutMs(), 20000);
    process.env.CTI_GEMINI_START_TIMEOUT_MS = '45000';
    assert.equal(getGeminiStartTimeoutMs(), 45000);
    process.env.CTI_GEMINI_START_TIMEOUT_MS = 'bad';
    assert.equal(getGeminiStartTimeoutMs(), 20000);
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

  it('detects capacity errors and returns a Telegram-safe message', () => {
    const stderr = [
      'YOLO mode is enabled. All tool calls will be automatically approved.',
      'Loaded cached credentials.',
      'Attempt 1 failed with status 429. Retrying with backoff... GaxiosError: [{',
      '  "error": {',
      '    "message": "No capacity available for model gemini-3.1-pro-preview on the server"',
      '  }',
      '}]',
      'RetryableQuotaError: No capacity available for model gemini-3.1-pro-preview on the server',
    ].join('\n');

    assert.equal(isGeminiCapacityError(stderr), true);
    assert.equal(
      formatGeminiCliError(stderr, { requestedModel: 'gemini-3.1-pro-preview' }),
      'Gemini 上游当前容量不足（模型 gemini-3.1-pro-preview），本次请求未完成。请稍后再试；如需更稳，可切换到 gemini-2.5-pro 或 gemini-2.5-flash。'
    );
  });

  it('detects quota exhaustion and returns a short recovery hint', () => {
    const stderr = [
      'Error when talking to Gemini API Full report available at: /tmp/some-report.json',
      'TerminalQuotaError: You have exhausted your capacity on this model. Your quota will reset after 16h28m17s.',
    ].join('\n');

    assert.equal(isGeminiQuotaError(stderr), true);
    assert.equal(
      formatGeminiCliError(stderr, { requestedModel: 'gemini-3.1-pro-preview' }),
      'Gemini 当前模型配额已耗尽（模型 gemini-3.1-pro-preview）。请等待额度恢复，或切换到 gemini-2.5-pro / gemini-2.5-flash。'
    );
  });

  it('formats startup timeout errors without leaking raw process noise', () => {
    const stderr = 'Gemini CLI timed out waiting for model output after 20000ms';
    assert.equal(
      formatGeminiCliError(stderr, { timedOut: true, timeoutMs: 20000 }),
      'Gemini 会话启动超时（>20000ms 无模型输出）。系统会优先丢弃卡住的旧会话；请重试一次。'
    );
  });

  it('derives sensible fallback models for preview traffic', () => {
    assert.deepEqual(getGeminiFallbackModels('gemini-3.1-pro-preview'), [
      'gemini-2.5-pro',
      'gemini-2.5-flash',
    ]);
  });

  it('prefers configured fallback models and drops non-gemini entries', () => {
    process.env.CTI_GEMINI_FALLBACK_MODELS = 'gemini-2.5-pro, claude-sonnet-4-6, gemini-2.5-flash, gemini-2.5-pro';

    assert.deepEqual(getGeminiFallbackModels('gemini-3.1-pro-preview'), [
      'gemini-2.5-pro',
      'gemini-2.5-flash',
    ]);
  });

  it('summarizes model-not-found errors without exposing the full stack', () => {
    const stderr = [
      'YOLO mode is enabled. All tool calls will be automatically approved.',
      'Error when talking to Gemini API Full report available at: /tmp/some-report.json',
      'ModelNotFoundError: Requested entity was not found.',
      '    at GeminiChat.makeApiCallAndProcessStream (...)',
    ].join('\n');

    assert.equal(
      formatGeminiCliError(stderr, { requestedModel: 'gemini-3.1-pro-preview' }),
      'Gemini 模型不可用或当前账号无权访问：gemini-3.1-pro-preview。请检查 CTI_DEFAULT_MODEL 和 CTI_GEMINI_FALLBACK_MODELS。'
    );
  });
});
