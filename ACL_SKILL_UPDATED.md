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
- `prompt`: 멀티라인 프롬프트 텍스트 (proto field 10) — 긴 작업 설명이나 코드 블록 포함 가능
- `output_schema`: 기대 출력 스키마
- `priority`: 0.0~1.0 우선순위
- `deadline_ms`: 마감 타임스탬프

> **참고**: `prompt` 필드는 constraints의 key-value와 별도로 존재하며, 멀티라인/대용량 프롬프트를 안전하게 전달하기 위해 사용됩니다. TaskNode에도 동일한 `prompt` 필드(field 18)가 전파됩니다.

### 2. Task State Machine
```
PENDING → CLAIMED → RUNNING → DONE
                             → FAILED
       → CANCELLED
```
각 전이마다 이벤트가 발행되고, 의존성 그래프(DAG)가 자동으로 해소됩니다. 태스크 제출 시 이벤트 페이로드에는 task_id, source_agent, intent, priority, target_agent, constraints_keys가 포함됩니다.

### 3. Agent Capability
에이전트는 `can_do` (수행 가능 능력), `requires` (입력 요건), `produces` (출력물), `cost` (비용 프로파일), `trust_score` (신뢰도)로 등록됩니다.

Intent 매칭은 **대소문자 무관(case-insensitive)** 이며, 앞뒤 공백이 자동으로 제거(trim)됩니다. 예를 들어 `"Code_Review"`, `" code_review "`, `"CODE_REVIEW"` 모두 동일하게 매칭됩니다.

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

**권장: manage_server.sh 사용**
```bash
cd <workspace>/AgentsCollaborationLayer
.skills/acl/scripts/manage_server.sh start
```

또는 직접 실행:
```bash
cd <workspace>/AgentsCollaborationLayer
nohup cargo run --release --bin acl-server > /tmp/acl-server.log 2>&1 &
ACL_PID=$!
echo "ACL server started (PID: $ACL_PID) on 0.0.0.0:50051"
```

서버 상태 확인:
```bash
.skills/acl/scripts/manage_server.sh status
# 또는
sleep 2 && grep -i "listening\|started\|error" /tmp/acl-server.log
```

> **참고**: gRPC 서버는 16MB 메시지 크기 제한으로 설정되어 있어 대용량 프롬프트와 아티팩트도 처리 가능합니다.

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

## 서버 관리 스크립트 (manage_server.sh)

`.skills/acl/scripts/manage_server.sh`로 서버 관리 작업을 수행합니다:

```bash
# 빌드
./manage_server.sh build

# 서버 시작/중지/상태
./manage_server.sh start [--debug]
./manage_server.sh stop
./manage_server.sh status

# 로그 확인
./manage_server.sh logs [N]       # 마지막 N줄 (기본: 50)

# 데모 실행
./manage_server.sh demo

# Python gRPC 바인딩 생성
./manage_server.sh gen-proto

# 태스크 직접 제출 (멀티라인 프롬프트 지원)
./manage_server.sh submit <source> <intent> [옵션]
```

### submit 명령 옵션
```bash
# 인라인 프롬프트
./manage_server.sh submit supervisor code_review --prompt "Review this code"

# 파일에서 프롬프트 읽기 (멀티라인 프롬프트에 권장)
./manage_server.sh submit supervisor code_review --prompt-file /path/to/prompt.txt

# 우선순위와 제약조건 지정
./manage_server.sh submit supervisor implement_feature \
  --prompt-file task.md \
  --priority 0.9 \
  --constraints '{"language": "rust"}'

# 제약조건 파일에서 읽기
./manage_server.sh submit supervisor refactor \
  --prompt-file prompt.md \
  --constraints-file constraints.json
```

## 클라이언트 스크립트

`scripts/acl_client.py`는 ACL gRPC 서버와 통신하는 Python 래퍼입니다. gRPC 채널은 16MB 메시지 제한으로 설정되어 대용량 프롬프트도 안전하게 전송됩니다.

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

