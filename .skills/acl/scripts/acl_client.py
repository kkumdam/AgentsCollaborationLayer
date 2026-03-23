#!/usr/bin/env python3
"""
ACL gRPC Client — Python wrapper for Agent Collaboration Layer server.

Usage:
    from acl_client import AclClient

    client = AclClient("localhost:50051")
    client.register_agent("my-agent", "anthropic/claude-sonnet-4-6", ["research"])
    task_id = client.submit_task("supervisor", intent="research", priority=0.9)
    client.claim_task(task_id, "my-agent")
    ...

CLI Usage:
    python acl_client.py register --agent-id researcher --model anthropic/claude-sonnet-4-6 --can-do research,summarize
    python acl_client.py submit --source supervisor --intent research --priority 0.9
    python acl_client.py claim --task-id <id> --agent-id researcher
    python acl_client.py status
    python acl_client.py list-agents
    python acl_client.py list-tasks
"""

import sys
import os
import json
import argparse
import uuid

# Add the generated proto directory to path
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

try:
    import grpc
    import acl_pb2
    import acl_pb2_grpc
except ImportError as e:
    print(f"Import error: {e}")
    print("Run the following to generate Python bindings:")
    print("  pip install grpcio grpcio-tools --break-system-packages")
    print("  python3 -m grpc_tools.protoc -I acl-proto/proto \\")
    print("    --python_out=.skills/acl/scripts/ \\")
    print("    --grpc_python_out=.skills/acl/scripts/ \\")
    print("    acl-proto/proto/acl.proto")
    sys.exit(1)


