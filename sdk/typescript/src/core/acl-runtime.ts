/**
 * ACL Runtime (TypeScript)
 *
 * The central orchestrator for the TypeScript SDK.
 * Provides a unified API for task management, adapter routing,
 * artifact exchange, and agent execution.
 *
 * This can operate:
 * - Standalone (in-memory, for local/embedded usage)
 * - Connected to the Rust gRPC server (for production)
 */

import { v4 as uuidv4 } from 'uuid';
import {
  ActionPacket,
  AgentCapability,
  Artifact,
  ArtifactReference,
  ModelAdapter,
  TaskExecutionInput,
  TaskExecutionOutput,
  TaskNode,
  TaskState,
  RuntimeStats,
  AclEvent,
  EventType,
} from '../types';
import { TaskGraphEngine, EventListener } from './task-graph';
import { ArtifactStore } from './artifact-store';
import { AdapterRegistry } from './adapter-registry';

// ─── Runtime Configuration ──────────────────────────────────────

export interface AclRuntimeConfig {
  /** Log all events to console */
  verbose?: boolean;
}

// ─── ACL Runtime ────────────────────────────────────────────────

export class AclRuntime {
  readonly taskGraph: TaskGraphEngine;
  readonly artifactStore: ArtifactStore;
  readonly adapterRegistry: AdapterRegistry;

  private agents: Map<string, AgentCapability> = new Map();
  private events: AclEvent[] = [];
  private verbose: boolean;

  constructor(config: AclRuntimeConfig = {}) {
    this.taskGraph = new TaskGraphEngine();
    this.artifactStore = new ArtifactStore();
    this.adapterRegistry = new AdapterRegistry();
    this.verbose = config.verbose ?? false;

    // Wire up event logging
    this.taskGraph.onEvent((event) => {
      this.events.push(event);
      if (this.verbose) {
        console.log(
          `  [EVENT] ${EventType[event.eventType]} from ${event.source}`,
          event.payload
        );
      }
    });
  }

  // ─── Agent Management ───────────────────────────────────────

  /**
   * Register an agent with its capabilities and optional model adapter
   */
  registerAgent(
    capability: AgentCapability,
    adapter?: ModelAdapter,
    additionalCapabilities?: string[]
  ): string {
    const agentId = capability.agentId;
    if (this.agents.has(agentId)) {
      throw new Error(`Agent already registered: ${agentId}`);
    }

    this.agents.set(agentId, capability);

    // If an adapter is provided, register it
    if (adapter) {
      try {
        this.adapterRegistry.register(
          adapter,
          additionalCapabilities ?? capability.canDo
        );
      } catch {
        // Adapter already registered for this model is OK
      }
    }

    this.log(`Agent registered: ${agentId} (${capability.modelBackend})`);
    return agentId;
  }

  /**
   * Get agent capability
   */
  getAgent(agentId: string): AgentCapability {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    return { ...agent };
  }

  /**
   * List all agents
   */
  listAgents(): AgentCapability[] {
    return Array.from(this.agents.values());
  }

  /**
   * Find agents by capability
   */
  findAgentsByCapability(capability: string): AgentCapability[] {
    return Array.from(this.agents.values()).filter((a) =>
      a.canDo.includes(capability)
    );
  }

  // ─── Task Management ────────────────────────────────────────

  /**
   * Submit a new task
   */
  submitTask(packet: ActionPacket, dependencies: string[] = []): TaskNode {
    if (!packet.packetId) {
      packet = { ...packet, packetId: uuidv4() };
    }
    return this.taskGraph.createTask(packet, dependencies);
  }

  /**
   * Claim a task for an agent
   */
  claimTask(taskId: string, agentId: string): TaskNode {
    if (!this.agents.has(agentId)) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    return this.taskGraph.claimTask(taskId, agentId);
  }

