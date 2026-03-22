//! ACL gRPC Server
//!
//! Implements all gRPC service definitions from the ACL protocol:
//! - AgentRegistryService
//! - TaskService
//! - SpawnService
//! - ArtifactService

pub mod services;

use std::net::SocketAddr;

use acl_core::{AclRuntime, RuntimeConfig};
use anyhow::Result;
use tonic::transport::Server;
use tracing::info;

use acl_proto::acl::v1::{
    agent_registry_service_server::AgentRegistryServiceServer,
    artifact_service_server::ArtifactServiceServer,
    spawn_service_server::SpawnServiceServer,
    task_service_server::TaskServiceServer,
};

use services::{
    AclAgentRegistryService,
    AclTaskService,
    AclSpawnService,
    AclArtifactService,
};

/// ACL Server wrapping all gRPC services
pub struct AclServer {
    runtime: AclRuntime,
    addr: SocketAddr,
}

impl AclServer {
    pub fn new(addr: SocketAddr, config: RuntimeConfig) -> Self {
        Self {
            runtime: AclRuntime::new(config),
            addr,
        }
    }

    pub fn with_runtime(addr: SocketAddr, runtime: AclRuntime) -> Self {
        Self { runtime, addr }
    }

    pub fn runtime(&self) -> &AclRuntime {
        &self.runtime
    }

    /// Start the gRPC server
    pub async fn serve(self) -> Result<()> {
        let registry_service = AclAgentRegistryService::new(self.runtime.clone());
        let task_service = AclTaskService::new(self.runtime.clone());
        let spawn_service = AclSpawnService::new(self.runtime.clone());
        let artifact_service = AclArtifactService::new(self.runtime.clone());

        info!(addr = %self.addr, "ACL gRPC server starting");

        Server::builder()
            .add_service(AgentRegistryServiceServer::new(registry_service))
            .add_service(TaskServiceServer::new(task_service))
            .add_service(SpawnServiceServer::new(spawn_service))
            .add_service(ArtifactServiceServer::new(artifact_service))
            .serve(self.addr)
            .await?;

        Ok(())
    }
}
