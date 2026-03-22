#!/usr/bin/env python3
"""
Pipeline Framework — DAG-based task orchestration for multi-CLI coding workflows.

Provides pipeline templates for common coding patterns:
- Feature implementation
- Bug fixing
- Refactoring
- Code review
- Custom pipelines

Each pipeline decomposes into a DAG of tasks, routed to the most appropriate
CLI agent based on capability profiles.
"""

import json
import os
import time
from dataclasses import dataclass, field
from typing import Optional, Callable
from pathlib import Path

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


@dataclass
class PipelineTask:
    """A single task in a pipeline DAG."""
    task_id: str
    intent: str
    prompt_template: str
    depends_on: list[str] = field(default_factory=list)
    priority: float = 0.5
    # Override auto-routing: force specific CLI
    force_agent: Optional[str] = None
    # Whether this task can run in parallel with siblings
    parallel: bool = True
    # Max time for this task
    timeout_seconds: int = 300
    # Tags for grouping
    tags: list[str] = field(default_factory=list)


@dataclass
class Pipeline:
    """A pipeline is a named DAG of PipelineTasks."""
    name: str
    description: str
    tasks: list[PipelineTask]
    # Variables that need to be filled in by the user
    required_vars: list[str] = field(default_factory=list)

    def get_execution_order(self) -> list[list[PipelineTask]]:
        """
        Topological sort into execution waves.
        Tasks in the same wave can run in parallel.
        """
        task_map = {t.task_id: t for t in self.tasks}
        completed = set()
        waves = []

        while len(completed) < len(self.tasks):
            wave = []
            for task in self.tasks:
                if task.task_id in completed:
                    continue
                # All dependencies satisfied?
                if all(d in completed for d in task.depends_on):
                    wave.append(task)
            if not wave:
                raise ValueError("Circular dependency detected in pipeline")
            waves.append(wave)
            completed.update(t.task_id for t in wave)

        return waves

    def render_prompts(self, variables: dict) -> dict[str, str]:
        """Fill in prompt templates with provided variables."""
        rendered = {}
        for task in self.tasks:
            prompt = task.prompt_template
            for key, value in variables.items():
                prompt = prompt.replace(f"{{{{{key}}}}}", str(value))
            rendered[task.task_id] = prompt
        return rendered

    def visualize(self) -> str:
        """ASCII visualization of the pipeline DAG."""
        waves = self.get_execution_order()
        lines = [f"Pipeline: {self.name}", f"  {self.description}", ""]

        for i, wave in enumerate(waves):
            if len(wave) == 1:
                t = wave[0]
                agent_hint = f" [{t.force_agent}]" if t.force_agent else ""
                lines.append(f"  Wave {i+1}: [{t.task_id}] ({t.intent}){agent_hint}")
            else:
                lines.append(f"  Wave {i+1} (parallel):")
                for t in wave:
                    agent_hint = f" [{t.force_agent}]" if t.force_agent else ""
                    lines.append(f"    ├── [{t.task_id}] ({t.intent}){agent_hint}")

            if i < len(waves) - 1:
                lines.append("    │")
                lines.append("    ▼")

        return "\n".join(lines)


# ═══════════════════════════════════════════════════════════════════
#  Pipeline Templates
# ═══════════════════════════════════════════════════════════════════

