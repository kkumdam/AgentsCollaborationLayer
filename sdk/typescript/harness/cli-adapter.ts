/**
 * CLI Bridge Adapters
 *
 * Wraps three CLI tools as ModelAdapter implementations, enabling
 * the ACL harness to use real LLMs via OAuth without needing API keys:
 *
 *   1. ClaudeCliAdapter   — `claude` CLI (Anthropic)
 *   2. CodexCliAdapter    — `codex` CLI (OpenAI)
 *   3. GeminiCliAdapter   — `gemini-cli` (Google)
 *
 * Each adapter:
 *   - Constructs a prompt from ACL's typed ActionPacket
 *   - Calls the CLI tool via child_process
 *   - Parses the output (JSON or plain text) back into TaskExecutionOutput
 */

import { execSync, spawnSync, spawn, ChildProcess } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import {
  ModelAdapter,
  TaskExecutionInput,
  TaskExecutionOutput,
  TokenUsage,
} from '../src';
import {
  buildSystemPrompt,
  buildUserMessage,
  parseResponse,
  estimateTokenCount,
} from '../src/adapters/base-adapter';

// ─── Progress Callback (for real-time monitoring) ─────────────

export interface ProgressInfo {
  chars: number;
  lines: number;
  activity: string;
  phase: 'starting' | 'streaming' | 'parsing' | 'done';
  /** Last detected file being worked on */
  currentFile?: string;
  /** Stderr hint (e.g. tool calls) */
  stderrHint?: string;
}

export type ProgressCallback = (info: ProgressInfo) => void;

