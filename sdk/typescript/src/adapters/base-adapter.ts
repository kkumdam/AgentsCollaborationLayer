/**
 * Base Adapter
 *
 * Shared utilities for all model adapters.
 * Handles the translation between ACL's typed protocol and LLM prompts.
 */

import {
  ModelAdapter,
  AdapterConfig,
  TaskExecutionInput,
  TaskExecutionOutput,
  TokenUsage,
  Artifact,
  TaskNode,
} from '../types';

/**
 * Build a structured system prompt from ACL task context.
 *
 * This is the ONLY place where ACL's typed data is converted to natural language.
 * The prompt is structured to maximize the LLM's ability to produce typed output.
 */
export function buildSystemPrompt(input: TaskExecutionInput): string {
  const { task, agentCapability } = input;

  return [
    `You are an AI agent operating within the Agent Collaboration Layer (ACL).`,
    `Your role: ${agentCapability.canDo.join(', ')}`,
    `Model backend: ${agentCapability.modelBackend}`,
    ``,
    `TASK CONTEXT:`,
    `- Intent: ${task.intent}`,
    `- Task ID: ${task.taskId}`,
    `- Output Schema: ${task.outputSchema}`,
    `- Priority: ${task.priority}`,
    task.constraints && Object.keys(task.constraints).length > 0
      ? `- Constraints: ${JSON.stringify(task.constraints)}`
      : null,
    ``,
    `RESPONSE FORMAT:`,
    `You MUST respond with valid JSON matching this structure:`,
    `{`,
    `  "result": <your output matching the "${task.outputSchema}" schema>,`,
    `  "confidence": <0.0-1.0 self-assessed confidence>,`,
    `  "reasoning": "<brief explanation of your approach>"`,
    `}`,
    ``,
    `Do NOT include any text outside the JSON. Raw JSON only.`,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/**
 * Build the user message from input artifacts
 */
export function buildUserMessage(input: TaskExecutionInput): string {
  const parts: string[] = [];

  if (input.inputArtifacts.length > 0) {
    parts.push('INPUT ARTIFACTS:');
    for (const artifact of input.inputArtifacts) {
      const content =
        typeof artifact.content === 'string'
          ? artifact.content
          : artifact.content.toString('utf-8');
      parts.push(`\n--- ${artifact.artifactType} (${artifact.producerAgent}) ---`);
      parts.push(content);
    }
    parts.push('');
  }

  parts.push(`Execute the "${input.task.intent}" task.`);

  if (input.task.constraints && Object.keys(input.task.constraints).length > 0) {
    parts.push(`\nConstraints:`);
    for (const [key, value] of Object.entries(input.task.constraints)) {
      parts.push(`- ${key}: ${value}`);
    }
  }

  return parts.join('\n');
}

/**
 * Parse LLM response into structured output
 */
export function parseResponse(
  rawContent: string,
  task: TaskNode,
  tokenUsage: TokenUsage,
  latencyMs: number
): TaskExecutionOutput {
  try {
    // Try to extract JSON from the response
    const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        success: true,
        content: rawContent,
        artifactType: task.outputSchema,
        confidence: 0.7, // Lower confidence for non-JSON response
        tokenUsage,
        latencyMs,
        metadata: { rawResponse: 'true' },
      };
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      success: true,
      content: typeof parsed.result === 'string'
        ? parsed.result
        : JSON.stringify(parsed.result, null, 2),
      artifactType: task.outputSchema,
      confidence: typeof parsed.confidence === 'number'
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.8,
      tokenUsage,
      latencyMs,
      metadata: {
        reasoning: parsed.reasoning ?? '',
      },
    };
  } catch {
    // If JSON parsing fails, return raw content
    return {
      success: true,
      content: rawContent,
      artifactType: task.outputSchema,
      confidence: 0.6,
      tokenUsage,
      latencyMs,
      metadata: { parseError: 'true' },
    };
  }
}

/**
 * Rough token estimation (4 chars ≈ 1 token)
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}
