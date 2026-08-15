# agent-broker

`agent-broker`는 루트 에이전트를 중심으로 다수의 하위 에이전트 작업을 배분하기 위한 작고 단순한 로컬 MCP 서버입니다.
- 작업 분해, 라우팅, 결과 통합, 최종 검증은 루트 에이전트가 맡습니다. 
- broker는 하위 에이전트 실행, 안전 정책, 세션 연결만 담당하며 사용자와 직접 소통하지 않습니다.

## 설계

MCP가 제공하는 도구는 3개입니다.

1. `list_agents` : 에이전트의 가용 상태와 역할, 모델, 작업 이어가기 지원 여부를 확인합니다.
2. `delegate` : 루트가 선택하고 우선순위를 정한 에이전트 집합에 범위가 명확한 작업 하나를 맡깁니다.
3. `continue` : 이전 위임에서 기록한 네이티브 세션을 그대로 이어갑니다.

## 빠른 시작

```bash
npm install
cp config/agents.example.json config/agents.local.json
npm run connect
```

워커는 미리 정해 두지 않습니다. 저장소 루트에서 `npm run connect`로 CLI 이름이나 경로를 입력해 `config/agents.local.json`에 추가합니다. 모든 에이전트는 `billing.mode: "subscription"`과 `billing.fallback: "forbidden"`을 사용해야 하며, broker는 자격 증명을 저장하거나 종량제 API로 대체하지 않습니다. 이 파일은 Git에 추가하지 마세요.

```bash
codex mcp add agent-broker -- node /absolute/path/to/agent-router/bin/agent-broker.js --config /absolute/path/to/agent-router/config/agents.local.json
```

Codex 세션을 다시 시작한 뒤 다음과 같이 사용합니다.

```text
list_agents({ refresh: true })
delegate({
  task: "Explore the repository and report the smallest safe implementation plan.",
  difficulty: "low",
  retry_safe: true,
  cwd: "/absolute/path/to/repository"
})
continue({ session_id: "broker-session-id", task: "Run the focused tests and summarize failures." })
```

후보는 `agent_ids` 순서로 시도합니다. 시작 전에 확인된 비활성·인증 실패·사용 중 상태는 다음 후보로 넘어가지만, 시작 후 할당량 소진은 `retry_safe: true`인 작업만 재시도합니다. 루트 세션과 같은 CLI를 워커로 지정하면 안 됩니다.

`native-cli`는 비상태형 CLI용 기본 어댑터이고, `codex-exec`는 `codex exec --json`과 `resume`을 사용하는 상태 유지형 어댑터입니다. 다른 CLI는 로컬 어댑터 모듈로 추가할 수 있습니다. 실패는 원인별로 구분되며, 동시 실행 한도를 넘으면 대기열 대신 `busy`를 반환합니다. 상세 기록은 `state_dir`에 남습니다.

MCP 서버 자체의 등록·해제·로그인은 `codex mcp add/remove/login/logout` 또는 `claude mcp add/remove/login/logout` 같은 호스트 CLI 명령을 그대로 사용하세요. broker는 그 위에서 하위 에이전트 실행만 담당합니다.

## 루트 skill

Skill은 저장소의 `skills/lead-agent-work`에 있습니다. 작업 분배 원칙은 skill이, CLI 실행은 broker와 어댑터가 맡습니다. `.claude/`, `.codex/`, `.grok/` 같은 호스트 전용 디렉터리는 Git에 올리지 마세요. 쓰는 호스트의 skill 경로로 심볼릭 링크하면 됩니다.

## 검증

```bash
npm test
npm run check
npm run connect -- --help
node bin/agent-broker.js --help
```

`npm run connect`는 저장소 루트에서 실행합니다. 홈 디렉터리에서 바로 쓰면 `package.json`을 찾지 못합니다.

테스트는 로컬 fake CLI만 사용합니다.
