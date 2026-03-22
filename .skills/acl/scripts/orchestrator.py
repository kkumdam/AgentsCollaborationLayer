#!/usr/bin/env python3
"""
ACL Orchestrator — Top-level entry point for multi-CLI coding workflows.

Ties together: Pipeline templates → Agent routing → CLI execution → Artifact collection

Usage:
    # As a library
    from orchestrator import Orchestrator
    orch = Orchestrator(workdir="/path/to/project")
    result = orch.run_feature("Add WebSocket support for real-time events")

    # As CLI
    python orchestrator.py feature "Add WebSocket support" --workdir /path/to/project
    python orchestrator.py bugfix "NullPointerException in UserService.login()" --error-log "..."
    python orchestrator.py refactor "Extract payment logic into separate module"
    python orchestrator.py review "src/auth/" --focus security,correctness
    python orchestrator.py status
"""

import json
import os
import sys
import time
import argparse
from datetime import datetime
from pathlib import Path
from typing import Optional

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from executor import CliExecutor, ExecutionResult
from pipeline import (
    Pipeline, PipelineTask, PIPELINE_TEMPLATES,
    feature_pipeline, bugfix_pipeline, refactor_pipeline, review_pipeline,
    custom_pipeline,
)


class Router:
    """Routes pipeline tasks to the most appropriate CLI agent."""

    def __init__(self, profiles_path: Optional[str] = None):
        path = profiles_path or os.path.join(SCRIPT_DIR, "profiles.json")
        with open(path) as f:
            data = json.load(f)
        self.agents = data["agents"]
        self.intent_mapping = data["routing_rules"]["intent_mapping"]
        self.available_agents: list[str] = []

    def set_available(self, available: list[str]):
        """Set which agents are actually available (CLI installed)."""
        self.available_agents = available

    def route(self, task: PipelineTask) -> str:
        """Determine which CLI agent should handle this task."""
        # Forced agent override
        if task.force_agent:
            if task.force_agent in self.available_agents:
                return task.force_agent
            # Fallback if forced agent not available
            print(f"  [WARN] {task.force_agent} not available, falling back")

        # Intent-based routing
        mapping = self.intent_mapping.get(task.intent)
        if mapping:
            if mapping["primary"] in self.available_agents:
                return mapping["primary"]
            for fallback in mapping.get("fallback", []):
                if fallback in self.available_agents:
                    return fallback

        # Last resort: pick by trust score among available
        best = None
        best_score = -1
        for name in self.available_agents:
            agent = self.agents.get(name, {})
            if agent.get("trust_score", 0) > best_score:
                best = name
                best_score = agent.get("trust_score", 0)

        return best or self.available_agents[0] if self.available_agents else "claude"


