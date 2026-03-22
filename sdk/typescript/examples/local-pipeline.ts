/**
 * ACL Local Pipeline Demo (No API Keys Required)
 *
 * Demonstrates ACL's typed state transition workflow using mock adapters.
 * Perfect for testing the SDK without API keys.
 *
 * Usage:
 *   npx ts-node examples/local-pipeline.ts
 */

import {
  AclRuntime,
  AgentCapability,
  ActionPacket,
  ModelAdapter,
  AdapterConfig,
  TaskExecutionInput,
  TaskExecutionOutput,
  TaskState,
  EventType,
} from '../src';

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

  /**
   * Pre-configure a response for a specific intent
   */
  setResponse(intent: string, content: string): void {
    this.mockResponses.set(intent, content);
  }

  async executeTask(input: TaskExecutionInput): Promise<TaskExecutionOutput> {
    // Simulate network latency
    await new Promise((resolve) => setTimeout(resolve, this.latencyMs));

    const intent = input.task.intent;
    const mockContent = this.mockResponses.get(intent) ?? JSON.stringify({
      result: `Mock ${intent} output from ${this.modelBackend}`,
      confidence: 0.85,
      reasoning: `Simulated execution of ${intent} task`,
    });

    // Simulate token counting
    const inputTokens = Math.ceil(JSON.stringify(input).length / 4);
    const outputTokens = Math.ceil(mockContent.length / 4);

    return {
      success: true,
      content: mockContent,
      artifactType: input.task.outputSchema,
      confidence: 0.85,
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

// ─── Main ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║     ACL Local Pipeline Demo (No API Keys Needed)        ║');
  console.log('║                                                          ║');
  console.log('║   Mock GPT-4o → Mock Claude → Mock Gemini                ║');
  console.log('║   Full typed state transition workflow                    ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const runtime = new AclRuntime({ verbose: true });

  // ─── Create Mock Adapters ─────────────────────────────────────

  const mockGpt = new MockAdapter('openai', 'gpt-4.1', 50);
  mockGpt.setResponse('research', JSON.stringify({
    result: {
      title: 'AI Agent Collaboration Market Analysis 2026',
      findings: [
        'Multi-agent systems market projected at $4.2B by 2027',
        'State-based communication reduces token costs by 70%',
        'ACL-style protocols gaining industry adoption',
      ],
      sources: 5,
    },
    confidence: 0.91,
    reasoning: 'Comprehensive analysis of available market data',
  }));

  const mockClaude = new MockAdapter('anthropic', 'claude-sonnet-4-6', 40);
  mockClaude.setResponse('write', JSON.stringify({
    result: {
      title: 'Executive Summary: AI Agent Collaboration 2026',
      body: 'The multi-agent systems market is experiencing rapid growth, driven by increasing demand for automated workflows...',
      wordCount: 480,
      sections: ['Market Overview', 'Key Trends', 'Recommendations'],
    },
    confidence: 0.88,
    reasoning: 'Synthesized research findings into executive summary format',
  }));

  const mockGemini = new MockAdapter('google', 'gemini-2.5-flash', 30);
  mockGemini.setResponse('review', JSON.stringify({
    result: {
      verdict: 'APPROVED',
      score: 8.5,
      feedback: {
        accuracy: 'High - claims supported by research data',
        completeness: 'Good - covers key market segments',
        clarity: 'Excellent - professional tone maintained',
      },
      suggestions: ['Consider adding regional breakdown'],
    },
    confidence: 0.89,
    reasoning: 'Evaluated against accuracy, completeness, and clarity criteria',
  }));

  // ─── Register Agents ──────────────────────────────────────────

  console.log('=== Agent Registration ===\n');

  runtime.registerAgent(
    {
      agentId: 'researcher',
      modelBackend: 'openai/gpt-4.1',
      canDo: ['research', 'summarize'],
      requires: [],
      produces: ['research_report'],
      cost: { inputCostPer1k: 0.0025, outputCostPer1k: 0.01, toolCallCost: 0 },
      avgLatencyMs: 300,
      trustScore: 0.9,
    },
    mockGpt
  );

  runtime.registerAgent(
    {
      agentId: 'writer',
      modelBackend: 'anthropic/claude-sonnet-4-6',
      canDo: ['write', 'edit'],
      requires: ['research_report'],
      produces: ['final_document'],
      cost: { inputCostPer1k: 0.003, outputCostPer1k: 0.015, toolCallCost: 0 },
      avgLatencyMs: 250,
      trustScore: 0.92,
    },
    mockClaude
  );

  runtime.registerAgent(
    {
      agentId: 'reviewer',
      modelBackend: 'google/gemini-2.5-flash',
      canDo: ['review', 'fact_check'],
      requires: ['final_document'],
      produces: ['review_verdict'],
      cost: { inputCostPer1k: 0.0001, outputCostPer1k: 0.0004, toolCallCost: 0 },
      avgLatencyMs: 200,
      trustScore: 0.88,
    },
    mockGemini
  );

  // ─── Build Task DAG ───────────────────────────────────────────

  console.log('\n=== Task Graph Construction ===\n');

  const t1 = runtime.submitTask({
    packetId: 'task-research',
    sourceAgent: 'supervisor',
    targetAgent: 'researcher',
    intent: 'research',
    inputRefs: [],
    constraints: { topic: 'AI agent collaboration 2026', depth: 'comprehensive' },
    outputSchema: 'research_report',
    priority: 0.9,
    deadlineMs: 0,
  });

  const t2 = runtime.submitTask(
    {
      packetId: 'task-write',
      sourceAgent: 'supervisor',
      targetAgent: 'writer',
      intent: 'write',
      inputRefs: [],
      constraints: { format: 'executive_summary', length: '500_words' },
      outputSchema: 'final_document',
      priority: 0.8,
      deadlineMs: 0,
    },
    [t1.taskId]
  );

  const t3 = runtime.submitTask(
    {
      packetId: 'task-review',
      sourceAgent: 'supervisor',
      targetAgent: 'reviewer',
      intent: 'review',
      inputRefs: [],
      constraints: { criteria: 'accuracy,completeness,clarity' },
      outputSchema: 'review_verdict',
      priority: 0.7,
      deadlineMs: 0,
    },
    [t2.taskId]
  );

  console.log(`  DAG: [${t1.taskId}] ──→ [${t2.taskId}] ──→ [${t3.taskId}]\n`);

  // ─── Execute Pipeline ─────────────────────────────────────────

  console.log('=== Pipeline Execution ===\n');

  let totalTokens = 0;
  let totalLatency = 0;

  // Step 1: Research
  console.log('--- Step 1: Research (Mock GPT-4o) ---');
  const r1 = await runtime.executeTask('task-research', 'researcher');
  totalTokens += r1.tokenUsage.totalTokens;
  totalLatency += r1.latencyMs;
  console.log(`  Tokens: ${r1.tokenUsage.totalTokens} | Latency: ${r1.latencyMs}ms | Confidence: ${r1.confidence}\n`);

  // Step 2: Write
  console.log('--- Step 2: Write (Mock Claude Sonnet) ---');
  const r2 = await runtime.executeTask('task-write', 'writer');
  totalTokens += r2.tokenUsage.totalTokens;
  totalLatency += r2.latencyMs;
  console.log(`  Tokens: ${r2.tokenUsage.totalTokens} | Latency: ${r2.latencyMs}ms | Confidence: ${r2.confidence}\n`);

  // Step 3: Review
  console.log('--- Step 3: Review (Mock Gemini Flash) ---');
  const r3 = await runtime.executeTask('task-review', 'reviewer');
  totalTokens += r3.tokenUsage.totalTokens;
  totalLatency += r3.latencyMs;
  console.log(`  Tokens: ${r3.tokenUsage.totalTokens} | Latency: ${r3.latencyMs}ms | Confidence: ${r3.confidence}\n`);

  // ─── Results ──────────────────────────────────────────────────

  const stats = runtime.stats();
  const events = runtime.getEventHistory();

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║                  Pipeline Complete                       ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Tasks:     ${stats.completedTasks}/${stats.totalTasks} completed`);
  console.log(`║  Agents:    ${stats.registeredAgents} (3 different models)`);
  console.log(`║  Tokens:    ${totalTokens} total`);
  console.log(`║  Latency:   ${totalLatency}ms total`);
  console.log(`║  Artifacts: ${stats.totalArtifacts}`);
  console.log(`║  Events:    ${stats.totalEvents}`);
  console.log('╠══════════════════════════════════════════════════════════╣');

  // Show event timeline
  console.log('║  Event Timeline:');
  for (const event of events) {
    const type = EventType[event.eventType] ?? 'UNKNOWN';
    console.log(`║    ${type.padEnd(16)} from ${event.source}`);
  }

  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log('║  All communication: typed ActionPackets + StateUpdates   ║');
  console.log('║  NL used only inside adapter ↔ LLM boundary             ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
}

main().catch(console.error);
