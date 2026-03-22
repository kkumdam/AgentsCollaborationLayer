/**
 * ACL Multi-Model Pipeline Demo
 *
 * Demonstrates the Phase 2 deliverable:
 * - GPT-4o performs research
 * - Claude Sonnet writes the report
 * - Gemini reviews the output
 *
 * All on a shared task graph with typed state transitions.
 * Zero natural language exchanged between agents.
 *
 * Usage:
 *   OPENAI_API_KEY=... ANTHROPIC_API_KEY=... GOOGLE_API_KEY=... npx ts-node examples/multi-model-pipeline.ts
 */

import {
  AclRuntime,
  OpenAIAdapter,
  AnthropicAdapter,
  GoogleAdapter,
  AgentCapability,
  ActionPacket,
  TaskState,
  EventType,
} from '../src';

// ─── Configuration ──────────────────────────────────────────────

const OPENAI_KEY = process.env.OPENAI_API_KEY ?? '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const GOOGLE_KEY = process.env.GOOGLE_API_KEY ?? '';

function checkKeys(): void {
  const missing: string[] = [];
  if (!OPENAI_KEY) missing.push('OPENAI_API_KEY');
  if (!ANTHROPIC_KEY) missing.push('ANTHROPIC_API_KEY');
  if (!GOOGLE_KEY) missing.push('GOOGLE_API_KEY');

  if (missing.length > 0) {
    console.log('\n  Missing API keys:', missing.join(', '));
    console.log('  Set environment variables and re-run.');
    console.log('  Or use: npx ts-node examples/local-pipeline.ts (no API keys needed)\n');
    process.exit(1);
  }
}

