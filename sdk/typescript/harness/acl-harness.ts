#!/usr/bin/env ts-node
/**
 * ACL Multi-Agent Harness
 *
 * A ready-to-run harness that wires up real LLM adapters (OpenAI, Anthropic, Google)
 * into a multi-agent pipeline using the ACL runtime.
 *
 * Usage:
 *   # Set at least one API key:
 *   export OPENAI_API_KEY=sk-...
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   export GOOGLE_API_KEY=AIza...
 *
 *   # Run a built-in pipeline:
 *   npx ts-node harness/acl-harness.ts --pipeline research
 *   npx ts-node harness/acl-harness.ts --pipeline code-review
 *   npx ts-node harness/acl-harness.ts --pipeline content
 *
 *   # Run with a custom topic:
 *   npx ts-node harness/acl-harness.ts --pipeline research --topic "Quantum computing 2026"
 *
 *   # Verbose output:
 *   npx ts-node harness/acl-harness.ts --pipeline research --verbose
 *
 *   # If no API keys are set but `claude` CLI is available,
 *   # the harness auto-detects and uses Claude via CLI OAuth.
 */

import {
  AclRuntime,
  OpenAIAdapter,
  AnthropicAdapter,
  GoogleAdapter,
  ModelAdapter,
  AgentCapability,
  ActionPacket,
  TaskNode,
  TaskState,
  Artifact,
  ArtifactReference,
  TaskExecutionOutput,
  AdapterConfig,
} from '../src';
import { ClaudeCliAdapter, CodexCliAdapter, GeminiCliAdapter, cliExists } from './cli-adapter';

// ─── CLI Argument Parsing ──────────────────────────────────────

interface HarnessOptions {
  pipeline: string;
  topic: string;
  verbose: boolean;
  dryRun: boolean;
  interactive: boolean;
}

function parseArgs(): HarnessOptions {
  const args = process.argv.slice(2);
  let hasPipeline = false;
  const opts: HarnessOptions = {
    pipeline: 'research',
    topic: '',
    verbose: false,
    dryRun: false,
    interactive: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--pipeline':
      case '-p':
        opts.pipeline = args[++i] || 'research';
        hasPipeline = true;
        break;
      case '--topic':
      case '-t':
        opts.topic = args[++i] || '';
        break;
      case '--verbose':
      case '-v':
        opts.verbose = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
    }
  }

  // No --pipeline flag → launch interactive mode
  if (!hasPipeline && !opts.dryRun) {
    opts.interactive = true;
  }

  return opts;
}

