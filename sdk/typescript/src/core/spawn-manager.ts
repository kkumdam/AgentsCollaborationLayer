/**
 * Spawn Manager (TypeScript SDK)
 *
 * Controls subagent lifecycle: creation, budget allocation,
 * TTL enforcement, spawn depth limits, and graceful termination.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  AgentCapability,
  SpawnPolicy,
  SpawnType,
  SpawnTree,
  SpawnRequest,
  SpawnResponse,
  EventType,
} from '../types';
import { PolicyEngine, PolicyConfig, PolicyViolationError } from './policy-engine';
import { AdapterRegistry } from './adapter-registry';

// ─── Spawned Agent Tracking ─────────────────────────────────────

interface SpawnedAgent {
  agentId: string;
  parentId: string;
  spawnType: SpawnType;
  aliveSince: number;
  budgetAllocated: number;
  children: string[];
  active: boolean;
}

// ─── Spawn Manager ──────────────────────────────────────────────

export class SpawnManager {
  private spawned: Map<string, SpawnedAgent> = new Map();
  private policyEngine: PolicyEngine;
  private onEventCallback?: (type: EventType, agentId: string, data: Record<string, unknown>) => void;

  constructor(policyEngine: PolicyEngine) {
    this.policyEngine = policyEngine;
  }

  /**
   * Set event callback for integration with runtime
   */
  onEvent(cb: (type: EventType, agentId: string, data: Record<string, unknown>) => void): void {
    this.onEventCallback = cb;
  }

  /**
   * Register a root agent for spawn tree tracking
   */
  registerRoot(agentId: string): void {
    this.spawned.set(agentId, {
      agentId,
      parentId: '',
      spawnType: SpawnType.PERSISTENT,
      aliveSince: Date.now(),
      budgetAllocated: 0,
      children: [],
      active: true,
    });
  }

  /**
   * Spawn a new subagent with policy enforcement
   */
  spawn(
    parentId: string,
    agentId: string | undefined,
    capability: AgentCapability,
    policy: SpawnPolicy,
    spawnType: SpawnType
  ): SpawnResponse {
    // 1. Evaluate policy
    try {
      this.policyEngine.evaluateSpawn(parentId, policy, spawnType);
    } catch (error) {
      if (error instanceof PolicyViolationError) {
        this.onEventCallback?.(EventType.POLICY_VIOLATION, parentId, {
          violation: error.violationType,
          message: error.message,
        });
        return { success: false, agentId: '', failureReason: error.message };
      }
      throw error;
    }

    // 2. Generate ID
    const id = agentId || `agent-${uuidv4().split('-')[0]}`;

    // 3. Register child policy
    const parentState = this.policyEngine.getState(parentId);
    const childPolicyConfig: PolicyConfig = {
      spawnLimit: policy.spawnLimit,
      spawnDepthLimit: policy.spawnDepth,
      toolAccess: policy.toolAccess,
      budgetUsd: policy.budgetUsd,
      ttlSeconds: policy.ttlSeconds,
      memoryScope: policy.memoryScope,
      maxRetries: 3,
      allowedModels: [],
    };
    this.policyEngine.registerAgentPolicy(
      id,
      parentId,
      childPolicyConfig,
      parentState.spawnDepth + 1
    );

    // 4. Record spawn in parent
    this.policyEngine.recordSpawn(parentId, spawnType === SpawnType.VIRTUAL ? 0 : policy.budgetUsd);

    // 5. Track spawned agent
    this.spawned.set(id, {
      agentId: id,
      parentId,
      spawnType,
      aliveSince: Date.now(),
      budgetAllocated: policy.budgetUsd,
      children: [],
      active: true,
    });

    // 6. Add as child of parent
    const parent = this.spawned.get(parentId);
    if (parent) parent.children.push(id);

    // 7. Emit event
    this.onEventCallback?.(EventType.SUBAGENT_SPAWNED, parentId, {
      agentId: id,
      parentAgent: parentId,
      spawnType: SpawnType[spawnType],
    });

    return { success: true, agentId: id, failureReason: '' };
  }

  /**
   * Terminate a subagent and all its children
   */
  terminate(agentId: string, reason: string): void {
    const agent = this.spawned.get(agentId);
    if (!agent) throw new Error(`Spawned agent not found: ${agentId}`);

    // Recursively terminate children
    for (const childId of [...agent.children]) {
      try {
        this.terminate(childId, 'parent terminated');
      } catch {
        // ignore
      }
    }

    agent.active = false;
    this.policyEngine.deactivate(agentId);

    this.onEventCallback?.(EventType.SUBAGENT_TERMINATED, agentId, {
      agentId,
      reason,
    });
  }

  /**
   * Enforce TTL on all spawned agents, returns list of expired IDs
   */
  enforceTtl(): string[] {
    const expired: string[] = [];
    for (const [id, agent] of this.spawned) {
      if (agent.active && this.policyEngine.checkTtl(id)) {
        expired.push(id);
      }
    }
    for (const id of expired) {
      this.terminate(id, 'TTL expired');
    }
    return expired;
  }

  /**
   * Build spawn tree visualization
   */
  getSpawnTree(rootId: string): SpawnTree {
    const agent = this.spawned.get(rootId);
    if (!agent) throw new Error(`Agent not found: ${rootId}`);

    let policyState;
    try {
      policyState = this.policyEngine.getState(rootId);
    } catch {
      policyState = null;
    }

    const children = agent.children
      .map((childId) => {
        try {
          return this.getSpawnTree(childId);
        } catch {
          return null;
        }
      })
      .filter((c): c is SpawnTree => c !== null);

    return {
      agentId: rootId,
      type: agent.spawnType,
      policy: policyState
        ? {
            spawnLimit: policyState.policy.spawnLimit,
            spawnDepth: policyState.policy.spawnDepthLimit,
            toolAccess: policyState.policy.toolAccess,
            budgetUsd: policyState.policy.budgetUsd,
            ttlSeconds: policyState.policy.ttlSeconds,
            memoryScope: policyState.policy.memoryScope,
          }
        : { spawnLimit: 0, spawnDepth: 0, toolAccess: [], budgetUsd: 0, ttlSeconds: 0, memoryScope: '' },
      budgetUsed: policyState?.budgetUsed ?? 0,
      aliveSince: agent.aliveSince,
      children,
    };
  }

  /**
   * Count active spawned agents
   */
  get activeCount(): number {
    let count = 0;
    for (const agent of this.spawned.values()) {
      if (agent.active) count++;
    }
    return count;
  }

  /**
   * Check if agent is active
   */
  isActive(agentId: string): boolean {
    return this.spawned.get(agentId)?.active ?? false;
  }
}
