//! Task Graph Engine
//!
//! Manages the directed acyclic graph (DAG) of tasks.
//! Handles task creation, dependency resolution, claim/release mechanics,
//! ownership tracking, state transitions, and retry logic.

use std::sync::Arc;

use chrono::Utc;
use dashmap::DashMap;
use tracing::{info, warn};
use uuid::Uuid;

use acl_proto::{ActionPacket, TaskNode, TaskState};

use crate::error::{AclError, AclResult};

/// Valid state transitions for the task lifecycle
fn is_valid_transition(from: TaskState, to: TaskState) -> bool {
    matches!(
        (from, to),
        (TaskState::Pending, TaskState::Claimed)
            | (TaskState::Pending, TaskState::Cancelled)
            | (TaskState::Claimed, TaskState::Running)
            | (TaskState::Claimed, TaskState::Pending) // release
            | (TaskState::Claimed, TaskState::Cancelled)
            | (TaskState::Running, TaskState::Done)
            | (TaskState::Running, TaskState::Failed)
            | (TaskState::Running, TaskState::Cancelled)
            | (TaskState::Failed, TaskState::Pending) // retry
    )
}

/// In-memory Task Graph Engine
#[derive(Debug, Clone)]
pub struct TaskGraphEngine {
    tasks: Arc<DashMap<String, TaskNode>>,
    /// task_id -> list of dependent task IDs (children waiting on this task)
    dependents: Arc<DashMap<String, Vec<String>>>,
}

impl TaskGraphEngine {
    pub fn new() -> Self {
        Self {
            tasks: Arc::new(DashMap::new()),
            dependents: Arc::new(DashMap::new()),
        }
    }

    /// Create a new task from an ActionPacket
    pub fn create_task(&self, packet: &ActionPacket, dependencies: Vec<String>) -> AclResult<TaskNode> {
        let now = Utc::now().timestamp_millis();
        let task_id = if packet.packet_id.is_empty() {
            Uuid::new_v4().to_string()
        } else {
            packet.packet_id.clone()
        };

        // Verify all dependencies exist
        for dep_id in &dependencies {
            if !self.tasks.contains_key(dep_id) {
                return Err(AclError::TaskNotFound(dep_id.clone()));
            }
        }

        let task = TaskNode {
            task_id: task_id.clone(),
            intent: packet.intent.clone(),
            state: TaskState::Pending.into(),
            owner_agent: String::new(),
            parent_task_id: packet.source_agent.clone(),
            dependency_ids: dependencies.clone(),
            artifact_refs: vec![],
            priority: packet.priority,
            created_at: now,
            updated_at: now,
            deadline_ms: packet.deadline_ms,
            constraints: packet.constraints.clone(),
            output_schema: packet.output_schema.clone(),
            confidence: 0.0,
            failure_reason: String::new(),
            retry_count: 0,
            max_retries: 3,
            prompt: packet.prompt.clone(),
        };

        // Register this task as a dependent of its dependencies
        for dep_id in &dependencies {
            self.dependents
                .entry(dep_id.clone())
                .or_insert_with(Vec::new)
                .push(task_id.clone());
        }

        self.tasks.insert(task_id.clone(), task.clone());
        info!(task_id = %task_id, intent = %packet.intent, "Task created");
        Ok(task)
    }

    /// Get a task by ID
    pub fn get_task(&self, task_id: &str) -> AclResult<TaskNode> {
        self.tasks
            .get(task_id)
            .map(|t| t.value().clone())
            .ok_or_else(|| AclError::TaskNotFound(task_id.to_string()))
    }

