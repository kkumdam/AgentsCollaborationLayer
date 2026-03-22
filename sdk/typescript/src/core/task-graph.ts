/**
 * In-Memory Task Graph Engine (TypeScript)
 *
 * Mirrors the Rust TaskGraphEngine for local/embedded usage.
 * For production, use AclClient to connect to the Rust gRPC server.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  ActionPacket,
  TaskNode,
  TaskState,
  AclEvent,
  EventType,
} from '../types';

// ─── Valid State Transitions ────────────────────────────────────

const VALID_TRANSITIONS: Map<TaskState, TaskState[]> = new Map([
  [TaskState.PENDING, [TaskState.CLAIMED, TaskState.CANCELLED]],
  [TaskState.CLAIMED, [TaskState.RUNNING, TaskState.PENDING, TaskState.CANCELLED]],
  [TaskState.RUNNING, [TaskState.DONE, TaskState.FAILED, TaskState.CANCELLED]],
  [TaskState.FAILED, [TaskState.PENDING]], // retry
]);

function isValidTransition(from: TaskState, to: TaskState): boolean {
  return VALID_TRANSITIONS.get(from)?.includes(to) ?? false;
}

// ─── Event Listener ─────────────────────────────────────────────

export type EventListener = (event: AclEvent) => void;

// ─── Task Graph Engine ──────────────────────────────────────────

export class TaskGraphEngine {
  private tasks: Map<string, TaskNode> = new Map();
  private dependents: Map<string, string[]> = new Map();
  private listeners: EventListener[] = [];

  /**
   * Register an event listener
   */
  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(type: EventType, source: string, payload: Record<string, unknown>): void {
    const event: AclEvent = {
      eventId: uuidv4(),
      eventType: type,
      payload,
      timestamp: Date.now(),
      source,
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Don't let listener errors break the engine
      }
    }
  }

  /**
   * Create a new task from an ActionPacket
   */
  createTask(packet: ActionPacket, dependencies: string[] = []): TaskNode {
    // Verify dependencies exist
    for (const depId of dependencies) {
      if (!this.tasks.has(depId)) {
        throw new Error(`Dependency not found: ${depId}`);
      }
    }

    const now = Date.now();
    const taskId = packet.packetId || uuidv4();

    const task: TaskNode = {
      taskId,
      intent: packet.intent,
      state: TaskState.PENDING,
      ownerAgent: '',
      parentTaskId: packet.sourceAgent,
      dependencyIds: dependencies,
      artifactRefs: [],
      priority: packet.priority,
      createdAt: now,
      updatedAt: now,
      deadlineMs: packet.deadlineMs,
      constraints: { ...packet.constraints },
      outputSchema: packet.outputSchema,
      confidence: 0,
      failureReason: '',
      retryCount: 0,
      maxRetries: 3,
    };

    // Register dependents
    for (const depId of dependencies) {
      const deps = this.dependents.get(depId) ?? [];
      deps.push(taskId);
      this.dependents.set(depId, deps);
    }

    this.tasks.set(taskId, task);
    this.emit(EventType.TASK_CREATED, packet.sourceAgent, { taskId, intent: packet.intent });

    return { ...task };
  }

  /**
   * Get a task by ID
   */
  getTask(taskId: string): TaskNode {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return { ...task };
  }

  /**
   * Check if all dependencies are resolved (DONE)
   */
  areDependenciesResolved(taskId: string): boolean {
    const task = this.getTask(taskId);
    return task.dependencyIds.every((depId) => {
      const dep = this.tasks.get(depId);
      return dep?.state === TaskState.DONE;
    });
  }

  /**
   * Claim a pending task
   */
  claimTask(taskId: string, agentId: string): TaskNode {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    if (task.state !== TaskState.PENDING) {
      throw new Error(`Task already claimed by: ${task.ownerAgent}`);
    }

    if (!this.areDependenciesResolved(taskId)) {
      const unresolved = task.dependencyIds.filter((depId) => {
        const dep = this.tasks.get(depId);
        return dep?.state !== TaskState.DONE;
      });
      throw new Error(`Unresolved dependencies: ${unresolved.join(', ')}`);
    }

    task.state = TaskState.CLAIMED;
    task.ownerAgent = agentId;
    task.updatedAt = Date.now();

    this.emit(EventType.TASK_CLAIMED, agentId, { taskId });
    return { ...task };
  }

  /**
   * Start a claimed task
   */
  startTask(taskId: string, agentId: string): TaskNode {
    return this.transitionTask(taskId, agentId, TaskState.RUNNING, EventType.TASK_RUNNING);
  }

  /**
   * Complete a task with artifacts
   */
  completeTask(
    taskId: string,
    agentId: string,
    artifactRefs: string[] = [],
    confidence: number = 1.0
  ): TaskNode {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    this.validateTransition(task, agentId, TaskState.DONE);

    task.state = TaskState.DONE;
    task.artifactRefs = artifactRefs;
    task.confidence = confidence;
    task.updatedAt = Date.now();

    this.emit(EventType.TASK_DONE, agentId, { taskId, artifactRefs, confidence });
    return { ...task };
  }

  /**
   * Fail a task
   */
  failTask(taskId: string, agentId: string, reason: string): TaskNode {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    this.validateTransition(task, agentId, TaskState.FAILED);

    task.state = TaskState.FAILED;
    task.failureReason = reason;
    task.updatedAt = Date.now();

    this.emit(EventType.TASK_FAILED, agentId, { taskId, reason });
    return { ...task };
  }

  /**
   * Retry a failed task
   */
  retryTask(taskId: string): TaskNode {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    if (task.state !== TaskState.FAILED) {
      throw new Error(`Cannot retry task in state: ${TaskState[task.state]}`);
    }

    if (task.retryCount >= task.maxRetries) {
      throw new Error(`Max retries exceeded for task: ${taskId}`);
    }

    task.state = TaskState.PENDING;
    task.ownerAgent = '';
    task.failureReason = '';
    task.retryCount++;
    task.updatedAt = Date.now();

    return { ...task };
  }

  /**
   * Get all claimable tasks (PENDING with resolved dependencies)
   */
  getClaimableTasks(): TaskNode[] {
    return Array.from(this.tasks.values())
      .filter(
        (task) =>
          task.state === TaskState.PENDING &&
          task.dependencyIds.every((depId) => {
            const dep = this.tasks.get(depId);
            return dep?.state === TaskState.DONE;
          })
      )
      .map((t) => ({ ...t }));
  }

  /**
   * Query tasks by state
   */
  queryByState(state: TaskState): TaskNode[] {
    return Array.from(this.tasks.values())
      .filter((t) => t.state === state)
      .map((t) => ({ ...t }));
  }

  /**
   * Query tasks by owner
   */
  queryByOwner(agentId: string): TaskNode[] {
    return Array.from(this.tasks.values())
      .filter((t) => t.ownerAgent === agentId)
      .map((t) => ({ ...t }));
  }

  /**
   * Get all tasks
   */
  allTasks(): TaskNode[] {
    return Array.from(this.tasks.values()).map((t) => ({ ...t }));
  }

  /**
   * Total task count
   */
  get taskCount(): number {
    return this.tasks.size;
  }

  // ─── Private Helpers ──────────────────────────────────────────

  private validateTransition(task: TaskNode, agentId: string, newState: TaskState): void {
    if (!isValidTransition(task.state, newState)) {
      throw new Error(
        `Invalid state transition: ${TaskState[task.state]} -> ${TaskState[newState]}`
      );
    }

    if (task.ownerAgent && task.ownerAgent !== agentId) {
      throw new Error(
        `Ownership mismatch: expected ${task.ownerAgent}, got ${agentId}`
      );
    }
  }

  private transitionTask(
    taskId: string,
    agentId: string,
    newState: TaskState,
    eventType: EventType
  ): TaskNode {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    this.validateTransition(task, agentId, newState);

    task.state = newState;
    task.updatedAt = Date.now();

    this.emit(eventType, agentId, { taskId });
    return { ...task };
  }
}
