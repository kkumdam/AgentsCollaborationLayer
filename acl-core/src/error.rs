use thiserror::Error;

#[derive(Error, Debug)]
pub enum AclError {
    // Task Graph errors
    #[error("Task not found: {0}")]
    TaskNotFound(String),

    #[error("Task already claimed by agent: {0}")]
    TaskAlreadyClaimed(String),

    #[error("Invalid state transition: {from:?} -> {to:?}")]
    InvalidStateTransition {
        from: acl_proto::TaskState,
        to: acl_proto::TaskState,
    },

    #[error("Task has unresolved dependencies: {0:?}")]
    UnresolvedDependencies(Vec<String>),

    #[error("Task ownership mismatch: expected {expected}, got {actual}")]
    OwnershipMismatch { expected: String, actual: String },

    #[error("Max retries exceeded for task: {0}")]
    MaxRetriesExceeded(String),

    // Agent Registry errors
    #[error("Agent not found: {0}")]
    AgentNotFound(String),

    #[error("Agent already registered: {0}")]
    AgentAlreadyRegistered(String),

    #[error("No capable agent found for intent: {0}")]
    NoCapableAgent(String),

    // Policy Engine errors
    #[error("Policy violation: {0}")]
    PolicyViolation(String),

    #[error("Budget exceeded: used {used:.4}, limit {limit:.4}")]
    BudgetExceeded { used: f32, limit: f32 },

    #[error("TTL expired for agent: {0}")]
    TtlExpired(String),

    #[error("Spawn depth limit exceeded: current {current}, limit {limit}")]
    SpawnDepthExceeded { current: i32, limit: i32 },

    #[error("Spawn limit exceeded: current {current}, limit {limit}")]
    SpawnLimitExceeded { current: i32, limit: i32 },

    #[error("Tool access denied: {0}")]
    ToolAccessDenied(String),

    // Artifact Store errors
    #[error("Artifact not found: {0}")]
    ArtifactNotFound(String),

    // Spawn Manager errors
    #[error("Spawn failed: {0}")]
    SpawnFailed(String),

    // Event Bus errors
    #[error("Event bus error: {0}")]
    EventBusError(String),

    // Generic
    #[error("Internal error: {0}")]
    Internal(String),
}

pub type AclResult<T> = Result<T, AclError>;
