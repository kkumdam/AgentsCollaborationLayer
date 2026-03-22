//! gRPC Service Implementations

use acl_core::AclRuntime;
use acl_core::event_bus::EventFilter;
use acl_proto::acl::v1::*;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::{Request, Response, Status};

// ─── Agent Registry Service ─────────────────────────────────────

pub struct AclAgentRegistryService {
    runtime: AclRuntime,
}

impl AclAgentRegistryService {
    pub fn new(runtime: AclRuntime) -> Self {
        Self { runtime }
    }
}

#[tonic::async_trait]
impl agent_registry_service_server::AgentRegistryService for AclAgentRegistryService {
    async fn register_agent(
        &self,
        request: Request<AgentCapability>,
    ) -> Result<Response<RegisterResponse>, Status> {
        let capability = request.into_inner();
        let agent_id = capability.agent_id.clone();

        match self.runtime.register_agent(capability) {
            Ok(id) => Ok(Response::new(RegisterResponse {
                success: true,
                agent_id: id,
                message: format!("Agent {} registered successfully", agent_id),
            })),
            Err(e) => Ok(Response::new(RegisterResponse {
                success: false,
                agent_id,
                message: e.to_string(),
            })),
        }
    }

    async fn deregister_agent(
        &self,
        request: Request<DeregisterRequest>,
    ) -> Result<Response<DeregisterResponse>, Status> {
        let req = request.into_inner();

        match self.runtime.deregister_agent(&req.agent_id) {
            Ok(()) => Ok(Response::new(DeregisterResponse {
                success: true,
                message: "Agent deregistered".to_string(),
            })),
            Err(e) => Ok(Response::new(DeregisterResponse {
                success: false,
                message: e.to_string(),
            })),
        }
    }

    async fn find_agents(
        &self,
        request: Request<AgentQuery>,
    ) -> Result<Response<QueryResponse>, Status> {
        let query = request.into_inner();
        let agents = if !query.capability_filter.is_empty() {
            self.runtime.registry.find_by_capability(&query.capability_filter)
        } else if !query.model_filter.is_empty() {
            self.runtime.registry.find_by_model(&query.model_filter)
        } else if !query.agent_id.is_empty() {
            match self.runtime.registry.get(&query.agent_id) {
                Ok(a) => vec![a],
                Err(_) => vec![],
            }
        } else {
            self.runtime.registry.list_all()
        };

        Ok(Response::new(QueryResponse {
            query_id: String::new(),
            tasks: vec![],
            agents,
            artifacts: vec![],
        }))
    }

    async fn list_agents(
        &self,
        _request: Request<ListAgentsRequest>,
    ) -> Result<Response<QueryResponse>, Status> {
        let agents = self.runtime.registry.list_all();

        Ok(Response::new(QueryResponse {
            query_id: String::new(),
            tasks: vec![],
            agents,
            artifacts: vec![],
        }))
    }
}

// ─── Task Service ───────────────────────────────────────────────

pub struct AclTaskService {
    runtime: AclRuntime,
}

impl AclTaskService {
    pub fn new(runtime: AclRuntime) -> Self {
        Self { runtime }
    }
}

#[tonic::async_trait]
impl task_service_server::TaskService for AclTaskService {
    async fn submit_task(
        &self,
        request: Request<ActionPacket>,
    ) -> Result<Response<TaskResponse>, Status> {
        let packet = request.into_inner();

        match self.runtime.submit_task(&packet, vec![]) {
            Ok(task) => Ok(Response::new(TaskResponse {
                success: true,
                task_id: task.task_id,
                message: "Task submitted".to_string(),
            })),
            Err(e) => Ok(Response::new(TaskResponse {
                success: false,
                task_id: String::new(),
                message: e.to_string(),
            })),
        }
    }

    async fn claim_task(
        &self,
        request: Request<ClaimRequest>,
    ) -> Result<Response<TaskResponse>, Status> {
        let req = request.into_inner();

        match self.runtime.claim_task(&req.task_id, &req.agent_id) {
            Ok(task) => Ok(Response::new(TaskResponse {
                success: true,
                task_id: task.task_id,
                message: "Task claimed".to_string(),
            })),
            Err(e) => Ok(Response::new(TaskResponse {
                success: false,
                task_id: req.task_id,
                message: e.to_string(),
            })),
        }
    }

    async fn update_task_state(
        &self,
        request: Request<StateUpdate>,
    ) -> Result<Response<TaskResponse>, Status> {
        let update = request.into_inner();

        match self.runtime.process_state_update(&update) {
            Ok(task) => {
                let state = task.state();
                Ok(Response::new(TaskResponse {
                    success: true,
                    task_id: task.task_id,
                    message: format!("Task state updated to {:?}", state),
                }))
            }
            Err(e) => Ok(Response::new(TaskResponse {
                success: false,
                task_id: update.task_id,
                message: e.to_string(),
            })),
        }
    }

