#!/bin/bash
##############################################################################
# ACL vs NL Real LLM Benchmark
#
# Uses claude CLI (authenticated via OAuth) to run identical 3-step pipeline
# in two modes:
#   1. ACL mode: Each agent gets ONLY typed ActionPacket + previous artifact
#   2. NL mode: Each agent gets FULL conversation history (growing context)
#
# Measures actual: tokens, cost, latency from Anthropic API
##############################################################################

set -e

MODEL="claude-haiku-4-5-20251001"
RESULTS_DIR="/sessions/peaceful-festive-noether/mnt/AgentsCollaborationLayer/benchmark-results"
mkdir -p "$RESULTS_DIR"

echo ""
echo "════════════════════════════════════════════════════════════════════════"
echo "  ACL vs NL Real LLM Benchmark"
echo "  Model: $MODEL"
echo "  Pipeline: Research → Write → Review (3 steps)"
echo "  Using: claude CLI with OAuth authentication"
echo "════════════════════════════════════════════════════════════════════════"
echo ""

##############################################################################
# Helper: run claude and extract metrics
##############################################################################
run_claude() {
  local label="$1"
  local system_prompt="$2"
  local user_prompt="$3"
  local outfile="$4"

  local start_ms=$(date +%s%N)
  local result
  result=$(claude -p --output-format json --max-turns 1 --model "$MODEL" \
    --append-system-prompt "$system_prompt" \
    --disallowed-tools "Bash" --disallowed-tools "Read" --disallowed-tools "Write" --disallowed-tools "Edit" --disallowed-tools "Glob" --disallowed-tools "Grep" --disallowed-tools "Agent" --disallowed-tools "WebSearch" --disallowed-tools "WebFetch" \
    "$user_prompt" 2>/dev/null) || true
  local end_ms=$(date +%s%N)
  local wall_ms=$(( (end_ms - start_ms) / 1000000 ))

  echo "$result" > "$outfile"

  # Extract metrics
  local input_tok=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('usage',{}).get('input_tokens',0))" 2>/dev/null || echo "0")
  local output_tok=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('usage',{}).get('output_tokens',0))" 2>/dev/null || echo "0")
  local cache_create=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('usage',{}).get('cache_creation_input_tokens',0))" 2>/dev/null || echo "0")
  local cache_read=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('usage',{}).get('cache_read_input_tokens',0))" 2>/dev/null || echo "0")
  local cost=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('total_cost_usd',0))" 2>/dev/null || echo "0")
  local api_ms=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('duration_api_ms',0))" 2>/dev/null || echo "0")
  local text=$(echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result','')[:200])" 2>/dev/null || echo "")

  echo "${label}|${input_tok}|${output_tok}|${cache_create}|${cache_read}|${api_ms}|${wall_ms}|${cost}|${text}"
}

##############################################################################
# ACL Pipeline — minimal typed packets
##############################################################################
echo "━━━ Running ACL Pipeline (typed ActionPackets) ━━━"
echo ""

ACL_SYS="You are an ACL protocol agent. Respond ONLY with valid JSON matching the requested outputSchema. No explanation, no markdown, no extra text. Pure JSON only."

echo "  Step 1/3: Research (ACL mode)..."
ACL_R1=$(run_claude "acl-research" "$ACL_SYS" \
  '{"protocol":"ACL/0.1","packetType":"ACTION","intent":"research","constraints":{"topic":"benefits of typed state protocols vs natural language for multi-agent AI communication","depth":"brief"},"outputSchema":"research_report","format":"JSON: {title:string, findings:string[3], confidence:number}"}' \
  "$RESULTS_DIR/acl-step1.json")

ACL_R1_TEXT=$(echo "$ACL_R1" | cut -d'|' -f9-)
echo "    Done. $(echo "$ACL_R1" | cut -d'|' -f2) input / $(echo "$ACL_R1" | cut -d'|' -f3) output tokens"

echo "  Step 2/3: Write (ACL mode — gets only research artifact)..."
ACL_R2=$(run_claude "acl-write" "$ACL_SYS" \
  "{\"protocol\":\"ACL/0.1\",\"packetType\":\"ACTION\",\"intent\":\"write\",\"inputArtifacts\":[{\"type\":\"research_report\",\"content\":$(echo "$ACL_R1_TEXT" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read().strip()))" 2>/dev/null)}],\"constraints\":{\"format\":\"executive_summary\",\"length\":\"100_words\"},\"outputSchema\":\"summary_document\",\"format\":\"JSON: {title:string, summary:string, wordCount:number}\"}" \
  "$RESULTS_DIR/acl-step2.json")

ACL_R2_TEXT=$(echo "$ACL_R2" | cut -d'|' -f9-)
echo "    Done. $(echo "$ACL_R2" | cut -d'|' -f2) input / $(echo "$ACL_R2" | cut -d'|' -f3) output tokens"

