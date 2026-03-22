//! Spawn Manager
//!
//! Controls the lifecycle of subagents: creation, budget allocation,
//! TTL enforcement, spawn depth limits, memory inheritance, and graceful termination.
//! Prevents infinite proliferation and cost runaway.

use std::sync::Arc;

use chrono::Utc;
use dashmap::DashMap;
use tracing::{info, warn};
use uuid::Uuid;

use acl_proto::{SpawnRequest, SpawnResponse, SpawnTree, SpawnType};

use crate::agent_registry::AgentRegistry;
use crate::error::{AclError, AclResult};
use crate::event_bus::EventBus;
use crate::policy_engine::{PolicyConfig, PolicyEngine};

/// Tracks a spawned agent's lifecycle
#[derive(Debug, Clone)]
pub struct SpawnedAgent {
    pub agent_id: String,
    pub parent_id: String,
    pub spawn_type: SpawnType,
    pub alive_since: i64,
    pub budget_allocated: f32,
    pub children: Vec<String>,
    pub active: bool,
}

/// Spawn Manager handles subagent lifecycle
#[derive(Clone)]
pub struct SpawnManager {
    spawned: Arc<DashMap<String, SpawnedAgent>>,
    registry: AgentRegistry,
    policy_engine: PolicyEngine,
    event_bus: EventBus,
}

impl SpawnManager {
    pub fn new(
        registry: AgentRegistry,
        policy_engine: PolicyEngine,
        event_bus: EventBus,
    ) -> Self {
        Self {
            spawned: Arc::new(DashMap::new()),
            registry,
            policy_engine,
            event_bus,
        }
    }

    /// Spawn a new subagent with policy enforcement
    pub fn spawn(&self, request: &SpawnRequest) -> AclResult<SpawnResponse> {
        // 1. Evaluate policy
        self.policy_engine.evaluate_spawn(request)?;

        // 2. Generate agent ID
        let agent_id = request
            .spec
            .as_ref()
            .map(|s| {
                if s.agent_id.is_empty() {
                    format!("agent-{}", Uuid::new_v4().to_string().split('-').next().unwrap_or("x"))
                } else {
                    s.agent_id.clone()
                }
            })
            .unwrap_or_else(|| format!("agent-{}", Uuid::new_v4().to_string().split('-').next().unwrap_or("x")));

        let spawn_type = request.r#type();
        let budget = request
            .policy
            .as_ref()
            .map(|p| p.budget_usd)
            .unwrap_or(0.0);

        // 3. Register the agent in the registry (with capabilities)
        if let Some(ref spec) = request.spec {
            let capability = acl_proto::AgentCapability {
                agent_id: agent_id.clone(),
                model_backend: spec.model_backend.clone(),
                can_do: spec.can_do.clone(),
                requires: spec.requires.clone(),
                produces: spec.produces.clone(),
                cost: None,
                avg_latency_ms: 0.0,
                trust_score: 0.5, // Default trust for new subagents
            };
            // Allow re-registration for virtual agents switching roles
            let _ = self.registry.register(capability);
        }

        // 4. Set up policy state for the child
        let parent_depth = self
            .policy_engine
            .get_policy_state(&request.parent_agent)
            .map(|s| s.spawn_depth)
            .unwrap_or(0);

        let child_policy = request
            .policy
            .as_ref()
            .map(PolicyConfig::from)
            .unwrap_or_else(|| self.policy_engine.default_policy().clone());

        self.policy_engine.register_agent_policy(
            &agent_id,
            Some(&request.parent_agent),
            child_policy,
            parent_depth + 1,
        );

        // 5. Record spawn in parent's policy state
        self.policy_engine
            .record_spawn(&request.parent_agent, budget)?;

        // 6. Track the spawned agent
        let spawned_agent = SpawnedAgent {
            agent_id: agent_id.clone(),
            parent_id: request.parent_agent.clone(),
            spawn_type,
            alive_since: Utc::now().timestamp_millis(),
            budget_allocated: budget,
            children: vec![],
            active: true,
        };

        self.spawned.insert(agent_id.clone(), spawned_agent);

        // 7. Add as child of parent
        if let Some(mut parent) = self.spawned.get_mut(&request.parent_agent) {
            parent.children.push(agent_id.clone());
        }

        // 8. Emit event
        let _ = self.event_bus.publish(
            acl_proto::EventType::SubagentSpawned,
            serde_json::json!({
                "agent_id": agent_id,
                "parent_agent": request.parent_agent,
                "spawn_type": format!("{:?}", spawn_type),
            })
            .to_string()
            .into_bytes(),
            &request.parent_agent,
        );

        info!(
            agent_id = %agent_id,
            parent = %request.parent_agent,
            spawn_type = ?spawn_type,
            "Subagent spawned"
        );

        Ok(SpawnResponse {
            success: true,
            agent_id,
            failure_reason: String::new(),
        })
    }