    async fn query_tasks(
        &self,
        request: Request<TaskQuery>,
    ) -> Result<Response<QueryResponse>, Status> {
        let query = request.into_inner();

        let tasks = if !query.task_id.is_empty() {
            match self.runtime.task_graph.get_task(&query.task_id) {
                Ok(t) => vec![t],
                Err(_) => vec![],
            }
        } else if query.state_filter != 0 {
            let state = TaskState::try_from(query.state_filter).unwrap_or(TaskState::Pending);
            self.runtime.task_graph.query_by_state(state)
        } else if !query.owner_filter.is_empty() {
            self.runtime.task_graph.query_by_owner(&query.owner_filter)
        } else if !query.intent_filter.is_empty() {
            self.runtime.task_graph.query_by_intent(&query.intent_filter)
        } else {
            self.runtime.task_graph.all_tasks()
        };

        Ok(Response::new(QueryResponse {
            query_id: String::new(),
            tasks,
            agents: vec![],
            artifacts: vec![],
        }))
    }

    async fn get_task(
        &self,
        request: Request<GetTaskRequest>,
    ) -> Result<Response<TaskNode>, Status> {
        let req = request.into_inner();

        self.runtime
            .task_graph
            .get_task(&req.task_id)
            .map(Response::new)
            .map_err(|e| Status::not_found(e.to_string()))
    }

    type SubscribeEventsStream = ReceiverStream<Result<Event, Status>>;

    async fn subscribe_events(
        &self,
        request: Request<SubscribeRequest>,
    ) -> Result<Response<Self::SubscribeEventsStream>, Status> {
        let req = request.into_inner();
        let filter = EventFilter {
            event_types: req.event_types.iter().filter_map(|&t| EventType::try_from(t).ok()).collect(),
            source_filter: None,
            task_id_filter: if req.task_id_filter.is_empty() {
                None
            } else {
                Some(req.task_id_filter)
            },
        };

        let mut rx = self.runtime.event_bus.subscribe(filter.clone());
        let (tx, out_rx) = mpsc::channel(128);

        tokio::spawn(async move {
            while let Ok(event) = rx.recv().await {
                if filter.matches(&event) {
                    if tx.send(Ok(event)).await.is_err() {
                        break;
                    }
                }
            }
        });

        Ok(Response::new(ReceiverStream::new(out_rx)))
    }
}

// ─── Spawn Service ──────────────────────────────────────────────

pub struct AclSpawnService {
    runtime: AclRuntime,
}

impl AclSpawnService {
    pub fn new(runtime: AclRuntime) -> Self {
        Self { runtime }
    }
}

#[tonic::async_trait]
impl spawn_service_server::SpawnService for AclSpawnService {
    async fn spawn(
        &self,
        request: Request<SpawnRequest>,
    ) -> Result<Response<SpawnResponse>, Status> {
        let req = request.into_inner();

        match self.runtime.spawn_agent(&req) {
            Ok(resp) => Ok(Response::new(resp)),
            Err(e) => Ok(Response::new(SpawnResponse {
                success: false,
                agent_id: String::new(),
                failure_reason: e.to_string(),
            })),
        }
    }

    async fn terminate(
        &self,
        request: Request<TerminateRequest>,
    ) -> Result<Response<TerminateResponse>, Status> {
        let req = request.into_inner();

        match self.runtime.terminate_agent(&req.agent_id, &req.reason) {
            Ok(()) => Ok(Response::new(TerminateResponse {
                success: true,
                message: "Agent terminated".to_string(),
            })),
            Err(e) => Ok(Response::new(TerminateResponse {
                success: false,
                message: e.to_string(),
            })),
        }
    }

    async fn get_spawn_tree(
        &self,
        request: Request<GetSpawnTreeRequest>,
    ) -> Result<Response<SpawnTree>, Status> {
        let req = request.into_inner();

        self.runtime
            .spawn_manager
            .get_spawn_tree(&req.root_agent_id)
            .map(Response::new)
            .map_err(|e| Status::not_found(e.to_string()))
    }
}

// ─── Artifact Service ───────────────────────────────────────────

pub struct AclArtifactService {
    runtime: AclRuntime,
}

impl AclArtifactService {
    pub fn new(runtime: AclRuntime) -> Self {
        Self { runtime }
    }
}

#[tonic::async_trait]
impl artifact_service_server::ArtifactService for AclArtifactService {
    async fn publish_artifact(
        &self,
        request: Request<Artifact>,
    ) -> Result<Response<ArtifactReference>, Status> {
        let artifact = request.into_inner();

        self.runtime
            .publish_artifact(artifact)
            .map(Response::new)
            .map_err(|e| Status::internal(e.to_string()))
    }

    async fn get_artifact(
        &self,
        request: Request<ArtifactReference>,
    ) -> Result<Response<Artifact>, Status> {
        let reference = request.into_inner();

        self.runtime
            .get_artifact(&reference)
            .map(Response::new)
            .map_err(|e| Status::not_found(e.to_string()))
    }

    async fn query_artifacts(
        &self,
        request: Request<ArtifactQuery>,
    ) -> Result<Response<QueryResponse>, Status> {
        let query = request.into_inner();

        let artifacts = if !query.type_filter.is_empty() {
            self.runtime.artifact_store.query_by_type(&query.type_filter)
        } else if !query.task_id_filter.is_empty() {
            self.runtime.artifact_store.query_by_task(&query.task_id_filter)
        } else {
            vec![]
        };

        Ok(Response::new(QueryResponse {
            query_id: String::new(),
            tasks: vec![],
            agents: vec![],
            artifacts,
        }))
    }
}