### CLI를 통한 태스크 제출 (멀티라인 프롬프트 지원)
```bash
# 기본 제출
python acl_client.py submit --source supervisor --intent code_review

# 인라인 프롬프트
python acl_client.py submit --source supervisor --intent code_review --prompt "Review auth module"

# 파일에서 프롬프트 (멀티라인 프롬프트에 권장)
python acl_client.py submit --source supervisor --intent code_review --prompt-file review_prompt.md

# stdin에서 프롬프트 (파이프 사용)
cat prompt.txt | python acl_client.py submit --source supervisor --intent code_review --prompt-file -

# 제약조건 파일과 함께
python acl_client.py submit --source supervisor --intent implement_feature \
  --prompt-file task.md \
  --constraints-file constraints.json \
  --priority 0.95
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

### 멀티라인 프롬프트 처리

CLI 에이전트로 프롬프트를 전달할 때, executor는 자동으로 최적의 전달 방식을 선택합니다:
- **짧은 단일행 프롬프트** (4KB 미만): CLI 인자로 직접 전달
- **긴 프롬프트 / 멀티라인**: 임시 파일에 기록 후 파일 경로로 전달. 작업 완료 후 자동 정리됨

이를 통해 코드 블록, 에러 로그, 상세 설명 등이 포함된 복잡한 프롬프트도 안전하게 처리됩니다.

### 에이전트 프로파일 (profiles.json)

각 CLI의 강점이 정의되어 있어 intent에 따라 자동 라우팅됩니다:
- **Codex**: code_generation, implement_feature, refactor, boilerplate (빠른 코드 생성)
- **Claude**: code_review, bug_analysis, architecture_analysis, test_generation (분석/리뷰)
- **Gemini**: research, documentation, large_context_analysis, api_integration (리서치/문서화)

프로파일은 `scripts/profiles.json`에서 커스터마이즈 가능합니다. Intent 매칭은 대소문자를 구분하지 않으며 공백이 자동 정리됩니다.

### 파이프라인 템플릿

`scripts/orchestrator.py`로 4가지 파이프라인을 실행할 수 있습니다:

#### 1. Feature Implementation
```bash
# 인라인 프롬프트
python orchestrator.py feature "Add WebSocket support for real-time events" --workdir /path/to/project

# 파일에서 상세 프롬프트 읽기
python orchestrator.py feature --prompt-file feature_spec.md --workdir /path/to/project
```
DAG: analyze → [implement-core, implement-supporting] → [write-tests, review] → finalize

#### 2. Bug Fix
```bash
python orchestrator.py bugfix "NullPointer in UserService.login()" --error-log "stack trace..."

# 파일에서 상세 버그 리포트 읽기
python orchestrator.py bugfix --prompt-file bug_report.md --error-log "..."
```
DAG: diagnose → [fix-primary, fix-alternative, write-regression-test] → verify

#### 3. Refactoring
```bash
python orchestrator.py refactor "Extract auth into separate module" --scope src/auth/

# 파일에서 리팩토링 계획 읽기
python orchestrator.py refactor --prompt-file refactor_plan.md --scope src/auth/
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

### 파이프라인 컨텍스트 관리

오케스트레이터는 파이프라인 실행 시 컨텍스트 크기를 자동으로 관리합니다:
- **최대 컨텍스트**: 태스크당 총 8,000자 제한
- **비례 축소(proportional truncation)**: 컨텍스트가 제한을 초과하면 각 섹션을 비율에 따라 축소
- **스마트 절단(smart truncation)**: 결과 요약 시 500자 제한으로 마지막 완전한 줄 기준 절단 (단어/줄 중간 잘림 방지)

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

