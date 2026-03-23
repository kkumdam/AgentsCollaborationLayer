//! ACL Runtime
//!
//! The central orchestrator that ties together all core components:
//! Task Graph, Agent Registry, Event Bus, Policy Engine, Spawn Manager,
//! and Artifact Store into a unified runtime.

use tracing::info;
use acl_proto::{
    ActionPacket, AgentCapability, Artifact, ArtifactReference, EventType,
    SpawnRequest, SpawnResponse, StateUpdate, TaskNode, TaskState,
};

use crate::agent_registry::AgentRegistry;
use crate::artifact_store::ArtifactStore;
use crate::error::{AclError, AclResult};
use crate::event_bus::{EventBus, EventFilter};
use crate::policy_engine::{PolicyConfig, PolicyEngine};
use crate::spawn_manager::SpawnManager;
use crate::task_graph::TaskGraphEngine;

/// ACL Runtime configuration
#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    pub event_bus_capacity: usize,
    pub default_policy: PolicyConfig,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            event_bus_capacity: 10000,
            default_policy: PolicyConfig::default(),
        }
    }
}

/// The central ACL Runtime
#[derive(Clone)]
pub struct AclRuntime {
    pub task_graph: TaskGraphEngine,
    pub registry: AgentRegistry,
    pub event_bus: EventBus,
    pub policy_engine: PolicyEngine,
    pub spawn_manager: SpawnManager,
    pub artifact_store: ArtifactStore,
}

impl AclRuntime {
    /// Create a new ACL Runtime with the given configuration
    pub fn new(config: RuntimeConfig) -> Self {
        let registry = AgentRegistry::new();
        let event_bus = EventBus::new(config.event_bus_capacity);
        let policy_engine = PolicyEngine::new(config.default_policy);
        let artifact_store = ArtifactStore::new();
        let spawn_manager = SpawnManager::new(
            registry.clone(),
            policy_engine.clone(),
            event_bus.clone(),
        );
        let task_graph = TaskGraphEngine::new();

        info!("ACL Runtime initialized");

        Self {
            task_graph,
            registry,
            event_bus,
            policy_engine,
            spawn_manager,
            artifact_store,
        }
    }

    // ─── Agent Operations ───────────────────────────────────────

    /// Register a new agent
    pub fn register_agent(&self, capability: AgentCapability) -> AclResult<String> {
        let agent_id = capability.agent_id.clone();
        self.registry.register(capability)?;

        // Register default policy for the agent
        self.policy_engine.register_agent_policy(
            &agent_id,
            None,
            self.policy_engine.default_policy().clone(),
            0,
        );

        self.event_bus.publish(
            EventType::AgentRegistered,
            serde_json::json!({"agent_id": &agent_id}).to_string().into_bytes(),
            &agent_id,
        )?;

        Ok(agent_id)
    }

    /// Deregister an agent
    pub fn deregister_agent(&self, agent_id: &str) -> AclResult<()> {
        self.registry.deregister(agent_id)?;
        self.policy_engine.deactivate(agent_id)?;

        self.event_bus.publish(
            EventType::AgentDeregistered,
            serde_json::json!({"agent_id": agent_id}).to_string().into_bytes(),
            agent_id,
        )?;

        Ok(())
    }

    // ─── Task Operations ────────────────────────────────────────

    /// Submit a new task from an ActionPacket
    pub fn submit_task(
        &self,
        packet: &ActionPacket,
        dependencies: Vec<String>,
    ) -> AclResult<TaskNode> {
        let task = self.task_graph.create_task(packet, dependencies)?;

        self.event_bus.publish(
            EventType::TaskCreated,
            serde_json::json!({
                "task_id": &task.task_id,
                "source_agent": &packet.source_agent,
                "intent": &packet.intent,
                "priority": packet.priority,
                "target_agent": &packet.target_agent,
                "constraints_keys": packet.constraints.keys().collect::<Vec<_>>(),
            })
            .to_string()
            .into_bytes(),
            &packet.source_agent,
        )?;

        // If a target agent is specified, try to auto-route
        if !packet.target_agent.is_empty() {
            info!(
                task_id = %task.task_id,
                target = %packet.target_agent,
                "Task submitted with target agent"
            );
        } else if !packet.intent.is_empty() {
            // Capability-based routing
            if let Ok(agent) = self.registry.route_intent(&packet.intent) {
                info!(
                    task_id = %task.task_id,
                    routed_to = %agent.agent_id,
                    "Task auto-routed by capability"
                );
            }
        }

        Ok(task)
    }

