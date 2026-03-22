/**
 * Anthropic Model Adapter
 *
 * Implements the ModelAdapter interface for Anthropic models (Claude Opus 4.6, Sonnet 4.6, Haiku 4.5).
 * Translates ACL typed protocols → Anthropic Messages API → ACL typed output.
 */

import Anthropic from '@anthropic-ai/sdk';
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

const ANTHROPIC_COSTS: Record<string, { input: number; output: number }> = {
  // Latest generation (4.6)
  'claude-opus-4-6': { input: 0.005, output: 0.025 },
  'claude-sonnet-4-6': { input: 0.003, output: 0.015 },
  'claude-haiku-4-5-20251001': { input: 0.001, output: 0.005 },
  // Aliases
  'claude-haiku-4-5': { input: 0.001, output: 0.005 },
  // Legacy (still available)
  'claude-sonnet-4-5-20250929': { input: 0.003, output: 0.015 },
  'claude-opus-4-5-20251101': { input: 0.005, output: 0.025 },
  'claude-opus-4-1-20250805': { input: 0.015, output: 0.075 },
  'claude-sonnet-4-20250514': { input: 0.003, output: 0.015 },
  'claude-opus-4-20250514': { input: 0.015, output: 0.075 },
};

export class AnthropicAdapter implements ModelAdapter {
  readonly provider = 'anthropic';
  readonly model: string;
  readonly modelBackend: string;
  readonly costProfile: { inputCostPer1k: number; outputCostPer1k: number };

  private client: Anthropic;
  private maxTokens: number;
  private temperature: number;

  constructor(config: AdapterConfig) {
    this.model = config.model;
    this.modelBackend = `anthropic/${config.model}`;
    this.maxTokens = config.maxTokens ?? 4096;
    this.temperature = config.temperature ?? 0.3;

    const costs = ANTHROPIC_COSTS[config.model] ?? { input: 0.003, output: 0.015 };
    this.costProfile = {
      inputCostPer1k: costs.input,
      outputCostPer1k: costs.output,
    };

    this.client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
  }

  async executeTask(input: TaskExecutionInput): Promise<TaskExecutionOutput> {
    const systemPrompt = buildSystemPrompt(input);
    const userMessage = buildUserMessage(input);
    const startTime = Date.now();

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        system: systemPrompt,
        messages: [
          { role: 'user', content: userMessage },
        ],
      });

      const latencyMs = Date.now() - startTime;

      // Extract text content
      const textBlock = response.content.find((block) => block.type === 'text');
      const content = textBlock && 'text' in textBlock ? textBlock.text : '';

      const tokenUsage: TokenUsage = {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        totalTokens:
          (response.usage?.input_tokens ?? 0) +
          (response.usage?.output_tokens ?? 0),
      };

      return parseResponse(content, input.task, tokenUsage, latencyMs);
    } catch (error) {
      const latencyMs = Date.now() - startTime;
      return {
        success: false,
        content: '',
        artifactType: input.task.outputSchema,
        confidence: 0,
        failureReason:
          error instanceof Error ? error.message : 'Anthropic API error',
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        latencyMs,
      };
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      // Anthropic doesn't have a models.list endpoint — do a minimal call
      await this.client.messages.create({
        model: this.model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
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
