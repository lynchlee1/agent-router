# agent-broker

`agent-broker`는 루트 에이전트가 여러 하위 에이전트에게 작업을 맡길 수 있게 해 주는 로컬 MCP 서버입니다. 루트 에이전트는 작업 분해와 결과 검증을 맡고, broker는 하위 에이전트 실행과 세션 연결을 담당합니다.

## 설치

Node.js 20 이상이 필요합니다. 저장소 루트에서 다음 명령을 실행하세요.

```bash
npm install
npm run connect
```

`connect` 화면에서 `/add <service> <model> <effort>`를 입력하고 task difficulty를 선택하면 `config/agents.local.json`에 route가 추가됩니다. 이 파일에는 로컬 설정이 담기므로 Git에 추가하지 마세요.

모든 에이전트는 `billing.mode: "subscription"`과 `billing.fallback: "forbidden"`을 사용해야 합니다. broker는 자격 증명을 저장하거나 종량제 API로 전환하지 않습니다.

설정을 마치면 MCP 서버를 등록하고 Codex를 다시 시작합니다.

```bash
npm run register
```

## 사용

제공하는 도구는 다음 3개입니다.

- `list_agents`: 사용할 수 있는 에이전트를 확인합니다.
- `delegate`: 선택한 에이전트에게 작업을 맡깁니다.
- `continue`: 이전 작업의 세션을 이어갑니다.

```text
list_agents({ refresh: true })
delegate({
  task: "Explore the repository and report the smallest safe implementation plan.",
  difficulty: "easy_task",
  retry_safe: true,
  cwd: "/absolute/path/to/repository"
})
continue({ session_id: "broker-session-id", task: "Run the focused tests and summarize failures." })
```

## 검증

```bash
npm test
npm run check
```
