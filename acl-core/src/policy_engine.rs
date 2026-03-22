//! Policy Engine
//!
//! Enforces authorization, cost budgets, priority rules, model selection policies,
//! and sandbox boundaries. Every action passes through policy evaluation before execution.

use std::sync::Arc;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use acl_proto::{SpawnPolicy, SpawnRequest, SpawnType};

use crate::error::{AclError, AclResult};

/// Runtime policy state tracking per agent
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentPolicyState {
    pub agent_id: String,
    pub parent_agent: Option<String>,
    pub policy: PolicyConfig,
    pub budget_used: f32,
    pub spawn_count: i32,
    pub spawn_depth: i32,
    pub active: bool,
    pub created_at: i64,
    pub ttl_seconds: i64,
}

/// Deserialized policy configuration (from TOML or SpawnPolicy)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyConfig {
    pub spawn_limit: i32,
    pub spawn_depth_limit: i32,
    pub tool_access: Vec<String>,
    pub budget_usd: f32,
    pub ttl_seconds: i64,
    pub memory_scope: String,
    pub max_retries: i32,
    pub allowed_models: Vec<String>,
}

impl Default for PolicyConfig {
    fn default() -> Self {
        Self {
            spawn_limit: 10,
            spawn_depth_limit: 3,
            tool_access: vec![],
            budget_usd: 5.0,
            ttl_seconds: 600,
            memory_scope: "default".to_string(),
            max_retries: 3,
            allowed_models: vec![],
        }
    }
}

impl From<&SpawnPolicy> for PolicyConfig {
    fn from(sp: &SpawnPolicy) -> Self {
        Self {
            spawn_limit: sp.spawn_limit,
            spawn_depth_limit: sp.spawn_depth,
            tool_access: sp.tool_access.clone(),
            budget_usd: sp.budget_usd,
            ttl_seconds: sp.ttl_seconds,
            memory_scope: sp.memory_scope.clone(),
            max_retries: 3,
            allowed_models: vec![],
        }
    }
}

/// Policy Engine that evaluates and enforces operational boundaries
#[derive(Debug, Clone)]
pub struct PolicyEngine {
    /// Per-agent policy state
    agent_policies: Arc<DashMap<String, AgentPolicyState>>,
    /// Global default policy
    default_policy: PolicyConfig,
}

impl PolicyEngine {
    pub fn new(default_policy: PolicyConfig) -> Self {
        Self {
            agent_policies: Arc::new(DashMap::new()),
            default_policy,
        }
    }

    /// Register an agent's policy state
    pub fn register_agent_policy(
        &self,
        agent_id: &str,
        parent_agent: Option<&str>,
        policy: PolicyConfig,
        spawn_depth: i32,
    ) {
        let state = AgentPolicyState {
            agent_id: agent_id.to_string(),
            parent_agent: parent_agent.map(String::from),
            policy,
            budget_used: 0.0,
            spawn_count: 0,
            spawn_depth,
            active: true,
            created_at: chrono::Utc::now().timestamp(),
            ttl_seconds: 0,
        };
        // Set TTL from policy
        let mut state = state;
        state.ttl_seconds = state.policy.ttl_seconds;
        self.agent_policies.insert(agent_id.to_string(), state);
        info!(agent_id = %agent_id, "Agent policy registered");
    }

    /// Evaluate whether a spawn request is allowed
    pub fn evaluate_spawn(&self, request: &SpawnRequest) -> AclResult<()> {
        let parent_id = &request.parent_agent;

        // Get parent's policy state
        let parent_state = self.agent_policies
            .get(parent_id)
            .ok_or_else(|| AclError::AgentNotFound(parent_id.clone()))?;

        // Check spawn limit
        if parent_state.spawn_count >= parent_state.policy.spawn_limit {
            warn!(
                agent_id = %parent_id,
                count = parent_state.spawn_count,
                limit = parent_state.policy.spawn_limit,
                "Spawn limit exceeded"
            );
            return Err(AclError::SpawnLimitExceeded {
                current: parent_state.spawn_count,
                limit: parent_state.policy.spawn_limit,
            });
        }

        // Check spawn depth
        let new_depth = parent_state.spawn_depth + 1;
        if new_depth > parent_state.policy.spawn_depth_limit {
            warn!(
                agent_id = %parent_id,
                depth = new_depth,
                limit = parent_state.policy.spawn_depth_limit,
                "Spawn depth exceeded"
            );
            return Err(AclError::SpawnDepthExceeded {
                current: new_depth,
                limit: parent_state.policy.spawn_depth_limit,
            });
        }

        // Check budget for non-virtual spawns
        if request.r#type() != SpawnType::Virtual {
            let child_budget = request
                .policy
                .as_ref()
                .map(|p| p.budget_usd)
                .unwrap_or(0.0);

            let remaining = parent_state.policy.budget_usd - parent_state.budget_used;
            if child_budget > remaining {
                return Err(AclError::BudgetExceeded {
                    used: parent_state.budget_used + child_budget,
                    limit: parent_state.policy.budget_usd,
                });
            }
        }

        // Check tool access inheritance
        if let Some(ref child_policy) = request.policy {
            for tool in &child_policy.tool_access {
                if !parent_state.policy.tool_access.contains(tool)
                    && !parent_state.policy.tool_access.is_empty()
                {
                    return Err(AclError::ToolAccessDenied(tool.clone()));
                }
            }
        }

