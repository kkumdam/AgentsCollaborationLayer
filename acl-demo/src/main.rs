//! ACL Demo: Supervisor + 2 Worker Agents
//!
//! Demonstrates the core ACL workflow:
//! 1. Register supervisor and worker agents
//! 2. Supervisor creates tasks with dependencies
//! 3. Workers claim and execute tasks via state transitions
//! 4. Artifacts are published and referenced
//! 5. All communication is typed packets — zero natural language

use acl_core::policy_engine::PolicyConfig;
use acl_core::runtime::{AclRuntime, RuntimeConfig};
use acl_proto::*;
use chrono::Utc;
use tracing::warn;
use tracing_subscriber::EnvFilter;

fn separator(title: &str) {
    println!("\n{}", "=".repeat(60));
    println!("  {}", title);
    println!("{}\n", "=".repeat(60));
}

fn print_task_state(runtime: &AclRuntime, task_id: &str, label: &str) {
    if let Ok(task) = runtime.task_graph.get_task(task_id) {
        println!(
            "  [{}] {} | state={:?} owner={} confidence={:.2}",
            label,
            task.task_id,
            task.state(),
            if task.owner_agent.is_empty() { "none" } else { &task.owner_agent },
            task.confidence,
        );
        if !task.artifact_refs.is_empty() {
            println!("         artifacts: {:?}", task.artifact_refs);
        }
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("acl=info".parse()?))
        .compact()
        .init();

    println!();
    println!("╔══════════════════════════════════════════════════════════╗");
    println!("║         ACL Demo: Multi-Agent Pipeline                  ║");
    println!("║   \"Market Analysis Report\" with Supervisor + Workers    ║");
    println!("║                                                         ║");
    println!("║   All communication via typed state transitions.        ║");
    println!("║   Zero natural language between agents.                 ║");
    println!("╚══════════════════════════════════════════════════════════╝");

    // ─── Initialize Runtime ─────────────────────────────────────
    let config = RuntimeConfig {
        event_bus_capacity: 1000,
        default_policy: PolicyConfig {
            spawn_limit: 10,
            spawn_depth_limit: 3,
            budget_usd: 10.0,
            tool_access: vec![
                "search".into(),
                "read_docs".into(),
                "summarize".into(),
                "write".into(),
            ],
            ttl_seconds: 600,
            ..Default::default()
        },
    };

    let runtime = AclRuntime::new(config);

    // ─── Phase 1: Agent Registration ────────────────────────────
    separator("Phase 1: Agent Registration");

    let supervisor = AgentCapability {
        agent_id: "supervisor-alpha".to_string(),
        model_backend: "anthropic/claude-sonnet-4-6".to_string(),
        can_do: vec!["orchestrate".into(), "plan".into(), "review".into()],
        requires: vec![],
        produces: vec!["task_plan".into()],
        cost: Some(CostProfile {
            input_cost_per_1k: 0.003,
            output_cost_per_1k: 0.015,
            tool_call_cost: 0.0,
        }),
        avg_latency_ms: 200.0,
        trust_score: 0.95,
    };

    let researcher = AgentCapability {
        agent_id: "researcher-beta".to_string(),
        model_backend: "openai/gpt-4.1".to_string(),
        can_do: vec!["research".into(), "summarize".into(), "cite".into()],
        requires: vec!["search_query".into()],
        produces: vec!["research_report".into(), "citation_list".into()],
        cost: Some(CostProfile {
            input_cost_per_1k: 0.005,
            output_cost_per_1k: 0.015,
            tool_call_cost: 0.001,
        }),
        avg_latency_ms: 350.0,
        trust_score: 0.88,
    };

    let writer = AgentCapability {
        agent_id: "writer-gamma".to_string(),
        model_backend: "anthropic/claude-sonnet-4-6".to_string(),
        can_do: vec!["write".into(), "edit".into(), "format".into()],
        requires: vec!["research_report".into()],
        produces: vec!["final_document".into()],
        cost: Some(CostProfile {
            input_cost_per_1k: 0.003,
            output_cost_per_1k: 0.015,
            tool_call_cost: 0.0,
        }),
        avg_latency_ms: 250.0,
        trust_score: 0.92,
    };

    runtime.register_agent(supervisor).unwrap();
    runtime.register_agent(researcher).unwrap();
    runtime.register_agent(writer).unwrap();

    println!("  Registered 3 agents:");
    for agent in runtime.registry.list_all() {
        println!(
            "    - {} ({}) | can_do={:?} trust={:.2}",
            agent.agent_id, agent.model_backend, agent.can_do, agent.trust_score,
        );
    }

    // ─── Phase 2: Task Graph Construction ───────────────────────
    separator("Phase 2: Task Graph Construction (DAG)");

    // Task 1: Research (no dependencies)
    let research_packet = ActionPacket {
        packet_id: "task-research-001".to_string(),
        source_agent: "supervisor-alpha".to_string(),
        target_agent: String::new(), // Let routing decide
        intent: "research".to_string(),
        input_refs: vec![],
        constraints: [
            ("topic".into(), "AI agent collaboration market 2026".into()),
            ("depth".into(), "comprehensive".into()),
            ("max_sources".into(), "10".into()),
        ]
        .into_iter()
        .collect(),
        output_schema: "research_report".to_string(),
        priority: 0.9,
        deadline_ms: Utc::now().timestamp_millis() + 300_000, // 5 min
        prompt: String::new(),
    };

    let research_task = runtime.submit_task(&research_packet, vec![]).unwrap();
    println!("  Created: {} (intent=research, priority=0.9)", research_task.task_id);

    // Task 2: Write Report (depends on research)
    let write_packet = ActionPacket {
        packet_id: "task-write-001".to_string(),
        source_agent: "supervisor-alpha".to_string(),
        target_agent: String::new(),
        intent: "write".to_string(),
        input_refs: vec![], // Will be filled with artifact refs
        constraints: [
            ("format".into(), "executive_summary".into()),
            ("length".into(), "2000_words".into()),
            ("tone".into(), "professional".into()),
        ]
        .into_iter()
        .collect(),
        output_schema: "final_document".to_string(),
        priority: 0.8,
        deadline_ms: Utc::now().timestamp_millis() + 600_000,
        prompt: String::new(),
    };

    let write_task = runtime
        .submit_task(&write_packet, vec![research_task.task_id.clone()])
        .unwrap();
    println!(
        "  Created: {} (intent=write, depends_on=[{}])",
        write_task.task_id, research_task.task_id,
    );

    // Task 3: Review (depends on write)
    let review_packet = ActionPacket {
        packet_id: "task-review-001".to_string(),
        source_agent: "supervisor-alpha".to_string(),
        target_agent: "supervisor-alpha".to_string(), // Self-review
        intent: "review".to_string(),
        input_refs: vec![],
        constraints: [
            ("criteria".into(), "accuracy,completeness,tone".into()),
        ]
        .into_iter()
        .collect(),
        output_schema: "review_verdict".to_string(),
        priority: 0.7,
        deadline_ms: 0,
        prompt: String::new(),
    };

    let review_task = runtime
        .submit_task(&review_packet, vec![write_task.task_id.clone()])
        .unwrap();
    println!(
        "  Created: {} (intent=review, depends_on=[{}])",
        review_task.task_id, write_task.task_id,
    );

    println!("\n  Task DAG:");
    println!("    [research-001] ──> [write-001] ──> [review-001]");

    // Show claimable tasks
    let claimable = runtime.get_claimable_tasks();
    println!(
        "\n  Claimable tasks: {:?}",
        claimable.iter().map(|t| &t.task_id).collect::<Vec<_>>()
    );

    // ─── Phase 3: Research Execution ────────────────────────────
    separator("Phase 3: Research Agent Executes Task");

    // Researcher claims and executes
    println!("  researcher-beta claims task-research-001...");
    runtime.claim_task(&research_task.task_id, "researcher-beta").unwrap();
    print_task_state(&runtime, &research_task.task_id, "CLAIMED");

    println!("  researcher-beta starts execution...");
    runtime.start_task(&research_task.task_id, "researcher-beta").unwrap();
    print_task_state(&runtime, &research_task.task_id, "RUNNING");

    // Publish research artifact
    let research_artifact = Artifact {
        artifact_id: String::new(),
        artifact_type: "research_report".to_string(),
        content_hash: String::new(),
        content: br#"{
  "title": "AI Agent Collaboration Market Analysis 2026",
  "key_findings": [
    "Multi-agent systems market growing at 45% CAGR",
    "Token efficiency is primary adoption barrier",
    "State-based communication reduces costs by 70%"
  ],
  "sources_count": 8,
  "confidence": 0.91
}"#
        .to_vec(),
        producer_agent: "researcher-beta".to_string(),
        task_id: research_task.task_id.clone(),
        created_at: 0,
        metadata: [
            ("format".into(), "json".into()),
            ("word_count".into(), "450".into()),
        ]
        .into_iter()
        .collect(),
    };

    let research_ref = runtime.publish_artifact(research_artifact).unwrap();
    println!("  Published artifact: {}", research_ref.uri);

    runtime
        .complete_task(
            &research_task.task_id,
            "researcher-beta",
            vec![research_ref.uri.clone()],
            0.91,
        )
        .unwrap();
    print_task_state(&runtime, &research_task.task_id, "DONE");

    // Check: write task should now be claimable
    let claimable = runtime.get_claimable_tasks();
    println!(
        "\n  Now claimable: {:?}",
        claimable.iter().map(|t| &t.task_id).collect::<Vec<_>>()
    );

    // ─── Phase 4: Writer Execution ──────────────────────────────
    separator("Phase 4: Writer Agent Executes Task");

    println!("  writer-gamma claims task-write-001...");
    runtime.claim_task(&write_task.task_id, "writer-gamma").unwrap();

    println!("  writer-gamma starts execution...");
    runtime.start_task(&write_task.task_id, "writer-gamma").unwrap();

    // Writer publishes final document
    let doc_artifact = Artifact {
        artifact_id: String::new(),
        artifact_type: "final_document".to_string(),
        content_hash: String::new(),
        content: br#"{
  "title": "Executive Summary: AI Agent Collaboration Market 2026",
  "sections": ["Market Overview", "Key Trends", "Competitive Landscape", "Recommendations"],
  "word_count": 1850,
  "format": "executive_summary",
  "based_on": ["artifact://research_report/..."]
}"#
        .to_vec(),
        producer_agent: "writer-gamma".to_string(),
        task_id: write_task.task_id.clone(),
        created_at: 0,
        metadata: Default::default(),
    };

    let doc_ref = runtime.publish_artifact(doc_artifact).unwrap();
    println!("  Published artifact: {}", doc_ref.uri);

    runtime
        .complete_task(
            &write_task.task_id,
            "writer-gamma",
            vec![doc_ref.uri.clone()],
            0.88,
        )
        .unwrap();
    print_task_state(&runtime, &write_task.task_id, "DONE");

    // ─── Phase 5: Review Execution ──────────────────────────────
    separator("Phase 5: Supervisor Reviews Final Output");

    runtime.claim_task(&review_task.task_id, "supervisor-alpha").unwrap();
    runtime.start_task(&review_task.task_id, "supervisor-alpha").unwrap();

    let review_artifact = Artifact {
        artifact_id: String::new(),
        artifact_type: "review_verdict".to_string(),
        content_hash: String::new(),
        content: br#"{
  "verdict": "APPROVED",
  "score": 0.89,
  "feedback": {
    "accuracy": "high",
    "completeness": "meets_requirements",
    "tone": "professional"
  }
}"#
        .to_vec(),
        producer_agent: "supervisor-alpha".to_string(),
        task_id: review_task.task_id.clone(),
        created_at: 0,
        metadata: Default::default(),
    };

    let review_ref = runtime.publish_artifact(review_artifact).unwrap();
    println!("  Published review verdict: {}", review_ref.uri);

    runtime
        .complete_task(
            &review_task.task_id,
            "supervisor-alpha",
            vec![review_ref.uri.clone()],
            0.89,
        )
        .unwrap();
    print_task_state(&runtime, &review_task.task_id, "DONE");

    // ─── Phase 6: Subagent Spawn Demo ───────────────────────────
    separator("Phase 6: Subagent Spawning Demo");

    // Register supervisor in spawn manager for tree tracking
    runtime.spawn_manager.spawned_insert_root("supervisor-alpha");

    let spawn_req = SpawnRequest {
        parent_agent: "supervisor-alpha".to_string(),
        spec: Some(AgentSpec {
            agent_id: "citation-checker-001".to_string(),
            model_backend: "openai/gpt-4.1-mini".to_string(),
            can_do: vec!["verify_citations".into(), "fact_check".into()],
            requires: vec!["citation_list".into()],
            produces: vec!["verification_report".into()],
        }),
        policy: Some(SpawnPolicy {
            spawn_limit: 0,
            spawn_depth: 1,
            tool_access: vec!["search".into()],
            budget_usd: 0.50,
            ttl_seconds: 120,
            memory_scope: "market_analysis".into(),
        }),
        r#type: SpawnType::Ephemeral.into(),
        memory_refs: vec!["market_analysis".into()],
    };

    match runtime.spawn_agent(&spawn_req) {
        Ok(resp) => {
            println!("  Spawned ephemeral subagent: {}", resp.agent_id);
            println!("    type=EPHEMERAL budget=$0.50 ttl=120s");
            println!("    can_do=[verify_citations, fact_check]");

            // Terminate after "work"
            runtime.terminate_agent(&resp.agent_id, "task complete").unwrap();
            println!("  Terminated: {} (task complete)", resp.agent_id);
        }
        Err(e) => warn!("Spawn failed: {}", e),
    }

    // ─── Final Summary ──────────────────────────────────────────
    separator("Pipeline Complete — Runtime Statistics");

    let stats = runtime.stats();
    println!("  Tasks:");
    println!("    Total:     {}", stats.total_tasks);
    println!("    Completed: {}", stats.completed_tasks);
    println!("    Failed:    {}", stats.failed_tasks);
    println!("    Pending:   {}", stats.pending_tasks);
    println!();
    println!("  Agents:");
    println!("    Registered:     {}", stats.registered_agents);
    println!("    Active Spawns:  {}", stats.active_subagents);
    println!();
    println!("  Artifacts: {}", stats.total_artifacts);
    println!("  Events:    {}", stats.total_events);
    println!();

    // Show event history summary
    let events = runtime.event_bus.get_history();
    println!("  Event Timeline ({} events):", events.len());
    for event in &events {
        println!(
            "    [{:>13}] {:?} from {}",
            event.timestamp,
            event.event_type(),
            event.source,
        );
    }

    println!();
    println!("╔══════════════════════════════════════════════════════════╗");
    println!("║   Demo Complete!                                        ║");
    println!("║                                                         ║");
    println!("║   All agent communication occurred via:                 ║");
    println!("║     - Typed ActionPackets (not prompts)                 ║");
    println!("║     - State transitions (not messages)                  ║");
    println!("║     - Artifact references (not raw content)             ║");
    println!("║     - Policy-governed spawning (not free spawning)      ║");
    println!("║                                                         ║");
    println!("║   Zero natural language was exchanged between agents.   ║");
    println!("╚══════════════════════════════════════════════════════════╝");
    println!();

    Ok(())
}
