# ACL 멀티라인 프롬프트 처리 — 전체 커뮤니케이션 경로 감사 보고서

## 전체 커뮤니케이션 경로 맵

```
경로 A: CLI → orchestrator.py (argparse) → pipeline.py → executor.py → subprocess → CLI 도구
경로 B: Python API → Orchestrator → pipeline → executor → subprocess → CLI 도구
경로 C: acl_client.py CLI → gRPC → Rust 서버 → task_graph
경로 D: Python AclClient API → gRPC → Rust 서버 → task_graph
경로 E: Rust 서버 내부 → event_bus → 이벤트 구독자
경로 F: Rust 서버 내부 → artifact_store → 아티팩트 저장/조회
경로 G: Rust 서버 내부 → agent_registry → intent 기반 라우팅
경로 H: executor 결과 → orchestrator._build_prompt (컨텍스트 주입) → 다음 태스크
경로 I: orchestrator 결과 → _build_summary → JSON 출력
```

---

## 발견된 문제점 (심각도 순)

---

### 🔴 CRITICAL 1: executor.py — 커맨드라인 인자로 프롬프트 직접 전달

**파일**: `scripts/executor.py` 223~261행 (`_build_command`)

**문제**: 멀티라인 프롬프트가 `subprocess.run(cmd)` 리스트의 원소로 그대로 전달됨.

```python
# codex: 포지셔널 인자
cmd.append(prompt)

# claude: -p 플래그 뒤
cmd.append(config["prompt_flag"])  # "-p"
cmd.append(prompt)

# gemini: -p 플래그 뒤
cmd.append(config["prompt_flag"])  # "-p"
cmd.append(prompt)
```

**영향**:
- `_build_prompt()`에서 이전 태스크 결과(최대 4000자)가 합쳐지면 프롬프트가 수천~수만 자에 달할 수 있음
- Linux `ARG_MAX` (보통 2MB) 초과 시 `OSError: [Errno 7] Argument list too long` 발생
- 일부 CLI 도구가 커맨드라인 인자의 뉴라인을 올바르게 처리하지 못할 수 있음
- 특히 **codex CLI**는 포지셔널 인자로 받으므로 쉘 이스케이프 문제 가능성 높음

**수정 방안**:
```python
# stdin으로 프롬프트 전달
result = subprocess.run(
    cmd,
    input=prompt,  # stdin으로 전달
    capture_output=True, text=True, ...
)

# 또는 임시 파일 사용
with tempfile.NamedTemporaryFile(mode='w', suffix='.txt', delete=False) as f:
    f.write(prompt)
    cmd.extend(["--prompt-file", f.name])
```

---

### 🔴 CRITICAL 2: orchestrator.py CLI — argparse가 멀티라인 입력을 받을 수 없음

**파일**: `scripts/orchestrator.py` 381~409행

**문제**: `description`이 포지셔널 argument로 정의됨.

```python
feat.add_argument("description", help="Feature description")
bug.add_argument("description", help="Bug description")
ref.add_argument("description", help="Refactoring goal")
```

**영향**:
- 터미널에서 멀티라인 입력 사실상 불가능 (`$'line1\nline2'` 필요)
- 긴 설명문은 쉘 따옴표 이스케이프 문제 발생
- 사용자가 자연스럽게 여러 줄의 요구사항을 전달할 수 없음

**수정 방안**:
```python
feat.add_argument("description", nargs="?", default=None)
feat.add_argument("--prompt-file", help="파일에서 프롬프트 읽기 (- 이면 stdin)")

# 로직:
if args.prompt_file == "-":
    description = sys.stdin.read()
elif args.prompt_file:
    with open(args.prompt_file) as f:
        description = f.read()
else:
    description = args.description
```

---

### 🔴 CRITICAL 3: acl_client.py CLI — submit에 프롬프트/설명 필드 부재

**파일**: `scripts/acl_client.py` 348~354행

**문제**: `submit` 서브커맨드에 프롬프트 전용 필드가 없음.

```python
submit.add_argument("--source", required=True)
submit.add_argument("--intent", required=True)
submit.add_argument("--constraints", default="{}", help="JSON string of constraints")
```

**영향**:
- 멀티라인 프롬프트를 전달하려면 `--constraints '{"prompt": "line1\nline2\nline3"}'` 형태의 JSON을 써야 함
- 쉘에서 JSON 안에 뉴라인/따옴표 이스케이프가 극히 번거로움
- `--intent`는 단일 키워드("research", "write")로 설계됨 → 긴 프롬프트 부적합

