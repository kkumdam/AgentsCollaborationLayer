/**
 * Policy Engine (TypeScript SDK)
 *
 * Enforces budget caps, TTL, spawn depth/limit, and tool access permissions.
 * Every spawn and execution passes through policy evaluation.
 */

import { SpawnPolicy, SpawnType, SpawnRequest } from '../types';

// ─── Policy Configuration ───────────────────────────────────────

export interface PolicyConfig {
  spawnLimit: number;
  spawnDepthLimit: number;
  toolAccess: string[];
  budgetUsd: number;
  ttlSeconds: number;
  memoryScope: string;
  maxRetries: number;
  allowedModels: string[];
}

export const DEFAULT_POLICY: PolicyConfig = {
  spawnLimit: 10,
  spawnDepthLimit: 3,
  toolAccess: [],
  budgetUsd: 5.0,
  ttlSeconds: 600,
  memoryScope: 'default',
  maxRetries: 3,
  allowedModels: [],
};

// ─── Agent Policy State ─────────────────────────────────────────

export interface AgentPolicyState {
  agentId: string;
  parentAgent?: string;
  policy: PolicyConfig;
  budgetUsed: number;
  spawnCount: number;
  spawnDepth: number;
  active: boolean;
  createdAt: number; // ms timestamp
}

// ─── Policy Violation ───────────────────────────────────────────

export class PolicyViolationError extends Error {
  constructor(
    public readonly violationType: string,
    message: string
  ) {
    super(`Policy violation [${violationType}]: ${message}`);
    this.name = 'PolicyViolationError';
  }
}

// ─── Policy Engine ──────────────────────────────────────────────

export class PolicyEngine {
  private agentPolicies: Map<string, AgentPolicyState> = new Map();
  private defaultPolicy: PolicyConfig;

  constructor(defaultPolicy: PolicyConfig = DEFAULT_POLICY) {
    this.defaultPolicy = { ...defaultPolicy };
  }

  /**
   * Register an agent's policy state
   */
  registerAgentPolicy(
    agentId: string,
    parentAgent: string | undefined,
    policy: PolicyConfig,
    spawnDepth: number
  ): void {
    this.agentPolicies.set(agentId, {
      agentId,
      parentAgent,
      policy: { ...policy },
      budgetUsed: 0,
      spawnCount: 0,
      spawnDepth,
      active: true,
      createdAt: Date.now(),
    });
  }

  /**
   * Evaluate whether a spawn request is allowed
   */
  evaluateSpawn(parentId: string, childPolicy: SpawnPolicy, spawnType: SpawnType): void {
    const parent = this.getState(parentId);

    // Spawn limit
    if (parent.spawnCount >= parent.policy.spawnLimit) {
      throw new PolicyViolationError(
        'SPAWN_LIMIT',
        `Agent ${parentId} has reached spawn limit (${parent.spawnCount}/${parent.policy.spawnLimit})`
      );
    }

    // Spawn depth
    const newDepth = parent.spawnDepth + 1;
    if (newDepth > parent.policy.spawnDepthLimit) {
      throw new PolicyViolationError(
        'SPAWN_DEPTH',
        `Depth ${newDepth} exceeds limit ${parent.policy.spawnDepthLimit}`
      );
    }

    // Budget (skip for virtual spawns)
    if (spawnType !== SpawnType.VIRTUAL) {
      const remaining = parent.policy.budgetUsd - parent.budgetUsed;
      if (childPolicy.budgetUsd > remaining) {
        throw new PolicyViolationError(
          'BUDGET',
          `Requested $${childPolicy.budgetUsd.toFixed(2)} but only $${remaining.toFixed(2)} remaining`
        );
      }
    }

    // Tool access inheritance
    if (parent.policy.toolAccess.length > 0) {
      for (const tool of childPolicy.toolAccess) {
        if (!parent.policy.toolAccess.includes(tool)) {
          throw new PolicyViolationError(
            'TOOL_ACCESS',
            `Tool "${tool}" not in parent's allowed tools`
          );
        }
      }
    }
  }

  /**
   * Record a successful spawn
   */
  recordSpawn(parentId: string, childBudget: number): void {
    const state = this.agentPolicies.get(parentId);
    if (!state) throw new Error(`Agent not found: ${parentId}`);
    state.spawnCount++;
    state.budgetUsed += childBudget;
  }

  /**
   * Record cost usage
   */
  recordCost(agentId: string, cost: number): void {
    const state = this.agentPolicies.get(agentId);
    if (!state) throw new Error(`Agent not found: ${agentId}`);

    const newTotal = state.budgetUsed + cost;
    if (newTotal > state.policy.budgetUsd) {
      throw new PolicyViolationError(
        'BUDGET_EXCEEDED',
        `$${newTotal.toFixed(4)} exceeds limit $${state.policy.budgetUsd.toFixed(2)}`
      );
    }
    state.budgetUsed = newTotal;
  }

  /**
   * Check TTL expiration
   */
  checkTtl(agentId: string): boolean {
    const state = this.getState(agentId);
    if (state.policy.ttlSeconds <= 0) return false;
    const elapsedSec = (Date.now() - state.createdAt) / 1000;
    return elapsedSec > state.policy.ttlSeconds;
  }

  /**
   * Check tool access
   */
  checkToolAccess(agentId: string, tool: string): boolean {
    const state = this.getState(agentId);
    if (state.policy.toolAccess.length === 0) return true;
    return state.policy.toolAccess.includes(tool);
  }

  /**
   * Remaining budget
   */
  remainingBudget(agentId: string): number {
    const state = this.getState(agentId);
    return state.policy.budgetUsd - state.budgetUsed;
  }

  /**
   * Deactivate agent
   */
  deactivate(agentId: string): void {
    const state = this.agentPolicies.get(agentId);
    if (state) state.active = false;
  }

  /**
   * Get policy state
   */
  getState(agentId: string): AgentPolicyState {
    const state = this.agentPolicies.get(agentId);
    if (!state) throw new Error(`Agent policy not found: ${agentId}`);
    return state;
  }

  get defaultPolicyConfig(): PolicyConfig {
    return { ...this.defaultPolicy };
  }
}
