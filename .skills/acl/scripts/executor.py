#!/usr/bin/env python3
"""
CLI Executor — Bridges ACL tasks to actual AI CLI invocations.

Supports: codex (OpenAI Codex CLI), claude (Claude Code CLI), gemini (Gemini CLI)

Each CLI tool is invoked as a subprocess with appropriate arguments,
and output is captured as ACL artifacts.
"""

import subprocess
import os
import sys
import json
import time
import tempfile
from dataclasses import dataclass, field
from typing import Optional
from pathlib import Path
import atexit


@dataclass
class ExecutionResult:
    """Result of a CLI execution."""
    agent_id: str
    success: bool
    output: str
    error: str = ""
    duration_ms: int = 0
    exit_code: int = 0
    artifacts: list = field(default_factory=list)  # list of file paths produced

    def to_dict(self) -> dict:
        return {
            "agent_id": self.agent_id,
            "success": self.success,
            "output": self.output,
            "error": self.error,
            "duration_ms": self.duration_ms,
            "exit_code": self.exit_code,
            "artifacts": self.artifacts,
        }


class CliExecutor:
    """Executes AI CLI tools and captures their output."""

    # Constant for prompt size limit
    PROMPT_ARG_MAX = 4096

    # CLI command templates
    CLI_COMMANDS = {
        "codex": {
            "bin": "codex",
            # codex CLI: codex -q "prompt" or codex --quiet "prompt"
            "prompt_flag": "",  # codex takes prompt as positional arg
            "quiet_flag": "-q",
            "approval_flag": "--full-auto",
            "workdir_flag": None,  # uses cwd
        },
        "claude": {
            "bin": "claude",
            # claude CLI: claude -p "prompt" --output-format json
            "prompt_flag": "-p",
            "quiet_flag": "--output-format json",
            "approval_flag": "--dangerously-skip-permissions",
            "workdir_flag": None,
        },
        "gemini": {
            "bin": "gemini",
            # gemini CLI: gemini -p "prompt"
            "prompt_flag": "-p",
            "quiet_flag": "",
            "approval_flag": "--sandbox",
            "workdir_flag": None,
        },
    }

    def __init__(self, workdir: str = "."):
        self.workdir = os.path.abspath(workdir)
        self._temp_files: list[str] = []  # Track temp files for cleanup
        atexit.register(self._cleanup_temp_files)

    def _needs_temp_file(self, prompt: str) -> bool:
        """Check if prompt should be written to a temp file."""
        return len(prompt) > self.PROMPT_ARG_MAX or "\n" in prompt

    def _write_prompt_file(self, prompt: str) -> str:
        """Write prompt to a temporary file and return its path."""
        with tempfile.NamedTemporaryFile(
            mode="w",
            suffix=".prompt.txt",
            prefix="acl-",
            delete=False,
            encoding="utf-8",
        ) as f:
            f.write(prompt)
            temp_path = f.name
        self._temp_files.append(temp_path)
        return temp_path

    def _cleanup_temp_files(self):
        """Clean up temporary prompt files."""
        for temp_path in self._temp_files:
            try:
                if os.path.exists(temp_path):
                    os.remove(temp_path)
            except Exception:
                pass

    def check_available(self, cli_name: str) -> bool:
        """Check if a CLI tool is available on PATH."""
        try:
            result = subprocess.run(
                ["which", self.CLI_COMMANDS[cli_name]["bin"]],
                capture_output=True, text=True, timeout=5,
            )
            return result.returncode == 0
        except (subprocess.TimeoutExpired, KeyError):
            return False

    def list_available(self) -> list[str]:
        """List all available CLI tools."""
        return [name for name in self.CLI_COMMANDS if self.check_available(name)]

    def execute(
        self,
        cli_name: str,
        prompt: str,
        workdir: Optional[str] = None,
        timeout_seconds: int = 300,
        context_files: Optional[list[str]] = None,
        output_dir: Optional[str] = None,
        auto_approve: bool = True,
    ) -> ExecutionResult:
        """
        Execute a CLI tool with the given prompt.

        Args:
            cli_name: Which CLI to use ("codex", "claude", "gemini")
            prompt: The task prompt to send
            workdir: Working directory (defaults to self.workdir)
            timeout_seconds: Max execution time
            context_files: Files to include as context
            output_dir: Directory to save output artifacts
            auto_approve: Whether to auto-approve actions
        """
        if cli_name not in self.CLI_COMMANDS:
            return ExecutionResult(
                agent_id=cli_name,
                success=False,
                output="",
                error=f"Unknown CLI: {cli_name}. Available: {list(self.CLI_COMMANDS.keys())}",
            )

        if not self.check_available(cli_name):
            return ExecutionResult(
                agent_id=cli_name,
                success=False,
                output="",
                error=f"{cli_name} CLI not found on PATH",
            )

        config = self.CLI_COMMANDS[cli_name]
        cwd = workdir or self.workdir

        # Check if prompt needs temp file
        prompt_file_path: Optional[str] = None
        if self._needs_temp_file(prompt):
            prompt_file_path = self._write_prompt_file(prompt)

        # Build command
        cmd = self._build_command(cli_name, config, prompt, context_files, auto_approve, prompt_file_path)

        start_time = time.time()
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                cwd=cwd,
                timeout=timeout_seconds,
                env={**os.environ, "TERM": "dumb", "NO_COLOR": "1"},
            )
            duration_ms = int((time.time() - start_time) * 1000)

            # Collect any output artifacts
            artifacts = []
            if output_dir and os.path.isdir(output_dir):
                for f in Path(output_dir).rglob("*"):
                    if f.is_file():
                        artifacts.append(str(f))

            return ExecutionResult(
                agent_id=cli_name,
                success=result.returncode == 0,
                output=result.stdout,
                error=result.stderr,
                duration_ms=duration_ms,
                exit_code=result.returncode,
                artifacts=artifacts,
            )

        except subprocess.TimeoutExpired:
            duration_ms = int((time.time() - start_time) * 1000)
            return ExecutionResult(
                agent_id=cli_name,
                success=False,
                output="",
                error=f"Timeout after {timeout_seconds}s",
                duration_ms=duration_ms,
                exit_code=-1,
            )
        except Exception as e:
            duration_ms = int((time.time() - start_time) * 1000)
            return ExecutionResult(
                agent_id=cli_name,
                success=False,
                output="",
                error=str(e),
                duration_ms=duration_ms,
                exit_code=-1,
            )
        finally:
            # Clean up temp file if it was created
            if prompt_file_path and os.path.exists(prompt_file_path):
                try:
                    os.remove(prompt_file_path)
                    self._temp_files.remove(prompt_file_path)
                except Exception:
                    pass

    def execute_parallel(
        self,
        tasks: list[dict],
        timeout_seconds: int = 300,
    ) -> list[ExecutionResult]:
        """
        Execute multiple CLI tasks in parallel.

        Args:
            tasks: List of dicts with keys: cli_name, prompt, workdir (optional)
            timeout_seconds: Max time per task
        """
        import concurrent.futures

        # Pre-allocate results list
        results = [None] * len(tasks)
        future_to_index = {}

        with concurrent.futures.ThreadPoolExecutor(max_workers=len(tasks)) as pool:
            futures = {}
            for idx, task in enumerate(tasks):
                future = pool.submit(
                    self.execute,
                    cli_name=task["cli_name"],
                    prompt=task["prompt"],
                    workdir=task.get("workdir"),
                    timeout_seconds=timeout_seconds,
                    context_files=task.get("context_files"),
                    output_dir=task.get("output_dir"),
                    auto_approve=task.get("auto_approve", True),
                )
                futures[future] = task
                future_to_index[future] = idx

            for future in concurrent.futures.as_completed(futures):
                idx = future_to_index[future]
                try:
                    results[idx] = future.result()
                except Exception as e:
                    # Create a failed ExecutionResult on exception
                    results[idx] = ExecutionResult(
                        agent_id=futures[future].get("cli_name", "unknown"),
                        success=False,
                        output="",
                        error=str(e),
                        duration_ms=0,
                        exit_code=-1,
                    )

        return results

    def _build_command(
        self,
        cli_name: str,
        config: dict,
        prompt: str,
        context_files: Optional[list[str]],
        auto_approve: bool,
        prompt_file_path: Optional[str] = None,
    ) -> list[str]:
        """Build the CLI command with appropriate flags."""
        cmd = [config["bin"]]

        # Use prompt file content if provided, otherwise use raw prompt
        effective_prompt = prompt
        if prompt_file_path:
            with open(prompt_file_path, "r", encoding="utf-8") as f:
                effective_prompt = f.read()

        if cli_name == "codex":
            if auto_approve and config["approval_flag"]:
                cmd.append(config["approval_flag"])
            if config["quiet_flag"]:
                cmd.append(config["quiet_flag"])
            # Add context files
            if context_files:
                for f in context_files:
                    cmd.extend(["--file", f])
            cmd.append(effective_prompt)

        elif cli_name == "claude":
            if config["prompt_flag"]:
                cmd.append(config["prompt_flag"])
            cmd.append(effective_prompt)
            if auto_approve and config["approval_flag"]:
                cmd.append(config["approval_flag"])
            if config["quiet_flag"]:
                cmd.extend(config["quiet_flag"].split())

        elif cli_name == "gemini":
            if auto_approve and config["approval_flag"]:
                cmd.append(config["approval_flag"])
            if config["prompt_flag"]:
                cmd.append(config["prompt_flag"])
            cmd.append(effective_prompt)

        return cmd


# ─── Convenience Functions ───────────────────────────────────────

def run_codex(prompt: str, workdir: str = ".", **kwargs) -> ExecutionResult:
    return CliExecutor(workdir).execute("codex", prompt, **kwargs)

def run_claude(prompt: str, workdir: str = ".", **kwargs) -> ExecutionResult:
    return CliExecutor(workdir).execute("claude", prompt, **kwargs)

def run_gemini(prompt: str, workdir: str = ".", **kwargs) -> ExecutionResult:
    return CliExecutor(workdir).execute("gemini", prompt, **kwargs)


if __name__ == "__main__":
    executor = CliExecutor()
    print("Available CLI tools:", executor.list_available())
