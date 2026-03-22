/**
 * Adapter Registry
 *
 * Manages model adapters, tracks their performance metrics,
 * and provides capability-based routing.
 */

import { ModelAdapter, AdapterRegistryEntry, TaskExecutionInput, TaskExecutionOutput } from '../types';

export class AdapterRegistry {
  private adapters: Map<string, AdapterRegistryEntry> = new Map();

  /**
   * Register a model adapter with its capabilities
   */
  register(adapter: ModelAdapter, capabilities: string[]): void {
    const key = adapter.modelBackend;
    if (this.adapters.has(key)) {
      throw new Error(`Adapter already registered: ${key}`);
    }

    this.adapters.set(key, {
      adapter,
      capabilities,
      avgLatencyMs: 0,
      trustScore: 0.5, // Start neutral
      totalExecutions: 0,
      successRate: 1.0,
    });
  }

  /**
   * Deregister an adapter
   */
  deregister(modelBackend: string): void {
    if (!this.adapters.delete(modelBackend)) {
      throw new Error(`Adapter not found: ${modelBackend}`);
    }
  }

  /**
   * Get an adapter by model backend
   */
  get(modelBackend: string): ModelAdapter {
    const entry = this.adapters.get(modelBackend);
    if (!entry) throw new Error(`Adapter not found: ${modelBackend}`);
    return entry.adapter;
  }

  /**
   * Find adapters that support a given capability
   */
  findByCapability(capability: string): AdapterRegistryEntry[] {
    return Array.from(this.adapters.values()).filter((entry) =>
      entry.capabilities.includes(capability)
    );
  }

  /**
   * Route an intent to the best adapter based on trust score, latency, and cost
   */
  routeIntent(intent: string): ModelAdapter {
    const candidates = this.findByCapability(intent);
    if (candidates.length === 0) {
      throw new Error(`No adapter found for intent: ${intent}`);
    }

    // Sort by trust (desc) -> latency (asc) -> cost (asc)
    candidates.sort((a, b) => {
      const trustDiff = b.trustScore - a.trustScore;
      if (Math.abs(trustDiff) > 0.01) return trustDiff;

      const latDiff = a.avgLatencyMs - b.avgLatencyMs;
      if (Math.abs(latDiff) > 10) return latDiff;

      const aCost = a.adapter.costProfile.inputCostPer1k;
      const bCost = b.adapter.costProfile.inputCostPer1k;
      return aCost - bCost;
    });

    return candidates[0].adapter;
  }

  /**
   * Execute a task through a specific adapter with metrics tracking
   */
  async executeWithTracking(
    modelBackend: string,
    input: TaskExecutionInput
  ): Promise<TaskExecutionOutput> {
    const entry = this.adapters.get(modelBackend);
    if (!entry) throw new Error(`Adapter not found: ${modelBackend}`);

    const startTime = Date.now();

    try {
      const output = await entry.adapter.executeTask(input);
      const latency = Date.now() - startTime;

      // Update metrics
      entry.totalExecutions++;
      entry.avgLatencyMs =
        (entry.avgLatencyMs * (entry.totalExecutions - 1) + latency) /
        entry.totalExecutions;

      if (output.success) {
        entry.trustScore = Math.min(1.0, entry.trustScore + 0.01);
        entry.successRate =
          (entry.successRate * (entry.totalExecutions - 1) + 1) /
          entry.totalExecutions;
      } else {
        entry.trustScore = Math.max(0.0, entry.trustScore - 0.05);
        entry.successRate =
          (entry.successRate * (entry.totalExecutions - 1)) /
          entry.totalExecutions;
      }

      return output;
    } catch (error) {
      entry.totalExecutions++;
      entry.trustScore = Math.max(0.0, entry.trustScore - 0.1);
      entry.successRate =
        (entry.successRate * (entry.totalExecutions - 1)) /
        entry.totalExecutions;

      throw error;
    }
  }

  /**
   * List all registered adapters
   */
  listAll(): AdapterRegistryEntry[] {
    return Array.from(this.adapters.values());
  }

  /**
   * Health check all adapters
   */
  async healthCheckAll(): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();
    for (const [key, entry] of this.adapters) {
      try {
        results.set(key, await entry.adapter.healthCheck());
      } catch {
        results.set(key, false);
      }
    }
    return results;
  }

  get count(): number {
    return this.adapters.size;
  }
}