/** Extract file path from agent output for status display */
function extractFileHint(text: string): string | undefined {
  // Match common patterns: "editing src/foo.ts", "created bar.js", file paths
  const patterns = [
    /(?:editing|creating|writing|reading|modifying|updating)\s+[`"']?([^\s`"'\n]+\.\w+)/i,
    /(?:file|path):\s*[`"']?([^\s`"'\n]+\.\w+)/i,
    /([a-zA-Z_/\\][\w/\\.-]+\.\w{1,6})(?:\s|$|`|")/,
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) return m[1];
  }
  return undefined;
}

// On Windows, CLI tools installed via npm/pip are .cmd/.bat wrappers.
// spawnSync cannot resolve them without shell: true.
const IS_WIN = process.platform === 'win32';
const SHELL_OPT = IS_WIN ? { shell: true as const } : {};

// ─── Shared Types ──────────────────────────────────────────────

export interface CliAdapterConfig {
  model: string;
  cliPath?: string;
  maxTurns?: number;
  timeout?: number;
}

/** Check whether a CLI tool exists on PATH (cross-platform) */
export function cliExists(name: string): boolean {
  try {
    const cmd = process.platform === 'win32' ? `where ${name}` : `which ${name}`;
    execSync(cmd, { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Shared JSON-extract helper */
function tryParseAclJson(
  content: string,
  input: TaskExecutionInput,
  tokenUsage: TokenUsage,
  latencyMs: number,
  extraMeta?: Record<string, string>
): TaskExecutionOutput {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        success: true,
        content:
          typeof parsed.result === 'string'
            ? parsed.result
            : JSON.stringify(parsed.result, null, 2),
        artifactType: input.task.outputSchema,
        confidence:
          typeof parsed.confidence === 'number'
            ? Math.max(0, Math.min(1, parsed.confidence))
            : 0.8,
        tokenUsage,
        latencyMs,
        metadata: {
          reasoning: parsed.reasoning || '',
          ...extraMeta,
        },
      };
    }
  } catch {
    // fall through
  }

  return {
    success: true,
    content,
    artifactType: input.task.outputSchema,
    confidence: 0.8,
    tokenUsage,
    latencyMs,
    metadata: extraMeta,
  };
}

// ═══════════════════════════════════════════════════════════════
//  1. Claude CLI Adapter (Anthropic)
// ═══════════════════════════════════════════════════════════════

export class ClaudeCliAdapter implements ModelAdapter {
  readonly provider = 'anthropic';
  readonly model: string;
  readonly modelBackend: string;
  readonly costProfile: { inputCostPer1k: number; outputCostPer1k: number };

  /** Set this before executeTask() for real-time monitoring */
  onProgress?: ProgressCallback;

  private cliPath: string;
  private maxTurns: number;
  private timeout: number;

  constructor(config: CliAdapterConfig) {
    this.model = config.model;
    this.modelBackend = `anthropic/${config.model}`;
    this.cliPath = config.cliPath || 'claude';
    this.maxTurns = config.maxTurns || 5;
    this.timeout = config.timeout || 120_000;

    const costs: Record<string, { input: number; output: number }> = {
      'claude-sonnet-4-6': { input: 0.003, output: 0.015 },
      'claude-haiku-4-5-20251001': { input: 0.001, output: 0.005 },
      'claude-opus-4-6': { input: 0.005, output: 0.025 },
    };
    const c = costs[config.model] ?? { input: 0.003, output: 0.015 };
    this.costProfile = { inputCostPer1k: c.input, outputCostPer1k: c.output };
  }

  async executeTask(input: TaskExecutionInput): Promise<TaskExecutionOutput> {
    const prompt = `${buildSystemPrompt(input)}\n\n---\n\n${buildUserMessage(input)}`;
    const startTime = Date.now();
    const cb = this.onProgress;

    cb?.({ chars: 0, lines: 0, activity: 'Starting Claude CLI...', phase: 'starting' });

    return new Promise<TaskExecutionOutput>((resolve) => {
      const args = [
        '-p', '--output-format', 'json', '--max-turns', String(this.maxTurns), '--model', this.model,
        '--allowedTools', 'Edit', 'Write', 'Read', 'Bash', 'Glob', 'Grep',
      ];

      const proc = spawn(this.cliPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(IS_WIN ? { shell: true } : {}),
      });

      let stdout = '';
      let stderr = '';
      let lineCount = 0;
      let lastFile: string | undefined;

      proc.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        lineCount += (text.match(/\n/g) || []).length;
        const fileHint = extractFileHint(text);
        if (fileHint) lastFile = fileHint;

        const lastLine = text.trim().split('\n').pop() || '';
        cb?.({
          chars: stdout.length, lines: lineCount,
          activity: lastLine.slice(0, 60),
          phase: 'streaming',
          currentFile: lastFile,
        });
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        // Parse tool usage hints from stderr
        if (text.includes('Tool:') || text.includes('tool_use')) {
          const toolMatch = text.match(/Tool:\s*(\w+)/i) || text.match(/"name":\s*"(\w+)"/);
          if (toolMatch) {
            cb?.({
              chars: stdout.length, lines: lineCount,
              activity: `Using tool: ${toolMatch[1]}`,
              phase: 'streaming',
              stderrHint: `tool:${toolMatch[1]}`,
              currentFile: lastFile,
            });
          }
        }
      });

      proc.stdin?.write(prompt);
      proc.stdin?.end();

      const timer = setTimeout(() => { proc.kill(); }, this.timeout);

      proc.on('close', (code) => {
        clearTimeout(timer);
        const latencyMs = Date.now() - startTime;
        cb?.({ chars: stdout.length, lines: lineCount, activity: 'Parsing output...', phase: 'parsing' });

        try {
          const cliOutput = JSON.parse(stdout);
          let inputTokens = 0, outputTokens = 0;
          if (cliOutput.usage) {
            inputTokens = cliOutput.usage.input_tokens || 0;
            outputTokens = cliOutput.usage.output_tokens || 0;
          } else if (cliOutput.modelUsage) {
            for (const m of Object.values(cliOutput.modelUsage) as any[]) {
              inputTokens += m.inputTokens || 0;
              outputTokens += m.outputTokens || 0;
            }
          }
          const tokenUsage: TokenUsage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
          const content = cliOutput.result || '';

          cb?.({ chars: stdout.length, lines: lineCount, activity: 'Done', phase: 'done' });
          resolve(tryParseAclJson(content, input, tokenUsage, latencyMs, {
            cliCostUsd: String(cliOutput.total_cost_usd || 0),
          }));
        } catch {
          cb?.({ chars: stdout.length, lines: lineCount, activity: 'Parse error', phase: 'done' });
          resolve(this.failResult(input, latencyMs, new Error(
            stderr ? `stderr: ${stderr.slice(0, 300)}` : `Exit code ${code}, stdout: ${stdout.slice(0, 300)}`
          )));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        cb?.({ chars: 0, lines: 0, activity: `Error: ${err.message}`, phase: 'done' });
        resolve(this.failResult(input, Date.now() - startTime, err));
      });
    });
  }

  async healthCheck(): Promise<boolean> {
    try {
      const proc = spawnSync(this.cliPath, ['-p', '--output-format', 'json', '--max-turns', '1', '--model', this.model], {
        input: 'ping', encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'], ...SHELL_OPT,
      });
      return (proc.stdout || '').includes('"result"');
    } catch { return false; }
  }

  estimateTokens(input: TaskExecutionInput): number {
    return estimateTokenCount(buildSystemPrompt(input)) + estimateTokenCount(buildUserMessage(input));
  }

  private failResult(input: TaskExecutionInput, latencyMs: number, err: unknown): TaskExecutionOutput {
    return { success: false, content: '', artifactType: input.task.outputSchema, confidence: 0, failureReason: err instanceof Error ? err.message : 'Claude CLI error', tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, latencyMs };
  }
}

// ═══════════════════════════════════════════════════════════════
//  2. Codex CLI Adapter (OpenAI)
// ═══════════════════════════════════════════════════════════════

export class CodexCliAdapter implements ModelAdapter {
  readonly provider = 'openai';
  readonly model: string;
  readonly modelBackend: string;
  readonly costProfile: { inputCostPer1k: number; outputCostPer1k: number };

  onProgress?: ProgressCallback;

  private cliPath: string;
  private timeout: number;

  constructor(config: CliAdapterConfig) {
    this.model = config.model;
    this.modelBackend = `openai/${config.model}`;
    this.cliPath = config.cliPath || 'codex';
    this.timeout = config.timeout || 120_000;

    const costs: Record<string, { input: number; output: number }> = {
      'gpt-5.4': { input: 0.003, output: 0.012 },
      'o4-mini': { input: 0.0011, output: 0.0044 },
      'o3-mini': { input: 0.0011, output: 0.0044 },
      'gpt-4.1': { input: 0.002, output: 0.008 },
      'gpt-4.1-mini': { input: 0.0004, output: 0.0016 },
      'gpt-4.1-nano': { input: 0.0001, output: 0.0004 },
    };
    const c = costs[config.model] ?? { input: 0.002, output: 0.008 };
    this.costProfile = { inputCostPer1k: c.input, outputCostPer1k: c.output };
  }

  async executeTask(input: TaskExecutionInput): Promise<TaskExecutionOutput> {
    const prompt = `${buildSystemPrompt(input)}\n\n---\n\n${buildUserMessage(input)}`;
    const startTime = Date.now();
    const cb = this.onProgress;

    cb?.({ chars: 0, lines: 0, activity: 'Starting Codex CLI...', phase: 'starting' });

    return new Promise<TaskExecutionOutput>((resolve) => {
      const proc = spawn(this.cliPath, [
        'exec', '--full-auto', '--json', '--skip-git-repo-check', '-c', `model="${this.model}"`, '-',
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(IS_WIN ? { shell: true } : {}),
      });

      let stdout = '';
      let stderr = '';
      let lineCount = 0;
      let content = '';
      let inputTokens = 0, outputTokens = 0;
      let lastFile: string | undefined;

      proc.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        lineCount += (text.match(/\n/g) || []).length;

        // Parse JSONL events in real-time
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === 'message' && event.content) {
              content += event.content;
            }
            if (event.type === 'item.completed' && event.item?.type === 'message') {
              for (const part of event.item.content || []) {
                if (part.type === 'output_text' || part.type === 'text') {
                  content += part.text || '';
                }
              }
            }
            if (event.type === 'turn.completed' && event.usage) {
              inputTokens += event.usage.input_tokens || 0;
              outputTokens += event.usage.output_tokens || 0;
            }
            // Detect file operations
            if (event.type === 'item.completed' && event.item?.type === 'function_call') {
              const fName = event.item.name || '';
              const fArgs = event.item.arguments ? JSON.parse(event.item.arguments) : {};
              const file = fArgs.path || fArgs.file_path || '';
              if (file) lastFile = file;
              cb?.({
                chars: content.length, lines: lineCount,
                activity: `${fName}${file ? ': ' + path.basename(file) : ''}`,
                phase: 'streaming', currentFile: lastFile,
              });
            }
          } catch {}
        }

        cb?.({ chars: content.length, lines: lineCount, activity: `Streaming... ${content.length} chars`, phase: 'streaming', currentFile: lastFile });
      });

      proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.stdin?.write(prompt);
      proc.stdin?.end();

      const timer = setTimeout(() => { proc.kill(); }, this.timeout);

      proc.on('close', (code) => {
        clearTimeout(timer);
        const latencyMs = Date.now() - startTime;

        // Fallback content extraction
        if (!content && stdout) {
          const lines = stdout.trim().split('\n');
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const e = JSON.parse(lines[i]);
              if (e.type !== 'error' && (e.result || e.content || e.text)) {
                content = e.result || e.content || e.text || '';
                break;
              }
            } catch {
              if (lines[i].trim() && !lines[i].includes('"type":"error"')) {
                content = lines[i]; break;
              }
            }
          }
        }

        const tokenUsage: TokenUsage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
        if (tokenUsage.totalTokens === 0) {
          tokenUsage.inputTokens = estimateTokenCount(prompt);
          tokenUsage.outputTokens = estimateTokenCount(content);
          tokenUsage.totalTokens = tokenUsage.inputTokens + tokenUsage.outputTokens;
        }

        cb?.({ chars: content.length, lines: lineCount, activity: 'Done', phase: 'done' });
        resolve(tryParseAclJson(content, input, tokenUsage, latencyMs));
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        cb?.({ chars: 0, lines: 0, activity: `Error: ${err.message}`, phase: 'done' });
        resolve(this.failResult(input, Date.now() - startTime, err));
      });
    });
  }

  async healthCheck(): Promise<boolean> {
    try {
      const proc = spawnSync(this.cliPath, ['exec', '--json', '--skip-git-repo-check', '-'], {
        input: 'ping', encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'], ...SHELL_OPT,
      });
      return (proc.stdout || '').length > 0;
    } catch { return false; }
  }

  estimateTokens(input: TaskExecutionInput): number {
    return estimateTokenCount(buildSystemPrompt(input)) + estimateTokenCount(buildUserMessage(input));
  }

  private failResult(input: TaskExecutionInput, latencyMs: number, err: unknown): TaskExecutionOutput {
    return { success: false, content: '', artifactType: input.task.outputSchema, confidence: 0, failureReason: err instanceof Error ? err.message : 'Codex CLI error', tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, latencyMs };
  }
}

// ═══════════════════════════════════════════════════════════════
//  3. Gemini CLI Adapter (Google)
// ═══════════════════════════════════════════════════════════════

export class GeminiCliAdapter implements ModelAdapter {
  readonly provider = 'google';
  readonly model: string;
  readonly modelBackend: string;
  readonly costProfile: { inputCostPer1k: number; outputCostPer1k: number };

  onProgress?: ProgressCallback;

  private cliPath: string;
  private timeout: number;

  constructor(config: CliAdapterConfig) {
    this.model = config.model;
    this.modelBackend = `google/${config.model}`;
    this.cliPath = config.cliPath || 'gemini-cli';
    this.timeout = config.timeout || 120_000;

    const costs: Record<string, { input: number; output: number }> = {
      'gemini-3.1-pro': { input: 0.002, output: 0.012 },
      'gemini-2.5-flash': { input: 0.0003, output: 0.0025 },
      'gemini-2.5-pro': { input: 0.00125, output: 0.01 },
      'gemini-2.5-flash-lite': { input: 0.0001, output: 0.0004 },
    };
    const c = costs[config.model] ?? { input: 0.0003, output: 0.0025 };
    this.costProfile = { inputCostPer1k: c.input, outputCostPer1k: c.output };
  }

  async executeTask(input: TaskExecutionInput): Promise<TaskExecutionOutput> {
    const systemPrompt = buildSystemPrompt(input);
    const userMessage = buildUserMessage(input);
    const fullPrompt = systemPrompt + '\n\n' + userMessage;
    const startTime = Date.now();
    const cb = this.onProgress;

    cb?.({ chars: 0, lines: 0, activity: 'Starting Gemini CLI...', phase: 'starting' });

    return new Promise<TaskExecutionOutput>((resolve) => {
      // Use stdin pipe to avoid OS arg length limits
      const args: string[] = [];

      const proc = spawn(this.cliPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(IS_WIN ? { shell: true } : {}),
      });

      let stdout = '';
      let stderr = '';
      let lineCount = 0;

      proc.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        lineCount += (text.match(/\n/g) || []).length;
        const lastLine = text.trim().split('\n').pop() || '';
        const fileHint = extractFileHint(text);
        cb?.({
          chars: stdout.length, lines: lineCount,
          activity: lastLine.slice(0, 60),
          phase: 'streaming',
          currentFile: fileHint,
        });
      });

      proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.stdin?.write(fullPrompt);
      proc.stdin?.end();

      const timer = setTimeout(() => { proc.kill(); }, this.timeout);

      proc.on('close', (code) => {
        clearTimeout(timer);
        const latencyMs = Date.now() - startTime;
        const content = stdout.trim();

        if (code !== 0 && !content) {
          cb?.({ chars: 0, lines: 0, activity: 'Failed', phase: 'done' });
          resolve(this.failResult(input, latencyMs, new Error(stderr || `Exit code ${code}`)));
          return;
        }

        const tokenUsage: TokenUsage = {
          inputTokens: estimateTokenCount(fullPrompt),
          outputTokens: estimateTokenCount(content),
          totalTokens: 0,
        };
        tokenUsage.totalTokens = tokenUsage.inputTokens + tokenUsage.outputTokens;

        cb?.({ chars: content.length, lines: lineCount, activity: 'Done', phase: 'done' });
        resolve(tryParseAclJson(content, input, tokenUsage, latencyMs));
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        cb?.({ chars: 0, lines: 0, activity: `Error: ${err.message}`, phase: 'done' });
        resolve(this.failResult(input, Date.now() - startTime, err));
      });
    });
  }

  async healthCheck(): Promise<boolean> {
    try {
      const proc = spawnSync(this.cliPath, ['ping'], {
        encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'], ...SHELL_OPT,
      });
      return proc.status === 0;
    } catch { return false; }
  }

  estimateTokens(input: TaskExecutionInput): number {
    return estimateTokenCount(buildSystemPrompt(input)) + estimateTokenCount(buildUserMessage(input));
  }

  private failResult(input: TaskExecutionInput, latencyMs: number, err: unknown): TaskExecutionOutput {
    return { success: false, content: '', artifactType: input.task.outputSchema, confidence: 0, failureReason: err instanceof Error ? err.message : 'Gemini CLI error', tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, latencyMs };
  }
}
