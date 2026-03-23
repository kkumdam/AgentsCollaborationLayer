#!/usr/bin/env bash
# ACL Server Management Script
# Usage:
#   ./manage_server.sh start [--release]   Start the ACL gRPC server
#   ./manage_server.sh stop                Stop the server
#   ./manage_server.sh status              Check server status
#   ./manage_server.sh logs [N]            Show last N lines of logs (default: 50)
#   ./manage_server.sh build               Build the project
#   ./manage_server.sh demo                Run the demo pipeline
#   ./manage_server.sh gen-proto           Generate Python gRPC bindings

set -euo pipefail

# Find the ACL project root (navigate up from scripts dir)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The skill is at .skills/acl/scripts/, project root is 3 levels up
ACL_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
LOG_FILE="/tmp/acl-server.log"
PID_FILE="/tmp/acl-server.pid"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info()  { echo -e "${GREEN}[ACL]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[ACL]${NC} $1"; }
log_error() { echo -e "${RED}[ACL]${NC} $1"; }

check_deps() {
    local missing=()
    command -v cargo >/dev/null 2>&1 || missing+=("cargo (Rust)")
    command -v protoc >/dev/null 2>&1 || missing+=("protoc (Protocol Buffers)")

    if [ ${#missing[@]} -gt 0 ]; then
        log_error "Missing dependencies: ${missing[*]}"
        echo ""
        echo "Install Rust:    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"
        echo "Install protoc:  apt-get install -y protobuf-compiler"
        return 1
    fi
    return 0
}

cmd_build() {
    check_deps || exit 1
    log_info "Building ACL project..."
    cd "$ACL_ROOT"
    cargo build --release 2>&1
    log_info "Build complete. Binaries in $ACL_ROOT/target/release/"
}

cmd_start() {
    if cmd_is_running; then
        log_warn "Server is already running (PID: $(cat "$PID_FILE"))"
        return 0
    fi

    check_deps || exit 1

    local build_flag="--release"
    if [[ "${1:-}" == "--debug" ]]; then
        build_flag=""
    fi

    log_info "Starting ACL server..."
    cd "$ACL_ROOT"

    if [ ! -f "target/release/acl-server" ] && [ "$build_flag" == "--release" ]; then
        log_info "Binary not found, building first..."
        cargo build --release 2>&1
    fi

    nohup cargo run $build_flag --bin acl-server > "$LOG_FILE" 2>&1 &
    local pid=$!
    echo "$pid" > "$PID_FILE"

    sleep 2
    if kill -0 "$pid" 2>/dev/null; then
        log_info "Server started (PID: $pid) on 0.0.0.0:50051"
        log_info "Logs: $LOG_FILE"
    else
        log_error "Server failed to start. Check logs:"
        tail -20 "$LOG_FILE"
        return 1
    fi
}

cmd_stop() {
    if [ -f "$PID_FILE" ]; then
        local pid
        pid=$(cat "$PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid"
            log_info "Server stopped (PID: $pid)"
        else
            log_warn "PID $pid not running"
        fi
        rm -f "$PID_FILE"
    else
        # Try pkill as fallback
        if pkill -f "acl-server" 2>/dev/null; then
            log_info "Server stopped via pkill"
        else
            log_warn "No running server found"
        fi
    fi
}

cmd_status() {
    if cmd_is_running; then
        local pid
        pid=$(cat "$PID_FILE")
        log_info "Server is RUNNING (PID: $pid)"
        echo "  Port: 50051"
        echo "  Log:  $LOG_FILE"
        # Check if port is actually listening
        if command -v lsof >/dev/null 2>&1; then
            lsof -i :50051 2>/dev/null | grep LISTEN || true
        fi
    else
        log_warn "Server is NOT running"
    fi
}

cmd_is_running() {
    if [ -f "$PID_FILE" ]; then
        local pid
        pid=$(cat "$PID_FILE")
        kill -0 "$pid" 2>/dev/null
        return $?
    fi
    return 1
}

cmd_logs() {
    local lines="${1:-50}"
    if [ -f "$LOG_FILE" ]; then
        tail -n "$lines" "$LOG_FILE"
    else
        log_warn "No log file found at $LOG_FILE"
    fi
}

cmd_demo() {
    check_deps || exit 1
    log_info "Running ACL demo pipeline..."
    cd "$ACL_ROOT"
    cargo run --release --bin acl-demo 2>&1
}

cmd_gen_proto() {
    command -v python3 >/dev/null 2>&1 || { log_error "python3 not found"; exit 1; }

    log_info "Generating Python gRPC bindings..."
    cd "$ACL_ROOT"

    python3 -m grpc_tools.protoc \
        -I acl-proto/proto \
        --python_out=.skills/acl/scripts/ \
        --grpc_python_out=.skills/acl/scripts/ \
        acl-proto/proto/acl.proto

    log_info "Generated: .skills/acl/scripts/acl_pb2.py, acl_pb2_grpc.py"
}

cmd_submit() {
    # Submit a task to the ACL server via the Python client
    # Supports --prompt-file for multi-line prompts
    local source="${1:?Usage: submit <source> <intent> [--prompt-file <file>] [--priority <p>]}"
    local intent="${2:?Usage: submit <source> <intent> [--prompt-file <file>] [--priority <p>]}"
    shift 2

    local extra_args=()
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --prompt-file)
                extra_args+=("--prompt-file" "$2")
                shift 2
                ;;
            --prompt)
                extra_args+=("--prompt" "$2")
                shift 2
                ;;
            --priority)
                extra_args+=("--priority" "$2")
                shift 2
                ;;
            --constraints)
                extra_args+=("--constraints" "$2")
                shift 2
                ;;
            --constraints-file)
                extra_args+=("--constraints-file" "$2")
                shift 2
                ;;
            *)
                extra_args+=("$1")
                shift
                ;;
        esac
    done

    log_info "Submitting task: source=$source intent=$intent"
    cd "$ACL_ROOT"
    python3 .skills/acl/scripts/acl_client.py submit \
        --source "$source" \
        --intent "$intent" \
        "${extra_args[@]}"
}

# ─── Main ────────────────────────────────────────────────────────

case "${1:-help}" in
    build)      cmd_build ;;
    start)      cmd_start "${2:-}" ;;
    stop)       cmd_stop ;;
    status)     cmd_status ;;
    logs)       cmd_logs "${2:-50}" ;;
    demo)       cmd_demo ;;
    gen-proto)  cmd_gen_proto ;;
    submit)     cmd_submit "${@:2}" ;;
    help|*)
        echo "ACL Server Management"
        echo ""
        echo "Usage: $0 <command> [args]"
        echo ""
        echo "Commands:"
        echo "  build              Build the ACL project"
        echo "  start [--debug]    Start the gRPC server (default: release mode)"
        echo "  stop               Stop the server"
        echo "  status             Check if server is running"
        echo "  logs [N]           Show last N lines of server logs"
        echo "  demo               Run the demo pipeline"
        echo "  gen-proto          Generate Python gRPC bindings"
        echo "  submit <src> <intent> [opts]  Submit a task (--prompt-file, --prompt, --priority)"
        ;;
esac
