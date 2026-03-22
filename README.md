# ACL — Agent Collaboration Layer

**Multi-CLI agent orchestrator that routes coding tasks across Codex, Claude, and Gemini via DAG-based pipelines.**

ACL decomposes complex coding workflows into directed acyclic graphs (DAGs), topologically sorts them into parallel execution waves, and auto-routes each task to the best-fit AI CLI agent based on capability profiles and intent mapping.

```
  ┌─────────────┐
  │   analyze    │  Wave 1  (Claude — architecture analysis)
  └──────┬──────┘
         │
   ┌─────┴──────┐
   ▼             ▼
┌──────┐   ┌──────────┐
│ core │   │ support  │  Wave 2  (Codex — parallel code generation)
└──┬───┘   └────┬─────┘
   │             │
   ▼             ▼
┌──────┐   ┌────────┐
│ test │   │ review │    Wave 3  (Claude — test + review in parallel)
└──┬───┘   └───┬────┘
   │           │
   ▼           ▼
  ┌─────────────┐
  │  finalize   │    Wave 4  (Gemini — documentation)
  └─────────────┘
```

## Why ACL?

Most AI coding assistants run as a single agent. ACL takes a different approach — it **orchestrates multiple specialized agents in parallel**, each handling what it's best at:

| Agent | Strengths | Routes to |
|-------|-----------|-----------|
| **Codex** | Fast code generation, boilerplate, refactoring | `code_generation`, `implement_feature`, `refactor` |
| **Claude** | Analysis, review, debugging, complex reasoning | `code_review`, `bug_analysis`, `architecture_analysis` |
| **Gemini** | Large context, research, documentation | `research`, `documentation`, `api_integration` |

If only one CLI is installed, all tasks route to it. ACL gracefully degrades — you don't need all three to get started.

## Quick Start

### Prerequisites

- **Python 3.10+**
- At least one AI CLI installed:

```bash
npm i -g @openai/codex          # Codex CLI
npm i -g @anthropic-ai/claude-code  # Claude Code CLI
npm i -g @google/gemini-cli     # Gemini CLI
```

### Run

**PowerShell (Windows):**

```powershell
# Dry run — see the DAG and routing without executing
.\run_pipeline.ps1

# Live execution against your project
.\run_pipeline.ps1 -Live -WorkDir C:\path\to\project

# Different pipeline types
.\run_pipeline.ps1 -Pipeline bugfix -Desc "NullPointer in UserService.login()" -Live
.\run_pipeline.ps1 -Pipeline refactor -Desc "Extract auth into separate module" -Live
.\run_pipeline.ps1 -Pipeline review -Desc "src/core/"
```

**Bash (macOS / Linux):**

```bash
# Dry run
./run_pipeline.sh

# Live execution
./run_pipeline.sh --live --workdir /path/to/project

# Different pipeline types
./run_pipeline.sh --live bugfix "NullPointer in UserService.login()"
./run_pipeline.sh --live refactor "Extract auth into separate module"
./run_pipeline.sh --live review src/core/ --focus security
```

## Pipelines

### Feature Implementation

```
analyze → [implement-core, implement-supporting] → [write-tests, review] → finalize
```

Decomposes a feature request into analysis, parallel implementation, testing, review, and documentation.

### Bug Fix

```
diagnose → [fix-primary, fix-alternative, write-regression-test] → verify
```

Produces two independent fix candidates in parallel, plus a regression test, then verifies which fix is best.

### Refactoring

```
analyze-structure → refactor-plan → [refactor-module-a, refactor-module-b] → integration-test → review
```

Plans the refactoring, executes module-level changes in parallel, then validates with integration tests.

### Code Review (Competitive Parallel)

```
[review-claude, review-gemini] → synthesize
```

Runs two independent reviews in parallel, then synthesizes findings into a unified report.

## Architecture