class Orchestrator:
    """
    Main orchestrator that runs multi-CLI coding pipelines.

    Architecture:
        User Request
            ↓
        Pipeline Template (feature/bugfix/refactor/review)
            ↓
        DAG → Execution Waves (topological sort)
            ↓
        Router → CLI Agent selection per task
            ↓
        CliExecutor → Parallel subprocess execution
            ↓
        Results collected as artifacts
    """

    def __init__(self, workdir: str = ".", profiles_path: Optional[str] = None):
        self.workdir = os.path.abspath(workdir)
        self.executor = CliExecutor(workdir)
        self.router = Router(profiles_path)

        # Detect available CLI tools
        available = self.executor.list_available()
        self.router.set_available(available)

        # Run log
        self.run_log: list[dict] = []
        self.start_time: Optional[float] = None

    def run_pipeline(
        self,
        pipeline: Pipeline,
        dry_run: bool = False,
        verbose: bool = True,
    ) -> dict:
        """
        Execute a pipeline end-to-end.

        Returns a summary dict with all task results.
        """
        self.start_time = time.time()
        self.run_log = []

        if verbose:
            print(pipeline.visualize())
            print()
            print(f"Available agents: {self.router.available_agents}")
            print(f"Working directory: {self.workdir}")
            print()

        waves = pipeline.get_execution_order()
        all_results: dict[str, ExecutionResult] = {}

        for wave_idx, wave in enumerate(waves):
            if verbose:
                parallel_label = " (parallel)" if len(wave) > 1 else ""
                print(f"{'='*60}")
                print(f"  Wave {wave_idx + 1}/{len(waves)}{parallel_label}")
                print(f"{'='*60}")

            # Route each task
            routed: list[tuple[PipelineTask, str]] = []
            for task in wave:
                agent = self.router.route(task)
                routed.append((task, agent))
                if verbose:
                    print(f"  [{task.task_id}] intent={task.intent} → {agent}")

            if dry_run:
                for task, agent in routed:
                    all_results[task.task_id] = ExecutionResult(
                        agent_id=agent, success=True,
                        output=f"[DRY RUN] Would execute with {agent}",
                    )
                continue

            # Execute wave (parallel if multiple tasks)
            if len(routed) == 1:
                task, agent = routed[0]
                result = self._execute_task(task, agent, all_results, verbose)
                all_results[task.task_id] = result
            else:
                # Parallel execution
                exec_tasks = []
                task_map = {}
                for task, agent in routed:
                    prompt = self._build_prompt(task, all_results)
                    exec_tasks.append({
                        "cli_name": agent,
                        "prompt": prompt,
                        "workdir": self.workdir,
                        "timeout_seconds": task.timeout_seconds,
                    })
                    task_map[agent + "|" + task.task_id] = task

                if verbose:
                    print(f"\n  Executing {len(exec_tasks)} tasks in parallel...")

                results = self.executor.execute_parallel(
                    exec_tasks, timeout_seconds=max(t.timeout_seconds for t, _ in routed)
                )

                for i, result in enumerate(results):
                    task = routed[i][0]
                    all_results[task.task_id] = result
                    self._log_result(task, result, verbose)

            if verbose:
                print()

        # Summary
        total_time = time.time() - self.start_time
        summary = self._build_summary(pipeline, all_results, total_time)

        if verbose:
            self._print_summary(summary)

        return summary

    def _execute_task(
        self,
        task: PipelineTask,
        agent: str,
        previous_results: dict[str, ExecutionResult],
        verbose: bool,
    ) -> ExecutionResult:
        """Execute a single task."""
        prompt = self._build_prompt(task, previous_results)

        if verbose:
            print(f"\n  Executing [{task.task_id}] via {agent}...")

        result = self.executor.execute(
            cli_name=agent,
            prompt=prompt,
            workdir=self.workdir,
            timeout_seconds=task.timeout_seconds,
        )

        self._log_result(task, result, verbose)
        return result

    def _build_prompt(
        self,
        task: PipelineTask,
        previous_results: dict[str, ExecutionResult],
    ) -> str:
        """Build the actual prompt, enriching with context from previous task results."""
        prompt = task.prompt_template

        # Inject context from dependency results
        if task.depends_on:
            context_parts = []
            for dep_id in task.depends_on:
                if dep_id in previous_results and previous_results[dep_id].success:
                    dep_output = previous_results[dep_id].output
                    if dep_output:
                        # Truncate very long outputs
                        if len(dep_output) > 4000:
                            dep_output = dep_output[:4000] + "\n... (truncated)"
                        context_parts.append(
                            f"[Output from '{dep_id}']:\n{dep_output}"
                        )

            if context_parts:
                prompt += "\n\n--- Context from previous steps ---\n"
                prompt += "\n\n".join(context_parts)

        return prompt

    def _log_result(self, task: PipelineTask, result: ExecutionResult, verbose: bool):
        """Log a task execution result."""
        entry = {
            "task_id": task.task_id,
            "agent": result.agent_id,
            "success": result.success,
            "duration_ms": result.duration_ms,
            "timestamp": datetime.now().isoformat(),
        }
        self.run_log.append(entry)

        if verbose:
            status = "OK" if result.success else "FAIL"
            print(f"  [{status}] {task.task_id} via {result.agent_id} ({result.duration_ms}ms)")
            if not result.success and result.error:
                print(f"    Error: {result.error[:200]}")

    def _build_summary(
        self,
        pipeline: Pipeline,
        results: dict[str, ExecutionResult],
        total_time: float,
    ) -> dict:
        """Build execution summary."""
        succeeded = sum(1 for r in results.values() if r.success)
        failed = sum(1 for r in results.values() if not r.success)

        return {
            "pipeline": pipeline.name,
            "description": pipeline.description,
            "total_tasks": len(results),
            "succeeded": succeeded,
            "failed": failed,
            "total_time_seconds": round(total_time, 2),
            "tasks": {
                tid: {
                    "agent": r.agent_id,
                    "success": r.success,
                    "duration_ms": r.duration_ms,
                    "output_preview": r.output[:200] if r.output else "",
                    "error": r.error[:200] if r.error else "",
                }
                for tid, r in results.items()
            },
            "run_log": self.run_log,
        }

    def _print_summary(self, summary: dict):
        """Print a human-readable summary."""
        print("=" * 60)
        print(f"  Pipeline Complete: {summary['pipeline']}")
        print("=" * 60)
        print(f"  Tasks: {summary['succeeded']}/{summary['total_tasks']} succeeded")
        print(f"  Time:  {summary['total_time_seconds']}s")
        print()
        for tid, info in summary["tasks"].items():
            status = "✓" if info["success"] else "✗"
            print(f"  {status} {tid} ({info['agent']}, {info['duration_ms']}ms)")

    # ─── Convenience Methods ─────────────────────────────────────

    def run_feature(self, description: str, **kwargs) -> dict:
        """Run a feature implementation pipeline."""
        pipeline = feature_pipeline(description, **kwargs)
        return self.run_pipeline(pipeline)

    def run_bugfix(self, description: str, **kwargs) -> dict:
        """Run a bug fix pipeline."""
        pipeline = bugfix_pipeline(description, **kwargs)
        return self.run_pipeline(pipeline)

    def run_refactor(self, description: str, **kwargs) -> dict:
        """Run a refactoring pipeline."""
        pipeline = refactor_pipeline(description, **kwargs)
        return self.run_pipeline(pipeline)

    def run_review(self, target: str, **kwargs) -> dict:
        """Run a code review pipeline."""
        pipeline = review_pipeline(target, **kwargs)
        return self.run_pipeline(pipeline)

    def status(self) -> dict:
        """Get current orchestrator status."""
        return {
            "workdir": self.workdir,
            "available_agents": self.router.available_agents,
            "agent_details": {
                name: {
                    "display_name": self.router.agents[name]["display_name"],
                    "can_do": self.router.agents[name]["can_do"],
                    "trust_score": self.router.agents[name]["trust_score"],
                }
                for name in self.router.available_agents
                if name in self.router.agents
            },
        }


