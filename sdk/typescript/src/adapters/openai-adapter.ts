/**
 * OpenAI Model Adapter
 *
 * Implements the ModelAdapter interface for OpenAI models (GPT-4.1, GPT-4.1-mini, o3, o4-mini).
 * Translates ACL typed protocols → OpenAI Chat Completions API → ACL typed output.
 */

import OpenAI from 'openai';
import {
  ModelAdapter,
  AdapterConfig,
  TaskExecutionInput,
  TaskExecutionOutput,
  TokenUsage,
} from '../types';
import {
  buildSystemPrompt,
  buildUserMessage,
  parseResponse,
  estimateTokenCount,
} from './base-adapter';

// ─── Cost profiles per model (USD per 1K tokens, as of 2026) ────

const OPENAI_COSTS: Record<string, { input: number; output: number }> = {
  // GPT-5 series (latest flagship)
  'gpt-5': { input: 0.00125, output: 0.01 },
  'gpt-5-mini': { input: 0.00025, output: 0.002 },
  // GPT-4.1 series (recommended for production)
  'gpt-4.1': { input: 0.002, output: 0.008 },
  'gpt-4.1-mini': { input: 0.0004, output: 0.0016 },
  'gpt-4.1-nano': { input: 0.0001, output: 0.0004 },
  // o-series reasoning models
  'o3': { input: 0.002, output: 0.008 },
  'o3-mini': { input: 0.0011, output: 0.0044 },
  'o4-mini': { input: 0.0011, output: 0.0044 },
  // Legacy GPT-4o (still available)
  'gpt-4o': { input: 0.0025, output: 0.01 },
  'gpt-4o-mini': { input: 0.00015, output: 0.0006 },
};

export class OpenAIAdapter implements ModelAdapter {
  readonly provider = 'openai';
  readonly model: string;
  readonly modelBackend: string;
  readonly costProfile: { inputCostPer1k: number; outputCostPer1k: number };

  private client: OpenAI;
  private maxTokens: number;
  private temperature: number;

  constructor(config: AdapterConfig) {
    this.model = config.model;
    this.modelBackend = `openai/${config.model}`;
    this.maxTokens = config.maxTokens ?? 4096;
    this.temperature = config.temperature ?? 0.3;

    const costs = OPENAI_COSTS[config.model] ?? { input: 0.005, output: 0.015 };
    this.costProfile = {
      inputCostPer1k: costs.input,
      outputCostPer1k: costs.output,
    };

    this.client = new OpenAI({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
  }

  async executeTask(input: TaskExecutionInput): Promise<TaskExecutionOutput> {
    const systemPrompt = buildSystemPrompt(input);
    const userMessage = buildUserMessage(input);
    const startTime = Date.now();

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        response_format: { type: 'json_object' },
      });

      const latencyMs = Date.now() - startTime;
      const choice = response.choices[0];
      const content = choice?.message?.content ?? '';

      const tokenUsage: TokenUsage = {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
      };

      return parseResponse(content, input.task, tokenUsage, latencyMs);
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      return {
        success: false,
        content: '',
        artifactType: input.task.outputSchema,
        confidence: 0,
        failureReason: error instanceof Error ? error.message : 'OpenAI API error',
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        latencyMs,
      };
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.models.list();
      return true;
    } catch {
      return false;
    }
  }

  estimateTokens(input: TaskExecutionInput): number {
    const system = buildSystemPrompt(input);
    const user = buildUserMessage(input);
    return estimateTokenCount(system) + estimateTokenCount(user);
  }
}
