import fs from 'node:fs';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

import type { LLMProvider, StreamChatParams } from 'claude-to-im/src/lib/bridge/host.js';
import type { PendingPermissions } from './permission-gateway.js';
import { sseEvent } from './sse-utils.js';

const GEMINI_FILE_EDIT_TOOLS = new Set([
  'edit_file',
  'write_file',
  'replace_file_content',
  'multi_replace_file_content',
]);
const DEFAULT_PREVIEW_FALLBACK_MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash'];
const DEFAULT_GEMINI_START_TIMEOUT_MS = 20000;
const GEMINI_FORCE_KILL_AFTER_MS = 5000;
const GEMINI_STDERR_NOISE_PATTERNS = [
  /^YOLO mode is enabled\./i,
  /^Loaded cached credentials\./i,
  /^Attempt\s+\d+\s+failed/i,
  /^Full report available at:/i,
  /^at\s+/i,
  /^\[cause\]:/i,
  /^config:\s*\{/i,
  /^response:\s*Response\s*\{/i,
  /^params:\s*\[Object\]/i,
  /^headers:\s*Headers\s*\{/i,
  /^Symbol\(/,
  /^\}/,
  /^\{$/,
  /^\],?$/,
  /^\],$/,
];

function parseListEnv(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function renderEnvTemplate(text: string): string {
  return text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, name) => process.env[name] || '');
}

function loadPromptPreamble(): string {
  const inline = process.env.CTI_GEMINI_PROMPT_PREAMBLE?.trim()
    || process.env.CTI_CODEX_PROMPT_PREAMBLE?.trim();
  if (inline) return renderEnvTemplate(inline);

  const file = process.env.CTI_GEMINI_PROMPT_PREAMBLE_FILE?.trim()
    || process.env.CTI_CODEX_PROMPT_PREAMBLE_FILE?.trim();
  if (!file) return '';

  try {
    return renderEnvTemplate(fs.readFileSync(file, 'utf-8').trim());
  } catch (err) {
    console.warn(`[gemini-provider] Failed to read prompt preamble file: ${file}`, err);
    return '';
  }
}

export function getGeminiStartTimeoutMs(): number {
  return parsePositiveIntEnv('CTI_GEMINI_START_TIMEOUT_MS', DEFAULT_GEMINI_START_TIMEOUT_MS);
}

export function buildGeminiPromptText(prompt: string, systemPrompt?: string): string {
  const sections: string[] = [];
  const preamble = loadPromptPreamble();
  if (preamble) sections.push(preamble);
  if (systemPrompt?.trim()) sections.push(`Session instructions:\n${systemPrompt.trim()}`);
  sections.push(prompt);
  return sections.join('\n\n');
}

export function normalizeGeminiToolName(toolName: string | undefined): string {
  if (!toolName) return 'Bash';
  if (GEMINI_FILE_EDIT_TOOLS.has(toolName)) return 'Edit';
  return 'Bash';
}

export function shouldRetryFreshGeminiSession(stderrText: string): boolean {
  return /Error\s+resuming\s+session:\s+(?:Invalid\s+session\s+identifier|No previous sessions found for this project)/i.test(stderrText);
}

export function isGeminiModelName(model: string | undefined): boolean {
  if (!model) return false;
  return /(^|\/)gemini([-.]|$)|^auto-gemini-/i.test(model);
}

export function isGeminiCapacityError(stderrText: string): boolean {
  return /MODEL_CAPACITY_EXHAUSTED|RESOURCE_EXHAUSTED|No capacity available for model/i.test(stderrText);
}

export function isGeminiQuotaError(stderrText: string): boolean {
  return /TerminalQuotaError|You have exhausted your capacity on this model|quota will reset after/i.test(stderrText);
}

export function isGeminiModelNotFoundError(stderrText: string): boolean {
  return /ModelNotFoundError|Requested entity was not found|code:\s*404/i.test(stderrText);
}

function collectIncludeDirectories(workingDirectory: string | undefined): string[] {
  const seen = new Set<string>();
  const ordered = [workingDirectory, ...parseListEnv('CTI_GEMINI_ADDITIONAL_DIRECTORIES')]
    .filter((value): value is string => Boolean(value));

  const unique: string[] = [];
  for (const dir of ordered) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    unique.push(dir);
  }
  return unique;
}

