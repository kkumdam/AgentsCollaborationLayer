/**
 * Model Adapter Types
 *
 * Defines the uniform interface that all LLM provider adapters must implement.
 * This abstraction enables model-agnostic agent registration and task execution.
 */

import { AgentCapability, Artifact, ArtifactReference, TaskNode } from './protocol';

// ─── Adapter Interface ──────────────────────────────────────────

/**
 * Message format for adapter communication.
 * This is the ONLY place where natural language enters the system —
 * adapters translate between ACL's typed protocols and the LLM's
 * text-based interface.
 */
export interface AdapterMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Structured input for task execution.
 * Adapters receive this typed context instead of raw prompts.
 */
export interface TaskExecutionInput {
  /** The task to execute */
  task: TaskNode;
  /** Resolved artifacts from input references */
  inputArtifacts: Artifact[];
  /** Agent's capability contract */
  agentCapability: AgentCapability;
  /** Additional context from the task graph */
  context?: Record<string, unknown>;
}

/**
 * Structured output from task execution.
 * Adapters must return typed results, not free-form text.
 */
export interface TaskExecutionOutput {
  /** Whether the task was completed successfully */
  success: boolean;
  /** The produced artifact content */
  content: string;
  /** Artifact type matching the task's output schema */
  artifactType: string;
  /** Confidence score (0.0 - 1.0) */
  confidence: number;
  /** Failure reason if success is false */
  failureReason?: string;
  /** Token usage for cost tracking */
  tokenUsage: TokenUsage;
  /** Execution latency in milliseconds */
  latencyMs: number;
  /** Additional metadata */
  metadata?: Record<string, string>;
}

/**
 * Token usage tracking for cost governance.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Adapter configuration for model initialization.
 */
export interface AdapterConfig {
  /** API key for the provider */
  apiKey: string;
  /** Model identifier (e.g., "gpt-4.1", "claude-sonnet-4-6") */
  model: string;
  /** Maximum tokens for output */
  maxTokens?: number;
  /** Temperature for generation */
  temperature?: number;
  /** Base URL override (for proxies/custom endpoints) */
  baseUrl?: string;
  /** Additional provider-specific options */
  options?: Record<string, unknown>;
}

// ─── Core Adapter Interface ─────────────────────────────────────

/**
 * ModelAdapter is the uniform interface that all LLM providers must implement.
 *
 * The adapter's job is to:
 * 1. Accept typed TaskExecutionInput (ACL protocol)
 * 2. Translate it into the provider's API format
 * 3. Execute the LLM call
 * 4. Parse the response back into TaskExecutionOutput (ACL protocol)
 *
 * This is the ONLY boundary where structured data meets natural language.
 */
export interface ModelAdapter {
  /** Provider identifier (e.g., "openai", "anthropic", "google") */
  readonly provider: string;

  /** Model identifier (e.g., "gpt-4.1", "claude-sonnet-4-6") */
  readonly model: string;

  /** Full model backend string (e.g., "openai/gpt-4.1") */
  readonly modelBackend: string;

  /** Cost profile for budget governance */
  readonly costProfile: {
    inputCostPer1k: number;
    outputCostPer1k: number;
  };

  /**
   * Execute a task using the underlying LLM.
   *
   * The adapter translates ACL's typed input into the LLM's format,
   * makes the API call, and returns structured output.
   */
  executeTask(input: TaskExecutionInput): Promise<TaskExecutionOutput>;

  /**
   * Health check for the adapter connection.
   */
  healthCheck(): Promise<boolean>;

  /**
   * Estimate token count for an input (for budget pre-check).
   */
  estimateTokens(input: TaskExecutionInput): number;
}

// ─── Adapter Registry ───────────────────────────────────────────

/**
 * Registry entry for a model adapter.
 */
export interface AdapterRegistryEntry {
  adapter: ModelAdapter;
  capabilities: string[];
  avgLatencyMs: number;
  trustScore: number;
  totalExecutions: number;
  successRate: number;
}
