/**
 * @acl/sdk - Agent Collaboration Layer TypeScript SDK
 *
 * High-speed, non-linguistic runtime for AI agent collaboration.
 */

// Types
export * from './types';

// Core
export { AclRuntime } from './core/acl-runtime';
export type { AclRuntimeConfig } from './core/acl-runtime';
export { TaskGraphEngine } from './core/task-graph';
export type { EventListener } from './core/task-graph';
export { ArtifactStore } from './core/artifact-store';
export { AdapterRegistry } from './core/adapter-registry';
export { PolicyEngine, PolicyViolationError, DEFAULT_POLICY } from './core/policy-engine';
export type { PolicyConfig, AgentPolicyState } from './core/policy-engine';
export { SpawnManager } from './core/spawn-manager';
export { simulateNlBaseline, compareBenchmarks, formatBenchmarkReport } from './core/benchmark';
export type { BenchmarkMetrics, BenchmarkComparison } from './core/benchmark';

// Adapters
export { OpenAIAdapter } from './adapters/openai-adapter';
export { AnthropicAdapter } from './adapters/anthropic-adapter';
export { GoogleAdapter } from './adapters/google-adapter';