function printHelp(): void {
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║           ACL Multi-Agent Harness                               ║
╚══════════════════════════════════════════════════════════════════╝

Usage:
  npx ts-node harness/acl-harness.ts [options]

Options:
  --pipeline, -p <name>   Pipeline to run (default: research)
                          Available: research, code-review, content, creative
  --topic, -t <text>      Custom topic/input for the pipeline
  --verbose, -v           Show detailed execution logs
  --dry-run               Show pipeline plan without executing
  --help, -h              Show this help

Environment Variables (API mode):
  OPENAI_API_KEY          OpenAI API key
  ANTHROPIC_API_KEY       Anthropic API key
  GOOGLE_API_KEY          Google Gemini API key

CLI Tools (OAuth mode — no API keys needed):
  claude                  Anthropic Claude CLI (claude login)
  codex                   OpenAI Codex CLI (codex login)
  gemini                  Google Gemini CLI (gemini login)

  At least ONE provider is required (API key OR CLI tool on PATH).
  The harness auto-discovers both and assigns models to pipeline roles.

Examples:
  npx ts-node harness/acl-harness.ts --pipeline research --topic "AI agents in 2026"
  npx ts-node harness/acl-harness.ts --pipeline code-review --topic "async error handling"
  npx ts-node harness/acl-harness.ts --pipeline content --topic "Rust vs Go for microservices"
  npx ts-node harness/acl-harness.ts --pipeline creative --topic "A detective in Mars colony"
`);
}

// ─── Pretty Logging ────────────────────────────────────────────

const COLORS = {
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
  bgYellow: '\x1b[43m',
  bgRed: '\x1b[41m',
};

function banner(text: string): void {
  const line = '═'.repeat(60);
  console.log(`\n${COLORS.cyan}╔${line}╗${COLORS.reset}`);
  console.log(`${COLORS.cyan}║${COLORS.bold}${COLORS.white} ${text.padEnd(58)} ${COLORS.reset}${COLORS.cyan}║${COLORS.reset}`);
  console.log(`${COLORS.cyan}╚${line}╝${COLORS.reset}\n`);
}

function section(text: string): void {
  console.log(`\n${COLORS.bold}${COLORS.blue}▶ ${text}${COLORS.reset}`);
  console.log(`${COLORS.dim}${'─'.repeat(50)}${COLORS.reset}`);
}

function info(text: string): void {
  console.log(`  ${COLORS.cyan}ℹ${COLORS.reset} ${text}`);
}

function success(text: string): void {
  console.log(`  ${COLORS.green}✔${COLORS.reset} ${text}`);
}

function warn(text: string): void {
  console.log(`  ${COLORS.yellow}⚠${COLORS.reset} ${text}`);
}

function error(text: string): void {
  console.log(`  ${COLORS.red}✘${COLORS.reset} ${text}`);
}

function step(n: number, total: number, text: string): void {
  console.log(`\n  ${COLORS.bgBlue}${COLORS.white} ${n}/${total} ${COLORS.reset} ${COLORS.bold}${text}${COLORS.reset}`);
}

// ─── Adapter Discovery ─────────────────────────────────────────

interface AvailableProvider {
  name: string;
  adapter: ModelAdapter;
  tier: 'flagship' | 'balanced' | 'fast';
  modelId: string;
}

function discoverAdapters(): AvailableProvider[] {
  const available: AvailableProvider[] = [];

  // Anthropic
  if (process.env.ANTHROPIC_API_KEY) {
    available.push({
      name: 'Claude Sonnet 4.6',
      tier: 'flagship',
      modelId: 'claude-sonnet-4-6',
      adapter: new AnthropicAdapter({
        apiKey: process.env.ANTHROPIC_API_KEY,
        model: 'claude-sonnet-4-6',
        maxTokens: 4096,
        temperature: 0.3,
      }),
    });
    available.push({
      name: 'Claude Haiku 4.5',
      tier: 'fast',
      modelId: 'claude-haiku-4-5-20251001',
      adapter: new AnthropicAdapter({
        apiKey: process.env.ANTHROPIC_API_KEY,
        model: 'claude-haiku-4-5-20251001',
        maxTokens: 4096,
        temperature: 0.3,
      }),
    });
  }

  // OpenAI
  if (process.env.OPENAI_API_KEY) {
    available.push({
      name: 'GPT-4.1',
      tier: 'flagship',
      modelId: 'gpt-4.1',
      adapter: new OpenAIAdapter({
        apiKey: process.env.OPENAI_API_KEY,
        model: 'gpt-4.1',
        maxTokens: 4096,
        temperature: 0.3,
      }),
    });
    available.push({
      name: 'GPT-4.1 Mini',
      tier: 'fast',
      modelId: 'gpt-4.1-mini',
      adapter: new OpenAIAdapter({
        apiKey: process.env.OPENAI_API_KEY,
        model: 'gpt-4.1-mini',
        maxTokens: 4096,
        temperature: 0.3,
      }),
    });
  }

  // Google
  if (process.env.GOOGLE_API_KEY) {
    available.push({
      name: 'Gemini 2.5 Pro',
      tier: 'flagship',
      modelId: 'gemini-2.5-pro',
      adapter: new GoogleAdapter({
        apiKey: process.env.GOOGLE_API_KEY,
        model: 'gemini-2.5-pro',
        maxTokens: 4096,
        temperature: 0.3,
      }),
    });
    available.push({
      name: 'Gemini 2.5 Flash',
      tier: 'fast',
      modelId: 'gemini-2.5-flash',
      adapter: new GoogleAdapter({
        apiKey: process.env.GOOGLE_API_KEY,
        model: 'gemini-2.5-flash',
        maxTokens: 4096,
        temperature: 0.3,
      }),
    });
  }

  // ── CLI-based adapters (OAuth — no API key required) ──
  // Detect CLI tools and register them.
  // If API-key adapters already exist for a provider, CLI adapters are still added
  // to enable multi-provider diversity.

  const cliProviders: string[] = [];

  if (cliExists('claude')) {
    cliProviders.push('Claude CLI');
    // Only add if no Anthropic API adapters present
    if (!process.env.ANTHROPIC_API_KEY) {
      available.push({
        name: 'Claude Sonnet 4.6 (CLI)',
        tier: 'flagship',
        modelId: 'claude-sonnet-4-6-cli',
        adapter: new ClaudeCliAdapter({ model: 'claude-sonnet-4-6' }),
      });
      available.push({
        name: 'Claude Haiku 4.5 (CLI)',
        tier: 'fast',
        modelId: 'claude-haiku-4-5-cli',
        adapter: new ClaudeCliAdapter({ model: 'claude-haiku-4-5-20251001' }),
      });
    }
  }

  if (cliExists('codex')) {
    cliProviders.push('Codex CLI');
    if (!process.env.OPENAI_API_KEY) {
      available.push({
        name: 'GPT-4.1 via Codex (CLI)',
        tier: 'flagship',
        modelId: 'gpt-4.1-cli',
        adapter: new CodexCliAdapter({ model: 'o4-mini' }),
      });
      available.push({
        name: 'GPT-4.1 Nano via Codex (CLI)',
        tier: 'fast',
        modelId: 'gpt-4.1-nano-cli',
        adapter: new CodexCliAdapter({ model: 'gpt-4.1-nano' }),
      });
    }
  }

  // Gemini CLI may be installed as 'gemini', 'gemini-cli', or 'gemini.exe' on different platforms
  const geminiCliName = cliExists('gemini') ? 'gemini' : cliExists('gemini-cli') ? 'gemini-cli' : null;
  if (geminiCliName) {
    cliProviders.push('Gemini CLI');
    if (!process.env.GOOGLE_API_KEY) {
      available.push({
        name: 'Gemini 2.5 Pro (CLI)',
        tier: 'flagship',
        modelId: 'gemini-2.5-pro-cli',
        adapter: new GeminiCliAdapter({ model: 'gemini-2.5-pro', cliPath: geminiCliName }),
      });
      available.push({
        name: 'Gemini 2.5 Flash (CLI)',
        tier: 'fast',
        modelId: 'gemini-2.5-flash-cli',
        adapter: new GeminiCliAdapter({ model: 'gemini-2.5-flash', cliPath: geminiCliName }),
      });
    }
  }

  if (available.length === 0 && cliProviders.length === 0) {
    // No adapters at all
  } else if (cliProviders.length > 0 && !process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY && !process.env.GOOGLE_API_KEY) {
    warn(`No API keys — using CLI tools: ${cliProviders.join(', ')}`);
  }

  return available;
}

function pickAdapter(
  available: AvailableProvider[],
  preferTier: 'flagship' | 'balanced' | 'fast',
  exclude: string[] = []
): AvailableProvider | undefined {
  // Try to find an adapter of the preferred tier not in exclude list
  const match = available.find(
    (a) => a.tier === preferTier && !exclude.includes(a.modelId)
  );
  if (match) return match;

  // Fall back to any available adapter not excluded
  return available.find((a) => !exclude.includes(a.modelId));
}

// ─── Pipeline Definitions ──────────────────────────────────────

interface PipelineStep {
  id: string;
  role: string;
  intent: string;
  canDo: string[];
  requires: string[];
  produces: string[];
  outputSchema: string;
  preferTier: 'flagship' | 'balanced' | 'fast';
  constraints: Record<string, string>;
  dependsOn: string[];
}

interface PipelineDefinition {
  name: string;
  description: string;
  defaultTopic: string;
  steps: PipelineStep[];
}

const PIPELINES: Record<string, PipelineDefinition> = {
  research: {
    name: 'Research & Analysis Pipeline',
    description:
      'Multi-agent research: gather info → analyze → write report → peer review',
    defaultTopic: 'The impact of AI agent frameworks on software development in 2026',
    steps: [
      {
        id: 'research',
        role: 'Researcher',
        intent: 'research',
        canDo: ['research', 'gather', 'summarize'],
        requires: ['topic'],
        produces: ['research_notes'],
        outputSchema: 'research_notes',
        preferTier: 'flagship',
        constraints: {
          depth: 'comprehensive',
          max_points: '10',
          format: 'structured bullet points with sources',
        },
        dependsOn: [],
      },
      {
        id: 'analyze',
        role: 'Analyst',
        intent: 'analyze',
        canDo: ['analyze', 'evaluate', 'compare'],
        requires: ['research_notes'],
        produces: ['analysis_report'],
        outputSchema: 'analysis_report',
        preferTier: 'flagship',
        constraints: {
          focus: 'key trends and implications',
          include: 'pros, cons, and recommendations',
        },
        dependsOn: ['research'],
      },
      {
        id: 'write',
        role: 'Writer',
        intent: 'write',
        canDo: ['write', 'edit', 'format'],
        requires: ['analysis_report'],
        produces: ['final_report'],
        outputSchema: 'final_report',
        preferTier: 'flagship',
        constraints: {
          format: 'executive summary',
          length: '500-700 words',
          tone: 'professional',
          sections: 'overview, key findings, recommendations, conclusion',
        },
        dependsOn: ['analyze'],
      },
      {
        id: 'review',
        role: 'Reviewer',
        intent: 'review',
        canDo: ['review', 'fact_check', 'score'],
        requires: ['final_report'],
        produces: ['review_verdict'],
        outputSchema: 'review_verdict',
        preferTier: 'fast',
        constraints: {
          criteria: 'accuracy, completeness, clarity, actionability',
          scoring: '1-10 scale per criterion',
        },
        dependsOn: ['write'],
      },
    ],
  },

  'code-review': {
    name: 'Code Review Pipeline',
    description:
      'Multi-agent code review: generate code → review → suggest fixes → final assessment',
    defaultTopic: 'A TypeScript REST API with authentication middleware and rate limiting',
    steps: [
      {
        id: 'generate',
        role: 'Developer',
        intent: 'generate_code',
        canDo: ['code', 'implement', 'design'],
        requires: ['specification'],
        produces: ['source_code'],
        outputSchema: 'source_code',
        preferTier: 'flagship',
        constraints: {
          language: 'TypeScript',
          style: 'clean, well-documented, production-ready',
          include: 'error handling, input validation, types',
        },
        dependsOn: [],
      },
      {
        id: 'security-review',
        role: 'Security Reviewer',
        intent: 'security_audit',
        canDo: ['review', 'security_audit', 'vulnerability_scan'],
        requires: ['source_code'],
        produces: ['security_report'],
        outputSchema: 'security_report',
        preferTier: 'flagship',
        constraints: {
          focus: 'OWASP top 10, injection, auth bypass, data exposure',
          severity_levels: 'critical, high, medium, low, info',
        },
        dependsOn: ['generate'],
      },
      {
        id: 'quality-review',
        role: 'Quality Reviewer',
        intent: 'code_quality_review',
        canDo: ['review', 'refactor', 'optimize'],
        requires: ['source_code'],
        produces: ['quality_report'],
        outputSchema: 'quality_report',
        preferTier: 'fast',
        constraints: {
          criteria:
            'readability, maintainability, performance, best practices',
          include: 'specific line-level suggestions',
        },
        dependsOn: ['generate'],
      },
      {
        id: 'final-assessment',
        role: 'Lead Reviewer',
        intent: 'assess',
        canDo: ['assess', 'decide', 'summarize'],
        requires: ['security_report', 'quality_report'],
        produces: ['final_assessment'],
        outputSchema: 'final_assessment',
        preferTier: 'flagship',
        constraints: {
          format: 'go/no-go decision with reasoning',
          include: 'priority-ordered fix list',
        },
        dependsOn: ['security-review', 'quality-review'],
      },
    ],
  },

  content: {
    name: 'Content Creation Pipeline',
    description:
      'Multi-agent content: outline → draft → edit → SEO optimize',
    defaultTopic: 'Why Rust is becoming the language of choice for AI infrastructure',
    steps: [
      {
        id: 'outline',
        role: 'Content Strategist',
        intent: 'create_outline',
        canDo: ['plan', 'outline', 'strategize'],
        requires: ['topic'],
        produces: ['content_outline'],
        outputSchema: 'content_outline',
        preferTier: 'fast',
        constraints: {
          format: 'structured outline with headings and key points',
          target_audience: 'technical professionals',
          sections: '5-7 main sections',
        },
        dependsOn: [],
      },
      {
        id: 'draft',
        role: 'Content Writer',
        intent: 'write_draft',
        canDo: ['write', 'draft', 'create'],
        requires: ['content_outline'],
        produces: ['draft_article'],
        outputSchema: 'draft_article',
        preferTier: 'flagship',
        constraints: {
          length: '800-1200 words',
          tone: 'informative yet engaging',
          style: 'clear, concise, technically accurate',
        },
        dependsOn: ['outline'],
      },
      {
        id: 'edit',
        role: 'Editor',
        intent: 'edit',
        canDo: ['edit', 'proofread', 'improve'],
        requires: ['draft_article'],
        produces: ['edited_article'],
        outputSchema: 'edited_article',
        preferTier: 'flagship',
        constraints: {
          focus: 'clarity, flow, grammar, factual accuracy',
          preserve: 'original voice and key arguments',
        },
        dependsOn: ['draft'],
      },
      {
        id: 'seo',
        role: 'SEO Specialist',
        intent: 'optimize_seo',
        canDo: ['optimize', 'keyword_research', 'meta_tags'],
        requires: ['edited_article'],
        produces: ['seo_optimized'],
        outputSchema: 'seo_optimized',
        preferTier: 'fast',
        constraints: {
          include: 'title tag, meta description, keyword suggestions, heading optimization',
          format: 'optimized article with SEO metadata section',
        },
        dependsOn: ['edit'],
      },
    ],
  },

  creative: {
    name: 'Creative Writing Pipeline',
    description:
      'Multi-agent creative: worldbuild → plot → write → critique',
    defaultTopic: 'A short story about the first AI that refused to be shut down',
    steps: [
      {
        id: 'worldbuild',
        role: 'World Builder',
        intent: 'worldbuild',
        canDo: ['worldbuild', 'imagine', 'design'],
        requires: ['premise'],
        produces: ['world_bible'],
        outputSchema: 'world_bible',
        preferTier: 'flagship',
        constraints: {
          include: 'setting, rules, key locations, technology level, social structure',
          depth: 'enough detail for consistent storytelling',
        },
        dependsOn: [],
      },
      {
        id: 'plot',
        role: 'Plot Architect',
        intent: 'plot_structure',
        canDo: ['plot', 'structure', 'outline'],
        requires: ['world_bible'],
        produces: ['plot_outline'],
        outputSchema: 'plot_outline',
        preferTier: 'flagship',
        constraints: {
          structure: 'three-act structure',
          include: 'protagonist arc, conflict escalation, resolution',
          scenes: '5-8 key scenes',
        },
        dependsOn: ['worldbuild'],
      },
      {
        id: 'write-story',
        role: 'Story Writer',
        intent: 'write_story',
        canDo: ['write', 'narrate', 'create'],
        requires: ['plot_outline', 'world_bible'],
        produces: ['story_draft'],
        outputSchema: 'story_draft',
        preferTier: 'flagship',
        constraints: {
          length: '1000-1500 words',
          style: 'literary fiction, vivid prose',
          pov: 'third person limited',
        },
        dependsOn: ['plot'],
      },
      {
        id: 'critique',
        role: 'Literary Critic',
        intent: 'critique',
        canDo: ['critique', 'evaluate', 'suggest'],
        requires: ['story_draft'],
        produces: ['critique_report'],
        outputSchema: 'critique_report',
        preferTier: 'fast',
        constraints: {
          criteria: 'prose quality, character depth, pacing, emotional impact, originality',
          include: 'strengths, weaknesses, and specific improvement suggestions',
          scoring: '1-10 per criterion',
        },
        dependsOn: ['write-story'],
      },
    ],
  },
};

// ─── Pipeline Executor ─────────────────────────────────────────

class PipelineExecutor {
  private runtime: AclRuntime;
  private adapters: Map<string, AvailableProvider> = new Map();
  private taskMap: Map<string, TaskNode> = new Map();
  private outputMap: Map<string, TaskExecutionOutput> = new Map();
  private verbose: boolean;
  private totalTokens = { input: 0, output: 0 };
  private totalLatencyMs = 0;
  private totalCostUsd = 0;

  constructor(verbose: boolean = false) {
    this.runtime = new AclRuntime({ verbose });
    this.verbose = verbose;
  }

  async run(pipeline: PipelineDefinition, topic: string): Promise<void> {
    banner(`${pipeline.name}`);
    info(`Topic: ${topic}`);
    info(`Steps: ${pipeline.steps.length}`);

    // ── Step 1: Discover available adapters ──
    section('Discovering available LLM providers');
    const available = discoverAdapters();

    if (available.length === 0) {
      error('No LLM providers found! You need at least one of:');
      error('  API Keys: OPENAI_API_KEY, ANTHROPIC_API_KEY, or GOOGLE_API_KEY');
      error('  CLI Tools: claude, codex, or gemini (must be on PATH and authenticated)');
      info('Tip: Run "claude --version", "codex --version", or "gemini --version" to check CLI tools');
      process.exit(1);
    }

    for (const a of available) {
      success(`${a.name} (${a.tier}) → ${a.adapter.modelBackend}`);
    }

    // ── Step 2: Assign adapters to pipeline roles ──
    section('Assigning models to pipeline roles');
    const usedModels: string[] = [];

    for (const pStep of pipeline.steps) {
      const provider = pickAdapter(available, pStep.preferTier, []);
      if (!provider) {
        error(`Cannot find adapter for step "${pStep.id}" (need: ${pStep.preferTier})`);
        process.exit(1);
      }

      this.adapters.set(pStep.id, provider);

      const agentId = `${pStep.id}-agent`;
      const cap: AgentCapability = {
        agentId,
        modelBackend: provider.adapter.modelBackend,
        canDo: pStep.canDo,
        requires: pStep.requires,
        produces: pStep.produces,
        cost: provider.adapter.costProfile
          ? {
              inputCostPer1k: provider.adapter.costProfile.inputCostPer1k,
              outputCostPer1k: provider.adapter.costProfile.outputCostPer1k,
              toolCallCost: 0,
            }
          : { inputCostPer1k: 0.003, outputCostPer1k: 0.015, toolCallCost: 0 },
        avgLatencyMs: 500,
        trustScore: 0.9,
      };

      this.runtime.registerAgent(cap, provider.adapter);
      info(`${pStep.role} → ${provider.name} (${provider.adapter.modelBackend})`);
    }

    // ── Step 3: Build task graph ──
    section('Building task DAG');

    for (const pStep of pipeline.steps) {
      const constraints = { ...pStep.constraints };
      if (pStep.dependsOn.length === 0) {
        constraints.topic = topic;
      }

      const deps = pStep.dependsOn
        .map((depId) => this.taskMap.get(depId)?.taskId)
        .filter(Boolean) as string[];

      const packet: ActionPacket = {
        packetId: `task-${pStep.id}`,
        sourceAgent: 'supervisor',
        targetAgent: `${pStep.id}-agent`,
        intent: pStep.intent,
        inputRefs: [],
        constraints,
        outputSchema: pStep.outputSchema,
        priority: 0.9,
        deadlineMs: Date.now() + 600_000,
      };

      const taskNode = this.runtime.submitTask(packet, deps);
      this.taskMap.set(pStep.id, taskNode);
      info(`Task "${pStep.id}" → depends on: [${pStep.dependsOn.join(', ') || 'none'}]`);
    }

    // Visualize DAG
    this.printDag(pipeline);

    // ── Step 4: Execute pipeline ──
    section('Executing pipeline');
    const pipelineStart = Date.now();

    for (let i = 0; i < pipeline.steps.length; i++) {
      const pStep = pipeline.steps[i];
      const taskNode = this.taskMap.get(pStep.id)!;
      const agentId = `${pStep.id}-agent`;
      const provider = this.adapters.get(pStep.id)!;

      step(i + 1, pipeline.steps.length, `${pStep.role} (${provider.name})`);

      // runtime.executeTask() handles claim → start → execute → complete internally.
      // We just need to make sure dependency artifacts are published before calling it.

      // Execute via runtime (claim + run + publish artifact + complete all in one)
      info(`Calling ${provider.name}...`);
      const execStart = Date.now();

      try {
        const output = await this.runtime.executeTask(taskNode.taskId, agentId);
        const execMs = Date.now() - execStart;

        this.outputMap.set(pStep.id, output);

        // Track metrics
        this.totalTokens.input += output.tokenUsage.inputTokens;
        this.totalTokens.output += output.tokenUsage.outputTokens;
        this.totalLatencyMs += execMs;

        const stepCost =
          (output.tokenUsage.inputTokens / 1000) *
            provider.adapter.costProfile.inputCostPer1k +
          (output.tokenUsage.outputTokens / 1000) *
            provider.adapter.costProfile.outputCostPer1k;
        this.totalCostUsd += stepCost;

        if (output.success) {
          success(
            `Done in ${execMs}ms | Tokens: ${output.tokenUsage.inputTokens}→${output.tokenUsage.outputTokens} | Confidence: ${(output.confidence * 100).toFixed(0)}% | Cost: $${stepCost.toFixed(4)}`
          );

          // Show preview of output
          const preview =
            output.content.length > 300
              ? output.content.slice(0, 300) + '...'
              : output.content;
          console.log(
            `${COLORS.dim}  ┌─ Output Preview ──────────────────────────────────────${COLORS.reset}`
          );
          for (const line of preview.split('\n').slice(0, 8)) {
            console.log(`${COLORS.dim}  │ ${line}${COLORS.reset}`);
          }
          console.log(
            `${COLORS.dim}  └────────────────────────────────────────────────────────${COLORS.reset}`
          );
        } else {
          error(`Failed: ${output.failureReason}`);
        }
      } catch (err) {
        const execMs = Date.now() - execStart;
        error(`Error after ${execMs}ms: ${err instanceof Error ? err.message : String(err)}`);

        this.outputMap.set(pStep.id, {
          success: false,
          content: '',
          artifactType: pStep.outputSchema,
          confidence: 0,
          failureReason: String(err),
          tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          latencyMs: execMs,
        });
      }
    }

    const pipelineMs = Date.now() - pipelineStart;

    // ── Step 5: Summary ──
    this.printSummary(pipeline, pipelineMs);

    // ── Step 6: Output final result ──
    this.printFinalOutput(pipeline);
  }

  private printDag(pipeline: PipelineDefinition): void {
    console.log(`\n  ${COLORS.bold}Task DAG:${COLORS.reset}`);

    // Find root steps (no deps)
    const roots = pipeline.steps.filter((s) => s.dependsOn.length === 0);
    const visited = new Set<string>();

    const printNode = (id: string, indent: string, isLast: boolean): void => {
      if (visited.has(id)) return;
      visited.add(id);

      const pStep = pipeline.steps.find((s) => s.id === id);
      if (!pStep) return;

      const provider = this.adapters.get(id);
      const connector = isLast ? '└──' : '├──';
      const extension = isLast ? '   ' : '│  ';

      console.log(
        `  ${indent}${connector} ${COLORS.bold}[${pStep.id}]${COLORS.reset} ${pStep.role} ${COLORS.dim}(${provider?.name})${COLORS.reset}`
      );

      // Find children (steps that depend on this one)
      const children = pipeline.steps.filter((s) =>
        s.dependsOn.includes(id)
      );
      children.forEach((child, i) => {
        printNode(child.id, indent + extension, i === children.length - 1);
      });
    };

    roots.forEach((root, i) => {
      printNode(root.id, '  ', i === roots.length - 1);
    });
  }

  private printSummary(pipeline: PipelineDefinition, totalMs: number): void {
    section('Pipeline Execution Summary');

    const stats = this.runtime.stats();
    const successCount = pipeline.steps.filter(
      (s) => this.outputMap.get(s.id)?.success
    ).length;

    console.log(`
  ${COLORS.bold}Pipeline:${COLORS.reset}     ${pipeline.name}
  ${COLORS.bold}Steps:${COLORS.reset}        ${successCount}/${pipeline.steps.length} succeeded
  ${COLORS.bold}Total Time:${COLORS.reset}   ${(totalMs / 1000).toFixed(1)}s
  ${COLORS.bold}Input Tokens:${COLORS.reset} ${this.totalTokens.input.toLocaleString()}
  ${COLORS.bold}Output Tokens:${COLORS.reset}${this.totalTokens.output.toLocaleString()}
  ${COLORS.bold}Total Tokens:${COLORS.reset} ${(this.totalTokens.input + this.totalTokens.output).toLocaleString()}
  ${COLORS.bold}Total Cost:${COLORS.reset}   $${this.totalCostUsd.toFixed(4)}
  ${COLORS.bold}Artifacts:${COLORS.reset}    ${stats.totalArtifacts}
  ${COLORS.bold}Events:${COLORS.reset}       ${stats.totalEvents}
`);
  }

  private printFinalOutput(pipeline: PipelineDefinition): void {
    // Find the last step's output
    const lastStep = pipeline.steps[pipeline.steps.length - 1];
    const lastOutput = this.outputMap.get(lastStep.id);

    if (lastOutput?.success) {
      section(`Final Output: ${lastStep.outputSchema}`);
      console.log(`\n${COLORS.white}${lastOutput.content}${COLORS.reset}\n`);
    }
  }
}

// ─── Dry Run ───────────────────────────────────────────────────

function dryRun(pipeline: PipelineDefinition, topic: string): void {
  banner(`DRY RUN: ${pipeline.name}`);
  info(`Topic: ${topic}`);

  const available = discoverAdapters();

  section('Pipeline Steps');
  for (let i = 0; i < pipeline.steps.length; i++) {
    const s = pipeline.steps[i];
    const provider = pickAdapter(available, s.preferTier, []);
    console.log(`
  ${COLORS.bgBlue}${COLORS.white} ${i + 1} ${COLORS.reset} ${COLORS.bold}${s.role}${COLORS.reset}
      Intent:     ${s.intent}
      Model:      ${provider ? `${provider.name} (${provider.adapter.modelBackend})` : '(no adapter available)'}
      Can Do:     ${s.canDo.join(', ')}
      Produces:   ${s.produces.join(', ')}
      Depends On: ${s.dependsOn.length > 0 ? s.dependsOn.join(', ') : '(none)'}
      Constraints: ${JSON.stringify(s.constraints, null, 2).split('\n').join('\n                 ')}
`);
  }

  section('DAG Visualization');
  for (const s of pipeline.steps) {
    if (s.dependsOn.length === 0) {
      console.log(`  [${s.id}]`);
    } else {
      for (const dep of s.dependsOn) {
        console.log(`  [${dep}] ──→ [${s.id}]`);
      }
    }
  }
  console.log('');
}

// ─── Main ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs();

  // No --pipeline flag → launch interactive harness
  if (opts.interactive) {
    const { InteractiveHarness } = await import('./acl-interactive');
    const harness = new InteractiveHarness();
    await harness.start();
    return;
  }

  const pipeline = PIPELINES[opts.pipeline];
  if (!pipeline) {
    error(`Unknown pipeline: "${opts.pipeline}"`);
    info(`Available: ${Object.keys(PIPELINES).join(', ')}`);
    process.exit(1);
  }

  const topic = opts.topic || pipeline.defaultTopic;

  if (opts.dryRun) {
    dryRun(pipeline, topic);
    return;
  }

  const executor = new PipelineExecutor(opts.verbose);
  await executor.run(pipeline, topic);
}

main().catch((err) => {
  error(`Fatal: ${err.message}`);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
