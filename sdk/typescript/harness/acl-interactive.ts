#!/usr/bin/env ts-node
/**
 * ACL Interactive Multi-Agent Harness (State-Transition Based)
 *
 * Uses the ACL SDK's state machine for orchestration:
 *   ActionPacket → TaskGraph → PENDING → CLAIMED → RUNNING → DONE
 *
 * Architecture:
 *   - Opus 4.6 (orchestrator): Plans and decomposes tasks into ActionPackets
 *   - Worker agents: Execute subtasks via AclRuntime state transitions
 *   - ArtifactStore: Typed output exchange between tasks
 *   - EventBus: Real-time status display driven by state transition events
 *
 * Usage:
 *   npx ts-node harness/acl-interactive.ts
 *   npx ts-node harness/acl-interactive.ts --project ./my-app
 */

import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, execSync, spawnSync, ChildProcess } from 'child_process';

// ACL SDK imports — state machine, runtime, types
import {
  AclRuntime,
  ModelAdapter,
  AgentCapability,
  ActionPacket,
  TaskNode,
  TaskState,
  TaskExecutionOutput,
  EventType,
  AclEvent,
} from '../src';
import {
  ClaudeCliAdapter,
  CodexCliAdapter,
  GeminiCliAdapter,
  cliExists,
  ProgressCallback,
  ProgressInfo,
} from './cli-adapter';

// ─── Platform ─────────────────────────────────────────────────
const IS_WIN = process.platform === 'win32';

// ─── Colors & Symbols ────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgBlue: '\x1b[44m',
  bgGreen: '\x1b[42m',
  bgMagenta: '\x1b[45m',
  bgYellow: '\x1b[43m',
  clearLine: '\x1b[2K',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
};

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ─── Worker Agent Definition ─────────────────────────────────
interface WorkerDef {
  id: string;
  name: string;
  tier: 'flagship' | 'fast';
  adapter: ModelAdapter;
  canDo: string[];
  produces: string[];
}

// ─── Orchestrator Plan (Opus output → ActionPackets) ─────────
interface SubTaskPlan {
  id: string;
  intent: string;
  description: string;
  assignTo: string;        // worker id or 'auto'
  outputSchema: string;
  fileScope?: string[];
  dependsOn?: string[];
}

interface OrchestratorPlan {
  analysis: string;
  subtasks: SubTaskPlan[];
  integrationNotes?: string;
}

// ─── Persisted Context ────────────────────────────────────────
interface PersistedContext {
  version: 1;
  projectDir: string;
  history: {
    prompt: string;
    taskCount: number;
    success: boolean;
    durationMs: number;
    timestamp: string;
  }[];
  lastSession: string;
  sessionNotes: string[];
}

const CONTEXT_FILENAME = '.acl-context.json';

function loadContext(projectDir: string): PersistedContext | null {
  try {
    const fp = path.join(projectDir, CONTEXT_FILENAME);
    if (fs.existsSync(fp)) {
      return JSON.parse(fs.readFileSync(fp, 'utf-8')) as PersistedContext;
    }
  } catch {}
  return null;
}

function saveContext(ctx: PersistedContext): void {
  try {
    const fp = path.join(ctx.projectDir, CONTEXT_FILENAME);
    fs.writeFileSync(fp, JSON.stringify(ctx, null, 2), 'utf-8');
  } catch {}
}

// ─── Current child process (for Ctrl+C cancellation) ─────────
let activeChild: ChildProcess | null = null;

// ─── Status Display (Event-Driven) ──────────────────────────
class StatusDisplay {
  private statuses: Map<string, {
    label: string;
    state: TaskState;
    startTime: number;
    chars: number;
    lines: number;
    activity: string;
    currentFile?: string;
    phase: string;
  }> = new Map();
  private timer: NodeJS.Timeout | null = null;
  private frameIdx = 0;
  private lineCount = 0;
  private rendered = false;

  addTask(taskId: string, label: string): void {
    this.statuses.set(taskId, {
      label,
      state: TaskState.PENDING,
      startTime: Date.now(),
      chars: 0,
      lines: 0,
      activity: 'Queued',
      phase: 'pending',
    });
  }

  /** Update from ACL state transition event */
  onStateTransition(taskId: string, newState: TaskState, detail?: string): void {
    const s = this.statuses.get(taskId);
    if (!s) return;
    s.state = newState;
    if (newState === TaskState.RUNNING) s.startTime = Date.now();
    if (detail) s.activity = detail;

    if (newState === TaskState.RUNNING && !this.timer) {
      process.stdout.write(C.hideCursor);
      this.render();
      this.timer = setInterval(() => this.render(), 200);
    }
  }