    /// Terminate a subagent and clean up
    pub fn terminate(&self, agent_id: &str, reason: &str) -> AclResult<()> {
        // Recursively terminate children first
        let children = {
            let agent = self.spawned
                .get(agent_id)
                .ok_or_else(|| AclError::AgentNotFound(agent_id.to_string()))?;
            agent.children.clone()
        };

        for child_id in &children {
            if let Err(e) = self.terminate(child_id, "parent terminated") {
                warn!(child_id = %child_id, error = %e, "Failed to terminate child");
            }
        }

        // Deactivate
        if let Some(mut agent) = self.spawned.get_mut(agent_id) {
            agent.active = false;
        }

        self.policy_engine.deactivate(agent_id)?;
        let _ = self.registry.deregister(agent_id);

        // Emit event
        let _ = self.event_bus.publish(
            acl_proto::EventType::SubagentTerminated,
            serde_json::json!({
                "agent_id": agent_id,
                "reason": reason,
            })
            .to_string()
            .into_bytes(),
            agent_id,
        );

        info!(agent_id = %agent_id, reason = %reason, "Subagent terminated");
        Ok(())
    }

    /// Check and enforce TTL for all spawned agents
    pub fn enforce_ttl(&self) -> Vec<String> {
        let mut expired = vec![];

        for entry in self.spawned.iter() {
            let agent_id = entry.key().clone();
            if let Ok(true) = self.policy_engine.check_ttl(&agent_id) {
                expired.push(agent_id.clone());
            }
        }

        for agent_id in &expired {
            if let Err(e) = self.terminate(agent_id, "TTL expired") {
                warn!(agent_id = %agent_id, error = %e, "Failed to terminate expired agent");
            }
        }

        expired
    }

    /// Build the spawn tree for visualization
    pub fn get_spawn_tree(&self, root_id: &str) -> AclResult<SpawnTree> {
        let agent = self.spawned
            .get(root_id)
            .ok_or_else(|| AclError::AgentNotFound(root_id.to_string()))?;

        let children: Vec<SpawnTree> = agent
            .children
            .iter()
            .filter_map(|child_id| self.get_spawn_tree(child_id).ok())
            .collect();

        let budget_used = self
            .policy_engine
            .get_policy_state(root_id)
            .map(|s| s.budget_used)
            .unwrap_or(0.0);

        let policy = self
            .policy_engine
            .get_policy_state(root_id)
            .ok()
            .map(|s| acl_proto::SpawnPolicy {
                spawn_limit: s.policy.spawn_limit,
                spawn_depth: s.policy.spawn_depth_limit,
                tool_access: s.policy.tool_access,
                budget_usd: s.policy.budget_usd,
                ttl_seconds: s.policy.ttl_seconds,
                memory_scope: s.policy.memory_scope,
            });

        Ok(SpawnTree {
            agent_id: root_id.to_string(),
            r#type: agent.spawn_type.into(),
            policy,
            budget_used,
            alive_since: agent.alive_since,
            children,
        })
    }