class AclClient:
    """High-level Python client for the ACL gRPC server."""

    def __init__(self, address: str = "localhost:50051"):
        self.address = address
        self.channel = grpc.insecure_channel(
            address,
            options=[
                ('grpc.max_send_message_length', 16 * 1024 * 1024),
                ('grpc.max_receive_message_length', 16 * 1024 * 1024),
            ],
        )
        self.registry_stub = acl_pb2_grpc.AgentRegistryServiceStub(self.channel)
        self.task_stub = acl_pb2_grpc.TaskServiceStub(self.channel)
        self.spawn_stub = acl_pb2_grpc.SpawnServiceStub(self.channel)
        self.artifact_stub = acl_pb2_grpc.ArtifactServiceStub(self.channel)

    def close(self):
        self.channel.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    # ─── Agent Registry ──────────────────────────────────────────

    def register_agent(
        self,
        agent_id: str,
        model_backend: str,
        can_do: list[str],
        requires: list[str] | None = None,
        produces: list[str] | None = None,
        input_cost_per_1k: float = 0.003,
        output_cost_per_1k: float = 0.015,
        tool_call_cost: float = 0.0,
        avg_latency_ms: float = 200.0,
        trust_score: float = 0.9,
    ) -> dict:
        """Register an agent with capabilities."""
        capability = acl_pb2.AgentCapability(
            agent_id=agent_id,
            model_backend=model_backend,
            can_do=can_do,
            requires=requires or [],
            produces=produces or [],
            cost=acl_pb2.CostProfile(
                input_cost_per_1k=input_cost_per_1k,
                output_cost_per_1k=output_cost_per_1k,
                tool_call_cost=tool_call_cost,
            ),
            avg_latency_ms=avg_latency_ms,
            trust_score=trust_score,
        )
        resp = self.registry_stub.RegisterAgent(capability)
        return {"success": resp.success, "agent_id": resp.agent_id, "message": resp.message}

    def deregister_agent(self, agent_id: str) -> dict:
        """Remove an agent from the registry."""
        resp = self.registry_stub.DeregisterAgent(
            acl_pb2.DeregisterRequest(agent_id=agent_id)
        )
        return {"success": resp.success, "message": resp.message}

    def list_agents(self) -> list[dict]:
        """List all registered agents."""
        resp = self.registry_stub.ListAgents(acl_pb2.ListAgentsRequest())
        return [
            {
                "agent_id": a.agent_id,
                "model_backend": a.model_backend,
                "can_do": list(a.can_do),
                "trust_score": a.trust_score,
                "avg_latency_ms": a.avg_latency_ms,
            }
            for a in resp.agents
        ]

    def find_agents(self, capability: str = "", model: str = "") -> list[dict]:
        """Find agents by capability or model."""
        query = acl_pb2.AgentQuery(
            capability_filter=capability,
            model_filter=model,
        )
        resp = self.registry_stub.FindAgents(query)
        return [
            {
                "agent_id": a.agent_id,
                "model_backend": a.model_backend,
                "can_do": list(a.can_do),
                "trust_score": a.trust_score,
            }
            for a in resp.agents
        ]

    # ─── Task Management ─────────────────────────────────────────

    def submit_task(
        self,
        source_agent: str,
        intent: str,
        target_agent: str = "",
        constraints: dict[str, str] | None = None,
        output_schema: str = "",
        priority: float = 0.5,
        deadline_ms: int = 0,
        input_refs: list[str] | None = None,
    ) -> str:
        """Submit a new task. Returns task_id."""
        packet = acl_pb2.ActionPacket(
            packet_id=f"task-{uuid.uuid4().hex[:8]}",
            source_agent=source_agent,
            target_agent=target_agent,
            intent=intent,
            input_refs=input_refs or [],
            constraints=constraints or {},
            output_schema=output_schema,
            priority=priority,
            deadline_ms=deadline_ms,
        )
        resp = self.task_stub.SubmitTask(packet)
        if not resp.success:
            raise RuntimeError(f"Submit failed: {resp.message}")
        return resp.task_id

    def claim_task(self, task_id: str, agent_id: str) -> dict:
        """Claim a pending task."""
        resp = self.task_stub.ClaimTask(
            acl_pb2.ClaimRequest(task_id=task_id, agent_id=agent_id)
        )
        return {"success": resp.success, "task_id": resp.task_id, "message": resp.message}

    def update_task_state(
        self,
        task_id: str,
        agent_id: str,
        state: str,
        artifact_refs: list[str] | None = None,
        confidence: float = 0.0,
        failure_reason: str = "",
    ) -> dict:
        """Update task state. state: RUNNING, DONE, FAILED, CANCELLED, PENDING."""
        state_map = {
            "PENDING": 1, "CLAIMED": 2, "RUNNING": 3,
            "DONE": 4, "FAILED": 5, "CANCELLED": 6,
        }
        update = acl_pb2.StateUpdate(
            task_id=task_id,
            state=state_map.get(state.upper(), 0),
            owner_agent=agent_id,
            artifact_refs=artifact_refs or [],
            confidence=confidence,
            failure_reason=failure_reason,
        )
        resp = self.task_stub.UpdateTaskState(update)
        return {"success": resp.success, "task_id": resp.task_id, "message": resp.message}

    def start_task(self, task_id: str, agent_id: str) -> dict:
        """Shortcut: transition task to RUNNING."""
        return self.update_task_state(task_id, agent_id, "RUNNING")

    def complete_task(
        self, task_id: str, agent_id: str,
        artifact_refs: list[str] | None = None,
        confidence: float = 0.9,
    ) -> dict:
        """Shortcut: transition task to DONE."""
        return self.update_task_state(
            task_id, agent_id, "DONE",
            artifact_refs=artifact_refs, confidence=confidence,
        )

    def fail_task(self, task_id: str, agent_id: str, reason: str) -> dict:
        """Shortcut: transition task to FAILED."""
        return self.update_task_state(
            task_id, agent_id, "FAILED", failure_reason=reason,
        )

    def get_task(self, task_id: str) -> dict:
        """Get a single task by ID."""
        task = self.task_stub.GetTask(acl_pb2.GetTaskRequest(task_id=task_id))
        return self._task_to_dict(task)

    def list_tasks(self, state: str = "", owner: str = "", intent: str = "") -> list[dict]:
        """Query tasks with optional filters."""
        state_map = {
            "": 0, "PENDING": 1, "CLAIMED": 2, "RUNNING": 3,
            "DONE": 4, "FAILED": 5, "CANCELLED": 6,
        }
        query = acl_pb2.TaskQuery(
            state_filter=state_map.get(state.upper(), 0),
            owner_filter=owner,
            intent_filter=intent,
        )
        resp = self.task_stub.QueryTasks(query)
        return [self._task_to_dict(t) for t in resp.tasks]

    # ─── Artifact Store ──────────────────────────────────────────

    def publish_artifact(
        self,
        artifact_type: str,
        content: bytes,
        producer_agent: str,
        task_id: str = "",
        metadata: dict[str, str] | None = None,
    ) -> dict:
        """Publish an artifact. Returns artifact reference."""
        artifact = acl_pb2.Artifact(
            artifact_type=artifact_type,
            content=content,
            producer_agent=producer_agent,
            task_id=task_id,
            metadata=metadata or {},
        )
        ref = self.artifact_stub.PublishArtifact(artifact)
        return {"uri": ref.uri, "type": ref.artifact_type, "hash": ref.content_hash}

    def get_artifact(self, uri: str, artifact_type: str = "", content_hash: str = "") -> dict:
        """Retrieve an artifact by reference."""
        ref = acl_pb2.ArtifactReference(
            uri=uri, artifact_type=artifact_type, content_hash=content_hash,
        )
        artifact = self.artifact_stub.GetArtifact(ref)
        return {
            "artifact_id": artifact.artifact_id,
            "type": artifact.artifact_type,
            "content": artifact.content.decode("utf-8", errors="replace"),
            "producer": artifact.producer_agent,
            "task_id": artifact.task_id,
            "metadata": dict(artifact.metadata),
        }

    # ─── Spawn Management ────────────────────────────────────────

    def spawn_agent(
        self,
        parent_agent: str,
        agent_id: str,
        model_backend: str,
        can_do: list[str],
        spawn_type: str = "EPHEMERAL",
        budget_usd: float = 1.0,
        ttl_seconds: int = 300,
        tool_access: list[str] | None = None,
    ) -> dict:
        """Spawn a subagent."""
        type_map = {"EPHEMERAL": 1, "PERSISTENT": 2, "VIRTUAL": 3}
        req = acl_pb2.SpawnRequest(
            parent_agent=parent_agent,
            spec=acl_pb2.AgentSpec(
                agent_id=agent_id,
                model_backend=model_backend,
                can_do=can_do,
            ),
            policy=acl_pb2.SpawnPolicy(
                budget_usd=budget_usd,
                ttl_seconds=ttl_seconds,
                tool_access=tool_access or [],
            ),
            type=type_map.get(spawn_type.upper(), 1),
        )
        resp = self.spawn_stub.Spawn(req)
        return {"success": resp.success, "agent_id": resp.agent_id, "failure_reason": resp.failure_reason}

    def terminate_agent(self, agent_id: str, reason: str = "task complete") -> dict:
        """Terminate a spawned agent."""
        resp = self.spawn_stub.Terminate(
            acl_pb2.TerminateRequest(agent_id=agent_id, reason=reason)
        )
        return {"success": resp.success, "message": resp.message}

    # ─── Helpers ─────────────────────────────────────────────────

    @staticmethod
    def _task_to_dict(task) -> dict:
        state_names = {0: "UNSPECIFIED", 1: "PENDING", 2: "CLAIMED", 3: "RUNNING", 4: "DONE", 5: "FAILED", 6: "CANCELLED"}
        return {
            "task_id": task.task_id,
            "intent": task.intent,
            "state": state_names.get(task.state, "UNKNOWN"),
            "owner": task.owner_agent,
            "priority": task.priority,
            "confidence": task.confidence,
            "artifact_refs": list(task.artifact_refs),
            "constraints": dict(task.constraints),
            "failure_reason": task.failure_reason,
        }