  /** Update from adapter streaming progress */
  onProgress(taskId: string, info: ProgressInfo): void {
    const s = this.statuses.get(taskId);
    if (!s) return;
    s.chars = info.chars;
    s.lines = info.lines;
    s.activity = info.activity;
    s.phase = info.phase;
    if (info.currentFile) s.currentFile = info.currentFile;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.rendered) {
      this.moveCursorToStart();
      for (let i = 0; i < this.lineCount; i++) {
        process.stdout.write(`${C.clearLine}\n`);
      }
      this.moveCursorToStart();
    }
    process.stdout.write(C.showCursor);
    this.statuses.clear();
    this.lineCount = 0;
    this.rendered = false;
  }

  private moveCursorToStart(): void {
    if (this.lineCount > 0) {
      process.stdout.write(`\x1b[${this.lineCount}A`);
    }
  }

  private render(): void {
    this.frameIdx = (this.frameIdx + 1) % SPINNER_FRAMES.length;
    const lines: string[] = [];

    for (const [, s] of this.statuses) {
      const elapsed = ((Date.now() - s.startTime) / 1000).toFixed(1);
      let icon: string, stateLabel: string;

      switch (s.state) {
        case TaskState.PENDING:
          icon = `${C.dim}○${C.reset}`;
          stateLabel = `${C.dim}PENDING${C.reset}`;
          break;
        case TaskState.CLAIMED:
          icon = `${C.yellow}◉${C.reset}`;
          stateLabel = `${C.yellow}CLAIMED${C.reset}`;
          break;
        case TaskState.RUNNING:
          icon = `${C.cyan}${SPINNER_FRAMES[this.frameIdx]}${C.reset}`;
          stateLabel = `${C.cyan}${elapsed}s${C.reset}`;
          break;
        case TaskState.DONE:
          icon = `${C.green}✔${C.reset}`;
          stateLabel = `${C.green}DONE ${elapsed}s${C.reset}`;
          break;
        case TaskState.FAILED:
          icon = `${C.red}✘${C.reset}`;
          stateLabel = `${C.red}FAILED${C.reset}`;
          break;
        default:
          icon = `${C.dim}?${C.reset}`;
          stateLabel = `${C.dim}${TaskState[s.state]}${C.reset}`;
      }

      // Build rich detail line for RUNNING state
      let detail = '';
      if (s.state === TaskState.RUNNING) {
        const parts: string[] = [];
        if (s.chars > 0) parts.push(`${s.chars} chars`);
        if (s.lines > 0) parts.push(`${s.lines} lines`);
        if (s.currentFile) parts.push(`📄 ${s.currentFile}`);
        const stats = parts.length > 0 ? parts.join(' · ') : '';
        const act = s.activity.slice(0, 45);
        detail = ` ${C.dim}│ ${stats}${stats && act ? ' │ ' : ''}${act}${C.reset}`;
      }

      lines.push(`  ${icon} ${C.bold}${s.label}${C.reset} ${stateLabel}${detail}`);
    }

    if (this.rendered) this.moveCursorToStart();
    for (const line of lines) {
      process.stdout.write(`\r${C.clearLine}${line}\n`);
    }
    this.lineCount = lines.length;
    this.rendered = true;
  }
}

// ─── Worker Discovery & Registration ─────────────────────────
function discoverWorkers(): WorkerDef[] {
  const workers: WorkerDef[] = [];

  if (cliExists('claude')) {
    workers.push({
      id: 'claude-sonnet',
      name: 'Claude Sonnet 4.6',
      tier: 'flagship',
      adapter: new ClaudeCliAdapter({ model: 'claude-sonnet-4-6', maxTurns: 10 }),
      canDo: ['code', 'analysis', 'review', 'write', 'refactor', 'test'],
      produces: ['code', 'text', 'analysis'],
    });
    workers.push({
      id: 'claude-haiku',
      name: 'Claude Haiku 4.5',
      tier: 'fast',
      adapter: new ClaudeCliAdapter({ model: 'claude-haiku-4-5-20251001', maxTurns: 5 }),
      canDo: ['code', 'write', 'test'],
      produces: ['code', 'text'],
    });
  }

  if (cliExists('codex')) {
    workers.push({
      id: 'codex',
      name: 'Codex (GPT 5.4)',
      tier: 'flagship',
      adapter: new CodexCliAdapter({ model: 'gpt-5.4' }),
      canDo: ['code', 'refactor', 'test', 'debug'],
      produces: ['code', 'text'],
    });
  }

  const geminiCli = cliExists('gemini') ? 'gemini' : cliExists('gemini-cli') ? 'gemini-cli' : null;
  if (geminiCli) {
    workers.push({
      id: 'gemini',
      name: 'Gemini 3.1 Pro',
      tier: 'flagship',
      adapter: new GeminiCliAdapter({ model: 'gemini-3.1-pro', cliPath: geminiCli }),
      canDo: ['code', 'analysis', 'write', 'research'],
      produces: ['code', 'text', 'analysis'],
    });
  }

  return workers;
}

// ─── Orchestrator (Opus 4.6 via CLI) ─────────────────────────

const PLANNER_SYSTEM_PROMPT = `You are the orchestrator of a multi-agent development system. Your job is to AGGRESSIVELY decompose a user's request into as many PARALLEL subtasks as possible. Each worker agent is a separate process — the more you split, the faster it completes.

Available worker agents:
{AGENTS}

DECOMPOSITION STRATEGY — be aggressive:
1. MAXIMIZE parallelism: if 5 files need changes, that's 5 separate subtasks, not 1
2. Split by file/module/concern: each subtask should touch DIFFERENT files
3. Split by layer: frontend, backend, database, tests, config, docs — all separate subtasks
4. Split by operation type: create new files vs modify existing vs write tests vs update config
5. Even within a single feature: model, controller, service, route, test, migration = 6 subtasks
6. Assign to DIFFERENT agents for true parallelism (each agent is a separate OS process)
7. Only use dependsOn when absolutely necessary (e.g. migration must exist before seeder)
8. For simple tasks (single file fix), 1 subtask is fine — but always look for hidden parallelism

RULES:
- Each subtask must be 100% self-contained with complete instructions
- Workers CANNOT see each other's output — include all needed context
- Include exact file paths and specific code expectations
- Each subtask needs: intent (semantic label), outputSchema (result type)
- Assign across different agents: if 3 workers available and 6 tasks, distribute 2 each

RESPOND WITH ONLY valid JSON (no markdown, no code fences):
{
  "analysis": "Brief analysis + parallelism strategy",
  "subtasks": [
    {
      "id": "task-1",
      "intent": "implement-user-model",
      "description": "Detailed, self-contained instructions...",
      "assignTo": "claude-sonnet|codex|gemini|auto",
      "outputSchema": "code|text|analysis",
      "fileScope": ["src/models/user.ts"],
      "dependsOn": []
    }
  ],
  "integrationNotes": "How subtask outputs integrate together"
}`;