```
User Request
    ↓
Pipeline Template (feature / bugfix / refactor / review)
    ↓
DAG → Topological Sort → Execution Waves
    ↓
Router → Intent-based agent selection per task
    ↓
CliExecutor → Parallel subprocess execution
    ↓
Results collected as artifacts
```

### Key Components

| File | Role |
|------|------|
| `scripts/pipeline.py` | Pipeline templates and DAG framework |
| `scripts/orchestrator.py` | Top-level runner: routing, wave execution, result aggregation |
| `scripts/executor.py` | CLI subprocess bridge (Codex, Claude, Gemini) |
| `scripts/profiles.json` | Agent capability profiles and routing rules |
| `run_pipeline.ps1` | Windows PowerShell entry point |
| `run_pipeline.sh` | macOS / Linux Bash entry point |

### Intent Routing

The router matches each task's `intent` to the best available agent:

```
code_generation      → Codex  (fallback: Gemini → Claude)
code_review          → Claude (fallback: Gemini)
architecture_analysis→ Claude (fallback: Gemini)
bug_analysis         → Claude (fallback: Gemini → Codex)
documentation        → Gemini (fallback: Claude)
research             → Gemini (fallback: Claude)
```

If the primary agent is not installed, the router automatically falls back. Tie-breaking uses `trust_score > latency > cost`.

## Custom Pipelines

### Python API

```python
from scripts.orchestrator import Orchestrator
from scripts.pipeline import custom_pipeline

pipeline = custom_pipeline(
    name="my-workflow",
    description="Custom coding workflow",
    tasks=[
        {"task_id": "research", "intent": "research",
         "prompt": "Research best practices for rate limiting"},
        {"task_id": "implement", "intent": "code_generation",
         "prompt": "Implement rate limiter", "depends_on": ["research"]},
        {"task_id": "test", "intent": "test_generation",
         "prompt": "Write tests for rate limiter", "depends_on": ["implement"]},
    ]
)

orch = Orchestrator(workdir="/path/to/project")
result = orch.run_pipeline(pipeline)
```

### Task Options

| Field | Type | Description |
|-------|------|-------------|
| `task_id` | string | Unique identifier |
| `intent` | string | Capability key for routing |
| `prompt` | string | Instructions for the agent |
| `depends_on` | list | Task IDs that must complete first |
| `force_agent` | string | Override auto-routing (`"codex"`, `"claude"`, `"gemini"`) |
| `priority` | float | 0.0–1.0, higher = more important |
| `timeout_seconds` | int | Max execution time per task |

## Customizing Agent Profiles

Edit `scripts/profiles.json` to adjust routing behavior, add new intents, or tune agent parameters:

```jsonc
{
  "agents": {
    "claude": {
      "can_do": ["code_review", "architecture_analysis", ...],
      "trust_score": 0.95,    // routing tie-breaker
      "avg_latency_ms": 20000,
      "timeout_seconds": 600
    }
  },
  "routing_rules": {
    "intent_mapping": {
      "code_review": { "primary": "claude", "fallback": ["gemini"] }
    }
  }
}
```

## Output

Pipeline results are saved as JSON:

```json
{
  "pipeline": "feature-implementation",
  "total_tasks": 6,
  "succeeded": 6,
  "failed": 0,
  "total_time_seconds": 142.5,
  "tasks": {
    "analyze": { "agent": "claude", "success": true, "duration_ms": 23400 },
    "implement-core": { "agent": "codex", "success": true, "duration_ms": 31200 },
    ...
  }
}
```

## Roadmap

- [ ] gRPC server for persistent agent registry and real-time task coordination
- [ ] Artifact store with content-addressable storage (SHA-256)
- [ ] Policy engine (spawn limits, budget caps, TTL, tool ACLs)
- [ ] Web dashboard for pipeline visualization and monitoring
- [ ] Plugin system for additional CLI agents

## Contributing

Contributions are welcome! Feel free to open issues or submit pull requests.

## License

[MIT](LICENSE) — free to use, modify, and distribute.
