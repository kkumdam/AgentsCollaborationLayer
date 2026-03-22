/**
 * ACL End-to-End Pipeline Demo
 *
 * 5-agent "Market Analysis Report" pipeline with:
 * - Supervisor orchestrating 4 specialist agents
 * - Spawn governance (budget, TTL, depth limits)
 * - Full DAG: research-market ─┐
 *                               ├──→ writer ──→ reviewer
 *             research-tech ────┘
 *                               └──→ citation-agent
 * - Benchmark comparison: ACL typed approach vs NL baseline
 *
 * Usage:
 *   npx ts-node examples/e2e-pipeline.ts
 */

import {
  AclRuntime,
  AgentCapability,
  ActionPacket,
  ModelAdapter,
  TaskExecutionInput,
  TaskExecutionOutput,
  TaskState,
  EventType,
  SpawnType,
  PolicyEngine,
  SpawnManager,
  simulateNlBaseline,
  compareBenchmarks,
  formatBenchmarkReport,
} from '../src';
import type { BenchmarkMetrics } from '../src';

// ─── Mock Adapter ───────────────────────────────────────────────

class MockAdapter implements ModelAdapter {
  readonly provider: string;
  readonly model: string;
  readonly modelBackend: string;
  readonly costProfile = { inputCostPer1k: 0.001, outputCostPer1k: 0.002 };

  private latencyMs: number;
  private mockResponses: Map<string, string>;

  constructor(provider: string, model: string, latencyMs: number = 100) {
    this.provider = provider;
    this.model = model;
    this.modelBackend = `${provider}/${model}`;
    this.latencyMs = latencyMs;
    this.mockResponses = new Map();
  }

  setResponse(intent: string, content: string): void {
    this.mockResponses.set(intent, content);
  }