export function getGeminiFallbackModels(primaryModel: string | undefined): string[] {
  const configured = parseListEnv('CTI_GEMINI_FALLBACK_MODELS')
    .filter((model) => isGeminiModelName(model));
  const fallbacks = configured.length > 0
    ? configured
    : ((primaryModel && /preview/i.test(primaryModel)) ? DEFAULT_PREVIEW_FALLBACK_MODELS : []);

  const seen = new Set<string>();
  const filtered: string[] = [];
  for (const model of fallbacks) {
    if (model === primaryModel || seen.has(model)) continue;
    seen.add(model);
    filtered.push(model);
  }
  return filtered;
}

function extractGeminiModelFromError(stderrText: string, fallbackModel?: string): string | undefined {
  const model = stderrText.match(/No capacity available for model\s+([A-Za-z0-9._-]+)/i)?.[1]
    || stderrText.match(/"model"\s*:\s*"([^"]+)"/i)?.[1]
    || fallbackModel;
  return model?.replace(/[.,]+$/, '');
}

function cleanupGeminiErrorLine(line: string): string {
  return line
    .replace(/^Error:\s*/i, '')
    .replace(/^Error when talking to Gemini API\s*/i, 'Gemini API error ')
    .replace(/\s*Full report available at:\s*\S+/i, '')
    .replace(/^"message"\s*:\s*/i, '')
    .replace(/^message\s*:\s*/i, '')
    .replace(/[,:]?\s*\{$/, '')
    .replace(/[',"]+$/g, '')
    .replace(/^["']+/, '')
    .trim();
}

function extractGeminiMeaningfulErrorLine(stderrText: string): string | undefined {
  for (const rawLine of stderrText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (GEMINI_STDERR_NOISE_PATTERNS.some((pattern) => pattern.test(line))) continue;
    if (/^https?:\/\//i.test(line)) continue;
    if (/^[{\[\]}]$/.test(line)) continue;
    if (/^"(?:error|errors|details|metadata|code|status|message)"\s*:/i.test(line)) continue;
    const cleaned = cleanupGeminiErrorLine(line);
    if (cleaned) return cleaned;
  }
  return undefined;
}

export function formatGeminiCliError(
  stderrText: string,
  options?: { exitCode?: number | null; requestedModel?: string; timedOut?: boolean; timeoutMs?: number },
): string {
  const requestedModel = options?.requestedModel;
  const detectedModel = extractGeminiModelFromError(stderrText, requestedModel);

  if (options?.timedOut) {
    const timeoutNote = options.timeoutMs ? `（>${options.timeoutMs}ms 无模型输出）` : '';
    return `Gemini 会话启动超时${timeoutNote}。系统会优先丢弃卡住的旧会话；请重试一次。`;
  }

  if (shouldRetryFreshGeminiSession(stderrText)) {
    return 'Gemini 会话已失效，系统已建议重新开始一个新会话。请重试一次。';
  }

  if (isGeminiQuotaError(stderrText)) {
    const modelNote = detectedModel ? `（模型 ${detectedModel}）` : '';
    return `Gemini 当前模型配额已耗尽${modelNote}。请等待额度恢复，或切换到 gemini-2.5-pro / gemini-2.5-flash。`;
  }

  if (isGeminiCapacityError(stderrText)) {
    const modelNote = detectedModel ? `（模型 ${detectedModel}）` : '';
    return `Gemini 上游当前容量不足${modelNote}，本次请求未完成。请稍后再试；如需更稳，可切换到 gemini-2.5-pro 或 gemini-2.5-flash。`;
  }

  if (isGeminiModelNotFoundError(stderrText)) {
    const modelNote = detectedModel ? `：${detectedModel}` : '';
    return `Gemini 模型不可用或当前账号无权访问${modelNote}。请检查 CTI_DEFAULT_MODEL 和 CTI_GEMINI_FALLBACK_MODELS。`;
  }

  const conciseLine = extractGeminiMeaningfulErrorLine(stderrText);
  if (conciseLine) {
    return `Gemini CLI 请求失败：${conciseLine}`;
  }

  if (options?.exitCode !== undefined) {
    return `Gemini CLI exited with code ${options.exitCode ?? 'unknown'}`;
  }

  return 'Gemini CLI 请求失败。';
}

export function buildGeminiArgs(
  params: Pick<StreamChatParams, 'prompt' | 'model' | 'workingDirectory' | 'sdkSessionId' | 'systemPrompt'>,
  options?: { resumeSessionId?: string },
): string[] {
  const promptText = buildGeminiPromptText(params.prompt, params.systemPrompt);
  const args = ['-p', promptText, '--yolo', '-o', 'stream-json'];

  if (isGeminiModelName(params.model)) {
    args.push('-m', params.model as string);
  }

  for (const dir of collectIncludeDirectories(params.workingDirectory)) {
    args.push('--include-directories', dir);
  }

  const hasResumeOverride = options && Object.prototype.hasOwnProperty.call(options, 'resumeSessionId');
  const allowModelResume = !params.model || isGeminiModelName(params.model);
  const resumeSessionId = hasResumeOverride
    ? options.resumeSessionId
    : (allowModelResume ? params.sdkSessionId : undefined);

  if (resumeSessionId) {
    args.push('--resume', resumeSessionId);
  }

  return args;
}

type GeminiRunOutcome = {
  exitCode: number | null;
  stderrText: string;
  sawResult: boolean;
  sawOutput: boolean;
  sessionId: string;
  timedOut: boolean;
  timeoutMs: number;
};

export function shouldRetryFreshGeminiSessionTimeout(outcome: GeminiRunOutcome): boolean {
  return outcome.timedOut && !outcome.sawOutput && !outcome.sawResult;
}

async function runGeminiOnce(
  params: StreamChatParams,
  controller: ReadableStreamDefaultController<string>,
  resumeSessionId?: string,
): Promise<GeminiRunOutcome> {
  const args = buildGeminiArgs(params, { resumeSessionId });
  const child = spawn('gemini', args, {
    env: process.env,
    cwd: params.workingDirectory || process.cwd(),
  });
  const stderrChunks: Buffer[] = [];
  const timeoutMs = getGeminiStartTimeoutMs();
  const exitPromise = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.once('error', () => resolve(1));
  });
  let sessionId = '';
  let sawResult = false;
  let sawOutput = false;
  let timedOut = false;
  let startupTimer: NodeJS.Timeout | undefined;
  let forceKillTimer: NodeJS.Timeout | undefined;

  const clearTimers = () => {
    if (startupTimer) {
      clearTimeout(startupTimer);
      startupTimer = undefined;
    }
    if (forceKillTimer) {
      clearTimeout(forceKillTimer);
      forceKillTimer = undefined;
    }
  };

  const killForTimeout = () => {
    timedOut = true;
    stderrChunks.push(Buffer.from(`Gemini CLI timed out waiting for model output after ${timeoutMs}ms\n`, 'utf-8'));
    try {
      child.kill('SIGTERM');
    } catch {
      // Child may already be gone.
    }
    forceKillTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Child may already be gone.
      }
    }, GEMINI_FORCE_KILL_AFTER_MS);
    forceKillTimer.unref?.();
  };

  if (timeoutMs > 0) {
    startupTimer = setTimeout(killForTimeout, timeoutMs);
    startupTimer.unref?.();
  }

  if (child.stderr) {
    child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
  }

  const rl = readline.createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (params.abortController?.signal.aborted) {
      clearTimers();
      child.kill();
      break;
    }

    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;

    try {
      const event = JSON.parse(trimmed);

      switch (event.type) {
        case 'init':
          sessionId = event.session_id || sessionId;
          controller.enqueue(sseEvent('status', { session_id: sessionId }));
          break;

        case 'message':
          if (event.role === 'assistant' && event.content) {
            sawOutput = true;
            clearTimers();
            controller.enqueue(sseEvent('text', event.content));
          }
          break;

        case 'tool_use':
          sawOutput = true;
          clearTimers();
          controller.enqueue(sseEvent('tool_use', {
            id: event.tool_id,
            name: normalizeGeminiToolName(event.tool_name),
            input: event.parameters,
          }));
          break;

        case 'tool_result':
          sawOutput = true;
          clearTimers();
          controller.enqueue(sseEvent('tool_result', {
            tool_use_id: event.tool_id,
            content: event.output,
            is_error: event.status !== 'success',
          }));
          break;

        case 'result': {
          const stats = event.stats || {};
          sawResult = true;
          sawOutput = true;
          clearTimers();
          controller.enqueue(sseEvent('result', {
            usage: {
              input_tokens: stats.input_tokens || 0,
              output_tokens: stats.output_tokens || 0,
              cache_read_input_tokens: stats.cached || 0,
            },
            session_id: sessionId,
          }));
          break;
        }
      }
    } catch {
      // Ignore non-JSON lines or parse errors.
    }
  }

  clearTimers();
  const exitCode = await exitPromise;

  return {
    exitCode,
    stderrText: Buffer.concat(stderrChunks).toString('utf-8'),
    sawResult,
    sawOutput,
    sessionId,
    timedOut,
    timeoutMs,
  };
}