    /// Claim a task for an agent
    pub fn claim_task(&self, task_id: &str, agent_id: &str) -> AclResult<TaskNode> {
        // Verify agent exists
        if !self.registry.exists(agent_id) {
            return Err(AclError::AgentNotFound(agent_id.to_string()));
        }

        let task = self.task_graph.claim_task(task_id, agent_id)?;

        self.event_bus.publish_state_update(
            EventType::TaskClaimed,
            task_id,
            agent_id,
        )?;

        Ok(task)
    }

    /// Start running a claimed task
    pub fn start_task(&self, task_id: &str, agent_id: &str) -> AclResult<TaskNode> {
        let task = self.task_graph.start_task(task_id, agent_id)?;

        self.event_bus.publish_state_update(
            EventType::TaskRunning,
            task_id,
            agent_id,
        )?;

        Ok(task)
    }

    /// Complete a task
    pub fn complete_task(
        &self,
        task_id: &str,
        agent_id: &str,
        artifact_refs: Vec<String>,
        confidence: f32,
    ) -> AclResult<TaskNode> {
        let task = self.task_graph.complete_task(
            task_id,
            agent_id,
            artifact_refs,
            confidence,
        )?;

        self.event_bus.publish_state_update(
            EventType::TaskDone,
            task_id,
            agent_id,
        )?;

        Ok(task)
    }

    /// Fail a task
    pub fn fail_task(
        &self,
        task_id: &str,
        agent_id: &str,
        reason: &str,
    ) -> AclResult<TaskNode> {
        let task = self.task_graph.fail_task(task_id, agent_id, reason)?;

        self.event_bus.publish_state_update(
            EventType::TaskFailed,
            task_id,
            agent_id,
        )?;

        Ok(task)
    }

    /// Process a StateUpdate message
    pub fn process_state_update(&self, update: &StateUpdate) -> AclResult<TaskNode> {
        let new_state = update.state();

        match new_state {
            TaskState::Claimed => {
                self.claim_task(&update.task_id, &update.owner_agent)
            }
            TaskState::Running => {
                self.start_task(&update.task_id, &update.owner_agent)
            }
            TaskState::Done => {
                self.complete_task(
                    &update.task_id,
                    &update.owner_agent,
                    update.artifact_refs.clone(),
                    update.confidence,
                )
            }
            TaskState::Failed => {
                self.fail_task(
                    &update.task_id,
                    &update.owner_agent,
                    &update.failure_reason,
                )
            }
            TaskState::Pending => {
                self.task_graph.retry_task(&update.task_id)
            }
            TaskState::Cancelled => {
                self.task_graph.cancel_task(&update.task_id)
            }
            _ => Err(AclError::Internal("Unknown state".to_string())),
        }
    }

    // ─── Spawn Operations ───────────────────────────────────────

    /// Spawn a subagent
    pub fn spawn_agent(&self, request: &SpawnRequest) -> AclResult<SpawnResponse> {
        self.spawn_manager.spawn(request)
    }

    /// Terminate a subagent
    pub fn terminate_agent(&self, agent_id: &str, reason: &str) -> AclResult<()> {
        self.spawn_manager.terminate(agent_id, reason)
    }

    // ─── Artifact Operations ────────────────────────────────────

    /// Publish an artifact
    pub fn publish_artifact(&self, artifact: Artifact) -> AclResult<ArtifactReference> {
        let reference = self.artifact_store.publish(artifact)?;

        self.event_bus.publish(
            EventType::ArtifactPublished,
            serde_json::json!({
                "uri": &reference.uri,
                "type": &reference.artifact_type,
            })
            .to_string()
            .into_bytes(),
            "artifact-store",
        )?;

        Ok(reference)
    }

    /// Get an artifact
    pub fn get_artifact(&self, reference: &ArtifactReference) -> AclResult<Artifact> {
        self.artifact_store.get(reference)
    }

    // ─── Event Operations ───────────────────────────────────────

    /// Subscribe to events
    pub fn subscribe_events(
        &self,
        filter: EventFilter,
    ) -> tokio::sync::broadcast::Receiver<acl_proto::Event> {
        self.event_bus.subscribe(filter)
    }

    // ─── Query Operations ───────────────────────────────────────

    /// Get all claimable tasks
    pub fn get_claimable_tasks(&self) -> Vec<TaskNode> {
        self.task_graph.get_claimable_tasks()
    }

    /// Get tasks owned by an agent
    pub fn get_agent_tasks(&self, agent_id: &str) -> Vec<TaskNode> {
        self.task_graph.query_by_owner(agent_id)
    }

    // ─── Metrics ────────────────────────────────────────────────