async function runOrchestratorAsync(prompt: string, cwd: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const args = ['-p', '--output-format', 'json', '--model', 'claude-opus-4-6', '--max-turns', '3'];
    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      ...(IS_WIN ? { shell: true as const } : {}),
    });

    let stdout = '';
    let stderr = '';
    let chars = 0;
    const startMs = Date.now();

    // Real-time planning progress display
    const spinFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let spinIdx = 0;
    const progressTimer = setInterval(() => {
      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
      const frame = spinFrames[spinIdx++ % spinFrames.length];
      process.stdout.write(`\r  ${frame} ${C.dim}Opus 4.6 planning... ${elapsed}s │ ${chars} chars received${C.reset}${C.clearLine}`);
    }, 200);

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      chars += text.length;
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // 5 minute timeout for large planning tasks
    const timeout = setTimeout(() => {
      clearInterval(progressTimer);
      proc.kill();
      reject(new Error(`Orchestrator timed out after 300s (received ${chars} chars)`));
    }, 300_000);

    proc.on('close', (code) => {
      clearInterval(progressTimer);
      clearTimeout(timeout);
      process.stdout.write(`\r${C.clearLine}`); // Clear spinner line

      if (code !== 0 && !stdout) {
        reject(new Error(`Orchestrator exit code ${code}: ${stderr.slice(0, 500)}`));
        return;
      }

      try {
        const cliOutput = JSON.parse(stdout);
        resolve(cliOutput.result || stdout);
      } catch {
        resolve(stdout);
      }
    });

    proc.on('error', (err) => {
      clearInterval(progressTimer);
      clearTimeout(timeout);
      reject(err);
    });

    // Pipe prompt via stdin (avoids OS arg length limits)
    proc.stdin?.write(prompt);
    proc.stdin?.end();
  });
}

function parseOrchestratorPlan(raw: string): OrchestratorPlan | null {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*"subtasks"[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.subtasks || !Array.isArray(parsed.subtasks) || parsed.subtasks.length === 0) {
      return null;
    }
    return {
      analysis: parsed.analysis || '',
      subtasks: parsed.subtasks.map((st: any, i: number) => ({
        id: st.id || `task-${i + 1}`,
        intent: st.intent || st.id || `subtask-${i + 1}`,
        description: st.description || '',
        assignTo: st.assignTo || 'auto',
        outputSchema: st.outputSchema || 'text',
        fileScope: st.fileScope || [],
        dependsOn: st.dependsOn || [],
      })),
      integrationNotes: parsed.integrationNotes || '',
    };
  } catch {
    return null;
  }
}

// ─── Project Directory Utilities ──────────────────────────────

function testWriteAccess(dir: string): boolean {
  const testFile = path.join(dir, `.acl-write-test-${Date.now()}`);
  try {
    fs.writeFileSync(testFile, '', { flag: 'w' });
    fs.unlinkSync(testFile);
    return true;
  } catch { return false; }
}

function tryGrantWriteAccess(dir: string): boolean {
  try {
    if (IS_WIN) {
      const user = process.env.USERNAME || process.env.USER || '';
      if (user) {
        execSync(`icacls "${dir}" /grant "${user}:(OI)(CI)F" /T /Q`, {
          encoding: 'utf-8', timeout: 10_000, stdio: 'pipe',
        });
      }
    } else {
      fs.chmodSync(dir, 0o755);
    }
    return testWriteAccess(dir);
  } catch { return false; }
}