export class GeminiProvider implements LLMProvider {
  constructor(private pendingPerms: PendingPermissions) {
    void this.pendingPerms;
  }

  streamChat(params: StreamChatParams): ReadableStream<string> {
    return new ReadableStream<string>({
      async start(controller) {
        try {
          if (params.model && !isGeminiModelName(params.model)) {
            console.warn(`[gemini-provider] Ignoring non-Gemini model hint: ${params.model}`);
          }

          let activeModel = isGeminiModelName(params.model) ? params.model : undefined;
          const fallbackModels = getGeminiFallbackModels(activeModel);
          const attemptedModels = new Set<string>(activeModel ? [activeModel] : []);

          let resumeSessionId = params.sdkSessionId;
          if (resumeSessionId && params.model && !isGeminiModelName(params.model)) {
            console.warn('[gemini-provider] Ignoring stale non-Gemini sdkSessionId; starting fresh Gemini session');
            resumeSessionId = undefined;
          }
          let allowRetryWithoutResume = Boolean(resumeSessionId);

          while (true) {
            const runParams = activeModel ? { ...params, model: activeModel } : params;
            const outcome = await runGeminiOnce(runParams, controller, resumeSessionId);

            if (params.abortController?.signal.aborted) {
              controller.close();
              return;
            }

            if (outcome.exitCode === 0 && !outcome.timedOut) {
              controller.close();
              return;
            }

            if (
              resumeSessionId &&
              allowRetryWithoutResume &&
              !outcome.sawResult &&
              (shouldRetryFreshGeminiSession(outcome.stderrText) || shouldRetryFreshGeminiSessionTimeout(outcome))
            ) {
              console.warn('[gemini-provider] Resume session became unhealthy; retrying with a fresh Gemini session');
              resumeSessionId = undefined;
              allowRetryWithoutResume = false;
              continue;
            }

            if (shouldRetryFreshGeminiSessionTimeout(outcome) && !outcome.sawOutput) {
              const nextModel = fallbackModels.find((model) => !attemptedModels.has(model));
              if (nextModel) {
                console.warn(
                  `[gemini-provider] Model ${activeModel || 'Gemini default model'} stalled during startup; retrying with fallback model ${nextModel}`,
                );
                activeModel = nextModel;
                attemptedModels.add(nextModel);
                resumeSessionId = undefined;
                allowRetryWithoutResume = false;
                continue;
              }
            }

            if ((isGeminiCapacityError(outcome.stderrText) || isGeminiQuotaError(outcome.stderrText)) && !outcome.sawOutput) {
              const nextModel = fallbackModels.find((model) => !attemptedModels.has(model));
              if (nextModel) {
                console.warn(
                  `[gemini-provider] Model ${activeModel || 'Gemini default model'} is unavailable; retrying with fallback model ${nextModel}`,
                );
                activeModel = nextModel;
                attemptedModels.add(nextModel);
                resumeSessionId = undefined;
                allowRetryWithoutResume = false;
                continue;
              }
            }

            console.error('[gemini-provider] Gemini CLI failed:', outcome.stderrText);
            const message = formatGeminiCliError(outcome.stderrText, {
              exitCode: outcome.exitCode,
              requestedModel: activeModel,
              timedOut: outcome.timedOut,
              timeoutMs: outcome.timeoutMs,
            });
            controller.enqueue(sseEvent('error', message));
            controller.close();
            return;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error('[gemini-provider] Error:', err);
          try {
            controller.enqueue(sseEvent('error', message));
            controller.close();
          } catch {
            // Controller might already be closed.
          }
        }
      },
    });
  }
}