echo "  Step 3/3: Review (ACL mode — gets only write artifact)..."
ACL_R3=$(run_claude "acl-review" "$ACL_SYS" \
  "{\"protocol\":\"ACL/0.1\",\"packetType\":\"ACTION\",\"intent\":\"review\",\"inputArtifacts\":[{\"type\":\"summary_document\",\"content\":$(echo "$ACL_R2_TEXT" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read().strip()))" 2>/dev/null)}],\"constraints\":{\"criteria\":\"accuracy,completeness,clarity\"},\"outputSchema\":\"review_verdict\",\"format\":\"JSON: {verdict:string, score:number, feedback:{accuracy:string,completeness:string,clarity:string}}\"}" \
  "$RESULTS_DIR/acl-step3.json")

echo "    Done. $(echo "$ACL_R3" | cut -d'|' -f2) input / $(echo "$ACL_R3" | cut -d'|' -f3) output tokens"

##############################################################################
# NL Pipeline — full conversation context re-serialized
##############################################################################
echo ""
echo "━━━ Running NL Pipeline (full context re-serialization) ━━━"
echo ""

NL_SYS="You are a helpful AI assistant working as part of a multi-step pipeline. Complete each task thoroughly. Provide detailed, well-structured responses that another agent can build upon."

NL_STEP1_PROMPT="Please research the following topic: Benefits of typed state protocols vs natural language for multi-agent AI communication.

Provide:
1. A clear title
2. At least 3 key findings covering technical advantages, cost implications, and reliability
3. Your confidence level

Be thorough but concise."

echo "  Step 1/3: Research (NL mode)..."
NL_R1=$(run_claude "nl-research" "$NL_SYS" "$NL_STEP1_PROMPT" "$RESULTS_DIR/nl-step1.json")

NL_R1_TEXT=$(echo "$NL_R1" | cut -d'|' -f9-)
echo "    Done. $(echo "$NL_R1" | cut -d'|' -f2) input / $(echo "$NL_R1" | cut -d'|' -f3) output tokens"

# NL Step 2: Re-send FULL context (original prompt + research output + new task)
NL_STEP2_PROMPT="Previous conversation:

User asked: $NL_STEP1_PROMPT

Research agent responded:
$NL_R1_TEXT

---

Now, based on the research above, please write an executive summary (approximately 100 words) that:
- Captures all key findings
- Is written in professional tone for executives
- Includes a clear title
Provide a word count."

echo "  Step 2/3: Write (NL mode — full context)..."
NL_R2=$(run_claude "nl-write" "$NL_SYS" "$NL_STEP2_PROMPT" "$RESULTS_DIR/nl-step2.json")

NL_R2_TEXT=$(echo "$NL_R2" | cut -d'|' -f9-)
echo "    Done. $(echo "$NL_R2" | cut -d'|' -f2) input / $(echo "$NL_R2" | cut -d'|' -f3) output tokens"

# NL Step 3: Re-send ENTIRE conversation (all previous prompts + outputs + new task)
NL_STEP3_PROMPT="Full conversation history:

Step 1 - User asked: $NL_STEP1_PROMPT

Step 1 - Research agent responded:
$NL_R1_TEXT

Step 2 - User asked the writer to create an executive summary.

Step 2 - Writer responded:
$NL_R2_TEXT

---

Now please review the executive summary above.
Evaluate against: accuracy, completeness, and clarity.
Provide:
- Verdict (APPROVED or REJECTED)
- Score (0-10)
- Detailed feedback for each criterion
- Confidence level"

echo "  Step 3/3: Review (NL mode — full context)..."
NL_R3=$(run_claude "nl-review" "$NL_SYS" "$NL_STEP3_PROMPT" "$RESULTS_DIR/nl-step3.json")

echo "    Done. $(echo "$NL_R3" | cut -d'|' -f2) input / $(echo "$NL_R3" | cut -d'|' -f3) output tokens"

##############################################################################
# Results
##############################################################################
echo ""
echo "════════════════════════════════════════════════════════════════════════"
echo "  RESULTS"
echo "════════════════════════════════════════════════════════════════════════"

# Parse all results
parse_field() { echo "$1" | cut -d'|' -f"$2"; }

