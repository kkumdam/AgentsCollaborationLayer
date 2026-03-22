//! ACL Core - Agent Collaboration Layer Runtime
//!
//! High-speed, non-linguistic runtime for AI agent collaboration
//! through structured state transitions, typed artifact exchange,
//! and policy-governed subagent lifecycle management.

pub mod error;
pub mod task_graph;
pub mod agent_registry;
pub mod event_bus;
pub mod policy_engine;
pub mod spawn_manager;
pub mod artifact_store;
pub mod runtime;

pub use runtime::{AclRuntime, RuntimeConfig, RuntimeStats};
pub use error::{AclError, AclResult};