**수정 방안**:
```python
submit.add_argument("--prompt", help="태스크 프롬프트 텍스트")
submit.add_argument("--prompt-file", help="프롬프트를 파일에서 읽기")
submit.add_argument("--constraints-file", help="constraints를 JSON 파일에서 읽기")
```

---

### 🟡 HIGH 4: Proto 스키마 — `ActionPacket`에 `prompt` 전용 필드 부재

**파일**: `acl-proto/proto/acl.proto` 50~61행

**문제**: `intent` 필드는 능력 매칭용 키워드이고, `constraints`는 key-value 맵인데, 멀티라인 자연어 프롬프트를 담을 전용 필드가 없음.

```protobuf
message ActionPacket {
  string intent = 4;           // "research" 같은 짧은 키워드용
  map<string, string> constraints = 6;  // 구조화된 메타데이터용
  // ❌ prompt 필드 없음
}
```

**영향**:
- 오케스트레이터(Python)에서는 `prompt_template`을 사용하지만 gRPC 경로에는 이 개념이 없음
- `constraints["prompt"]`에 넣는 우회 방법은 비직관적이고 문서화되지 않음
- Rust 서버 측에서 프롬프트 기반 라우팅 불가

**수정 방안**:
```protobuf
message ActionPacket {
  string intent = 4;
  string prompt = 10;           // 새 필드: 멀티라인 자연어 프롬프트
  map<string, string> constraints = 6;
}
```

---

### 🟡 HIGH 5: agent_registry.rs — intent 문자열 정확 일치만 지원

**파일**: `acl-core/src/agent_registry.rs` `find_by_capability()`, `route_intent()`

**문제**: intent와 capability를 정확 일치(`==`)로만 비교.

```rust
// find_by_capability에서
.filter(|entry| entry.value().can_do.iter().any(|c| c == capability))
```

**영향**:
- `intent: "research\n"` (뉴라인 포함) → `can_do: ["research"]` 매칭 실패
- 공백이나 대소문자 차이도 매칭 실패
- 오케스트레이터에서 `intent`에 프롬프트를 넣으면 라우팅 완전 불가

**수정 방안**:
```rust
// trim + 대소문자 무시 매칭
.filter(|entry| entry.value().can_do.iter()
    .any(|c| c.trim().eq_ignore_ascii_case(capability.trim())))
```

---

### 🟡 HIGH 6: orchestrator._build_prompt — 컨텍스트 합성 시 프롬프트 폭발

**파일**: `scripts/orchestrator.py` 230~256행

**문제**: 이전 태스크 결과가 4000자씩 합쳐져서 프롬프트가 기하급수적으로 커질 수 있음.

```python
if len(dep_output) > 4000:
    dep_output = dep_output[:4000] + "\n... (truncated)"
context_parts.append(f"[Output from '{dep_id}']:\n{dep_output}")
```

**영향**:
- 의존성이 3개면 최대 12,000자+ 컨텍스트 추가
- executor에서 이 전체가 커맨드라인 인자로 전달됨 (CRITICAL 1과 연쇄)
- CLI 도구의 토큰 제한 초과 가능성

**수정 방안**: 총 컨텍스트 크기에 상한을 두고, 요약 전략을 적용해야 함.

---

### 🟡 MEDIUM 7: executor.py — 병렬 실행 시 결과 순서 불일치

**파일**: `scripts/executor.py` 188~221행 (`execute_parallel`)

**문제**: `as_completed`가 완료 순서로 반환하므로 태스크 순서와 결과 순서가 달라짐.

```python
for future in concurrent.futures.as_completed(futures):
    results.append(future.result())
```

**영향**: `orchestrator.py` 190행에서 `results[i]`로 인덱싱할 때 잘못된 태스크에 결과가 매핑될 수 있음.

```python
for i, result in enumerate(results):
    task = routed[i][0]  # ❌ 순서가 보장되지 않음
    all_results[task.task_id] = result
```

**수정 방안**:
```python
# futures 딕셔너리에서 태스크 ID를 키로 사용
futures = {}
for i, task in enumerate(exec_tasks):
    future = pool.submit(...)
    futures[future] = i  # 원래 인덱스 보존

for future in concurrent.futures.as_completed(futures):
    idx = futures[future]
    results[idx] = future.result()
```

---

### 🟡 MEDIUM 8: orchestrator._build_summary — 출력 미리보기 200자 잘림

**파일**: `scripts/orchestrator.py` 293~300행

**문제**: 결과 요약에서 출력이 200자로 잘리면서 멀티라인 구조가 깨짐.

