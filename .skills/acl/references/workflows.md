# ACL Workflow Patterns

ACL에서 자주 사용되는 멀티에이전트 워크플로우 패턴을 정리합니다.

## 1. Sequential Pipeline (순차 파이프라인)

가장 기본적인 패턴. 각 단계가 이전 단계의 완료에 의존합니다.

```
[research] ──> [write] ──> [review]
```

### 구현 방법

```python
from acl_client import AclClient

client = AclClient()

# 에이전트 등록
client.register_agent("supervisor", "anthropic/claude-sonnet-4-6", ["orchestrate", "review"])
client.register_agent("researcher", "anthropic/claude-sonnet-4-6", ["research", "summarize"])
client.register_agent("writer", "anthropic/claude-sonnet-4-6", ["write", "edit"])

# 태스크 체인 생성 (의존성은 서버에서 DAG로 관리)
t1 = client.submit_task("supervisor", intent="research",
    constraints={"topic": "AI agent market", "depth": "comprehensive"}, priority=0.9)
t2 = client.submit_task("supervisor", intent="write",
    constraints={"format": "executive_summary"}, priority=0.8)
t3 = client.submit_task("supervisor", intent="review",
    constraints={"criteria": "accuracy,completeness"}, priority=0.7)

# 각 에이전트가 순차적으로 claim → start → complete
client.claim_task(t1, "researcher")
client.start_task(t1, "researcher")
ref = client.publish_artifact("research_report", b'{"findings": [...]}', "researcher", t1)
client.complete_task(t1, "researcher", artifact_refs=[ref["uri"]])

# write는 research 완료 후 claimable
client.claim_task(t2, "writer")
client.start_task(t2, "writer")
doc_ref = client.publish_artifact("document", b'{"content": "..."}', "writer", t2)
client.complete_task(t2, "writer", artifact_refs=[doc_ref["uri"]])

# review는 write 완료 후
client.claim_task(t3, "supervisor")
client.start_task(t3, "supervisor")
client.complete_task(t3, "supervisor", confidence=0.92)
```

## 2. Fan-Out / Fan-In (분산 수집)

하나의 supervisor가 여러 worker에게 병렬 작업을 분배하고, 결과를 통합합니다.

```
              ┌──> [research-A] ──┐
[supervisor] ─┼──> [research-B] ──┼──> [synthesize]
              └──> [research-C] ──┘
```

### 구현 방법

```python
# 병렬 리서치 태스크 생성
topics = ["market-size", "competitors", "technology-trends"]
task_ids = []
for topic in topics:
    tid = client.submit_task("supervisor", intent="research",
        constraints={"topic": topic}, priority=0.9)
    task_ids.append(tid)

# 각각 다른 에이전트(또는 같은 에이전트가 순차적으로) claim
for i, tid in enumerate(task_ids):
    agent = f"researcher-{i}"
    client.claim_task(tid, agent)
    client.start_task(tid, agent)
    # ... 작업 수행 후 complete

# 모든 리서치 완료 후 synthesis 태스크 생성
synth_id = client.submit_task("supervisor", intent="synthesize",
    constraints={"source_tasks": ",".join(task_ids)}, priority=0.8)
```

## 3. Hierarchical Spawn (계층적 스폰)

supervisor가 특화된 subagent를 동적으로 스폰합니다. 정책 엔진이 스폰 깊이, 예산, TTL을 제어합니다.

```
[supervisor]
  ├── spawn → [fact-checker] (ephemeral, budget=$0.50, ttl=120s)
  └── spawn → [formatter]    (ephemeral, budget=$0.30, ttl=60s)
```

### 구현 방법

```python
# Subagent 스폰
result = client.spawn_agent(
    parent_agent="supervisor",
    agent_id="fact-checker-001",
    model_backend="openai/gpt-4.1-mini",
    can_do=["verify_citations", "fact_check"],
    spawn_type="EPHEMERAL",
    budget_usd=0.50,
    ttl_seconds=120,
    tool_access=["search"]
)

# 작업 완료 후 종료
client.terminate_agent("fact-checker-001", reason="task complete")
```

## 4. Review Loop (리뷰 루프)

작업물이 품질 기준을 통과할 때까지 반복합니다.

```
[write] ──> [review] ──┐
  ^                     │ (rejected)
  └─────────────────────┘
```

### 구현 방법

```python
MAX_RETRIES = 3
for attempt in range(MAX_RETRIES):
    # Write
    write_id = client.submit_task("supervisor", intent="write",
        constraints={"attempt": str(attempt + 1)}, priority=0.8)
    client.claim_task(write_id, "writer")
    client.start_task(write_id, "writer")
    doc_ref = client.publish_artifact("draft", content, "writer", write_id)
    client.complete_task(write_id, "writer", artifact_refs=[doc_ref["uri"]])

    # Review
    review_id = client.submit_task("supervisor", intent="review",
        constraints={"artifact": doc_ref["uri"]}, priority=0.9)
    client.claim_task(review_id, "reviewer")
    client.start_task(review_id, "reviewer")

    # Check review result
    review_ref = client.publish_artifact("review_verdict",
        b'{"verdict": "APPROVED", "score": 0.92}', "reviewer", review_id)
    client.complete_task(review_id, "reviewer", artifact_refs=[review_ref["uri"]], confidence=0.92)

    verdict = client.get_artifact(review_ref["uri"])
    if "APPROVED" in verdict["content"]:
        break
```

## 5. Cowork 통합 패턴

코워크의 Claude가 ACL supervisor 역할을 하면서, ACL 런타임의 에이전트들과 협업합니다.

```
[Cowork Claude (supervisor)]
  ├── ACL: register self as supervisor
  ├── ACL: submit task DAG
  ├── ACL: monitor events
  └── ACL: collect artifacts → present to user
```

이 패턴에서 Claude는:
1. ACL 서버를 시작하고
2. 자신을 supervisor로 등록하고
3. 사용자 요청을 ActionPacket으로 변환하여 제출하고
4. 워커 에이전트의 결과 아티팩트를 수집하여 사용자에게 전달합니다.