# ─── CLI Interface ───────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="ACL gRPC Client CLI")
    parser.add_argument("--address", default="localhost:50051", help="Server address")
    sub = parser.add_subparsers(dest="command")

    # register
    reg = sub.add_parser("register", help="Register an agent")
    reg.add_argument("--agent-id", required=True)
    reg.add_argument("--model", default="anthropic/claude-sonnet-4-6")
    reg.add_argument("--can-do", required=True, help="Comma-separated capabilities")
    reg.add_argument("--trust-score", type=float, default=0.9)

    # submit
    submit = sub.add_parser("submit", help="Submit a task")
    submit.add_argument("--source", required=True, help="Source agent ID")
    submit.add_argument("--intent", required=True)
    submit.add_argument("--target", default="")
    submit.add_argument("--priority", type=float, default=0.5)
    submit.add_argument("--prompt", default="", help="Task prompt text")
    submit.add_argument("--prompt-file", default="", help="Read prompt from file (use - for stdin)")
    submit.add_argument("--constraints", default="{}", help="JSON string of constraints")
    submit.add_argument("--constraints-file", default="", help="Read constraints JSON from file")

    # claim
    claim = sub.add_parser("claim", help="Claim a task")
    claim.add_argument("--task-id", required=True)
    claim.add_argument("--agent-id", required=True)

    # start
    start = sub.add_parser("start", help="Start a claimed task")
    start.add_argument("--task-id", required=True)
    start.add_argument("--agent-id", required=True)

    # complete
    comp = sub.add_parser("complete", help="Complete a task")
    comp.add_argument("--task-id", required=True)
    comp.add_argument("--agent-id", required=True)
    comp.add_argument("--confidence", type=float, default=0.9)

    # fail
    fail = sub.add_parser("fail", help="Fail a task")
    fail.add_argument("--task-id", required=True)
    fail.add_argument("--agent-id", required=True)
    fail.add_argument("--reason", required=True)

    # list
    sub.add_parser("list-agents", help="List all agents")
    sub.add_parser("list-tasks", help="List all tasks")

    # get-task
    gt = sub.add_parser("get-task", help="Get task details")
    gt.add_argument("--task-id", required=True)

    # publish-artifact
    pa = sub.add_parser("publish-artifact", help="Publish an artifact")
    pa.add_argument("--type", required=True, dest="atype")
    pa.add_argument("--content", required=True, help="Content string or @filepath")
    pa.add_argument("--producer", required=True)
    pa.add_argument("--task-id", default="")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return

    client = AclClient(args.address)

    try:
        if args.command == "register":
            result = client.register_agent(
                agent_id=args.agent_id,
                model_backend=args.model,
                can_do=args.can_do.split(","),
                trust_score=args.trust_score,
            )
        elif args.command == "submit":
            # Read prompt from file or args
            prompt_text = ""
            if args.prompt_file:
                if args.prompt_file == "-":
                    prompt_text = sys.stdin.read()
                elif os.path.isfile(args.prompt_file):
                    with open(args.prompt_file, "r", encoding="utf-8") as f:
                        prompt_text = f.read()
            elif args.prompt:
                prompt_text = args.prompt

            # Read constraints from file or args
            if args.constraints_file and os.path.isfile(args.constraints_file):
                with open(args.constraints_file, "r", encoding="utf-8") as f:
                    constraints = json.load(f)
            else:
                constraints = json.loads(args.constraints)

            # Inject prompt into constraints if provided
            if prompt_text:
                constraints["prompt"] = prompt_text

            task_id = client.submit_task(
                source_agent=args.source,
                intent=args.intent,
                target_agent=args.target,
                constraints=constraints,
                priority=args.priority,
            )
            result = {"task_id": task_id}
        elif args.command == "claim":
            result = client.claim_task(args.task_id, args.agent_id)
        elif args.command == "start":
            result = client.start_task(args.task_id, args.agent_id)
        elif args.command == "complete":
            result = client.complete_task(args.task_id, args.agent_id, confidence=args.confidence)
        elif args.command == "fail":
            result = client.fail_task(args.task_id, args.agent_id, args.reason)
        elif args.command == "list-agents":
            result = client.list_agents()
        elif args.command == "list-tasks":
            result = client.list_tasks()
        elif args.command == "get-task":
            result = client.get_task(args.task_id)
        elif args.command == "publish-artifact":
            content = args.content
            if content.startswith("@"):
                with open(content[1:], "rb") as f:
                    content_bytes = f.read()
            else:
                content_bytes = content.encode("utf-8")
            result = client.publish_artifact(
                artifact_type=args.atype,
                content=content_bytes,
                producer_agent=args.producer,
                task_id=args.task_id,
            )
        else:
            parser.print_help()
            return

        print(json.dumps(result, indent=2, ensure_ascii=False))

    except grpc.RpcError as e:
        print(f"gRPC Error: {e.code()} - {e.details()}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        client.close()


if __name__ == "__main__":
    main()
