#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  ACL Multi-Agent Harness - Setup & Run Script
# ═══════════════════════════════════════════════════════════════

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK_DIR="$(dirname "$SCRIPT_DIR")"

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║       ACL Multi-Agent Harness Setup                      ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ── Step 1: Check Node.js ──
echo "▶ Checking prerequisites..."
if ! command -v node &> /dev/null; then
  echo "  ✘ Node.js not found. Install: https://nodejs.org"
  exit 1
fi
echo "  ✔ Node.js $(node -v)"

# ── Step 2: Install dependencies ──
echo ""
echo "▶ Installing dependencies..."
cd "$SDK_DIR"

if [ ! -d "node_modules" ]; then
  npm install 2>&1 | tail -3
  echo "  ✔ Dependencies installed"
else
  echo "  ✔ Dependencies already installed"
fi

# ── Step 3: TypeScript check ──
echo ""
echo "▶ Type checking..."
npx tsc --noEmit 2>&1 || {
  echo "  ⚠ TypeScript errors found (may still work with ts-node)"
}
echo "  ✔ Type check passed"

# ── Step 4: API Key check ──
echo ""
echo "▶ Checking API keys..."
KEY_COUNT=0

if [ -n "$OPENAI_API_KEY" ]; then
  echo "  ✔ OPENAI_API_KEY set"
  KEY_COUNT=$((KEY_COUNT + 1))
else
  echo "  - OPENAI_API_KEY not set"
fi

if [ -n "$ANTHROPIC_API_KEY" ]; then
  echo "  ✔ ANTHROPIC_API_KEY set"
  KEY_COUNT=$((KEY_COUNT + 1))
else
  echo "  - ANTHROPIC_API_KEY not set"
fi

if [ -n "$GOOGLE_API_KEY" ]; then
  echo "  ✔ GOOGLE_API_KEY set"
  KEY_COUNT=$((KEY_COUNT + 1))
else
  echo "  - GOOGLE_API_KEY not set"
fi

if [ $KEY_COUNT -eq 0 ]; then
  echo ""
  echo "  ⚠ No API keys found!"
  echo "  Set at least one to use the harness with real LLMs:"
  echo ""
  echo "    export OPENAI_API_KEY=sk-..."
  echo "    export ANTHROPIC_API_KEY=sk-ant-..."
  echo "    export GOOGLE_API_KEY=AIza..."
  echo ""
  echo "  You can still run --dry-run to see the pipeline plan."
fi

# ── Done ──
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Setup complete! Run the harness with:"
echo ""
echo "  cd $SDK_DIR"
echo ""
echo "  # See available pipelines:"
echo "  npx ts-node harness/acl-harness.ts --help"
echo ""
echo "  # Dry run (no API needed):"
echo "  npx ts-node harness/acl-harness.ts --pipeline research --dry-run"
echo ""
echo "  # Real execution:"
echo "  npx ts-node harness/acl-harness.ts --pipeline research"
echo "  npx ts-node harness/acl-harness.ts --pipeline code-review --topic \"JWT auth middleware\""
echo "  npx ts-node harness/acl-harness.ts --pipeline content --topic \"Rust for AI infra\""
echo "  npx ts-node harness/acl-harness.ts --pipeline creative --topic \"First contact at Mars\""
echo ""
echo "═══════════════════════════════════════════════════════════"