// ─── Main Pipeline ──────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║       ACL Multi-Model Pipeline Demo (Phase 2)          ║');
  console.log('║                                                         ║');
  console.log('║   GPT-4o researches → Claude writes → Gemini reviews    ║');
  console.log('║   All via typed state transitions. No NL between agents ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  checkKeys();

  // ─── Initialize ─────────────────────────────────────────────
  const runtime = new AclRuntime({ verbose: true });

  // Track metrics
  let totalTokens = 0;
  let totalLatency = 0;
  let totalCost = 0;

  // ─── Create Adapters ────────────────────────────────────────

  const openaiAdapter = new OpenAIAdapter({
    apiKey: OPENAI_KEY,
    model: 'gpt-4.1',
    maxTokens: 2048,
    temperature: 0.3,
  });

  const anthropicAdapter = new AnthropicAdapter({
    apiKey: ANTHROPIC_KEY,
    model: 'claude-sonnet-4-6',
    maxTokens: 2048,
    temperature: 0.3,
  });

  const googleAdapter = new GoogleAdapter({
    apiKey: GOOGLE_KEY,
    model: 'gemini-2.5-flash',
    maxTokens: 2048,
    temperature: 0.3,
  });

  // ─── Register Agents ────────────────────────────────────────

  console.log('=== Phase 1: Agent Registration ===\n');

  const researcher: AgentCapability = {
    agentId: 'researcher-gpt41',
    modelBackend: 'openai/gpt-4.1',
    canDo: ['research', 'summarize', 'cite'],
    requires: ['search_query'],
    produces: ['research_report'],
    cost: { inputCostPer1k: 0.002, outputCostPer1k: 0.008, toolCallCost: 0 },
    avgLatencyMs: 300,
    trustScore: 0.9,
  };

  const writer: AgentCapability = {
    agentId: 'writer-claude',
    modelBackend: 'anthropic/claude-sonnet-4-6',
    canDo: ['write', 'edit', 'format'],
    requires: ['research_report'],
    produces: ['final_document'],
    cost: { inputCostPer1k: 0.003, outputCostPer1k: 0.015, toolCallCost: 0 },
    avgLatencyMs: 250,
    trustScore: 0.92,
  };

  const reviewer: AgentCapability = {
    agentId: 'reviewer-gemini',
    modelBackend: 'google/gemini-2.5-flash',
    canDo: ['review', 'fact_check', 'score'],
    requires: ['final_document'],
    produces: ['review_verdict'],
    cost: { inputCostPer1k: 0.0001, outputCostPer1k: 0.0004, toolCallCost: 0 },
    avgLatencyMs: 200,
    trustScore: 0.88,
  };

  runtime.registerAgent(researcher, openaiAdapter);
  runtime.registerAgent(writer, anthropicAdapter);
  runtime.registerAgent(reviewer, googleAdapter);

  console.log('  Registered: researcher-gpt41 (OpenAI GPT-4.1)');
  console.log('  Registered: writer-claude (Anthropic Claude Sonnet 4.6)');
  console.log('  Registered: reviewer-gemini (Google Gemini 2.5 Flash)\n');

  // ─── Build Task Graph ───────────────────────────────────────

  console.log('=== Phase 2: Task Graph Construction ===\n');

  const researchPacket: ActionPacket = {
    packetId: 'task-research',
    sourceAgent: 'supervisor',
    targetAgent: 'researcher-gpt41',
    intent: 'research',
    inputRefs: [],
    constraints: {
      topic: 'AI agent collaboration frameworks comparison 2026',
      depth: 'comprehensive',
      max_sources: '5',
    },
    outputSchema: 'research_report',
    priority: 0.9,
    deadlineMs: Date.now() + 300_000,
  };

  const researchTask = runtime.submitTask(researchPacket);
  console.log(`  Created: ${researchTask.taskId} (research → GPT-4.1)`);

  const writePacket: ActionPacket = {
    packetId: 'task-write',
    sourceAgent: 'supervisor',
    targetAgent: 'writer-claude',
    intent: 'write',
    inputRefs: [],
    constraints: {
      format: 'executive_summary',
      length: '500_words',
      tone: 'professional',
    },
    outputSchema: 'final_document',
    priority: 0.8,
    deadlineMs: Date.now() + 600_000,
  };

  const writeTask = runtime.submitTask(writePacket, [researchTask.taskId]);
  console.log(`  Created: ${writeTask.taskId} (write → Claude, depends on research)`);

  const reviewPacket: ActionPacket = {
    packetId: 'task-review',
    sourceAgent: 'supervisor',
    targetAgent: 'reviewer-gemini',
    intent: 'review',
    inputRefs: [],
    constraints: {
      criteria: 'accuracy,completeness,clarity',
      scoring: '1-10 scale',
    },
    outputSchema: 'review_verdict',
    priority: 0.7,
    deadlineMs: 0,
  };

  const reviewTask = runtime.submitTask(reviewPacket, [writeTask.taskId]);
  console.log(`  Created: ${reviewTask.taskId} (review → Gemini, depends on write)\n`);
  console.log('  DAG: [research] ──→ [write] ──→ [review]\n');

  // ─── Execute Pipeline ───────────────────────────────────────

  console.log('=== Phase 3: Pipeline Execution ===\n');

  // Step 1: Research (GPT-4o)
  console.log('--- Step 1: Research (GPT-4o) ---');
  const researchOutput = await runtime.executeTask('task-research', 'researcher-gpt4o');
  totalTokens += researchOutput.tokenUsage.totalTokens;
  totalLatency += researchOutput.latencyMs;
  totalCost +=
    (researchOutput.tokenUsage.inputTokens / 1000) * openaiAdapter.costProfile.inputCostPer1k +
    (researchOutput.tokenUsage.outputTokens / 1000) * openaiAdapter.costProfile.outputCostPer1k;

  console.log(`  Success: ${researchOutput.success}`);
  console.log(`  Confidence: ${researchOutput.confidence.toFixed(2)}`);
  console.log(`  Tokens: ${researchOutput.tokenUsage.totalTokens}`);
  console.log(`  Latency: ${researchOutput.latencyMs}ms\n`);

  // Step 2: Write (Claude Sonnet)
  console.log('--- Step 2: Write Report (Claude Sonnet) ---');
  const writeOutput = await runtime.executeTask('task-write', 'writer-claude');
  totalTokens += writeOutput.tokenUsage.totalTokens;
  totalLatency += writeOutput.latencyMs;
  totalCost +=
    (writeOutput.tokenUsage.inputTokens / 1000) * anthropicAdapter.costProfile.inputCostPer1k +
    (writeOutput.tokenUsage.outputTokens / 1000) * anthropicAdapter.costProfile.outputCostPer1k;

  console.log(`  Success: ${writeOutput.success}`);
  console.log(`  Confidence: ${writeOutput.confidence.toFixed(2)}`);
  console.log(`  Tokens: ${writeOutput.tokenUsage.totalTokens}`);
  console.log(`  Latency: ${writeOutput.latencyMs}ms\n`);

  // Step 3: Review (Gemini)
  console.log('--- Step 3: Review (Gemini Flash) ---');
  const reviewOutput = await runtime.executeTask('task-review', 'reviewer-gemini');
  totalTokens += reviewOutput.tokenUsage.totalTokens;
  totalLatency += reviewOutput.latencyMs;
  totalCost +=
    (reviewOutput.tokenUsage.inputTokens / 1000) * googleAdapter.costProfile.inputCostPer1k +
    (reviewOutput.tokenUsage.outputTokens / 1000) * googleAdapter.costProfile.outputCostPer1k;

  console.log(`  Success: ${reviewOutput.success}`);
  console.log(`  Confidence: ${reviewOutput.confidence.toFixed(2)}`);
  console.log(`  Tokens: ${reviewOutput.tokenUsage.totalTokens}`);
  console.log(`  Latency: ${reviewOutput.latencyMs}ms\n`);

  // ─── Final Report ─────────────────────────────────────────────

  const stats = runtime.stats();

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║                 Pipeline Results                        ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Tasks: ${stats.completedTasks} completed / ${stats.totalTasks} total`);
  console.log(`║  Models: GPT-4o + Claude Sonnet + Gemini Flash`);
  console.log(`║  Total Tokens: ${totalTokens}`);
  console.log(`║  Total Latency: ${totalLatency}ms`);
  console.log(`║  Estimated Cost: $${totalCost.toFixed(4)}`);
  console.log(`║  Artifacts: ${stats.totalArtifacts}`);
  console.log(`║  Events: ${stats.totalEvents}`);
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║  All inter-agent communication via typed packets.       ║');
  console.log('║  Zero natural language exchanged between agents.        ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
}

main().catch(console.error);