    /// Get runtime statistics
    pub fn stats(&self) -> RuntimeStats {
        RuntimeStats {
            total_tasks: self.task_graph.task_count(),
            pending_tasks: self.task_graph.query_by_state(TaskState::Pending).len(),
            running_tasks: self.task_graph.query_by_state(TaskState::Running).len(),
            completed_tasks: self.task_graph.query_by_state(TaskState::Done).len(),
            failed_tasks: self.task_graph.query_by_state(TaskState::Failed).len(),
            registered_agents: self.registry.count(),
            active_subagents: self.spawn_manager.active_count(),
            total_events: self.event_bus.event_count(),
            total_artifacts: self.artifact_store.count(),
        }
    }
}

/// Runtime statistics snapshot
#[derive(Debug, Clone, serde::Serialize)]
pub struct RuntimeStats {
    pub total_tasks: usize,
    pub pending_tasks: usize,
    pub running_tasks: usize,
    pub completed_tasks: usize,
    pub failed_tasks: usize,
    pub registered_agents: usize,
    pub active_subagents: usize,
    pub total_events: usize,
    pub total_artifacts: usize,
}

#[cfg(test)]
mod tests {
    use super::*;
    use acl_proto::CostProfile;

    fn setup_runtime() -> AclRuntime {
        AclRuntime::new(RuntimeConfig::default())
    }

    fn make_agent(id: &str, capabilities: Vec<&str>) -> AgentCapability {
        AgentCapability {
            agent_id: id.to_string(),
            model_backend: "anthropic/claude-sonnet-4-6".to_string(),
            can_do: capabilities.into_iter().map(String::from).collect(),
            requires: vec![],
            produces: vec![],
            cost: Some(CostProfile {
                input_cost_per_1k: 0.003,
                output_cost_per_1k: 0.015,
                tool_call_cost: 0.0,
            }),
            avg_latency_ms: 200.0,
            trust_score: 0.9,
        }
    }

    #[tokio::test]
    async fn test_full_workflow() {
        let runtime = setup_runtime();

        // Register agents
        runtime.register_agent(make_agent("supervisor", vec!["orchestrate"])).unwrap();
        runtime.register_agent(make_agent("researcher", vec!["research", "summarize"])).unwrap();
        runtime.register_agent(make_agent("writer", vec!["write", "edit"])).unwrap();

        // Submit tasks with dependencies
        let research_packet = ActionPacket {
            packet_id: "task-research".into(),
            source_agent: "supervisor".into(),
            target_agent: "researcher".into(),
            intent: "research".into(),
            input_refs: vec![],
            constraints: Default::default(),
            output_schema: "research_report".into(),
            priority: 0.8,
            deadline_ms: 0,
        };
        let research_task = runtime.submit_task(&research_packet, vec![]).unwrap();

        let write_packet = ActionPacket {
            packet_id: "task-write".into(),
            source_agent: "supervisor".into(),
            target_agent: "writer".into(),
            intent: "write".into(),
            input_refs: vec![],
            constraints: Default::default(),
            output_schema: "final_document".into(),
            priority: 0.7,
            deadline_ms: 0,
        };
        let write_task = runtime
            .submit_task(&write_packet, vec![research_task.task_id.clone()])
            .unwrap();

        // Research phase
        runtime.claim_task(&research_task.task_id, "researcher").unwrap();
        runtime.start_task(&research_task.task_id, "researcher").unwrap();

        // Publish research artifact
        let artifact = Artifact {
            artifact_id: String::new(),
            artifact_type: "research_report".into(),
            content_hash: String::new(),
            content: b"Market analysis findings...".to_vec(),
            producer_agent: "researcher".into(),
            task_id: research_task.task_id.clone(),
            created_at: 0,
            metadata: Default::default(),
        };
        let artifact_ref = runtime.publish_artifact(artifact).unwrap();

        runtime
            .complete_task(
                &research_task.task_id,
                "researcher",
                vec![artifact_ref.uri.clone()],
                0.92,
            )
            .unwrap();

        // Write phase (now unblocked)
        runtime.claim_task(&write_task.task_id, "writer").unwrap();
        runtime.start_task(&write_task.task_id, "writer").unwrap();
        runtime
            .complete_task(&write_task.task_id, "writer", vec![], 0.88)
            .unwrap();

        // Verify final state
        let stats = runtime.stats();
        assert_eq!(stats.total_tasks, 2);
        assert_eq!(stats.completed_tasks, 2);
        assert_eq!(stats.registered_agents, 3);
        assert_eq!(stats.total_artifacts, 1);
        assert!(stats.total_events > 0);
    }
}