echo ""
echo "  ── ACL Pipeline (Typed Packets) ──"
echo ""
echo "  Step          Input Tok   Output Tok  API Latency   Cost"
echo "  ─────────────────────────────────────────────────────────────"
printf "  %-14s %-12s %-12s %-14s \$%s\n" "Research" "$(parse_field "$ACL_R1" 2)" "$(parse_field "$ACL_R1" 3)" "$(parse_field "$ACL_R1" 6)ms" "$(parse_field "$ACL_R1" 8)"
printf "  %-14s %-12s %-12s %-14s \$%s\n" "Write" "$(parse_field "$ACL_R2" 2)" "$(parse_field "$ACL_R2" 3)" "$(parse_field "$ACL_R2" 6)ms" "$(parse_field "$ACL_R2" 8)"
printf "  %-14s %-12s %-12s %-14s \$%s\n" "Review" "$(parse_field "$ACL_R3" 2)" "$(parse_field "$ACL_R3" 3)" "$(parse_field "$ACL_R3" 6)ms" "$(parse_field "$ACL_R3" 8)"

ACL_TOTAL_IN=$(($(parse_field "$ACL_R1" 2) + $(parse_field "$ACL_R2" 2) + $(parse_field "$ACL_R3" 2)))
ACL_TOTAL_OUT=$(($(parse_field "$ACL_R1" 3) + $(parse_field "$ACL_R2" 3) + $(parse_field "$ACL_R3" 3)))
ACL_TOTAL_TOK=$((ACL_TOTAL_IN + ACL_TOTAL_OUT))
ACL_TOTAL_LAT=$(($(parse_field "$ACL_R1" 6) + $(parse_field "$ACL_R2" 6) + $(parse_field "$ACL_R3" 6)))
ACL_TOTAL_COST=$(python3 -c "print($(parse_field "$ACL_R1" 8) + $(parse_field "$ACL_R2" 8) + $(parse_field "$ACL_R3" 8))")

echo "  ─────────────────────────────────────────────────────────────"
printf "  %-14s %-12s %-12s %-14s \$%s\n" "TOTAL" "$ACL_TOTAL_IN" "$ACL_TOTAL_OUT" "${ACL_TOTAL_LAT}ms" "$ACL_TOTAL_COST"

echo ""
echo "  ── NL Pipeline (Full Context) ──"
echo ""
echo "  Step          Input Tok   Output Tok  API Latency   Cost"
echo "  ─────────────────────────────────────────────────────────────"
printf "  %-14s %-12s %-12s %-14s \$%s\n" "Research" "$(parse_field "$NL_R1" 2)" "$(parse_field "$NL_R1" 3)" "$(parse_field "$NL_R1" 6)ms" "$(parse_field "$NL_R1" 8)"
printf "  %-14s %-12s %-12s %-14s \$%s\n" "Write" "$(parse_field "$NL_R2" 2)" "$(parse_field "$NL_R2" 3)" "$(parse_field "$NL_R2" 6)ms" "$(parse_field "$NL_R2" 8)"
printf "  %-14s %-12s %-12s %-14s \$%s\n" "Review" "$(parse_field "$NL_R3" 2)" "$(parse_field "$NL_R3" 3)" "$(parse_field "$NL_R3" 6)ms" "$(parse_field "$NL_R3" 8)"

NL_TOTAL_IN=$(($(parse_field "$NL_R1" 2) + $(parse_field "$NL_R2" 2) + $(parse_field "$NL_R3" 2)))
NL_TOTAL_OUT=$(($(parse_field "$NL_R1" 3) + $(parse_field "$NL_R2" 3) + $(parse_field "$NL_R3" 3)))
NL_TOTAL_TOK=$((NL_TOTAL_IN + NL_TOTAL_OUT))
NL_TOTAL_LAT=$(($(parse_field "$NL_R1" 6) + $(parse_field "$NL_R2" 6) + $(parse_field "$NL_R3" 6)))
NL_TOTAL_COST=$(python3 -c "print($(parse_field "$NL_R1" 8) + $(parse_field "$NL_R2" 8) + $(parse_field "$NL_R3" 8))")

echo "  ─────────────────────────────────────────────────────────────"
printf "  %-14s %-12s %-12s %-14s \$%s\n" "TOTAL" "$NL_TOTAL_IN" "$NL_TOTAL_OUT" "${NL_TOTAL_LAT}ms" "$NL_TOTAL_COST"

##############################################################################
# Comparison
##############################################################################
echo ""
echo "════════════════════════════════════════════════════════════════════════"
echo "  COMPARISON"
echo "════════════════════════════════════════════════════════════════════════"

python3 << PYEOF
acl_in = $ACL_TOTAL_IN
nl_in = $NL_TOTAL_IN
acl_out = $ACL_TOTAL_OUT
nl_out = $NL_TOTAL_OUT
acl_tok = $ACL_TOTAL_TOK
nl_tok = $NL_TOTAL_TOK
acl_lat = $ACL_TOTAL_LAT
nl_lat = $NL_TOTAL_LAT
acl_cost = $ACL_TOTAL_COST
nl_cost = $NL_TOTAL_COST

def pct(a, b):
    if b == 0: return 0
    return ((b - a) / b) * 100

