/**
 * Google Gemini Model Adapter
 *
 * Implements the ModelAdapter interface for Google Gemini models.
 * Translates ACL typed protocols → Gemini GenerativeAI API → ACL typed output.
 */

import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
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

const GOOGLE_COSTS: Record<string, { input: number; output: number }> = {
  // Gemini 3 series (latest preview)
  'gemini-3.1-pro-preview': { input: 0.002, output: 0.012 },
  'gemini-3-flash-preview': { input: 0.0005, output: 0.003 },
  // Gemini 2.5 series (current stable)
  'gemini-2.5-pro': { input: 0.00125, output: 0.01 },
  'gemini-2.5-flash': { input: 0.0003, output: 0.0025 },
  'gemini-2.5-flash-lite': { input: 0.0001, output: 0.0004 },
  // Legacy (retiring June 2026)
  'gemini-2.0-flash': { input: 0.0001, output: 0.0004 },
  'gemini-2.0-pro': { input: 0.00125, output: 0.005 },
};

export class GoogleAdapter implements ModelAdapter {
  readonly provider = 'google';
  readonly model: string;
  readonly modelBackend: string;
  readonly costProfile: { inputCostPer1k: number; outputCostPer1k: number };

  private genAI: GoogleGenerativeAI;
  private generativeModel: GenerativeModel;
  private maxTokens: number;
  private temperature: number;

  constructor(config: AdapterConfig) {
    this.model = config.model;
    this.modelBackend = `google/${config.model}`;
    this.maxTokens = config.maxTokens ?? 4096;
    this.temperature = config.temperature ?? 0.3;

    const costs = GOOGLE_COSTS[config.model] ?? { input: 0.001, output: 0.002 };
    this.costProfile = {
      inputCostPer1k: costs.input,
      outputCostPer1k: costs.output,
    };

    this.genAI = new GoogleGenerativeAI(config.apiKey);
    this.generativeModel = this.genAI.getGenerativeModel({
      model: config.model,
      generationConfig: {
        maxOutputTokens: this.maxTokens,
        temperature: this.temperature,
        responseMimeType: 'application/json',
      },
    });
  }

  async executeTask(input: TaskExecutionInput): Promise<TaskExecutionOutput> {
    const systemPrompt = buildSystemPrompt(input);
    const userMessage = buildUserMessage(input);
    const startTime = Date.now();

    try {
      const chat = this.generativeModel.startChat({
        history: [
          {
            role: 'user',
            parts: [{ text: `SYSTEM INSTRUCTIONS:\n${systemPrompt}` }],
          },
          {
            role: 'model',
            parts: [
              {
                text: 'Understood. I will respond with JSON only, following the ACL protocol.',
              },
            ],
          },
        ],
      });

      const result = await chat.sendMessage(userMessage);
      const latencyMs = Date.now() - startTime;

      const response = result.response;
      const content = response.text();

      // Gemini usage metadata
      const usageMeta = response.usageMetadata;
      const tokenUsage: TokenUsage = {
        inputTokens: usageMeta?.promptTokenCount ?? 0,
        outputTokens: usageMeta?.candidatesTokenCount ?? 0,
        totalTokens: usageMeta?.totalTokenCount ?? 0,
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
          error instanceof Error ? error.message : 'Google Gemini API error',
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        latencyMs,
      };
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.generativeModel.generateContent('ping');
      return !!result.response.text();
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