  async executeTask(input: TaskExecutionInput): Promise<TaskExecutionOutput> {
    await new Promise((resolve) => setTimeout(resolve, this.latencyMs));

    const intent = input.task.intent;
    const mockContent = this.mockResponses.get(intent) ?? JSON.stringify({
      result: `Mock ${intent} output from ${this.modelBackend}`,
      confidence: 0.85,
    });

    const inputTokens = Math.ceil(JSON.stringify(input).length / 4);
    const outputTokens = Math.ceil(mockContent.length / 4);

    return {
      success: true,
      content: mockContent,
      artifactType: input.task.outputSchema,
      confidence: 0.88,
      tokenUsage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
      latencyMs: this.latencyMs,
      metadata: { mock: 'true' },
    };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  estimateTokens(input: TaskExecutionInput): number {
    return Math.ceil(JSON.stringify(input).length / 4);
  }
}

// ─── Spawn Governance Demo ───────────────────────────────────────

function demoSpawnGovernance(): void {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║          Phase 1: Spawn Governance Demo                  ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const policy = new PolicyEngine({
    spawnLimit: 5,
    spawnDepthLimit: 3,
    toolAccess: ['web_search', 'file_read', 'code_exec'],
    budgetUsd: 2.0,
    ttlSeconds: 300,
    memoryScope: 'pipeline',
    maxRetries: 3,
    allowedModels: [],
  });

  const spawnMgr = new SpawnManager(policy);

  // Register root supervisor
  policy.registerAgentPolicy('supervisor', undefined, {
    spawnLimit: 5,
    spawnDepthLimit: 3,
    toolAccess: ['web_search', 'file_read', 'code_exec'],
    budgetUsd: 2.0,
    ttlSeconds: 300,
    memoryScope: 'pipeline',
    maxRetries: 3,
    allowedModels: [],
  }, 0);
  spawnMgr.registerRoot('supervisor');

  // Track events
  spawnMgr.onEvent((type, agentId, data) => {
    console.log(`  [SPAWN] ${EventType[type]} | agent=${agentId}`, data);
  });

  // Spawn 4 specialist subagents
  const agents = [
    { id: 'researcher-market', tools: ['web_search'], budget: 0.5 },
    { id: 'researcher-tech', tools: ['web_search', 'code_exec'], budget: 0.4 },
    { id: 'writer-agent', tools: ['file_read'], budget: 0.3 },
    { id: 'reviewer-agent', tools: ['file_read'], budget: 0.2 },
  ];

  console.log('--- Spawning specialist agents ---\n');

  for (const agent of agents) {
    const result = spawnMgr.spawn(
      'supervisor',
      agent.id,
      {
        agentId: agent.id,
        modelBackend: 'mock/model',
        canDo: [],
        requires: [],
        produces: [],
        cost: { inputCostPer1k: 0.001, outputCostPer1k: 0.002, toolCallCost: 0 },
        avgLatencyMs: 100,
        trustScore: 0.9,
      },
      {
        spawnLimit: 2,
        spawnDepth: 2,
        toolAccess: agent.tools,
        budgetUsd: agent.budget,
        ttlSeconds: 120,
        memoryScope: 'task',
      },
      SpawnType.PERSISTENT
    );
    console.log(`  Spawned ${agent.id}: success=${result.success}`);
  }

  // Show spawn tree
  console.log('\n--- Spawn Tree ---\n');
  const tree = spawnMgr.getSpawnTree('supervisor');
  printSpawnTree(tree, 0);

  // Demonstrate budget enforcement
  console.log('\n--- Budget Enforcement ---\n');
  const overBudget = spawnMgr.spawn(
    'supervisor',
    'extra-agent',
    {
      agentId: 'extra-agent',
      modelBackend: 'mock/model',
      canDo: [],
      requires: [],
      produces: [],
      cost: { inputCostPer1k: 0.001, outputCostPer1k: 0.002, toolCallCost: 0 },
      avgLatencyMs: 100,
      trustScore: 0.9,
    },
    {
      spawnLimit: 1,
      spawnDepth: 1,
      toolAccess: ['web_search'],
      budgetUsd: 5.0, // Exceeds remaining budget
      ttlSeconds: 60,
      memoryScope: 'task',
    },
    SpawnType.PERSISTENT
  );
  console.log(`  Over-budget spawn attempt: success=${overBudget.success}`);
  console.log(`  Reason: ${overBudget.failureReason}`);

  // Demonstrate tool access restriction
  console.log('\n--- Tool Access Inheritance ---\n');
  const toolViolation = spawnMgr.spawn(
    'supervisor',
    'rogue-agent',
    {
      agentId: 'rogue-agent',
      modelBackend: 'mock/model',
      canDo: [],
      requires: [],
      produces: [],
      cost: { inputCostPer1k: 0.001, outputCostPer1k: 0.002, toolCallCost: 0 },
      avgLatencyMs: 100,
      trustScore: 0.9,
    },
    {
      spawnLimit: 1,
      spawnDepth: 1,
      toolAccess: ['web_search', 'dangerous_tool'], // parent doesn't have 'dangerous_tool'
      budgetUsd: 0.1,
      ttlSeconds: 60,
      memoryScope: 'task',
    },
    SpawnType.PERSISTENT
  );
  console.log(`  Rogue tool request: success=${toolViolation.success}`);
  console.log(`  Reason: ${toolViolation.failureReason}`);

  // Active count
  console.log(`\n  Active agents: ${spawnMgr.activeCount}`);

  // Terminate one agent
  spawnMgr.terminate('researcher-market', 'task completed');
  console.log(`  After termination: ${spawnMgr.activeCount} active`);
}

function printSpawnTree(tree: any, depth: number): void {
  const indent = '  '.repeat(depth + 1);
  const prefix = depth === 0 ? '🌳' : '├──';
  console.log(`${indent}${prefix} ${tree.agentId} [budget: $${tree.policy.budgetUsd.toFixed(2)}, ttl: ${tree.policy.ttlSeconds}s]`);
  for (const child of tree.children) {
    printSpawnTree(child, depth + 1);
  }
}

// ─── 5-Agent Pipeline ────────────────────────────────────────────

async function runPipeline(): Promise<{ totalTokens: number; totalLatencyMs: number; totalCostUsd: number }> {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║         Phase 2: 5-Agent Pipeline Execution              ║');
  console.log('║                                                           ║');
  console.log('║  Supervisor → [Market Researcher, Tech Researcher]        ║');
  console.log('║            → Writer → Reviewer + Citation Agent           ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const runtime = new AclRuntime({ verbose: false });

  // ── Create adapters ──

  const marketResearchAdapter = new MockAdapter('openai', 'gpt-4.1', 80);
  marketResearchAdapter.setResponse('research_market', JSON.stringify({
    result: {
      title: 'AI Agent Market Analysis 2026',
      marketSize: '$4.2B projected by 2027',
      growth: '32% CAGR',
      keyPlayers: ['Anthropic', 'OpenAI', 'Google DeepMind', 'Microsoft'],
      trends: [
        'Multi-agent orchestration frameworks gaining traction',
        'Typed communication protocols replacing NL handoffs',
        'Budget-governed agent spawning becoming standard',
      ],
      sources: 12,
    },
    confidence: 0.92,
  }));

  const techResearchAdapter = new MockAdapter('anthropic', 'claude-sonnet-4-6', 70);
  techResearchAdapter.setResponse('research_tech', JSON.stringify({
    result: {
      title: 'Technical Architecture Comparison',
      architectures: {
        'NL-Based': { tokenCost: 'high', reliability: 'medium', latency: 'high' },
        'State-Based (ACL)': { tokenCost: 'low', reliability: 'high', latency: 'low' },
        'RPC-Based': { tokenCost: 'medium', reliability: 'high', latency: 'medium' },
      },
      recommendation: 'State-based ACL approach offers best balance of cost and reliability',
      benchmarks: { aclTokenReduction: '72%', aclLatencyReduction: '65%' },
    },
    confidence: 0.90,
  }));

  const writerAdapter = new MockAdapter('anthropic', 'claude-opus-4-6', 120);
  writerAdapter.setResponse('write_report', JSON.stringify({
    result: {
      title: 'AI Agent Collaboration: Market Landscape & Technical Analysis 2026',
      abstract: 'This report examines the rapidly evolving multi-agent systems market...',
      sections: [
        { heading: 'Executive Summary', wordCount: 250 },
        { heading: 'Market Overview', wordCount: 800 },
        { heading: 'Technical Architecture Analysis', wordCount: 1200 },
        { heading: 'ACL Protocol Deep Dive', wordCount: 600 },
        { heading: 'Recommendations', wordCount: 400 },
      ],
      totalWordCount: 3250,
      readingTime: '13 minutes',
    },
    confidence: 0.91,
  }));

  const reviewerAdapter = new MockAdapter('google', 'gemini-2.5-pro', 60);
  reviewerAdapter.setResponse('review_report', JSON.stringify({
    result: {
      verdict: 'APPROVED_WITH_MINOR_REVISIONS',
      overallScore: 8.7,
      criteria: {
        accuracy: { score: 9.0, notes: 'Market data well-sourced and current' },
        completeness: { score: 8.5, notes: 'Could expand on regulatory considerations' },
        clarity: { score: 8.8, notes: 'Professional tone, well-structured' },
        originality: { score: 8.2, notes: 'Good synthesis of market and technical analysis' },
      },
      revisions: ['Add regulatory landscape section', 'Update Q4 2025 market data'],
    },
    confidence: 0.89,
  }));

  const citationAdapter = new MockAdapter('google', 'gemini-2.5-flash', 40);
  citationAdapter.setResponse('generate_citations', JSON.stringify({
    result: {
      citations: [
        { id: 1, source: 'Gartner Multi-Agent Systems Report 2026', type: 'industry_report' },
        { id: 2, source: 'IEEE Transactions on AI Agent Communication', type: 'academic' },
        { id: 3, source: 'ACL Protocol Specification v0.3', type: 'technical_spec' },
        { id: 4, source: 'Bloomberg AI Market Intelligence', type: 'market_data' },
        { id: 5, source: 'Anthropic Research Blog', type: 'blog' },
      ],
      format: 'APA',
      totalSources: 5,
    },
    confidence: 0.95,
  }));

  // ── Register 5 agents ──

  console.log('--- Registering 5 agents ---\n');

  const agentDefs: Array<{ cap: AgentCapability; adapter: MockAdapter }> = [
    {
      cap: {
        agentId: 'market-researcher',
        modelBackend: 'openai/gpt-4.1',
        canDo: ['research_market'],
        requires: [],
        produces: ['market_research'],
        cost: { inputCostPer1k: 0.0025, outputCostPer1k: 0.01, toolCallCost: 0 },
        avgLatencyMs: 300,
        trustScore: 0.92,
      },
      adapter: marketResearchAdapter,
    },
    {
      cap: {
        agentId: 'tech-researcher',
        modelBackend: 'anthropic/claude-sonnet-4-6',
        canDo: ['research_tech'],
        requires: [],
        produces: ['tech_research'],
        cost: { inputCostPer1k: 0.003, outputCostPer1k: 0.015, toolCallCost: 0 },
        avgLatencyMs: 250,
        trustScore: 0.90,
      },
      adapter: techResearchAdapter,
    },
    {
      cap: {
        agentId: 'report-writer',
        modelBackend: 'anthropic/claude-opus-4-6',
        canDo: ['write_report'],
        requires: ['market_research', 'tech_research'],
        produces: ['draft_report'],
        cost: { inputCostPer1k: 0.015, outputCostPer1k: 0.075, toolCallCost: 0 },
        avgLatencyMs: 500,
        trustScore: 0.95,
      },
      adapter: writerAdapter,
    },
    {
      cap: {
        agentId: 'report-reviewer',
        modelBackend: 'google/gemini-2.5-pro',
        canDo: ['review_report'],
        requires: ['draft_report'],
        produces: ['review_verdict'],
        cost: { inputCostPer1k: 0.00125, outputCostPer1k: 0.005, toolCallCost: 0 },
        avgLatencyMs: 200,
        trustScore: 0.88,
      },
      adapter: reviewerAdapter,
    },
    {
      cap: {
        agentId: 'citation-agent',
        modelBackend: 'google/gemini-2.5-flash',
        canDo: ['generate_citations'],
        requires: ['draft_report'],
        produces: ['citation_list'],
        cost: { inputCostPer1k: 0.0001, outputCostPer1k: 0.0004, toolCallCost: 0 },
        avgLatencyMs: 150,
        trustScore: 0.87,
      },
      adapter: citationAdapter,
    },
  ];

  for (const { cap, adapter } of agentDefs) {
    runtime.registerAgent(cap, adapter);
    console.log(`  ✓ ${cap.agentId} (${cap.modelBackend})`);
  }

  // ── Build Task DAG ──

  console.log('\n--- Building Task DAG ---\n');

  // Two parallel research tasks
  const tMarket = runtime.submitTask({
    packetId: 'task-market-research',
    sourceAgent: 'supervisor',
    targetAgent: 'market-researcher',
    intent: 'research_market',
    inputRefs: [],
    constraints: { topic: 'AI agent collaboration market', depth: 'comprehensive', year: '2026' },
    outputSchema: 'market_research',
    priority: 0.95,
    deadlineMs: 0,
  });

  const tTech = runtime.submitTask({
    packetId: 'task-tech-research',
    sourceAgent: 'supervisor',
    targetAgent: 'tech-researcher',
    intent: 'research_tech',
    inputRefs: [],
    constraints: { topic: 'Agent communication architectures', depth: 'technical' },
    outputSchema: 'tech_research',
    priority: 0.95,
    deadlineMs: 0,
  });

  // Writer depends on both research tasks
  const tWrite = runtime.submitTask(
    {
      packetId: 'task-write-report',
      sourceAgent: 'supervisor',
      targetAgent: 'report-writer',
      intent: 'write_report',
      inputRefs: [],
      constraints: { format: 'full_report', targetLength: '3000_words' },
      outputSchema: 'draft_report',
      priority: 0.9,
      deadlineMs: 0,
    },
    [tMarket.taskId, tTech.taskId]
  );

  // Reviewer and Citation agent depend on writer (parallel)
  const tReview = runtime.submitTask(
    {
      packetId: 'task-review-report',
      sourceAgent: 'supervisor',
      targetAgent: 'report-reviewer',
      intent: 'review_report',
      inputRefs: [],
      constraints: { criteria: 'accuracy,completeness,clarity,originality' },
      outputSchema: 'review_verdict',
      priority: 0.85,
      deadlineMs: 0,
    },
    [tWrite.taskId]
  );

  const tCitation = runtime.submitTask(
    {
      packetId: 'task-citations',
      sourceAgent: 'supervisor',
      targetAgent: 'citation-agent',
      intent: 'generate_citations',
      inputRefs: [],
      constraints: { format: 'APA', minSources: '5' },
      outputSchema: 'citation_list',
      priority: 0.8,
      deadlineMs: 0,
    },
    [tWrite.taskId]
  );

  console.log('  DAG structure:');
  console.log('  ┌─ [market-research] (GPT-4.1)     ─┐');
  console.log('  │                                    ├──→ [write-report] (Claude Opus)');
  console.log('  └─ [tech-research]  (Claude Sonnet) ─┘         │');
  console.log('                                           ┌─────┴─────┐');
  console.log('                                    [review-report]  [citations]');
  console.log('                                    (Gemini Pro)     (Gemini Flash)');

  // ── Execute ──

  console.log('\n--- Executing Pipeline ---\n');

  let totalTokens = 0;
  let totalLatency = 0;
  const costPerToken = 0.000003; // rough average

  // Step 1 & 2: Parallel research (simulated sequential here)
  console.log('  Step 1: Market Research (GPT-4.1)');
  const r1 = await runtime.executeTask('task-market-research', 'market-researcher');
  totalTokens += r1.tokenUsage.totalTokens;
  totalLatency += r1.latencyMs;
  console.log(`    ✓ Tokens: ${r1.tokenUsage.totalTokens} | Latency: ${r1.latencyMs}ms`);

  console.log('  Step 2: Tech Research (Claude Sonnet)');
  const r2 = await runtime.executeTask('task-tech-research', 'tech-researcher');
  totalTokens += r2.tokenUsage.totalTokens;
  totalLatency += r2.latencyMs;
  console.log(`    ✓ Tokens: ${r2.tokenUsage.totalTokens} | Latency: ${r2.latencyMs}ms`);

  console.log('  Step 3: Write Report (Claude Opus)');
  const r3 = await runtime.executeTask('task-write-report', 'report-writer');
  totalTokens += r3.tokenUsage.totalTokens;
  totalLatency += r3.latencyMs;
  console.log(`    ✓ Tokens: ${r3.tokenUsage.totalTokens} | Latency: ${r3.latencyMs}ms`);

  console.log('  Step 4: Review Report (Gemini Pro)');
  const r4 = await runtime.executeTask('task-review-report', 'report-reviewer');
  totalTokens += r4.tokenUsage.totalTokens;
  totalLatency += r4.latencyMs;
  console.log(`    ✓ Tokens: ${r4.tokenUsage.totalTokens} | Latency: ${r4.latencyMs}ms`);

  console.log('  Step 5: Generate Citations (Gemini Flash)');
  const r5 = await runtime.executeTask('task-citations', 'citation-agent');
  totalTokens += r5.tokenUsage.totalTokens;
  totalLatency += r5.latencyMs;
  console.log(`    ✓ Tokens: ${r5.tokenUsage.totalTokens} | Latency: ${r5.latencyMs}ms`);

  // ── Pipeline Summary ──

  const stats = runtime.stats();
  const events = runtime.getEventHistory();
  const totalCostUsd = totalTokens * costPerToken;

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║               Pipeline Execution Summary                  ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Tasks:        ${stats.completedTasks}/${stats.totalTasks} completed`);
  console.log(`║  Agents:       ${stats.registeredAgents} (4 different models)`);
  console.log(`║  Total Tokens: ${totalTokens}`);
  console.log(`║  Total Latency:${totalLatency}ms`);
  console.log(`║  Est. Cost:    $${totalCostUsd.toFixed(4)}`);
  console.log(`║  Artifacts:    ${stats.totalArtifacts}`);
  console.log(`║  Events:       ${stats.totalEvents}`);
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║  Event Timeline:');
  const eventTypes = new Map<string, number>();
  for (const event of events) {
    const type = EventType[event.eventType] ?? 'UNKNOWN';
    eventTypes.set(type, (eventTypes.get(type) ?? 0) + 1);
  }
  for (const [type, count] of eventTypes) {
    console.log(`║    ${type.padEnd(24)} × ${count}`);
  }
  console.log('╚══════════════════════════════════════════════════════════╝');

  return { totalTokens, totalLatencyMs: totalLatency, totalCostUsd };
}

// ─── Benchmark Comparison ────────────────────────────────────────

function runBenchmark(pipelineResults: { totalTokens: number; totalLatencyMs: number; totalCostUsd: number }): void {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║       Phase 3: ACL vs NL Baseline Benchmark              ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const steps = 5; // 5 handoffs in pipeline

  // ACL metrics from actual pipeline execution
  const aclMetrics: BenchmarkMetrics = {
    approach: 'ACL',
    totalTokens: pipelineResults.totalTokens,
    tokensPerHandoff: Math.round(pipelineResults.totalTokens / steps),
    totalLatencyMs: pipelineResults.totalLatencyMs,
    avgLatencyPerStep: Math.round(pipelineResults.totalLatencyMs / steps),
    totalCostUsd: pipelineResults.totalCostUsd,
    completionRate: 1.0,     // All 5 tasks succeeded
    retrySuccessRate: 1.0,   // No retries needed
    stepsCompleted: steps,
    totalSteps: steps,
  };

  // Simulate NL baseline
  const nlMetrics = simulateNlBaseline(aclMetrics, steps);

  // Compare
  const comparison = compareBenchmarks(aclMetrics, nlMetrics);

  // Print report
  console.log(formatBenchmarkReport(comparison));

  // Additional analysis
  console.log('\n--- Analysis ---\n');
  console.log(`  ACL transmitted ${aclMetrics.tokensPerHandoff} tokens per handoff (typed packets)`);
  console.log(`  NL baseline would need ~${nlMetrics.tokensPerHandoff} tokens per handoff (full context)`);
  console.log(`  Token reduction: ${comparison.tokenSavingsPercent}%`);
  console.log(`  Latency reduction: ${comparison.latencyReductionPercent}%`);
  console.log(`  Cost reduction: ${comparison.costReductionPercent}%`);
  console.log(`\n  ACL completion rate: ${(aclMetrics.completionRate * 100).toFixed(0)}%`);
  console.log(`  NL baseline completion rate: ${(nlMetrics.completionRate * 100).toFixed(0)}%`);
  console.log('  (NL pipelines degrade significantly at 5+ handoffs due to context loss)\n');
}

// ─── Main ────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n' + '═'.repeat(60));
  console.log('  ACL End-to-End Demo: 5-Agent Market Analysis Pipeline');
  console.log('  Spawn Governance + DAG Execution + Benchmark');
  console.log('═'.repeat(60));

  // Phase 1: Spawn governance demonstration
  demoSpawnGovernance();

  // Phase 2: Full 5-agent pipeline execution
  const pipelineResults = await runPipeline();

  // Phase 3: Benchmark comparison
  runBenchmark(pipelineResults);

  console.log('═'.repeat(60));
  console.log('  End-to-End demo complete.');
  console.log('  All communication used typed ACL packets — no NL between agents.');
  console.log('═'.repeat(60) + '\n');
}

main().catch(console.error);
