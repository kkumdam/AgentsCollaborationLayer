---
name: acl
description: "Agent Collaboration Layer (ACL) skill for orchestrating multi-agent workflows via typed, non-linguistic communication. Use this skill whenever the user mentions: multi-agent coordination, agent orchestration, task DAGs, agent pipelines, ACL, spawning subagents, artifact-based agent communication, or wants to run structured multi-agent workflows. Also trigger when the user wants to build, start, or interact with the ACL gRPC server, register agents, submit tasks, or manage agent lifecycles. Even if the user just says 'run agents' or 'coordinate tasks', this skill should activate."
---

# Agent Collaboration Layer (ACL) — Cowork Skill

ACL은 에이전트 간 비언어적(non-linguistic) 통신 및 오케스트레이션 런타임입니다. 에이전트들이 자연어 프롬프트 대신 **타입 기반 ActionPacket**, **상태 전이**, **아티팩트 참조**로 협업합니다.

## 프로젝트 위치

ACL 소스코드는 사용자의 워크스페이스 폴더에 있습니다:
```
<workspace>/AgentsCollaborationLayer/
```

워크스페이스 경로는 환경에 따라 달라질 수 있으므로, 실행 전 반드시 `ls` 로 프로젝트 디렉토리를 확인하세요.

## 핵심 개념

### 1. ActionPacket (작업 요청 단위)
에이전트 간 모든 작업 요청은 ActionPacket으로 구조화됩니다:
- `packet_id`: 고유 식별자
- `source_agent` / `target_agent`: 발신/수신 에이전트
- `intent`: 능력 매칭용 의도 (예: "research", "write", "review")
- `constraints`: key-value 제약 조건
- `output_schema`: 기대 출력 스키마
- `priority`: 0.0~1.0 우선순위
- `deadline_ms`: 마감 타임스탬프

### 2. Task State Machine
```
PENDING → CLAIMED → RUNNING → DONE
                             → FAILED
       → CANCELLED
```
각 전이마다 이벤트가 발행되고, 의존성 그래프(DAG)가 자동으로 해소됩니다.

### 3. Agent Capability
에이전트는 `can_do` (수행 가능 능력), `requires` (입력 요건), `produces` (출력물), `cost` (비용 프로파일), `trust_score` (신뢰도)로 등록됩니다.

### 4. Artifact Store
모든 에이전트 산출물은 SHA-256 해시 기반 content-addressable 저장소에 보관됩니다. `artifact://type/hash` URI로 참조합니다.

### 5. Policy Engine
스폰 제한, 예산 한도(USD), TTL, 도구 접근 제어를 관리합니다.

## 사용 방법

### Step 1: 빌드 환경 확인 및 준비

Rust 툴체인이 필요합니다. 환경을 확인하세요:
```bash
which rustc cargo protoc
rustc --version
```

없으면 설치:
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
```

protobuf 컴파일러도 필요합니다:
```bash
apt-get update && apt-get install -y protobuf-compiler
```

### Step 2: ACL 빌드

```bash
cd <workspace>/AgentsCollaborationLayer
cargo build --release 2>&1
```

빌드 결과물:
- `target/release/acl-server` — gRPC 서버
- `target/release/acl-demo` — 데모 파이프라인

### Step 3: 서버 실행

```bash
cd <workspace>/AgentsCollaborationLayer
nohup cargo run --release --bin acl-server > /tmp/acl-server.log 2>&1 &
ACL_PID=$!
echo "ACL server started (PID: $ACL_PID) on 0.0.0.0:50051"
```

서버 상태 확인:
```bash
sleep 2 && grep -i "listening\|started\|error" /tmp/acl-server.log
```

### Step 4: Python gRPC 클라이언트 사용

`scripts/acl_client.py`를 사용하여 서버와 상호작용합니다. 자세한 내용은 아래 "클라이언트 스크립트" 섹션을 참고하세요.

```bash
pip install grpcio grpcio-tools --break-system-packages
```

Proto 파일에서 Python 바인딩 생성:
```bash
cd <workspace>/AgentsCollaborationLayer
python3 -m grpc_tools.protoc \
  -I acl-proto/proto \
  --python_out=scripts/ \
  --grpc_python_out=scripts/ \
  acl-proto/proto/acl.proto
```

그런 다음 `scripts/acl_client.py`를 통해 에이전트 등록, 태스크 제출, 아티팩트 관리 등을 수행할 수 있습니다.

## 클라이언트 스크립트

`scripts/acl_client.py`는 ACL gRPC 서버와 통신하는 Python 래퍼입니다. 주요 기능:

### 에이전트 등록
```python
from acl_client import AclClient