def feature_pipeline(
    feature_desc: str,
    target_files: str = "",
    test_requirements: str = "",
    project_context: str = "",
) -> Pipeline:
    """
    Feature Implementation Pipeline:
      analyze → [implement_A, implement_B, ...] → test → review → finalize
    """
    context_block = f"\n\nProject context: {project_context}" if project_context else ""
    files_block = f"\n\nTarget files: {target_files}" if target_files else ""
    test_block = f"\n\nTest requirements: {test_requirements}" if test_requirements else ""

    return Pipeline(
        name="feature-implementation",
        description=f"Implement: {feature_desc}",
        required_vars=["feature_desc"],
        tasks=[
            PipelineTask(
                task_id="analyze",
                intent="architecture_analysis",
                prompt_template=(
                    f"Analyze the codebase and create a detailed implementation plan for: "
                    f"{feature_desc}{context_block}{files_block}\n\n"
                    f"Output a JSON plan with: affected_files, new_files, dependencies, "
                    f"implementation_steps, potential_risks. Be specific about what code "
                    f"changes are needed in each file."
                ),
                priority=0.95,
                tags=["planning"],
            ),
            PipelineTask(
                task_id="implement-core",
                intent="implement_feature",
                prompt_template=(
                    f"Implement the core logic for: {feature_desc}{files_block}\n\n"
                    f"Focus on the main business logic and data structures. "
                    f"Write clean, well-documented code. Follow existing code conventions."
                ),
                depends_on=["analyze"],
                priority=0.9,
                tags=["implementation"],
            ),
            PipelineTask(
                task_id="implement-supporting",
                intent="code_generation",
                prompt_template=(
                    f"Implement supporting code (helpers, utilities, types) for: "
                    f"{feature_desc}{files_block}\n\n"
                    f"Create any helper functions, type definitions, constants, or utility "
                    f"modules needed. Follow existing patterns in the codebase."
                ),
                depends_on=["analyze"],
                priority=0.85,
                tags=["implementation"],
            ),
            PipelineTask(
                task_id="write-tests",
                intent="test_generation",
                prompt_template=(
                    f"Write comprehensive tests for: {feature_desc}{test_block}\n\n"
                    f"Include: unit tests, edge cases, error handling tests. "
                    f"Use the project's existing test framework and conventions."
                ),
                depends_on=["implement-core", "implement-supporting"],
                priority=0.85,
                tags=["testing"],
            ),
            PipelineTask(
                task_id="review",
                intent="code_review",
                prompt_template=(
                    f"Review all code changes for: {feature_desc}\n\n"
                    f"Check for: correctness, edge cases, error handling, performance, "
                    f"security issues, code style consistency. Provide specific feedback "
                    f"with file/line references."
                ),
                depends_on=["implement-core", "implement-supporting"],
                priority=0.8,
                force_agent="claude",
                tags=["review"],
            ),
            PipelineTask(
                task_id="finalize",
                intent="documentation",
                prompt_template=(
                    f"Finalize the implementation of: {feature_desc}\n\n"
                    f"Update any relevant documentation, README, CHANGELOG. "
                    f"Add inline comments for complex logic. Ensure all public APIs "
                    f"are documented."
                ),
                depends_on=["write-tests", "review"],
                priority=0.7,
                tags=["documentation"],
            ),
        ],
    )


def bugfix_pipeline(
    bug_description: str,
    error_log: str = "",
    affected_files: str = "",
    project_context: str = "",
) -> Pipeline:
    """
    Bug Fix Pipeline:
      diagnose → [fix_candidate_A, fix_candidate_B] → verify → review
    """
    error_block = f"\n\nError log:\n```\n{error_log}\n```" if error_log else ""
    files_block = f"\n\nAffected files: {affected_files}" if affected_files else ""

    return Pipeline(
        name="bugfix",
        description=f"Fix: {bug_description}",
        required_vars=["bug_description"],
        tasks=[
            PipelineTask(
                task_id="diagnose",
                intent="bug_analysis",
                prompt_template=(
                    f"Diagnose this bug: {bug_description}{error_block}{files_block}\n\n"
                    f"Analyze the code to find the root cause. Output: root_cause, "
                    f"affected_components, fix_strategy, risk_assessment."
                ),
                priority=0.95,
                force_agent="claude",
                tags=["diagnosis"],
            ),
            PipelineTask(
                task_id="fix-primary",
                intent="code_edit",
                prompt_template=(
                    f"Fix this bug: {bug_description}{files_block}\n\n"
                    f"Apply the most direct fix. Minimize changes to reduce regression risk. "
                    f"Add defensive checks where appropriate."
                ),
                depends_on=["diagnose"],
                priority=0.9,
                tags=["fix"],
            ),
            PipelineTask(
                task_id="fix-alternative",
                intent="code_edit",
                prompt_template=(
                    f"Provide an alternative fix for: {bug_description}{files_block}\n\n"
                    f"Take a different approach than the most obvious fix. "
                    f"Consider a more robust or general solution."
                ),
                depends_on=["diagnose"],
                priority=0.85,
                tags=["fix"],
            ),
            PipelineTask(
                task_id="write-regression-test",
                intent="test_generation",
                prompt_template=(
                    f"Write regression tests for: {bug_description}\n\n"
                    f"Create tests that would have caught this bug. Include the exact "
                    f"scenario that triggered it plus related edge cases."
                ),
                depends_on=["diagnose"],
                priority=0.85,
                tags=["testing"],
            ),
            PipelineTask(
                task_id="verify",
                intent="code_review",
                prompt_template=(
                    f"Verify the fix for: {bug_description}\n\n"
                    f"Compare fix candidates, check for regressions, verify the root cause "
                    f"is actually addressed. Recommend which fix to adopt and why."
                ),
                depends_on=["fix-primary", "fix-alternative", "write-regression-test"],
                priority=0.9,
                force_agent="claude",
                tags=["verification"],
            ),
        ],
    )