```python
"output_preview": r.output[:200] if r.output else "",
"error": r.error[:200] if r.error else "",
```

**영향**:
- JSON 출력의 중간에서 잘려 유효하지 않은 JSON이 됨
- 다음 태스크가 이 요약을 참고할 경우 파싱 에러

---

### 🟢 LOW 9: pipeline.py — render_prompts의 이중 중괄호 패턴

**파일**: `scripts/pipeline.py` 77~85행

**문제**: `{{key}}` 패턴으로 변수 치환하는데, 이는 Python f-string과 충돌 가능.

```python
prompt = prompt.replace(f"{{{{{key}}}}}", str(value))
```

**영향**: 현재 코드에서는 `render_prompts`가 실제로 사용되지 않지만, 향후 사용 시 멀티라인 값의 중괄호가 문제될 수 있음.

---

### 🟢 LOW 10: gRPC 전송 — 기본 메시지 크기 제한

**구성 요소**: gRPC 채널 (Python 클라이언트 / Rust 서버)

**문제**: gRPC 기본 메시지 크기 제한이 4MB. 매우 긴 프롬프트나 대용량 아티팩트에서 문제 가능.

**영향**: 대형 아티팩트 content 전송 시 `RESOURCE_EXHAUSTED` 에러 가능.

**수정 방안**: 서버/클라이언트에서 `max_receive_message_length` 설정.

---

### 🟢 LOW 11: event_bus — 이벤트 payload에 프롬프트 정보 없음

**파일**: `acl-core/src/event_bus.rs`, `runtime.rs` 89~93행

**문제**: 태스크 생성 이벤트에 `agent_id`만 포함되고, 프롬프트/constraints 정보가 없음.

```rust
self.event_bus.publish(
    EventType::TaskCreated,
    serde_json::json!({"agent_id": &agent_id}).to_string().into_bytes(),
    &agent_id,
)?;
```

**영향**: 이벤트 구독자가 태스크 내용을 알 수 없어 모니터링/디버깅 어려움.

---

### 🟢 LOW 12: manage_server.sh — 프롬프트 관련 기능 없음

**파일**: `scripts/manage_server.sh`

**문제**: 서버 관리 스크립트에 태스크 제출 기능이 없어서 쉘에서 직접 멀티라인 프롬프트를 테스트할 방법이 없음.

---

## ✅ 문제없는 경로 (확인 완료)

| 경로 | 상태 | 설명 |
|------|------|------|
| gRPC Protobuf 직렬화 | ✅ 안전 | Proto3 `string`은 UTF-8 바이트로 직렬화되며 뉴라인 보존 |
| Artifact Store | ✅ 안전 | `bytes` 필드로 저장하므로 인코딩 손실 없음 |
| Event Bus 직렬화 | ✅ 안전 | `serde_json`이 특수문자 올바르게 이스케이프 |
| Python → gRPC 전송 | ✅ 안전 | `grpcio`가 UTF-8 문자열을 올바르게 직렬화 |
| Rust DashMap 저장 | ✅ 안전 | String 타입이 뉴라인 포함 문자열을 완벽 보존 |
| Task state machine | ✅ 안전 | 상태 전이와 문자열 내용 무관 |
| Spawn manager | ✅ 안전 | 문자열 필드를 그대로 전달 |
| Policy engine | ✅ 안전 | tool_access 비교만 수행, 프롬프트 무관 |

---

## 요약: 심각도별 문제 수

| 심각도 | 건수 | 핵심 원인 |
|--------|------|-----------|
| 🔴 CRITICAL | 3 | CLI 인터페이스가 멀티라인 입력을 구조적으로 지원하지 않음 |
| 🟡 HIGH | 3 | 스키마 설계에 프롬프트 전용 채널이 없고, 문자열 매칭이 취약함 |
| 🟡 MEDIUM | 2 | 병렬 실행 순서 버그, 출력 잘림 |
| 🟢 LOW | 4 | 모니터링, 메시지 크기 제한, 미사용 코드 |

---

## 권장 수정 우선순위

1. **executor.py**: stdin/파일 기반 프롬프트 전달로 변경 (CRITICAL 1)
2. **병렬 실행 순서 버그 수정** (MEDIUM 7 — 데이터 정합성 문제)
3. **CLI에 --prompt-file 옵션 추가** (CRITICAL 2, 3)
4. **Proto 스키마에 prompt 필드 추가** (HIGH 4)
5. **intent 매칭에 trim/정규화 적용** (HIGH 5)
6. **컨텍스트 크기 상한 설정** (HIGH 6)