        Ok(())
    }

    /// Record a successful spawn (increment counters)
    pub fn record_spawn(&self, parent_id: &str, child_budget: f32) -> AclResult<()> {
        let mut state = self.agent_policies
            .get_mut(parent_id)
            .ok_or_else(|| AclError::AgentNotFound(parent_id.to_string()))?;

        state.spawn_count += 1;
        state.budget_used += child_budget;
        Ok(())
    }

    /// Record budget usage for an agent
    pub fn record_cost(&self, agent_id: &str, cost: f32) -> AclResult<()> {
        let mut state = self.agent_policies
            .get_mut(agent_id)
            .ok_or_else(|| AclError::AgentNotFound(agent_id.to_string()))?;

        let new_total = state.budget_used + cost;
        if new_total > state.policy.budget_usd {
            return Err(AclError::BudgetExceeded {
                used: new_total,
                limit: state.policy.budget_usd,
            });
        }

        state.budget_used = new_total;
        Ok(())
    }

    /// Check if an agent's TTL has expired
    pub fn check_ttl(&self, agent_id: &str) -> AclResult<bool> {
        let state = self.agent_policies
            .get(agent_id)
            .ok_or_else(|| AclError::AgentNotFound(agent_id.to_string()))?;

        if state.policy.ttl_seconds <= 0 {
            return Ok(false); // No TTL limit
        }

        let elapsed = chrono::Utc::now().timestamp() - state.created_at;
        Ok(elapsed > state.policy.ttl_seconds)
    }

    /// Check if an agent has access to a specific tool
    pub fn check_tool_access(&self, agent_id: &str, tool: &str) -> AclResult<bool> {
        let state = self.agent_policies
            .get(agent_id)
            .ok_or_else(|| AclError::AgentNotFound(agent_id.to_string()))?;

        // Empty tool_access means all tools allowed
        if state.policy.tool_access.is_empty() {
            return Ok(true);
        }

        Ok(state.policy.tool_access.iter().any(|t| t == tool))
    }

    /// Get remaining budget for an agent
    pub fn remaining_budget(&self, agent_id: &str) -> AclResult<f32> {
        let state = self.agent_policies
            .get(agent_id)
            .ok_or_else(|| AclError::AgentNotFound(agent_id.to_string()))?;

        Ok(state.policy.budget_usd - state.budget_used)
    }

    /// Deactivate an agent's policy (on termination)
    pub fn deactivate(&self, agent_id: &str) -> AclResult<()> {
        let mut state = self.agent_policies
            .get_mut(agent_id)
            .ok_or_else(|| AclError::AgentNotFound(agent_id.to_string()))?;
        state.active = false;
        Ok(())
    }

    /// Get policy state for an agent
    pub fn get_policy_state(&self, agent_id: &str) -> AclResult<AgentPolicyState> {
        self.agent_policies
            .get(agent_id)
            .map(|s| s.value().clone())
            .ok_or_else(|| AclError::AgentNotFound(agent_id.to_string()))
    }

    /// Get the default policy
    pub fn default_policy(&self) -> &PolicyConfig {
        &self.default_policy
    }
}

impl Default for PolicyEngine {
    fn default() -> Self {
        Self::new(PolicyConfig::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use acl_proto::{AgentSpec, SpawnPolicy as ProtoSpawnPolicy};

    #[test]
    fn test_spawn_limit_enforcement() {
        let engine = PolicyEngine::new(PolicyConfig::default());

        let policy = PolicyConfig {
            spawn_limit: 2,
            spawn_depth_limit: 3,
            tool_access: vec!["search".into(), "read".into()],
            budget_usd: 5.0,
            ttl_seconds: 300,
            ..Default::default()
        };

        engine.register_agent_policy("supervisor", None, policy, 0);

        let spawn_req = SpawnRequest {
            parent_agent: "supervisor".into(),
            spec: Some(AgentSpec {
                agent_id: "worker-1".into(),
                model_backend: "anthropic/claude-sonnet-4-6".into(),
                can_do: vec!["summarize".into()],
                requires: vec![],
                produces: vec![],
            }),
            policy: Some(ProtoSpawnPolicy {
                spawn_limit: 0,
                spawn_depth: 1,
                tool_access: vec!["search".into()],
                budget_usd: 1.0,
                ttl_seconds: 60,
                memory_scope: "default".into(),
            }),
            r#type: SpawnType::Ephemeral.into(),
            memory_refs: vec![],
        };

        // First two spawns should succeed
        engine.evaluate_spawn(&spawn_req).unwrap();
        engine.record_spawn("supervisor", 1.0).unwrap();

        engine.evaluate_spawn(&spawn_req).unwrap();
        engine.record_spawn("supervisor", 1.0).unwrap();

        // Third spawn should fail
        let result = engine.evaluate_spawn(&spawn_req);
        assert!(result.is_err());
    }

    #[test]
    fn test_budget_enforcement() {
        let engine = PolicyEngine::new(PolicyConfig::default());

        let policy = PolicyConfig {
            budget_usd: 2.0,
            spawn_limit: 10,
            spawn_depth_limit: 5,
            ..Default::default()
        };

        engine.register_agent_policy("agent-1", None, policy, 0);

        // Use some budget
        engine.record_cost("agent-1", 1.5).unwrap();
        assert!((engine.remaining_budget("agent-1").unwrap() - 0.5).abs() < f32::EPSILON);

        // Exceeding budget should fail
        let result = engine.record_cost("agent-1", 1.0);
        assert!(result.is_err());
    }

    #[test]
    fn test_tool_access() {
        let engine = PolicyEngine::new(PolicyConfig::default());

        let policy = PolicyConfig {
            tool_access: vec!["search".into(), "read_docs".into()],
            ..Default::default()
        };

        engine.register_agent_policy("agent-1", None, policy, 0);

        assert!(engine.check_tool_access("agent-1", "search").unwrap());
        assert!(engine.check_tool_access("agent-1", "read_docs").unwrap());
        assert!(!engine.check_tool_access("agent-1", "write_file").unwrap());
    }
}