function ensureProjectDir(dir: string): { valid: boolean; created?: boolean; error?: string } {
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) {
    try {
      fs.mkdirSync(resolved, { recursive: true });
      return { valid: true, created: true };
    } catch (err) {
      return { valid: false, error: `Failed to create directory: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) return { valid: false, error: `Not a directory: ${resolved}` };
  if (!testWriteAccess(resolved)) {
    if (!tryGrantWriteAccess(resolved)) {
      return { valid: false, error: `No write permission: ${resolved}` };
    }
  }
  return { valid: true };
}

function fileTree(dir: string, maxDepth: number = 2): string {
  const lines: string[] = [];
  const SKIP = new Set(['.git', 'node_modules', 'target', 'dist', '__pycache__', '.next', 'build', '.venv']);
  function walk(d: string, prefix: string, depth: number) {
    if (depth > maxDepth) return;
    try {
      const entries = fs.readdirSync(d, { withFileTypes: true })
        .filter(e => !e.name.startsWith('.') && !SKIP.has(e.name))
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      entries.forEach((entry, i) => {
        const isLast = i === entries.length - 1;
        const connector = isLast ? '└── ' : '├── ';
        const extension = isLast ? '    ' : '│   ';
        if (entry.isDirectory()) {
          lines.push(`${prefix}${connector}${entry.name}/`);
          walk(path.join(d, entry.name), prefix + extension, depth + 1);
        } else {
          lines.push(`${prefix}${connector}${entry.name}`);
        }
      });
    } catch {}
  }
  walk(dir, '    ', 0);
  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════
//  Interactive Harness (State-Transition Based)
// ═══════════════════════════════════════════════════════════════

export class InteractiveHarness {
  private runtime!: AclRuntime;
  private workers: WorkerDef[] = [];
  private projectDir: string | null = null;
  private context: PersistedContext | null = null;
  private rl!: readline.Interface;
  private autoAssignIdx = 0;

  async start(): Promise<void> {
    this.printBanner();

    // Discover workers
    this.workers = discoverWorkers();

    // Check orchestrator
    if (!cliExists('claude')) {
      console.log(`  ${C.red}✘ Claude CLI not found — Opus 4.6 orchestrator required!${C.reset}`);
      console.log(`  ${C.dim}Install and authenticate: claude login${C.reset}`);
      process.exit(1);
    }
    if (this.workers.length === 0) {
      console.log(`  ${C.red}✘ No worker agents found on PATH!${C.reset}`);
      process.exit(1);
    }

    this.printAgents();

    // Initialize ACL Runtime
    this.runtime = new AclRuntime({ verbose: false });

    // Register all workers as agents in the runtime
    for (const w of this.workers) {
      const cap: AgentCapability = {
        agentId: w.id,
        modelBackend: `${w.adapter.provider}/${w.adapter.model}`,
        canDo: w.canDo,
        requires: [],
        produces: w.produces,
        cost: w.adapter.costProfile
          ? { inputCostPer1k: w.adapter.costProfile.inputCostPer1k, outputCostPer1k: w.adapter.costProfile.outputCostPer1k, toolCallCost: 0 }
          : { inputCostPer1k: 0.003, outputCostPer1k: 0.015, toolCallCost: 0 },
        avgLatencyMs: 500,
        trustScore: 0.9,
      };
      this.runtime.registerAgent(cap, w.adapter);
    }

    console.log(`  ${C.green}✔ AclRuntime initialized${C.reset} ${C.dim}(${this.workers.length} agents, state machine active)${C.reset}\n`);

    // Wire up event listener for state transition logging
    this.runtime.onEvent((event: AclEvent) => {
      const stateEvents = [EventType.TASK_CREATED, EventType.TASK_CLAIMED, EventType.TASK_RUNNING, EventType.TASK_DONE, EventType.TASK_FAILED];
      if (stateEvents.includes(event.eventType)) {
        const taskId = (event.payload as any)?.taskId || '';
        console.log(`  ${C.dim}[${EventType[event.eventType]}] ${taskId} from ${event.source}${C.reset}`);
      }
    });

    // Parse CLI args
    const projectArg = this.getArg('--project') || this.getArg('-d');
    if (projectArg) this.setProject(projectArg);

    // Setup readline
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    this.rl.on('SIGINT', () => {
      if (activeChild) {
        activeChild.kill();
        activeChild = null;
        process.stdout.write(C.showCursor);
        console.log(`\n  ${C.yellow}⚠ Task cancelled${C.reset}`);
      } else {
        this.saveCurrentContext();
        console.log(`\n  ${C.cyan}Goodbye! Context saved.${C.reset}\n`);
        process.exit(0);
      }
    });

    if (!this.projectDir) await this.askProjectDir();
    this.loadPersistedContext();
    this.printHelp(true);
    await this.repl();
  }

  // ── UI ──────────────────────────────────────────────────────

  private printBanner(): void {
    console.log(`
${C.cyan}╔══════════════════════════════════════════════════════════════╗
║${C.bold}${C.white}  ACL Interactive Harness (State-Transition Engine)           ${C.reset}${C.cyan}║
║${C.dim}  ActionPacket → TaskGraph → PENDING → CLAIMED → RUNNING → DONE${C.reset}${C.cyan}║
╚══════════════════════════════════════════════════════════════╝${C.reset}
`);
  }

  private printAgents(): void {
    console.log(`  ${C.bold}Orchestrator:${C.reset}`);
    console.log(`    ${C.green}✔${C.reset} Claude Opus 4.6 ${C.bgMagenta}${C.white} planner ${C.reset} ${C.dim}(decomposes → ActionPackets)${C.reset}`);
    console.log(`  ${C.bold}Workers (registered in AclRuntime):${C.reset}`);
    for (const w of this.workers) {
      const tierBadge = w.tier === 'flagship'
        ? `${C.bgGreen}${C.white} flagship ${C.reset}`
        : `${C.bgBlue}${C.white} fast ${C.reset}`;
      console.log(`    ${C.green}✔${C.reset} ${w.name} ${tierBadge} ${C.dim}[${w.canDo.join(', ')}]${C.reset}`);
    }
    console.log();
  }

  private printHelp(compact: boolean): void {
    if (compact) {
      console.log(`  ${C.dim}Type any task. Opus plans → workers execute via state transitions. /help for commands.${C.reset}\n`);
      return;
    }
    console.log(`
  ${C.bold}Architecture:${C.reset}
    ${C.magenta}Opus 4.6${C.reset} decomposes your request into ${C.cyan}ActionPackets${C.reset}
    → submitted to ${C.cyan}TaskGraph${C.reset} (DAG with dependencies)
    → workers claim & execute via ${C.cyan}state transitions${C.reset}
    → results published as ${C.cyan}Artifacts${C.reset} in ArtifactStore

  ${C.bold}Commands:${C.reset}
    ${C.cyan}/project <path>${C.reset}  Set or show project directory
    ${C.cyan}/agents${C.reset}           List orchestrator + workers
    ${C.cyan}/direct <task>${C.reset}    Skip orchestrator, run single worker directly
    ${C.cyan}/stats${C.reset}            Show AclRuntime statistics
    ${C.cyan}/note <text>${C.reset}      Save a session note
    ${C.cyan}/notes${C.reset}            Show saved session notes
    ${C.cyan}/history${C.reset}          Show task history
    ${C.cyan}/save${C.reset}             Force-save context
    ${C.cyan}/help${C.reset}             Show this help
    ${C.cyan}/exit${C.reset}             Exit (context auto-saved)
`);
  }

  // ── Context Persistence ─────────────────────────────────────

  private loadPersistedContext(): void {
    if (!this.projectDir) return;
    const ctx = loadContext(this.projectDir);
    if (ctx) {
      this.context = ctx;
      const histCount = ctx.history.length;
      if (histCount > 0) {
        console.log(`  ${C.green}✔ Context restored${C.reset} ${C.dim}(${histCount} past tasks)${C.reset}`);
        for (const h of ctx.history.slice(-3)) {
          const icon = h.success ? `${C.green}✔${C.reset}` : `${C.red}✘${C.reset}`;
          const preview = h.prompt.length > 55 ? h.prompt.slice(0, 55) + '...' : h.prompt;
          console.log(`    ${icon} ${preview} ${C.dim}(${h.taskCount} subtasks, ${(h.durationMs / 1000).toFixed(1)}s)${C.reset}`);
        }
      }
      console.log();
    } else {
      console.log(`  ${C.dim}New project — no previous context found.${C.reset}\n`);
    }
  }

  private saveCurrentContext(): void {
    if (!this.projectDir) return;
    const ctx: PersistedContext = {
      version: 1,
      projectDir: this.projectDir,
      history: (this.context?.history || []).slice(-50),
      lastSession: new Date().toISOString(),
      sessionNotes: this.context?.sessionNotes || [],
    };
    saveContext(ctx);
  }

  private addHistoryEntry(prompt: string, taskCount: number, success: boolean, durationMs: number): void {
    if (!this.context) {
      this.context = {
        version: 1,
        projectDir: this.projectDir || '',
        history: [],
        lastSession: new Date().toISOString(),
        sessionNotes: [],
      };
    }
    this.context.history.push({
      prompt: prompt.slice(0, 200),
      taskCount,
      success,
      durationMs,
      timestamp: new Date().toISOString(),
    });
  }

  // ── Project Directory ───────────────────────────────────────

  private async askProjectDir(): Promise<void> {
    console.log(`  ${C.yellow}📂 Project directory not set.${C.reset}`);
    console.log(`  ${C.dim}Agents need a project folder to work in.${C.reset}\n`);

    return new Promise((resolve) => {
      const ask = () => {
        this.rl.question(`  ${C.cyan}Project path: ${C.reset}`, (answer) => {
          const trimmed = answer.trim().replace(/^["']|["']$/g, '');
          if (!trimmed) { ask(); return; }
          if (this.setProject(trimmed)) resolve();
          else ask();
        });
      };
      ask();
    });
  }

  private setProject(dir: string): boolean {
    const resolved = path.resolve(dir);
    const result = ensureProjectDir(resolved);
    if (!result.valid) {
      console.log(`  ${C.red}✘ ${result.error}${C.reset}`);
      return false;
    }
    if (result.created) console.log(`  ${C.yellow}📁 Created: ${resolved}${C.reset}`);
    this.projectDir = resolved;
    console.log(`  ${C.green}✔ Project: ${resolved}${C.reset}`);
    const tree = fileTree(resolved);
    if (tree) console.log(`\n${C.dim}  Project structure:${C.reset}\n${tree}`);
    console.log();
    return true;
  }

  // ── REPL (multi-line paste support) ────────────────────────

  private static readonly PASTE_THRESHOLD_MS = 50;

  private async repl(): Promise<void> {
    this.rl.close();
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    this.rl.on('SIGINT', () => {
      if (activeChild) {
        activeChild.kill(); activeChild = null;
        process.stdout.write(C.showCursor);
        console.log(`\n  ${C.yellow}⚠ Task cancelled${C.reset}`);
      } else {
        this.saveCurrentContext();
        console.log(`\n  ${C.cyan}Goodbye! Context saved.${C.reset}\n`);
        process.exit(0);
      }
    });

    const promptUser = () => {
      const workerCount = this.workers.filter(w => w.tier === 'flagship').length;
      const dirLabel = this.projectDir ? `${C.dim}${path.basename(this.projectDir)}${C.reset}` : `${C.red}no project${C.reset}`;
      const agentLabel = `${C.magenta}opus${C.reset}${C.dim}→${workerCount}w${C.reset}`;
      const stats = this.runtime.stats();
      const statsLabel = stats.totalTasks > 0
        ? ` ${C.dim}tasks:${stats.completedTasks}/${stats.totalTasks}${C.reset}` : '';

      process.stdout.write(`\n  ${C.bold}You${C.reset} ${C.dim}[${dirLabel}|${agentLabel}${statsLabel}]${C.reset} ${C.cyan}›${C.reset} `);

      let lineBuffer: string[] = [];
      let pasteTimer: NodeJS.Timeout | null = null;
      let processing = false;

      const flushAndProcess = async () => {
        if (processing) return;
        processing = true;
        this.rl.removeListener('line', onLine);

        const fullInput = lineBuffer.join('\n').trim();
        lineBuffer = [];

        if (!fullInput) { processing = false; promptUser(); return; }

        const lineCount = fullInput.split('\n').length;
        if (lineCount > 1) console.log(`  ${C.dim}(${lineCount} lines received)${C.reset}`);

        try {
          if (fullInput.startsWith('/')) await this.handleCommand(fullInput);
          else await this.handleTask(fullInput);
        } catch (err) {
          console.log(`  ${C.red}✘ Error: ${err instanceof Error ? err.message : String(err)}${C.reset}`);
        }

        this.saveCurrentContext();
        processing = false;
        promptUser();
      };

      const onLine = (line: string) => {
        lineBuffer.push(line);
        if (pasteTimer) clearTimeout(pasteTimer);
        pasteTimer = setTimeout(() => { pasteTimer = null; flushAndProcess(); }, InteractiveHarness.PASTE_THRESHOLD_MS);
      };

      this.rl.on('line', onLine);
    };

    promptUser();
  }

  // ── Command Handling ────────────────────────────────────────

  private async handleCommand(input: string): Promise<void> {
    const spaceIdx = input.indexOf(' ');
    const cmd = (spaceIdx > 0 ? input.slice(0, spaceIdx) : input).toLowerCase();
    const arg = spaceIdx > 0 ? input.slice(spaceIdx + 1).trim() : '';

    switch (cmd) {
      case '/project':
      case '/dir':
        if (arg) { if (this.setProject(arg)) this.loadPersistedContext(); }
        else if (this.projectDir) { console.log(`  📂 ${this.projectDir}`); console.log(fileTree(this.projectDir)); }
        else console.log(`  ${C.yellow}No project set. Use: /project <path>${C.reset}`);
        break;

      case '/agents':
        this.printAgents();
        break;

      case '/direct':
        if (arg) await this.handleDirectTask(arg);
        else console.log(`  ${C.dim}Usage: /direct <task> — skips orchestrator${C.reset}`);
        break;

      case '/stats':
        this.printStats();
        break;

      case '/note':
        if (arg) {
          if (!this.context) {
            this.context = { version: 1, projectDir: this.projectDir || '', history: [], lastSession: new Date().toISOString(), sessionNotes: [] };
          }
          this.context.sessionNotes.push(`[${new Date().toISOString()}] ${arg}`);
          this.saveCurrentContext();
          console.log(`  ${C.green}✔ Note saved${C.reset}`);
        } else console.log(`  ${C.dim}Usage: /note <text>${C.reset}`);
        break;

      case '/notes':
        const notes = this.context?.sessionNotes || [];
        if (notes.length === 0) { console.log(`  ${C.dim}No notes.${C.reset}`); break; }
        console.log(`\n  ${C.bold}Session Notes:${C.reset}`);
        for (const n of notes.slice(-20)) console.log(`    ${C.dim}${n}${C.reset}`);
        console.log();
        break;

      case '/history':
        const hist = this.context?.history || [];
        if (hist.length === 0) { console.log(`  ${C.dim}No history.${C.reset}`); break; }
        console.log(`\n  ${C.bold}Task History:${C.reset}`);
        for (const h of hist.slice(-15)) {
          const icon = h.success ? `${C.green}✔${C.reset}` : `${C.red}✘${C.reset}`;
          console.log(`    ${icon} ${h.prompt.slice(0, 60)} ${C.dim}(${h.taskCount} tasks, ${(h.durationMs / 1000).toFixed(1)}s)${C.reset}`);
        }
        console.log();
        break;

      case '/save':
        this.saveCurrentContext();
        console.log(`  ${C.green}✔ Context saved${C.reset}`);
        break;

      case '/help':
        this.printHelp(false);
        break;

      case '/exit':
      case '/quit':
        this.saveCurrentContext();
        console.log(`\n  ${C.green}✔ Context saved.${C.reset} ${C.cyan}Goodbye!${C.reset}\n`);
        process.exit(0);

      default:
        console.log(`  ${C.dim}Unknown command: ${cmd}. /help for commands.${C.reset}`);
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  Core: Orchestrated Task Execution via State Transitions
  // ═══════════════════════════════════════════════════════════

  private async handleTask(userPrompt: string): Promise<void> {
    if (!this.projectDir) {
      console.log(`  ${C.yellow}⚠ Set a project directory first: /project <path>${C.reset}`);
      return;
    }

    const startTime = Date.now();

    // ── Phase 1: Opus 4.6 plans → decomposes into subtask specs ──
    console.log(`\n  ${C.bgMagenta}${C.white} Phase 1: Planning ${C.reset} ${C.dim}Opus 4.6 → ActionPacket decomposition${C.reset}\n`);

    const workerList = this.workers
      .filter(w => w.tier === 'flagship')
      .map(w => `  - ${w.id}: ${w.name} [${w.canDo.join(', ')}]`)
      .join('\n');

    const plannerPrompt = PLANNER_SYSTEM_PROMPT.replace('{AGENTS}', workerList)
      + `\n\nProject directory: ${this.projectDir}`
      + `\nProject structure:\n${fileTree(this.projectDir, 2)}`
      + (this.context?.sessionNotes?.length
        ? `\n\nContext:\n${this.context.sessionNotes.slice(-5).join('\n')}` : '')
      + `\n\nUser request: ${userPrompt}`;

    let plan: OrchestratorPlan | null = null;
    try {
      const plannerOutput = await runOrchestratorAsync(plannerPrompt, this.projectDir);
      plan = parseOrchestratorPlan(plannerOutput);
    } catch (err) {
      console.log(`  ${C.red}✘ Orchestrator error: ${err instanceof Error ? err.message : String(err)}${C.reset}`);
    }

    if (!plan) {
      console.log(`  ${C.yellow}⚠ Could not parse plan — falling back to parallel split${C.reset}`);
      // Instead of single-agent direct mode, distribute across all flagship workers
      plan = this.generateFallbackPlan(userPrompt);
    }

    if (!plan) {
      console.log(`  ${C.yellow}⚠ No workers available — falling back to direct execution${C.reset}`);
      await this.handleDirectTask(userPrompt);
      return;
    }

    // ── Display plan ──
    console.log(`  ${C.bgGreen}${C.white} Plan ${C.reset} ${C.dim}${plan.analysis}${C.reset}\n`);

    // ── Phase 2: Submit ActionPackets to TaskGraph ──
    console.log(`  ${C.bgBlue}${C.white} Phase 2: TaskGraph ${C.reset} ${C.dim}Submitting ${plan.subtasks.length} ActionPacket(s)${C.reset}\n`);

    const taskMap = new Map<string, { taskNode: TaskNode; agentId: string; planTask: SubTaskPlan }>();

    for (const st of plan.subtasks) {
      const agentId = this.resolveWorkerId(st.assignTo);

      // Build ActionPacket (the core ACL message type)
      const packet: ActionPacket = {
        packetId: `interactive-${st.id}-${Date.now()}`,
        sourceAgent: 'opus-orchestrator',
        targetAgent: agentId,
        intent: st.intent,
        inputRefs: [],
        constraints: {
          description: st.description,
          projectDir: this.projectDir!,
          ...(st.fileScope?.length ? { fileScope: st.fileScope.join(',') } : {}),
        },
        outputSchema: st.outputSchema,
        priority: 0.9,
        deadlineMs: Date.now() + 600_000,
      };

      // Resolve dependency taskIds
      const deps = (st.dependsOn || [])
        .map(depId => taskMap.get(depId)?.taskNode.taskId)
        .filter(Boolean) as string[];

      // Submit to runtime → creates TaskNode in PENDING state
      const taskNode = this.runtime.submitTask(packet, deps);

      taskMap.set(st.id, { taskNode, agentId, planTask: st });
      console.log(`    ${C.cyan}${st.id}${C.reset} → ${C.bold}${agentId}${C.reset} [${st.intent}] ${C.dim}state: PENDING${C.reset}`);
    }

    // ── Phase 3: Execute via state transitions (parallel where possible) ──
    console.log(`\n  ${C.bgBlue}${C.white} Phase 3: Executing ${C.reset} ${C.dim}State transitions: PENDING → CLAIMED → RUNNING → DONE${C.reset}\n`);

    const status = new StatusDisplay();
    for (const [planId, { agentId }] of taskMap) {
      const w = this.workers.find(w => w.id === agentId);
      status.addTask(planId, `${w?.name || agentId} [${planId}]`);
    }

    const results = await this.executeViaStateTransitions(taskMap, status);
    status.stop();

    // ── Display results ──
    const totalDuration = Date.now() - startTime;
    let allSuccess = true;

    console.log(`\n  ${C.bold}━━━ Results ━━━${C.reset}`);
    for (const [planId, output] of results) {
      const icon = output.success ? `${C.green}✔${C.reset}` : `${C.red}✘${C.reset}`;
      const conf = (output.confidence * 100).toFixed(0);
      console.log(`  ${icon} ${C.bold}${planId}${C.reset} ${C.dim}confidence:${conf}% tokens:${output.tokenUsage.totalTokens} latency:${output.latencyMs}ms${C.reset}`);
      if (!output.success) {
        allSuccess = false;
        if (output.failureReason) console.log(`    ${C.red}${output.failureReason.slice(0, 200)}${C.reset}`);
      }
    }

    const runtimeStats = this.runtime.stats();
    const totalIcon = allSuccess ? `${C.green}✔${C.reset}` : `${C.yellow}⚠${C.reset}`;
    console.log(`\n  ${totalIcon} ${C.bold}Complete${C.reset} ${C.dim}(${(totalDuration / 1000).toFixed(1)}s wall, tasks:${runtimeStats.completedTasks}/${runtimeStats.totalTasks}, artifacts:${runtimeStats.totalArtifacts})${C.reset}`);

    if (plan.integrationNotes) {
      console.log(`  ${C.dim}Integration: ${plan.integrationNotes}${C.reset}`);
    }

    this.addHistoryEntry(userPrompt, plan.subtasks.length, allSuccess, totalDuration);
  }

  /**
   * Execute tasks via AclRuntime state transitions.
   * Respects dependency DAG: tasks with unmet deps wait.
   * Independent tasks execute in parallel via Promise.all.
   */
  private async executeViaStateTransitions(
    taskMap: Map<string, { taskNode: TaskNode; agentId: string; planTask: SubTaskPlan }>,
    status: StatusDisplay,
  ): Promise<Map<string, TaskExecutionOutput>> {
    const results = new Map<string, TaskExecutionOutput>();
    const completedPlanIds = new Set<string>();
    const remaining = new Map(taskMap);

    while (remaining.size > 0) {
      // Find tasks whose dependencies are all done
      const ready: [string, { taskNode: TaskNode; agentId: string; planTask: SubTaskPlan }][] = [];

      for (const [planId, entry] of remaining) {
        const deps = entry.planTask.dependsOn || [];
        if (deps.every(dep => completedPlanIds.has(dep))) {
          ready.push([planId, entry]);
        }
      }

      if (ready.length === 0 && remaining.size > 0) {
        // Circular dependency — force execute remaining
        console.log(`  ${C.yellow}⚠ Unresolvable deps — forcing remaining tasks${C.reset}`);
        for (const [planId, entry] of remaining) ready.push([planId, entry]);
        remaining.clear();
      }

      // Remove ready tasks from remaining
      for (const [planId] of ready) remaining.delete(planId);

      // Execute ready tasks in parallel via runtime.executeTask()
      // Each call internally handles: CLAIM → START → EXECUTE → COMPLETE/FAIL
      const promises = ready.map(async ([planId, { taskNode, agentId }]) => {
        status.onStateTransition(planId, TaskState.CLAIMED, 'Claimed by ' + agentId);

        // Wire progress callback to the worker's adapter for real-time monitoring
        const worker = this.workers.find(w => w.id === agentId);
        if (worker) {
          const adapter = worker.adapter as any;
          if ('onProgress' in adapter) {
            adapter.onProgress = (info: ProgressInfo) => {
              status.onProgress(planId, info);
            };
          }
        }

        try {
          status.onStateTransition(planId, TaskState.RUNNING, 'Starting...');
          const output = await this.runtime.executeTask(taskNode.taskId, agentId);

          status.onStateTransition(planId, output.success ? TaskState.DONE : TaskState.FAILED,
            output.success ? 'Done' : (output.failureReason || 'Failed'));

          return { planId, output };
        } catch (err) {
          const failOutput: TaskExecutionOutput = {
            success: false,
            content: '',
            artifactType: taskNode.outputSchema,
            confidence: 0,
            failureReason: err instanceof Error ? err.message : String(err),
            tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            latencyMs: 0,
          };
          status.onStateTransition(planId, TaskState.FAILED, failOutput.failureReason!);
          return { planId, output: failOutput };
        }
      });

      const batchResults = await Promise.all(promises);
      for (const { planId, output } of batchResults) {
        results.set(planId, output);
        completedPlanIds.add(planId);
      }
    }

    return results;
  }

  /**
   * Fallback plan when Opus orchestrator fails.
   * Distributes the task across all flagship workers in parallel,
   * each receiving the full prompt but scoped to their strengths.
   */
  private generateFallbackPlan(userPrompt: string): OrchestratorPlan | null {
    const flagships = this.workers.filter(w => w.tier === 'flagship');
    if (flagships.length === 0) return null;

    console.log(`  ${C.cyan}ℹ Auto-splitting across ${flagships.length} flagship workers${C.reset}`);

    const subtasks: SubTaskPlan[] = flagships.map((w, idx) => ({
      id: `fallback-${idx + 1}`,
      assignTo: w.id,
      intent: 'implement',
      description: `${userPrompt}\n\n[You are ${w.name}. Focus on your strengths: ${w.canDo.join(', ')}. Coordinate by dividing work by file/module. Avoid duplicating other agents' work.]`,
      outputSchema: 'code',
      dependsOn: [],
    }));

    return {
      analysis: `Fallback: distributing to ${flagships.length} workers in parallel`,
      subtasks,
      integrationNotes: 'Each worker focuses on its specialties. Results are merged.',
    };
  }

  /** /direct — bypass orchestrator, single task via runtime */
  private async handleDirectTask(userPrompt: string): Promise<void> {
    if (!this.projectDir) {
      console.log(`  ${C.yellow}⚠ Set a project directory first.${C.reset}`);
      return;
    }

    const worker = this.workers.find(w => w.tier === 'flagship') || this.workers[0];
    const startTime = Date.now();

    // Create ActionPacket
    const packet: ActionPacket = {
      packetId: `direct-${Date.now()}`,
      sourceAgent: 'user',
      targetAgent: worker.id,
      intent: 'direct-task',
      inputRefs: [],
      constraints: {
        description: userPrompt,
        projectDir: this.projectDir,
      },
      outputSchema: 'text',
      priority: 0.9,
      deadlineMs: Date.now() + 600_000,
    };

    // Submit → PENDING
    const taskNode = this.runtime.submitTask(packet);
    console.log(`\n  ${C.bgBlue}${C.white} ${worker.name} ${C.reset} ${C.dim}(direct mode, task: ${taskNode.taskId})${C.reset}\n`);

    const status = new StatusDisplay();
    status.addTask('direct', worker.name);
    status.onStateTransition('direct', TaskState.RUNNING, 'Starting...');

    // Wire progress callback
    const adapter = worker.adapter as any;
    if ('onProgress' in adapter) {
      adapter.onProgress = (info: ProgressInfo) => {
        status.onProgress('direct', info);
      };
    }

    // Execute via runtime (CLAIM → START → EXECUTE → COMPLETE/FAIL)
    try {
      const output = await this.runtime.executeTask(taskNode.taskId, worker.id);
      status.onStateTransition('direct', output.success ? TaskState.DONE : TaskState.FAILED);
      status.stop();

      const icon = output.success ? `${C.green}✔${C.reset}` : `${C.red}✘${C.reset}`;
      const duration = (output.latencyMs / 1000).toFixed(1);
      console.log(`\n  ${icon} ${C.bold}${worker.name}${C.reset} ${C.dim}(${duration}s, confidence:${(output.confidence * 100).toFixed(0)}%, tokens:${output.tokenUsage.totalTokens})${C.reset}`);

      this.addHistoryEntry(userPrompt, 1, output.success, Date.now() - startTime);
    } catch (err) {
      status.onStateTransition('direct', TaskState.FAILED);
      status.stop();
      console.log(`  ${C.red}✘ ${err instanceof Error ? err.message : String(err)}${C.reset}`);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────

  private resolveWorkerId(assignTo: string): string {
    if (assignTo !== 'auto') {
      const found = this.workers.find(w => w.id === assignTo);
      if (found) return found.id;
    }
    const flagships = this.workers.filter(w => w.tier === 'flagship');
    if (flagships.length === 0) return this.workers[0].id;
    const agent = flagships[this.autoAssignIdx % flagships.length];
    this.autoAssignIdx++;
    return agent.id;
  }

  private printStats(): void {
    const s = this.runtime.stats();
    console.log(`\n  ${C.bold}AclRuntime Stats:${C.reset}`);
    console.log(`    Tasks:    ${s.totalTasks} total, ${s.completedTasks} done, ${s.failedTasks} failed, ${s.pendingTasks} pending`);
    console.log(`    Agents:   ${s.registeredAgents} registered`);
    console.log(`    Events:   ${s.totalEvents}`);
    console.log(`    Artifacts: ${s.totalArtifacts}`);
    console.log();
  }

  private getArg(name: string): string | null {
    const idx = process.argv.indexOf(name);
    if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
    return null;
  }
}

// ─── Main (only when run directly) ────────────────────────────
if (require.main === module) {
  const harness = new InteractiveHarness();
  harness.start().catch((err) => {
    console.error(`\n  ${C.red}Fatal: ${err instanceof Error ? err.message : String(err)}${C.reset}`);
    process.exit(1);
  });
}