    /// Check if all dependencies of a task are resolved (DONE)
    pub fn are_dependencies_resolved(&self, task_id: &str) -> AclResult<bool> {
        let task = self.get_task(task_id)?;
        for dep_id in &task.dependency_ids {
            let dep = self.get_task(dep_id)?;
            if dep.state() != TaskState::Done {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// Get unresolved dependency IDs for a task
    pub fn get_unresolved_dependencies(&self, task_id: &str) -> AclResult<Vec<String>> {
        let task = self.get_task(task_id)?;
        let mut unresolved = vec![];
        for dep_id in &task.dependency_ids {
            let dep = self.get_task(dep_id)?;
            if dep.state() != TaskState::Done {
                unresolved.push(dep_id.clone());
            }
        }
        Ok(unresolved)
    }

    /// Claim a pending task for an agent
    pub fn claim_task(&self, task_id: &str, agent_id: &str) -> AclResult<TaskNode> {
        // Check dependencies BEFORE acquiring write lock to avoid deadlock.
        // DashMap's get_mut holds a per-shard write lock; if a dependency
        // hashes to the same shard, get_unresolved_dependencies would need
        // a read lock on that shard and deadlock.
        let unresolved = self.get_unresolved_dependencies(task_id)?;
        if !unresolved.is_empty() {
            return Err(AclError::UnresolvedDependencies(unresolved));
        }

        let mut task = self.tasks
            .get_mut(task_id)
            .ok_or_else(|| AclError::TaskNotFound(task_id.to_string()))?;

        let current_state = task.state();
        if current_state != TaskState::Pending {
            return Err(AclError::TaskAlreadyClaimed(
                task.owner_agent.clone(),
            ));
        }

        task.state = TaskState::Claimed.into();
        task.owner_agent = agent_id.to_string();
        task.updated_at = Utc::now().timestamp_millis();

        info!(task_id = %task_id, agent_id = %agent_id, "Task claimed");
        Ok(task.clone())
    }

    /// Transition task to RUNNING state
    pub fn start_task(&self, task_id: &str, agent_id: &str) -> AclResult<TaskNode> {
        self.transition_task(task_id, agent_id, TaskState::Running, None, None)
    }

    /// Complete a task with artifacts
    pub fn complete_task(
        &self,
        task_id: &str,
        agent_id: &str,
        artifact_refs: Vec<String>,
        confidence: f32,
    ) -> AclResult<TaskNode> {
        self.transition_task(
            task_id,
            agent_id,
            TaskState::Done,
            Some(artifact_refs),
            Some(confidence),
        )
    }

    /// Fail a task with a reason
    pub fn fail_task(
        &self,
        task_id: &str,
        agent_id: &str,
        reason: &str,
    ) -> AclResult<TaskNode> {
        let mut task = self.tasks
            .get_mut(task_id)
            .ok_or_else(|| AclError::TaskNotFound(task_id.to_string()))?;

        let current_state = task.state();
        if !is_valid_transition(current_state, TaskState::Failed) {
            return Err(AclError::InvalidStateTransition {
                from: current_state,
                to: TaskState::Failed,
            });
        }

        if task.owner_agent != agent_id {
            return Err(AclError::OwnershipMismatch {
                expected: task.owner_agent.clone(),
                actual: agent_id.to_string(),
            });
        }

        task.state = TaskState::Failed.into();
        task.failure_reason = reason.to_string();
        task.updated_at = Utc::now().timestamp_millis();

        warn!(task_id = %task_id, reason = %reason, "Task failed");
        Ok(task.clone())
    }

    /// Retry a failed task (transitions FAILED -> PENDING)
    pub fn retry_task(&self, task_id: &str) -> AclResult<TaskNode> {
        let mut task = self.tasks
            .get_mut(task_id)
            .ok_or_else(|| AclError::TaskNotFound(task_id.to_string()))?;

        if task.state() != TaskState::Failed {
            return Err(AclError::InvalidStateTransition {
                from: task.state(),
                to: TaskState::Pending,
            });
        }

        if task.retry_count >= task.max_retries {
            return Err(AclError::MaxRetriesExceeded(task_id.to_string()));
        }

        task.state = TaskState::Pending.into();
        task.owner_agent = String::new();
        task.failure_reason = String::new();
        task.retry_count += 1;
        task.updated_at = Utc::now().timestamp_millis();

        info!(task_id = %task_id, retry = task.retry_count, "Task retrying");
        Ok(task.clone())
    }

    /// Release a claimed task back to PENDING
    pub fn release_task(&self, task_id: &str, agent_id: &str) -> AclResult<TaskNode> {
        let mut task = self.tasks
            .get_mut(task_id)
            .ok_or_else(|| AclError::TaskNotFound(task_id.to_string()))?;

        if task.state() != TaskState::Claimed {
            return Err(AclError::InvalidStateTransition {
                from: task.state(),
                to: TaskState::Pending,
            });
        }

        if task.owner_agent != agent_id {
            return Err(AclError::OwnershipMismatch {
                expected: task.owner_agent.clone(),
                actual: agent_id.to_string(),
            });
        }

        task.state = TaskState::Pending.into();
        task.owner_agent = String::new();
        task.updated_at = Utc::now().timestamp_millis();

        info!(task_id = %task_id, "Task released");
        Ok(task.clone())
    }

    /// Cancel a task
    pub fn cancel_task(&self, task_id: &str) -> AclResult<TaskNode> {
        let mut task = self.tasks
            .get_mut(task_id)
            .ok_or_else(|| AclError::TaskNotFound(task_id.to_string()))?;

        let current_state = task.state();
        if !is_valid_transition(current_state, TaskState::Cancelled) {
            return Err(AclError::InvalidStateTransition {
                from: current_state,
                to: TaskState::Cancelled,
            });
        }

        task.state = TaskState::Cancelled.into();
        task.updated_at = Utc::now().timestamp_millis();

        info!(task_id = %task_id, "Task cancelled");
        Ok(task.clone())
    }

    /// Generic state transition with validation
    fn transition_task(
        &self,
        task_id: &str,
        agent_id: &str,
        new_state: TaskState,
        artifact_refs: Option<Vec<String>>,
        confidence: Option<f32>,
    ) -> AclResult<TaskNode> {
        let mut task = self.tasks
            .get_mut(task_id)
            .ok_or_else(|| AclError::TaskNotFound(task_id.to_string()))?;

        let current_state = task.state();
        if !is_valid_transition(current_state, new_state) {
            return Err(AclError::InvalidStateTransition {
                from: current_state,
                to: new_state,
            });
        }

        if !task.owner_agent.is_empty() && task.owner_agent != agent_id {
            return Err(AclError::OwnershipMismatch {
                expected: task.owner_agent.clone(),
                actual: agent_id.to_string(),
            });
        }

        task.state = new_state.into();
        task.updated_at = Utc::now().timestamp_millis();

        if let Some(refs) = artifact_refs {
            task.artifact_refs = refs;
        }
        if let Some(conf) = confidence {
            task.confidence = conf;
        }

        info!(
            task_id = %task_id,
            from = ?current_state,
            to = ?new_state,
            "Task state transition"
        );
        Ok(task.clone())
    }

    /// Query tasks by state
    pub fn query_by_state(&self, state: TaskState) -> Vec<TaskNode> {
        self.tasks
            .iter()
            .filter(|entry| entry.value().state() == state)
            .map(|entry| entry.value().clone())
            .collect()
    }

    /// Query tasks by owner
    pub fn query_by_owner(&self, agent_id: &str) -> Vec<TaskNode> {
        self.tasks
            .iter()
            .filter(|entry| entry.value().owner_agent == agent_id)
            .map(|entry| entry.value().clone())
            .collect()
    }

    /// Query tasks by intent
    pub fn query_by_intent(&self, intent: &str) -> Vec<TaskNode> {
        self.tasks
            .iter()
            .filter(|entry| entry.value().intent == intent)
            .map(|entry| entry.value().clone())
            .collect()
    }

    /// Get all pending tasks that have resolved dependencies (ready to claim)
    pub fn get_claimable_tasks(&self) -> Vec<TaskNode> {
        self.tasks
            .iter()
            .filter(|entry| {
                let task = entry.value();
                task.state() == TaskState::Pending
                    && task.dependency_ids.iter().all(|dep_id| {
                        self.tasks
                            .get(dep_id)
                            .map(|d| d.state() == TaskState::Done)
                            .unwrap_or(false)
                    })
            })
            .map(|entry| entry.value().clone())
            .collect()
    }

    /// Get total task count
    pub fn task_count(&self) -> usize {
        self.tasks.len()
    }

    /// Get all tasks
    pub fn all_tasks(&self) -> Vec<TaskNode> {
        self.tasks.iter().map(|e| e.value().clone()).collect()
    }
}

impl Default for TaskGraphEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_packet(intent: &str) -> ActionPacket {
        ActionPacket {
            packet_id: Uuid::new_v4().to_string(),
            source_agent: "test-supervisor".to_string(),
            target_agent: String::new(),
            intent: intent.to_string(),
            input_refs: vec![],
            constraints: Default::default(),
            output_schema: String::new(),
            priority: 0.5,
            deadline_ms: 0,
        }
    }

    #[test]
    fn test_create_and_claim_task() {
        let engine = TaskGraphEngine::new();
        let packet = make_packet("code_review");
        let task = engine.create_task(&packet, vec![]).unwrap();
        assert_eq!(task.state(), TaskState::Pending);

        let claimed = engine.claim_task(&task.task_id, "worker-1").unwrap();
        assert_eq!(claimed.state(), TaskState::Claimed);
        assert_eq!(claimed.owner_agent, "worker-1");
    }

    #[test]
    fn test_full_lifecycle() {
        let engine = TaskGraphEngine::new();
        let packet = make_packet("summarize");
        let task = engine.create_task(&packet, vec![]).unwrap();

        // PENDING -> CLAIMED
        engine.claim_task(&task.task_id, "agent-a").unwrap();
        // CLAIMED -> RUNNING
        engine.start_task(&task.task_id, "agent-a").unwrap();
        // RUNNING -> DONE
        let done = engine
            .complete_task(&task.task_id, "agent-a", vec!["artifact://doc/abc".into()], 0.95)
            .unwrap();
        assert_eq!(done.state(), TaskState::Done);
        assert_eq!(done.artifact_refs, vec!["artifact://doc/abc"]);
        assert!((done.confidence - 0.95).abs() < f32::EPSILON);
    }

    #[test]
    fn test_dependency_blocking() {
        let engine = TaskGraphEngine::new();

        let p1 = make_packet("research");
        let task1 = engine.create_task(&p1, vec![]).unwrap();

        let p2 = make_packet("write_report");
        let task2 = engine.create_task(&p2, vec![task1.task_id.clone()]).unwrap();

        // task2 should not be claimable because task1 is not done
        let result = engine.claim_task(&task2.task_id, "writer");
        assert!(result.is_err());

        // Complete task1
        engine.claim_task(&task1.task_id, "researcher").unwrap();
        engine.start_task(&task1.task_id, "researcher").unwrap();
        engine.complete_task(&task1.task_id, "researcher", vec![], 1.0).unwrap();

        // Now task2 should be claimable
        let claimed = engine.claim_task(&task2.task_id, "writer").unwrap();
        assert_eq!(claimed.state(), TaskState::Claimed);
    }

    #[test]
    fn test_retry_logic() {
        let engine = TaskGraphEngine::new();
        let packet = make_packet("flaky_task");
        let task = engine.create_task(&packet, vec![]).unwrap();

        engine.claim_task(&task.task_id, "worker").unwrap();
        engine.start_task(&task.task_id, "worker").unwrap();
        engine.fail_task(&task.task_id, "worker", "timeout").unwrap();

        let retried = engine.retry_task(&task.task_id).unwrap();
        assert_eq!(retried.state(), TaskState::Pending);
        assert_eq!(retried.retry_count, 1);
    }

    #[test]
    fn test_claimable_tasks() {
        let engine = TaskGraphEngine::new();

        let p1 = make_packet("task_a");
        let t1 = engine.create_task(&p1, vec![]).unwrap();

        let p2 = make_packet("task_b");
        let t2 = engine.create_task(&p2, vec![t1.task_id.clone()]).unwrap();

        let claimable = engine.get_claimable_tasks();
        assert_eq!(claimable.len(), 1);
        assert_eq!(claimable[0].task_id, t1.task_id);

        // Complete t1, now t2 should be claimable
        engine.claim_task(&t1.task_id, "a").unwrap();
        engine.start_task(&t1.task_id, "a").unwrap();
        engine.complete_task(&t1.task_id, "a", vec![], 1.0).unwrap();

        let claimable = engine.get_claimable_tasks();
        assert_eq!(claimable.len(), 1);
        assert_eq!(claimable[0].task_id, t2.task_id);
    }
}