def refactor_pipeline(
    refactor_goal: str,
    scope: str = "",
    constraints: str = "",
    project_context: str = "",
) -> Pipeline:
    """
    Refactoring Pipeline:
      analyze_structure → plan → [refactor modules in parallel] → integration_test → review
    """
    scope_block = f"\n\nScope: {scope}" if scope else ""
    constraints_block = f"\n\nConstraints: {constraints}" if constraints else ""

    return Pipeline(
        name="refactoring",
        description=f"Refactor: {refactor_goal}",
        required_vars=["refactor_goal"],
        tasks=[
            PipelineTask(
                task_id="analyze-structure",
                intent="architecture_analysis",
                prompt_template=(
                    f"Analyze the codebase structure for refactoring: {refactor_goal}"
                    f"{scope_block}{constraints_block}\n\n"
                    f"Map current architecture, identify coupling points, suggest "
                    f"refactoring approach. Output: dependency_graph, modules_to_change, "
                    f"migration_strategy, breaking_changes."
                ),
                priority=0.95,
                force_agent="claude",
                tags=["analysis"],
            ),
            PipelineTask(
                task_id="refactor-plan",
                intent="refactor_plan",
                prompt_template=(
                    f"Create a step-by-step refactoring plan for: {refactor_goal}"
                    f"{scope_block}\n\n"
                    f"Break down into atomic, independently-verifiable steps. "
                    f"Each step should keep the code in a compilable/runnable state."
                ),
                depends_on=["analyze-structure"],
                priority=0.9,
                tags=["planning"],
            ),
            PipelineTask(
                task_id="refactor-module-a",
                intent="refactor",
                prompt_template=(
                    f"Execute refactoring step 1 for: {refactor_goal}\n\n"
                    f"Apply the first set of changes from the refactoring plan. "
                    f"Ensure backward compatibility where possible."
                ),
                depends_on=["refactor-plan"],
                priority=0.85,
                tags=["refactoring"],
            ),
            PipelineTask(
                task_id="refactor-module-b",
                intent="refactor",
                prompt_template=(
                    f"Execute refactoring step 2 for: {refactor_goal}\n\n"
                    f"Apply the second set of changes from the refactoring plan. "
                    f"Ensure backward compatibility where possible."
                ),
                depends_on=["refactor-plan"],
                priority=0.85,
                tags=["refactoring"],
            ),
            PipelineTask(
                task_id="integration-test",
                intent="test_generation",
                prompt_template=(
                    f"Create integration tests verifying the refactoring: {refactor_goal}\n\n"
                    f"Test that all public APIs still work correctly, performance hasn't "
                    f"degraded, and the refactoring goals are met."
                ),
                depends_on=["refactor-module-a", "refactor-module-b"],
                priority=0.85,
                tags=["testing"],
            ),
            PipelineTask(
                task_id="review",
                intent="code_review",
                prompt_template=(
                    f"Review the complete refactoring: {refactor_goal}\n\n"
                    f"Verify: no regressions, improved code quality, consistent style, "
                    f"proper test coverage. Flag any remaining tech debt."
                ),
                depends_on=["integration-test"],
                priority=0.8,
                force_agent="claude",
                tags=["review"],
            ),
        ],
    )


