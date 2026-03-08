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

function parseListEnv(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter(Boolean);
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
  return /Error\s+resuming\s+session:\s+Invalid\s+session\s+identifier/i.test(stderrText);
}

export function isGeminiModelName(model: string | undefined): boolean {
  if (!model) return false;
  return /(^|\/)gemini([-.]|$)|^auto-gemini-/i.test(model);
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
  sessionId: string;
};

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
  let sessionId = '';
  let sawResult = false;

  if (child.stderr) {
    child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
  }

  const rl = readline.createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (params.abortController?.signal.aborted) {
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
            controller.enqueue(sseEvent('text', event.content));
          }
          break;

        case 'tool_use':
          controller.enqueue(sseEvent('tool_use', {
            id: event.tool_id,
            name: normalizeGeminiToolName(event.tool_name),
            input: event.parameters,
          }));
          break;

        case 'tool_result':
          controller.enqueue(sseEvent('tool_result', {
            tool_use_id: event.tool_id,
            content: event.output,
            is_error: event.status !== 'success',
          }));
          break;

        case 'result': {
          const stats = event.stats || {};
          sawResult = true;
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

  const exitCode = await new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });

  return {
    exitCode,
    stderrText: Buffer.concat(stderrChunks).toString('utf-8'),
    sawResult,
    sessionId,
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

          let resumeSessionId = params.sdkSessionId;
          if (resumeSessionId && params.model && !isGeminiModelName(params.model)) {
            console.warn('[gemini-provider] Ignoring stale non-Gemini sdkSessionId; starting fresh Gemini session');
            resumeSessionId = undefined;
          }
          let allowRetryWithoutResume = Boolean(resumeSessionId);

          while (true) {
            const outcome = await runGeminiOnce(params, controller, resumeSessionId);

            if (outcome.exitCode === 0 || outcome.exitCode === null) {
              controller.close();
              return;
            }

            if (
              resumeSessionId &&
              allowRetryWithoutResume &&
              !outcome.sawResult &&
              shouldRetryFreshGeminiSession(outcome.stderrText)
            ) {
              console.warn('[gemini-provider] Invalid resume session ID; retrying with a fresh Gemini session');
              resumeSessionId = undefined;
              allowRetryWithoutResume = false;
              continue;
            }

            const message = outcome.stderrText.trim() || `Gemini CLI exited with code ${outcome.exitCode}`;
            controller.enqueue(sseEvent('error', `Gemini CLI Error: \n${message}`));
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