    /// Insert a root agent (for tree tracking, not a real spawn)
    pub fn spawned_insert_root(&self, agent_id: &str) {
        self.spawned.insert(agent_id.to_string(), SpawnedAgent {
            agent_id: agent_id.to_string(),
            parent_id: String::new(),
            spawn_type: SpawnType::Persistent,
            alive_since: Utc::now().timestamp_millis(),
            budget_allocated: 0.0,
            children: vec![],
            active: true,
        });
    }

    /// Get count of active spawned agents
    pub fn active_count(&self) -> usize {
        self.spawned.iter().filter(|e| e.active).count()
    }

    /// Check if an agent is active
    pub fn is_active(&self, agent_id: &str) -> bool {
        self.spawned
            .get(agent_id)
            .map(|a| a.active)
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use acl_proto::{AgentSpec, SpawnPolicy as ProtoSpawnPolicy};

    fn setup() -> SpawnManager {
        let registry = AgentRegistry::new();
        let policy_engine = PolicyEngine::new(PolicyConfig::default());
        let event_bus = EventBus::default();

        // Register root supervisor
        let root_policy = PolicyConfig {
            spawn_limit: 5,
            spawn_depth_limit: 3,
            budget_usd: 10.0,
            tool_access: vec!["search".into(), "read".into(), "write".into()],
            ..Default::default()
        };
        policy_engine.register_agent_policy("supervisor", None, root_policy, 0);

        SpawnManager::new(registry, policy_engine, event_bus)
    }

    fn make_spawn_request(parent: &str, child_id: &str) -> SpawnRequest {
        SpawnRequest {
            parent_agent: parent.into(),
            spec: Some(AgentSpec {
                agent_id: child_id.into(),
                model_backend: "anthropic/claude-sonnet-4-6".into(),
                can_do: vec!["summarize".into()],
                requires: vec![],
                produces: vec![],
            }),
            policy: Some(ProtoSpawnPolicy {
                spawn_limit: 2,
                spawn_depth: 2,
                tool_access: vec!["search".into()],
                budget_usd: 1.0,
                ttl_seconds: 60,
                memory_scope: "default".into(),
            }),
            r#type: SpawnType::Ephemeral.into(),
            memory_refs: vec![],
        }
    }

    #[test]
    fn test_spawn_and_terminate() {
        let manager = setup();

        // Register supervisor as spawned
        manager.spawned.insert("supervisor".into(), SpawnedAgent {
            agent_id: "supervisor".into(),
            parent_id: String::new(),
            spawn_type: SpawnType::Persistent,
            alive_since: Utc::now().timestamp_millis(),
            budget_allocated: 0.0,
            children: vec![],
            active: true,
        });

        let req = make_spawn_request("supervisor", "worker-1");
        let resp = manager.spawn(&req).unwrap();
        assert!(resp.success);
        assert_eq!(resp.agent_id, "worker-1");
        assert_eq!(manager.active_count(), 2);

        manager.terminate("worker-1", "task complete").unwrap();
        assert!(!manager.is_active("worker-1"));
    }

    #[test]
    fn test_spawn_tree() {
        let manager = setup();

        manager.spawned.insert("supervisor".into(), SpawnedAgent {
            agent_id: "supervisor".into(),
            parent_id: String::new(),
            spawn_type: SpawnType::Persistent,
            alive_since: Utc::now().timestamp_millis(),
            budget_allocated: 0.0,
            children: vec![],
            active: true,
        });

        let req1 = make_spawn_request("supervisor", "worker-1");
        manager.spawn(&req1).unwrap();

        let req2 = make_spawn_request("supervisor", "worker-2");
        manager.spawn(&req2).unwrap();

        let tree = manager.get_spawn_tree("supervisor").unwrap();
        assert_eq!(tree.children.len(), 2);
    }
}
