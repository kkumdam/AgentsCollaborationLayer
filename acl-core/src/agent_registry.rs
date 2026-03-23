//! Agent Registry
//!
//! Maintains the catalog of all registered agents with their capabilities,
//! cost profiles, latency characteristics, model backends, and tool permissions.
//! Enables capability-based routing.

use std::sync::Arc;

use dashmap::DashMap;
use tracing::info;

use acl_proto::AgentCapability;

use crate::error::{AclError, AclResult};

/// In-memory Agent Registry with capability-based routing
#[derive(Debug, Clone)]
pub struct AgentRegistry {
    agents: Arc<DashMap<String, AgentCapability>>,
}

impl AgentRegistry {
    pub fn new() -> Self {
        Self {
            agents: Arc::new(DashMap::new()),
        }
    }

    /// Register a new agent with its capability contract
    pub fn register(&self, capability: AgentCapability) -> AclResult<()> {
        let agent_id = capability.agent_id.clone();
        if self.agents.contains_key(&agent_id) {
            return Err(AclError::AgentAlreadyRegistered(agent_id));
        }
        self.agents.insert(agent_id.clone(), capability);
        info!(agent_id = %agent_id, "Agent registered");
        Ok(())
    }

    /// Deregister an agent
    pub fn deregister(&self, agent_id: &str) -> AclResult<()> {
        self.agents
            .remove(agent_id)
            .ok_or_else(|| AclError::AgentNotFound(agent_id.to_string()))?;
        info!(agent_id = %agent_id, "Agent deregistered");
        Ok(())
    }

    /// Get an agent by ID
    pub fn get(&self, agent_id: &str) -> AclResult<AgentCapability> {
        self.agents
            .get(agent_id)
            .map(|a| a.value().clone())
            .ok_or_else(|| AclError::AgentNotFound(agent_id.to_string()))
    }

    /// Find agents that can handle a specific intent/capability
    pub fn find_by_capability(&self, capability: &str) -> Vec<AgentCapability> {
        let normalized = capability.trim().to_lowercase();
        self.agents
            .iter()
            .filter(|entry| {
                entry.value().can_do.iter().any(|c| c.trim().to_lowercase() == normalized)
            })
            .map(|entry| entry.value().clone())
            .collect()
    }

    /// Find agents by model backend
    pub fn find_by_model(&self, model: &str) -> Vec<AgentCapability> {
        self.agents
            .iter()
            .filter(|entry| entry.value().model_backend == model)
            .map(|entry| entry.value().clone())
            .collect()
    }

    /// Route a task intent to the best available agent
    /// Selection criteria: capability match -> trust score -> latency -> cost
    pub fn route_intent(&self, intent: &str) -> AclResult<AgentCapability> {
        let normalized = intent.trim();
        let candidates = self.find_by_capability(normalized);
        if candidates.is_empty() {
            return Err(AclError::NoCapableAgent(intent.to_string()));
        }

        // Sort by trust_score (desc), then latency (asc), then cost (asc)
        let mut sorted = candidates;
        sorted.sort_by(|a, b| {
            b.trust_score
                .partial_cmp(&a.trust_score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| {
                    a.avg_latency_ms
                        .partial_cmp(&b.avg_latency_ms)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .then_with(|| {
                    let a_cost = a.cost.as_ref().map(|c| c.input_cost_per_1k).unwrap_or(0.0);
                    let b_cost = b.cost.as_ref().map(|c| c.input_cost_per_1k).unwrap_or(0.0);
                    a_cost
                        .partial_cmp(&b_cost)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
        });

        Ok(sorted.into_iter().next().unwrap())
    }

    /// List all registered agents
    pub fn list_all(&self) -> Vec<AgentCapability> {
        self.agents.iter().map(|e| e.value().clone()).collect()
    }

    /// Count of registered agents
    pub fn count(&self) -> usize {
        self.agents.len()
    }

    /// Check if an agent exists
    pub fn exists(&self, agent_id: &str) -> bool {
        self.agents.contains_key(agent_id)
    }

    /// Update an agent's trust score
    pub fn update_trust_score(&self, agent_id: &str, score: f32) -> AclResult<()> {
        let mut agent = self.agents
            .get_mut(agent_id)
            .ok_or_else(|| AclError::AgentNotFound(agent_id.to_string()))?;
        agent.trust_score = score;
        Ok(())
    }
}

impl Default for AgentRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use acl_proto::CostProfile;

    fn make_agent(id: &str, capabilities: Vec<&str>, trust: f32) -> AgentCapability {
        AgentCapability {
            agent_id: id.to_string(),
            model_backend: "anthropic/claude-sonnet-4-6".to_string(),
            can_do: capabilities.into_iter().map(String::from).collect(),
            requires: vec!["text".to_string()],
            produces: vec!["text".to_string()],
            cost: Some(CostProfile {
                input_cost_per_1k: 0.003,
                output_cost_per_1k: 0.015,
                tool_call_cost: 0.0,
            }),
            avg_latency_ms: 500.0,
            trust_score: trust,
        }
    }

    #[test]
    fn test_register_and_find() {
        let registry = AgentRegistry::new();
        registry.register(make_agent("reviewer-1", vec!["code_review", "summarize"], 0.9)).unwrap();
        registry.register(make_agent("writer-1", vec!["write", "summarize"], 0.85)).unwrap();

        let reviewers = registry.find_by_capability("code_review");
        assert_eq!(reviewers.len(), 1);
        assert_eq!(reviewers[0].agent_id, "reviewer-1");

        let summarizers = registry.find_by_capability("summarize");
        assert_eq!(summarizers.len(), 2);
    }

    #[test]
    fn test_routing_by_trust() {
        let registry = AgentRegistry::new();
        registry.register(make_agent("low-trust", vec!["summarize"], 0.5)).unwrap();
        registry.register(make_agent("high-trust", vec!["summarize"], 0.95)).unwrap();

        let routed = registry.route_intent("summarize").unwrap();
        assert_eq!(routed.agent_id, "high-trust");
    }

    #[test]
    fn test_deregister() {
        let registry = AgentRegistry::new();
        registry.register(make_agent("temp-agent", vec!["test"], 0.5)).unwrap();
        assert!(registry.exists("temp-agent"));

        registry.deregister("temp-agent").unwrap();
        assert!(!registry.exists("temp-agent"));
    }
}