client = AclClient("localhost:50051")
client.register_agent(
    agent_id="my-researcher",
    model_backend="anthropic/claude-sonnet-4-6",
    can_do=["research", "summarize"],
    trust_score=0.9
)
```

### 태스크 제출
```python
task_id = client.submit_task(
    source_agent="supervisor",
    intent="research",
    constraints={"topic": "AI trends 2026", "depth": "comprehensive"},
    priority=0.9
)
```

### 태스크 라이프사이클
```python
client.claim_task(task_id, "my-researcher")
client.start_task(task_id, "my-researcher")
# ... 작업 수행 ...
client.complete_task(task_id, "my-researcher", artifact_refs=["artifact://report/abc123"])
```

### 아티팩트 발행
```python
ref = client.publish_artifact(
    artifact_type="research_report",
    content=b'{"findings": [...]}',
    producer_agent="my-researcher",
    task_id=task_id
)
print(f"Published: {ref.uri}")
```

## Multi-CLI 오케스트레이션 (Codex + Claude + Gemini)

ACL의 핵심 기능: Codex CLI, Claude CLI, Gemini CLI를 서브에이전트로 등록하고 능력 기반으로 자동 라우팅하여 병렬 코딩 워크플로우를 실행합니다.

### 에이전트 프로파일 (profiles.json)

각 CLI의 강점이 정의되어 있어 intent에 따라 자동 라우팅됩니다:
- **Codex**: code_generation, implement_feature, refactor, boilerplate (빠른 코드 생성)
- **Claude**: code_review, bug_analysis, architecture_analysis, test_generation (분석/리뷰)
- **Gemini**: research, documentation, large_context_analysis, api_integration (리서치/문서화)

프로파일은 `scripts/profiles.json`에서 커스터마이즈 가능합니다.

### 파이프라인 템플릿

`scripts/orchestrator.py`로 4가지 파이프라인을 실행할 수 있습니다:

#### 1. Feature Implementation
```bash
python orchestrator.py feature "Add WebSocket support for real-time events" --workdir /path/to/project
```
DAG: analyze → [implement-core, implement-supporting] → [write-tests, review] → finalize

#### 2. Bug Fix
```bash
python orchestrator.py bugfix "NullPointer in UserService.login()" --error-log "stack trace..."
```
DAG: diagnose → [fix-primary, fix-alternative, write-regression-test] → verify

#### 3. Refactoring
```bash
python orchestrator.py refactor "Extract auth into separate module" --scope src/auth/
```
DAG: analyze-structure → refactor-plan → [refactor-module-a, refactor-module-b] → integration-test → review

#### 4. Code Review (경쟁적 병렬)
```bash
python orchestrator.py review src/core/ --focus security,performance
```
DAG: [review-claude, review-gemini] → synthesize

#### Dry Run (실행 계획만 보기)
```bash
python orchestrator.py feature "Add caching" --dry-run
python orchestrator.py visualize feature "Add caching"
```

### Python API로 사용

```python
from orchestrator import Orchestrator

orch = Orchestrator(workdir="/path/to/project")

# 상태 확인
print(orch.status())  # 사용 가능한 CLI agents 목록

# 파이프라인 실행
result = orch.run_feature("Add rate limiting to API endpoints")
result = orch.run_bugfix("Memory leak in connection pool", error_log="...")
result = orch.run_refactor("Split monolith into microservices", scope="src/")
result = orch.run_review("src/payment/", focus_areas="security")
```

### 커스텀 파이프라인

```python
from pipeline import custom_pipeline
from orchestrator import Orchestrator

pipeline = custom_pipeline(
    name="my-workflow",
    description="Custom coding workflow",
    tasks=[
        {"task_id": "research", "intent": "research", "prompt": "Research best practices for..."},
        {"task_id": "implement", "intent": "code_generation", "prompt": "Implement...", "depends_on": ["research"]},
        {"task_id": "test", "intent": "test_generation", "prompt": "Write tests...", "depends_on": ["implement"]},
    ]
)

orch = Orchestrator(workdir=".")
result = orch.run_pipeline(pipeline)
```

## 기존 워크플로우 패턴

ACL gRPC 서버 기반 워크플로우 패턴은 `references/workflows.md`를 참고하세요.

## 데모 실행

```bash
cd <workspace>/AgentsCollaborationLayer
cargo run --release --bin acl-demo
```

## 서버 종료

```bash
kill $ACL_PID 2>/dev/null
# 또는
pkill -f acl-server
```

## 트러블슈팅

- **빌드 실패**: `protoc` 버전 확인. `protoc --version`이 3.x 이상이어야 합니다.
- **서버 연결 실패**: 포트 50051이 사용 중인지 확인. `lsof -i :50051`
- **Python 바인딩 오류**: `grpcio-tools` 설치 확인. proto 파일 경로가 정확한지 확인.
- **CLI not found**: `which codex claude gemini`로 CLI 설치 확인. `orchestrator.py status`로 사용 가능한 에이전트 확인.