> **참고**: `pipeline.py`의 `render_prompts()`는 `string.Template.safe_substitute()`를 사용하여 변수 치환을 수행합니다. 존재하지 않는 변수는 무시되며 KeyError가 발생하지 않습니다.

## 병렬 실행

파이프라인의 병렬 웨이브에서 실행된 태스크들의 결과는 **입력 순서가 보장**됩니다. 즉, 어떤 태스크가 먼저 완료되든 상관없이 원래 정의된 순서대로 결과가 반환됩니다.

## 기존 워크플로우 패턴

ACL gRPC 서버 기반 워크플로우 패턴은 `references/workflows.md`를 참고하세요.

## 데모 실행

```bash
cd <workspace>/AgentsCollaborationLayer
cargo run --release --bin acl-demo
# 또는
.skills/acl/scripts/manage_server.sh demo
```

## 서버 종료

```bash
.skills/acl/scripts/manage_server.sh stop
# 또는
kill $ACL_PID 2>/dev/null
# 또는
pkill -f acl-server
```

## 트러블슈팅

- **빌드 실패**: `protoc` 버전 확인. `protoc --version`이 3.x 이상이어야 합니다.
- **서버 연결 실패**: 포트 50051이 사용 중인지 확인. `lsof -i :50051`
- **Python 바인딩 오류**: `grpcio-tools` 설치 확인. proto 파일 경로가 정확한지 확인.
- **CLI not found**: `which codex claude gemini`로 CLI 설치 확인. `orchestrator.py status`로 사용 가능한 에이전트 확인.
- **멀티라인 프롬프트 깨짐**: `--prompt-file` 옵션을 사용하여 파일에서 프롬프트를 읽으세요. CLI 인자로 직접 전달 시 셸 이스케이프 문제가 발생할 수 있습니다.
- **대용량 프롬프트 전송 실패**: gRPC 메시지 크기가 16MB로 제한됩니다. 이를 초과하는 경우 프롬프트를 분할하거나 아티팩트 스토어를 활용하세요.
- **Intent 매칭 실패**: intent는 대소문자를 구분하지 않으며 앞뒤 공백이 자동 제거됩니다. `profiles.json`에서 에이전트의 `can_do` 목록을 확인하세요.

## 변경 이력 (v1.1 — 멀티라인 프롬프트 감사)

12개 이슈가 9개 통신 경로에서 식별되어 수정되었습니다:

1. **[CRITICAL] executor.py — 임시 파일 프롬프트 전달**: 4KB 초과 또는 멀티라인 프롬프트를 임시 파일로 전달
2. **[CRITICAL] orchestrator.py — `--prompt-file` 지원**: feature, bugfix, refactor에 파일/stdin 프롬프트 입력 추가
3. **[CRITICAL] acl_client.py — submit에 prompt 필드**: `--prompt`, `--prompt-file`, `--constraints-file` 옵션 추가
4. **[HIGH] acl.proto — prompt 필드 추가**: ActionPacket(field 10), TaskNode(field 18)에 전용 prompt 필드
5. **[HIGH] agent_registry.rs — 정규화된 매칭**: intent 매칭 시 trim + lowercase 적용
6. **[HIGH] orchestrator.py — 컨텍스트 크기 제한**: 8,000자 상한, 비례 축소
7. **[MEDIUM] executor.py — 병렬 순서 보장**: future_to_index로 입력 순서 유지
8. **[MEDIUM] orchestrator.py — 스마트 절단**: 500자 제한, 완전한 줄 기준 절단
9. **[LOW] pipeline.py — 안전한 변수 치환**: string.Template.safe_substitute() 사용
10. **[LOW] acl-server + acl_client — 메시지 크기 16MB**: 서버 및 클라이언트 양측 설정
11. **[LOW] runtime.rs — 풍부한 이벤트 페이로드**: submit_task 이벤트에 상세 정보 포함
12. **[LOW] manage_server.sh — submit 명령**: 셸에서 직접 태스크 제출 가능