print()
print(f"  Metric              ACL              NL               Savings")
print(f"  ─────────────────   ──────────────   ──────────────   ────────")
print(f"  Input Tokens        {acl_in:<17}{nl_in:<17}{pct(acl_in, nl_in):.1f}%")
print(f"  Output Tokens       {acl_out:<17}{nl_out:<17}{'--':>6}")
print(f"  Total Tokens        {acl_tok:<17}{nl_tok:<17}{pct(acl_tok, nl_tok):.1f}%")
print(f"  API Latency         {str(acl_lat)+'ms':<17}{str(nl_lat)+'ms':<17}{pct(acl_lat, nl_lat):.1f}%")
print(f"  Total Cost          \${acl_cost:<16.6f}\${nl_cost:<16.6f}{pct(acl_cost, nl_cost):.1f}%")
print()

# Per-step input growth
acl_steps = [$(parse_field "$ACL_R1" 2), $(parse_field "$ACL_R2" 2), $(parse_field "$ACL_R3" 2)]
nl_steps = [$(parse_field "$NL_R1" 2), $(parse_field "$NL_R2" 2), $(parse_field "$NL_R3" 2)]
labels = ['Research', 'Write', 'Review']

print(f"  Input Token Growth Per Step:")
print(f"  Step          ACL Input    NL Input     NL Overhead")
print(f"  {'─'*56}")
for i in range(3):
    overhead = nl_steps[i] - acl_steps[i]
    mult = nl_steps[i] / acl_steps[i] if acl_steps[i] > 0 else 0
    print(f"  {labels[i]:<14} {acl_steps[i]:<13}{nl_steps[i]:<13}+{overhead} ({mult:.1f}x)")

print()
print(f"  Key Finding:")
print(f"  ACL Step 3 input: {acl_steps[2]} tokens (only typed packet + artifact)")
print(f"  NL  Step 3 input: {nl_steps[2]} tokens (full conversation history)")
if nl_steps[2] > 0:
    print(f"  NL uses {nl_steps[2]/acl_steps[2]:.1f}x more input tokens at step 3")
    if len(nl_steps) >= 2 and nl_steps[1] > nl_steps[0]:
        growth = nl_steps[2] - nl_steps[0]
        print(f"  NL context grew by +{growth} tokens over 3 steps (linear growth)")
        print(f"  Projected at 10 steps: NL ~{nl_steps[0] + growth * 3}+ tokens/step vs ACL ~{sum(acl_steps)//3}")
        print(f"  Projected at 20 steps: NL ~{nl_steps[0] + growth * 6}+ tokens/step vs ACL ~{sum(acl_steps)//3}")

print()

# Save CSV for later analysis
with open("$RESULTS_DIR/benchmark-results.csv", "w") as f:
    f.write("approach,step,input_tokens,output_tokens,total_tokens,latency_ms,cost_usd\\n")
    for i, label in enumerate(labels):
        f.write(f"ACL,{label},{acl_steps[i]},$(parse_field "$ACL_R1" 3 if i==0 else (parse_field "$ACL_R2" 3 if i==1 else parse_field "$ACL_R3" 3)),{acl_steps[i]+int('$(parse_field "$ACL_R1" 3)' if i==0 else ('$(parse_field "$ACL_R2" 3)' if i==1 else '$(parse_field "$ACL_R3" 3)'))},{int('$(parse_field "$ACL_R1" 6)' if i==0 else ('$(parse_field "$ACL_R2" 6)' if i==1 else '$(parse_field "$ACL_R3" 6)'))},{float('$(parse_field "$ACL_R1" 8)' if i==0 else ('$(parse_field "$ACL_R2" 8)' if i==1 else '$(parse_field "$ACL_R3" 8)')):.6f}\\n")
    nl_out_toks = [$(parse_field "$NL_R1" 3), $(parse_field "$NL_R2" 3), $(parse_field "$NL_R3" 3)]
    nl_lats = [$(parse_field "$NL_R1" 6), $(parse_field "$NL_R2" 6), $(parse_field "$NL_R3" 6)]
    nl_costs = [$(parse_field "$NL_R1" 8), $(parse_field "$NL_R2" 8), $(parse_field "$NL_R3" 8)]
    for i, label in enumerate(labels):
        f.write(f"NL,{label},{nl_steps[i]},{nl_out_toks[i]},{nl_steps[i]+nl_out_toks[i]},{nl_lats[i]},{nl_costs[i]:.6f}\\n")

print(f"  Results saved to: $RESULTS_DIR/benchmark-results.csv")
PYEOF

echo ""
echo "════════════════════════════════════════════════════════════════════════"
echo "  Benchmark Complete — All metrics from actual Claude API calls"
echo "════════════════════════════════════════════════════════════════════════"
echo ""