# ─── CLI Interface ───────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="ACL Orchestrator — Multi-CLI Coding Pipeline Runner",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python orchestrator.py feature "Add WebSocket support for real-time events"
  python orchestrator.py bugfix "NullPointerException in login()" --error-log "stack trace..."
  python orchestrator.py refactor "Extract auth into separate module" --scope src/auth/
  python orchestrator.py review src/core/ --focus security,performance
  python orchestrator.py status
  python orchestrator.py visualize feature "Add caching layer"
        """,
    )
    parser.add_argument("--workdir", default=".", help="Project working directory")
    parser.add_argument("--dry-run", action="store_true", help="Show plan without executing")
    parser.add_argument("--quiet", action="store_true", help="Minimal output")
    parser.add_argument("--output", help="Save results JSON to file")

    sub = parser.add_subparsers(dest="command")

    # feature
    feat = sub.add_parser("feature", help="Implement a feature")
    feat.add_argument("description", help="Feature description")
    feat.add_argument("--target-files", default="", help="Target files to modify")
    feat.add_argument("--tests", default="", help="Test requirements")

    # bugfix
    bug = sub.add_parser("bugfix", help="Fix a bug")
    bug.add_argument("description", help="Bug description")
    bug.add_argument("--error-log", default="", help="Error log or stack trace")
    bug.add_argument("--affected-files", default="", help="Affected files")

    # refactor
    ref = sub.add_parser("refactor", help="Refactor code")
    ref.add_argument("description", help="Refactoring goal")
    ref.add_argument("--scope", default="", help="Files/modules in scope")
    ref.add_argument("--constraints", default="", help="Constraints")

    # review
    rev = sub.add_parser("review", help="Review code")
    rev.add_argument("target", help="Files/directories to review")
    rev.add_argument("--focus", default="correctness,security,performance,style")

    # status
    sub.add_parser("status", help="Show orchestrator status")

    # visualize
    viz = sub.add_parser("visualize", help="Visualize a pipeline without running")
    viz.add_argument("pipeline_type", choices=["feature", "bugfix", "refactor", "review"])
    viz.add_argument("description", help="Task description")

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        return

    orch = Orchestrator(workdir=args.workdir)

    if args.command == "status":
        status = orch.status()
        print(json.dumps(status, indent=2))
        return

    if args.command == "visualize":
        funcs = {
            "feature": lambda d: feature_pipeline(d),
            "bugfix": lambda d: bugfix_pipeline(d),
            "refactor": lambda d: refactor_pipeline(d),
            "review": lambda d: review_pipeline(d),
        }
        pipeline = funcs[args.pipeline_type](args.description)
        print(pipeline.visualize())
        return

    verbose = not getattr(args, "quiet", False)
    dry_run = getattr(args, "dry_run", False)

    if args.command == "feature":
        result = orch.run_pipeline(
            feature_pipeline(args.description, target_files=args.target_files,
                             test_requirements=args.tests),
            dry_run=dry_run, verbose=verbose,
        )
    elif args.command == "bugfix":
        result = orch.run_pipeline(
            bugfix_pipeline(args.description, error_log=args.error_log,
                            affected_files=args.affected_files),
            dry_run=dry_run, verbose=verbose,
        )
    elif args.command == "refactor":
        result = orch.run_pipeline(
            refactor_pipeline(args.description, scope=args.scope,
                              constraints=args.constraints),
            dry_run=dry_run, verbose=verbose,
        )
    elif args.command == "review":
        result = orch.run_pipeline(
            review_pipeline(args.target, focus_areas=args.focus),
            dry_run=dry_run, verbose=verbose,
        )
    else:
        parser.print_help()
        return

    if getattr(args, "output", None):
        with open(args.output, "w") as f:
            json.dump(result, f, indent=2)
        print(f"\nResults saved to: {args.output}")


if __name__ == "__main__":
    main()
