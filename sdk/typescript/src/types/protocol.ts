/**
 * ACL Protocol Types
 *
 * TypeScript equivalents of the Protocol Buffers definitions.
 * These types form the contract between agents on the ACL runtime.
 */

// ─── Enumerations ───────────────────────────────────────────────

export enum TaskState {
  UNSPECIFIED = 0,
  PENDING = 1,
  CLAIMED = 2,
  RUNNING = 3,
  DONE = 4,
  FAILED = 5,
  CANCELLED = 6,
}

export enum SpawnType {
  UNSPECIFIED = 0,
  EPHEMERAL = 1,
  PERSISTENT = 2,
  VIRTUAL = 3,
}

export enum EventType {
  UNSPECIFIED = 0,
  TASK_CREATED = 1,
  TASK_CLAIMED = 2,
  TASK_RUNNING = 3,
  TASK_DONE = 4,
  TASK_FAILED = 5,
  TASK_CANCELLED = 6,
  ARTIFACT_PUBLISHED = 7,
  REVIEW_REQUESTED = 8,
  REVIEW_APPROVED = 9,
  REVIEW_REJECTED = 10,
  SUBAGENT_SPAWNED = 11,
  SUBAGENT_TERMINATED = 12,
  POLICY_VIOLATION = 13,
  AGENT_REGISTERED = 14,
  AGENT_DEREGISTERED = 15,
}

// ─── Core Messages ──────────────────────────────────────────────

export interface ActionPacket {
  packetId: string;
  sourceAgent: string;
  targetAgent: string;
  intent: string;
  inputRefs: string[];
  constraints: Record<string, string>;
  outputSchema: string;
  priority: number;
  deadlineMs: number;
}

export interface StateUpdate {
  taskId: string;
  state: TaskState;
  ownerAgent: string;
  artifactRefs: string[];
  confidence: number;
  failureReason: string;
  timestampMs: number;
}

export interface SpawnRequest {
  parentAgent: string;
  spec: AgentSpec;
  policy: SpawnPolicy;
  type: SpawnType;
  memoryRefs: string[];
}

export interface SpawnResponse {
  success: boolean;
  agentId: string;
  failureReason: string;
}

// ─── Agent Specification ────────────────────────────────────────

export interface AgentSpec {
  agentId: string;
  modelBackend: string;
  canDo: string[];
  requires: string[];
  produces: string[];
}

export interface SpawnPolicy {
  spawnLimit: number;
  spawnDepth: number;
  toolAccess: string[];
  budgetUsd: number;
  ttlSeconds: number;
  memoryScope: string;
}

export interface CostProfile {
  inputCostPer1k: number;
  outputCostPer1k: number;
  toolCallCost: number;
}

export interface AgentCapability {
  agentId: string;
  modelBackend: string;
  canDo: string[];
  requires: string[];
  produces: string[];
  cost: CostProfile;
  avgLatencyMs: number;
  trustScore: number;
}

// ─── Task Graph ─────────────────────────────────────────────────

export interface TaskNode {
  taskId: string;
  intent: string;
  state: TaskState;
  ownerAgent: string;
  parentTaskId: string;
  dependencyIds: string[];
  artifactRefs: string[];
  priority: number;
  createdAt: number;
  updatedAt: number;
  deadlineMs: number;
  constraints: Record<string, string>;
  outputSchema: string;
  confidence: number;
  failureReason: string;
  retryCount: number;
  maxRetries: number;
}

// ─── Artifact Store ─────────────────────────────────────────────

export interface Artifact {
  artifactId: string;
  artifactType: string;
  contentHash: string;
  content: Buffer | string;
  producerAgent: string;
  taskId: string;
  createdAt: number;
  metadata: Record<string, string>;
}

export interface ArtifactReference {
  uri: string;
  artifactType: string;
  contentHash: string;
}

// ─── Event System ───────────────────────────────────────────────

export interface AclEvent {
  eventId: string;
  eventType: EventType;
  payload: Record<string, unknown>;
  timestamp: number;
  source: string;
}

// ─── Query System ───────────────────────────────────────────────

export interface TaskQuery {
  taskId?: string;
  stateFilter?: TaskState;
  ownerFilter?: string;
  intentFilter?: string;
}

export interface AgentQuery {
  agentId?: string;
  capabilityFilter?: string;
  modelFilter?: string;
}

export interface ArtifactQuery {
  artifactId?: string;
  typeFilter?: string;
  taskIdFilter?: string;
}

export interface QueryResponse {
  queryId: string;
  tasks: TaskNode[];
  agents: AgentCapability[];
  artifacts: ArtifactReference[];
}

// ─── Spawn Tree ─────────────────────────────────────────────────

export interface SpawnTree {
  agentId: string;
  type: SpawnType;
  policy: SpawnPolicy;
  budgetUsed: number;
  aliveSince: number;
  children: SpawnTree[];
}

// ─── Runtime Stats ──────────────────────────────────────────────

export interface RuntimeStats {
  totalTasks: number;
  pendingTasks: number;
  runningTasks: number;
  completedTasks: number;
  failedTasks: number;
  registeredAgents: number;
  activeSubagents: number;
  totalEvents: number;
  totalArtifacts: number;
}