def review_pipeline(
    review_target: str,
    focus_areas: str = "correctness,security,performance,style",
) -> Pipeline:
    """
    Code Review Pipeline (competitive parallel):
      [review_by_claude, review_by_gemini] → synthesize
    """
    return Pipeline(
        name="code-review",
        description=f"Review: {review_target}",
        required_vars=["review_target"],
        tasks=[
            PipelineTask(
                task_id="review-claude",
                intent="code_review",
                prompt_template=(
                    f"Perform a thorough code review of: {review_target}\n\n"
                    f"Focus areas: {focus_areas}\n"
                    f"For each issue found, provide: severity, location, description, "
                    f"suggested fix. Also note any positive patterns worth keeping."
                ),
                priority=0.9,
                force_agent="claude",
                tags=["review"],
            ),
            PipelineTask(
                task_id="review-gemini",
                intent="code_review",
                prompt_template=(
                    f"Perform a thorough code review of: {review_target}\n\n"
                    f"Focus areas: {focus_areas}\n"
                    f"For each issue found, provide: severity, location, description, "
                    f"suggested fix. Also note any positive patterns worth keeping."
                ),
                priority=0.9,
                force_agent="gemini",
                tags=["review"],
            ),
            PipelineTask(
                task_id="synthesize",
                intent="architecture_analysis",
                prompt_template=(
                    f"Synthesize code review findings for: {review_target}\n\n"
                    f"Combine the review results from multiple reviewers. "
                    f"Deduplicate findings, prioritize by severity, and produce a "
                    f"unified review report with actionable recommendations."
                ),
                depends_on=["review-claude", "review-gemini"],
                priority=0.85,
                force_agent="claude",
                tags=["synthesis"],
            ),
        ],
    )


def custom_pipeline(
    name: str,
    description: str,
    tasks: list[dict],
) -> Pipeline:
    """
    Create a custom pipeline from a task specification.

    tasks format:
    [
        {
            "task_id": "my-task",
            "intent": "code_generation",
            "prompt": "Do something...",
            "depends_on": [],          # optional
            "force_agent": "codex",    # optional
            "priority": 0.9,           # optional
        }
    ]
    """
    pipeline_tasks = []
    for t in tasks:
        pipeline_tasks.append(PipelineTask(
            task_id=t["task_id"],
            intent=t["intent"],
            prompt_template=t["prompt"],
            depends_on=t.get("depends_on", []),
            priority=t.get("priority", 0.5),
            force_agent=t.get("force_agent"),
            timeout_seconds=t.get("timeout_seconds", 300),
            tags=t.get("tags", []),
        ))

    return Pipeline(
        name=name,
        description=description,
        tasks=pipeline_tasks,
    )


# ─── Pipeline Registry ──────────────────────────────────────────

PIPELINE_TEMPLATES = {
    "feature": feature_pipeline,
    "bugfix": bugfix_pipeline,
    "refactor": refactor_pipeline,
    "review": review_pipeline,
    "custom": custom_pipeline,
}


if __name__ == "__main__":
    # Demo: visualize a feature pipeline
    p = feature_pipeline("Add WebSocket support for real-time event streaming")
    print(p.visualize())
    print()
    waves = p.get_execution_order()
    print(f"Total waves: {len(waves)}")
    for i, wave in enumerate(waves):
        print(f"  Wave {i+1}: {[t.task_id for t in wave]}")