  /**
   * Execute a task using the registered model adapter.
   *
   * This is the core "execution loop":
   * 1. Claim the task
   * 2. Resolve input artifacts
   * 3. Execute via model adapter
   * 4. Publish output artifact
   * 5. Complete/fail the task
   */
  async executeTask(taskId: string, agentId: string): Promise<TaskExecutionOutput> {
    const agent = this.getAgent(agentId);

    // 1. Claim & start
    this.claimTask(taskId, agentId);
    this.taskGraph.startTask(taskId, agentId);
    const task = this.taskGraph.getTask(taskId);

    // 2. Resolve input artifacts
    const inputArtifacts: Artifact[] = [];
    for (const ref of task.artifactRefs) {
      try {
        const artifact = this.artifactStore.getByUri(ref);
        inputArtifacts.push(artifact);
      } catch {
        // Artifact not found, skip
      }
    }

    // Also check if dependency tasks have artifacts
    for (const depId of task.dependencyIds) {
      const depRefs = this.artifactStore.queryByTask(depId);
      for (const depRef of depRefs) {
        try {
          const artifact = this.artifactStore.get(depRef);
          inputArtifacts.push(artifact);
        } catch {
          // skip
        }
      }
    }

    // 3. Build execution input
    const input: TaskExecutionInput = {
      task,
      inputArtifacts,
      agentCapability: agent,
      context: {
        dependencyCount: task.dependencyIds.length,
        retryCount: task.retryCount,
      },
    };

    // 4. Execute via adapter
    let output: TaskExecutionOutput;
    try {
      output = await this.adapterRegistry.executeWithTracking(
        agent.modelBackend,
        input
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown error';
      this.taskGraph.failTask(taskId, agentId, reason);
      return {
        success: false,
        content: '',
        artifactType: task.outputSchema,
        confidence: 0,
        failureReason: reason,
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        latencyMs: 0,
      };
    }

    // 5. Publish output artifact & complete/fail
    if (output.success) {
      const artifactRef = this.artifactStore.publish({
        artifactId: '',
        artifactType: output.artifactType || task.outputSchema,
        contentHash: '',
        content: output.content,
        producerAgent: agentId,
        taskId,
        createdAt: Date.now(),
        metadata: output.metadata ?? {},
      });

      this.taskGraph.completeTask(
        taskId,
        agentId,
        [artifactRef.uri],
        output.confidence
      );

      this.log(
        `Task ${taskId} completed by ${agentId} | ` +
          `confidence=${output.confidence.toFixed(2)} ` +
          `tokens=${output.tokenUsage.totalTokens} ` +
          `latency=${output.latencyMs}ms`
      );
    } else {
      this.taskGraph.failTask(
        taskId,
        agentId,
        output.failureReason || 'Execution failed'
      );
    }

    return output;
  }

  /**
   * Execute all claimable tasks for a given agent
   */
  async executeClaimableTasks(agentId: string): Promise<TaskExecutionOutput[]> {
    const agent = this.getAgent(agentId);
    const claimable = this.taskGraph.getClaimableTasks();
    const results: TaskExecutionOutput[] = [];

    for (const task of claimable) {
      // Check if agent can handle this intent
      if (agent.canDo.includes(task.intent)) {
        const output = await this.executeTask(task.taskId, agentId);
        results.push(output);
      }
    }

    return results;
  }

  // ─── Artifact Management ──────────────────────────────────────

  /**
   * Publish an artifact directly
   */
  publishArtifact(artifact: Artifact): ArtifactReference {
    return this.artifactStore.publish(artifact);
  }

  /**
   * Get an artifact
   */
  getArtifact(ref: ArtifactReference): Artifact {
    return this.artifactStore.get(ref);
  }

  // ─── Event System ─────────────────────────────────────────────

  /**
   * Subscribe to events
   */
  onEvent(listener: EventListener): () => void {
    return this.taskGraph.onEvent(listener);
  }

  /**
   * Get event history
   */
  getEventHistory(): AclEvent[] {
    return [...this.events];
  }

  // ─── Statistics ───────────────────────────────────────────────

  /**
   * Get runtime statistics
   */
  stats(): RuntimeStats {
    const allTasks = this.taskGraph.allTasks();
    return {
      totalTasks: allTasks.length,
      pendingTasks: allTasks.filter((t) => t.state === TaskState.PENDING).length,
      runningTasks: allTasks.filter((t) => t.state === TaskState.RUNNING).length,
      completedTasks: allTasks.filter((t) => t.state === TaskState.DONE).length,
      failedTasks: allTasks.filter((t) => t.state === TaskState.FAILED).length,
      registeredAgents: this.agents.size,
      activeSubagents: 0,
      totalEvents: this.events.length,
      totalArtifacts: this.artifactStore.count,
    };
  }

  /**
   * Get total token usage across all executions
   */
  getTotalTokenUsage(): { input: number; output: number; total: number } {
    // This would aggregate from adapter tracking in production
    return { input: 0, output: 0, total: 0 };
  }

  // ─── Private ──────────────────────────────────────────────────

  private log(msg: string): void {
    if (this.verbose) {
      console.log(`  [ACL] ${msg}`);
    }
  }
}
