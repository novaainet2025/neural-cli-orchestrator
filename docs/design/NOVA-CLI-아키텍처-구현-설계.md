# NOVA CLI 아키텍처 및 구현 설계

## 1. 목표

NOVA CLI는 `NCO`와 `Nova-AX`를 동시에 관측하고 제어하는 로컬 터미널 오케스트레이터다.

- NCO: `http://localhost:6200` REST, `ws://localhost:6201` WebSocket
- Nova-AX: `http://localhost:6300` REST, `ws://localhost:6301` WebSocket
- UI 스택: `React Ink + TypeScript + Node.js`

핵심 기능:

- REPL 커맨드
  - `/model`
  - `/teams`
  - `/tasks`
  - `/voice`
- 실시간 D3형 노드 그래프의 터미널 ASCII/ANSI 트리뷰
- 자동 프로바이더 장애 복구와 세션 재연결
- Side-by-Side Diff 인터랙티브 뷰어

## 2. 설계 원칙

- 기존 `src/core`, `src/server`, `src/cli` 패턴을 유지한다.
- 네트워크 연동과 터미널 렌더링을 분리한다.
- REST는 명령/스냅샷 조회, WebSocket은 스트리밍 이벤트에만 사용한다.
- NCO와 Nova-AX는 공통 인터페이스 뒤에 감춘다.
- UI 상태는 이벤트 소싱 기반으로 축적하고, Ink 컴포넌트는 파생 상태만 렌더링한다.
- 장애 복구는 provider failover, transport reconnect, command retry를 분리한다.

## 3. 고수준 구조

```text
User
  -> NOVA CLI REPL (Ink App)
      -> Command Router
          -> Domain Controllers
              -> NCO Gateway Client (6200/6201)
              -> Nova-AX Gateway Client (6300/6301)
              -> Unified Event Store
              -> Failover Orchestrator
              -> Voice Controller
              -> Diff Session Manager
      -> Terminal Views
          -> REPL Pane
          -> Task/Team Pane
          -> ASCII Graph Pane
          -> Side-by-Side Diff Pane
          -> Status Bar / Alerts
```

## 4. 런타임 계층

### 4.1 App Shell

- Ink 루트
- 입력 포커스, 레이아웃, 글로벌 단축키 관리
- reconnect, loading, degraded 상태 표시

### 4.2 Command Layer

- slash command 파싱
- 인자 검증
- 명령별 controller dispatch

### 4.3 Integration Layer

- NCO REST/WS client
- Nova-AX REST/WS client
- 공통 재시도, heartbeat, reconnect, subscription 관리

### 4.4 State Layer

- 이벤트를 정규화해 `AppState`로 축적
- tasks, teams, providers, topology, diff sessions, voice 상태를 단일 저장소로 통합

### 4.5 View Layer

- ASCII tree renderer
- ANSI color policy
- diff viewport / keyboard navigation

## 5. 핵심 도메인 모듈

### 5.1 Gateway Adapter

공통 인터페이스:

```ts
interface BackendGateway {
  name: 'nco' | 'nova-ax';
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getHealth(): Promise<HealthSnapshot>;
  getTeams(): Promise<TeamSummary[]>;
  getTasks(filter?: TaskFilter): Promise<TaskSummary[]>;
  switchModel(input: ModelSwitchRequest): Promise<ModelSwitchResult>;
  setVoiceMode(input: VoiceModeRequest): Promise<VoiceModeResult>;
  subscribe(listener: (event: BackendEvent) => void): Unsubscribe;
}
```

의도:

- NCO와 Nova-AX 차이를 숨긴다.
- REST path 차이와 WS payload 차이는 adapter 내부에서 흡수한다.

### 5.2 Command Router

지원 명령:

- `/model <providerOrAlias>`
  - 현재 세션의 모델/프로바이더 전환
  - 실패 시 failover 후보 제안 또는 자동 전환
- `/teams [list|show <teamId>]`
  - 팀 목록과 상태 조회
- `/tasks [list|watch|show <taskId>]`
  - 진행률, 담당자, 최근 이벤트, 재시도 상태 표시
- `/voice [on|off|push-to-talk|mute]`
  - 음성 입력/출력 상태 제어

확장 예약:

- `/diff <left> <right>`
- `/graph [focus <nodeId>]`
- `/providers`

### 5.3 Unified Event Store

권장 구조:

```ts
interface AppState {
  session: SessionState;
  connectivity: ConnectivityState;
  providers: ProviderState[];
  teams: TeamState[];
  tasks: Record<string, TaskState>;
  topology: TopologyGraph;
  diff: DiffState;
  voice: VoiceState;
  alerts: AlertState[];
}
```

설계 포인트:

- WS 이벤트는 backend별 raw event 그대로 저장하지 않는다.
- `normalizeNcoEvent`, `normalizeNovaAxEvent`로 공통 이벤트로 변환한다.
- 화면 컴포넌트는 raw transport 구조를 몰라야 한다.

### 5.4 ASCII Graph Renderer

목적:

- 브라우저 D3 그래프 대신 터미널에서 팀/태스크/프로바이더 관계를 읽기 좋게 보여준다.

표현 규칙:

- depth 기반 트리 우선
- cross-edge는 보조 링크로 별도 하단 표시
- 상태는 ANSI 색상과 아이콘 문자로 표기
- 업데이트 빈도는 150ms~300ms 배치 렌더

예시:

```text
NOVA Mesh
├─ NCO
│  ├─ Team: research         [active]
│  │  ├─ Task: task_142      [62%] owner=codex
│  │  └─ Task: task_143      [queued]
│  └─ Provider: codex        [ok]
├─ Nova-AX
│  ├─ Voice Pipeline         [listening]
│  └─ Provider: hermes       [degraded]
└─ Links
   ├─ task_142 -> hermes     failover: pending
   └─ research -> Voice      signal: subscribed
```

렌더러 내부 단계:

1. topology snapshot 수집
2. graph index 생성
3. spanning tree 선택
4. label width 계산
5. ANSI 색 적용
6. incremental repaint

### 5.5 Failover Orchestrator

기존 `src/server/task-failover.ts`와 `config/failover-chains.json`을 재사용하되, CLI 레벨에서 다음을 추가한다.

- provider health score
- WS disconnect fallback
- command idempotency key
- 사용자 가시성 높은 경고와 자동 재시도 카운트

분리해야 하는 장애 유형:

1. Provider failure
   - completion timeout
   - empty response
   - connection refused
2. Transport failure
   - WS disconnect
   - REST timeout
3. Domain rejection
   - invalid model
   - unauthorized command

정책:

- provider failure: 체인 기반 자동 전환
- transport failure: 같은 provider 유지 후 reconnect
- domain rejection: 자동 전환 금지, 사용자 확인 필요

### 5.6 Side-by-Side Diff Viewer

요구사항:

- 좌우 파일 동시 스크롤
- hunk 점프
- 인라인 선택
- staged/unstaged/remote 비교 소스 지원

권장 내부 모델:

```ts
interface DiffHunk {
  id: string;
  header: string;
  leftStart: number;
  rightStart: number;
  lines: DiffLine[];
}

interface DiffLine {
  kind: 'context' | 'add' | 'remove' | 'modify';
  left?: string;
  right?: string;
}
```

렌더링 전략:

- `git diff --no-color --unified=3` 또는 backend diff endpoint 결과를 파싱
- terminal width를 측정해 좌우 pane 폭을 동적으로 계산
- 긴 줄은 wrap보다 horizontal scroll 우선
- 선택된 hunk만 high-intensity ANSI 적용

키맵 제안:

- `j/k`: line 이동
- `n/p`: hunk 이동
- `tab`: 포커스 전환
- `enter`: hunk expand/collapse
- `q`: diff 종료

## 6. 권장 디렉터리 구조

```text
src/
  nova-cli/
    index.ts
    bootstrap.ts
    types/
      app-state.ts
      commands.ts
      events.ts
      topology.ts
      diff.ts
      voice.ts
    config/
      cli-config.ts
      keybindings.ts
      color-theme.ts
    app/
      NovaCliApp.tsx
      AppProviders.tsx
      AppRouter.tsx
    repl/
      ReplController.ts
      command-parser.ts
      command-registry.ts
      history-store.ts
      completion.ts
    commands/
      model-command.ts
      teams-command.ts
      tasks-command.ts
      voice-command.ts
      diff-command.ts
      graph-command.ts
    controllers/
      model-controller.ts
      teams-controller.ts
      tasks-controller.ts
      voice-controller.ts
      diff-controller.ts
      graph-controller.ts
    integrations/
      common/
        backend-gateway.ts
        rest-client.ts
        ws-client.ts
        retry-policy.ts
        circuit-state.ts
      nco/
        nco-gateway.ts
        nco-rest.ts
        nco-ws.ts
        nco-event-normalizer.ts
      nova-ax/
        nova-ax-gateway.ts
        nova-ax-rest.ts
        nova-ax-ws.ts
        nova-ax-event-normalizer.ts
    state/
      app-store.ts
      reducers/
        connectivity-reducer.ts
        provider-reducer.ts
        team-reducer.ts
        task-reducer.ts
        topology-reducer.ts
        diff-reducer.ts
        voice-reducer.ts
      selectors/
        task-selectors.ts
        team-selectors.ts
        topology-selectors.ts
        diff-selectors.ts
    services/
      failover/
        failover-orchestrator.ts
        provider-health.ts
        fallback-policy.ts
      topology/
        topology-builder.ts
        topology-layout.ts
        ascii-tree-renderer.ts
        ansi-palette.ts
      diff/
        diff-session-manager.ts
        diff-parser.ts
        diff-layout.ts
      voice/
        voice-session.ts
        voice-device-manager.ts
    ui/
      components/
        Layout.tsx
        StatusBar.tsx
        CommandInput.tsx
        CommandPalette.tsx
        AlertsPanel.tsx
      panes/
        TeamsPane.tsx
        TasksPane.tsx
        GraphPane.tsx
        DiffPane.tsx
        VoicePane.tsx
      widgets/
        AsciiTree.tsx
        ProgressBar.tsx
        ProviderBadge.tsx
        DiffGutter.tsx
    hooks/
      use-app-store.ts
      use-command-dispatch.ts
      use-backend-events.ts
      use-terminal-size.ts
      use-diff-navigation.ts
    utils/
      ansi.ts
      width.ts
      debounce.ts
      object-pool.ts
    __tests__/
      command-parser.test.ts
      failover-orchestrator.test.ts
      ascii-tree-renderer.test.ts
      diff-parser.test.ts
      reducers.test.ts
```

## 7. 기존 저장소와의 연결 지점

기존 코드 재사용 권장:

- `src/server/task-failover.ts`
  - retryable failure 판별
  - failover chain 선택 로직
- `config/failover-chains.json`
  - 프로바이더 우선순위 체인
- `src/core/cli-mesh.ts`
  - 세션 메타데이터, 협업 상태, conflict 개념
- `src/server/websocket.ts`
  - delta event, client subscription, event buffering 패턴
- `src/server/topology.ts`
  - topology 메타모델 참고

주의:

- `src/server/topology.ts`는 현재 브라우저용 HTML inline 성격이 강하다.
- NOVA CLI에서는 시각화 엔진 자체를 재사용하지 말고 topology 데이터 모델만 차용한다.

## 8. 명령별 처리 흐름

### 8.1 `/model`

```text
Input -> parse -> model-controller
      -> active backend resolve
      -> backend.switchModel()
      -> failure? failover-orchestrator.evaluate()
      -> state.providers/session 갱신
      -> status bar + alerts 반영
```

### 8.2 `/teams`

```text
Input -> teams-controller
      -> gateway.getTeams()
      -> normalize
      -> store.teams 갱신
      -> TeamsPane 렌더
```

### 8.3 `/tasks`

```text
Input -> tasks-controller
      -> gateway.getTasks() + live WS subscription
      -> task reducer 축적
      -> TasksPane + GraphPane 동시 갱신
```

### 8.4 `/voice`

```text
Input -> voice-controller
      -> local voice session or Nova-AX voice endpoint 제어
      -> voice state 반영
      -> status bar / voice pane 갱신
```

## 9. 상태 동기화 전략

초기화 시:

- NCO health fetch
- Nova-AX health fetch
- teams/tasks/providers snapshot fetch
- 이후 WS subscribe

실시간 중:

- event batcher가 100ms 단위로 store commit
- topology redraw는 최대 4fps
- diff pane은 사용자 포커스 중일 때만 재계산

연결 복구:

- exponential backoff with jitter
- reconnect 성공 시 snapshot 재동기화
- stale state는 `degraded` 마킹 후 덮어쓴다

## 10. 테스트 전략

### 10.1 단위 테스트

- command parser
- event normalizer
- failover candidate selection
- ASCII tree layout
- diff parser

### 10.2 통합 테스트

- mocked NCO REST/WS
- mocked Nova-AX REST/WS
- `/model` 장애 후 자동 failover
- `/tasks watch` 실시간 갱신
- reconnect 후 state recovery

### 10.3 스냅샷 테스트

- ANSI tree 렌더 결과
- side-by-side diff layout
- status bar degraded/healthy 상태

## 11. 구현 순서

1. `src/nova-cli` 앱 골격과 bootstrap 생성
2. 공통 gateway, REST/WS client 구현
3. NCO, Nova-AX event normalizer 구현
4. App store와 reducer 구성
5. REPL parser와 `/model`, `/teams`, `/tasks`, `/voice` 구현
6. failover orchestrator 연결
7. ASCII graph pane 구현
8. diff parser와 side-by-side viewer 구현
9. 통합 테스트와 terminal snapshot 보강

## 12. 추천 엔트리포인트

- `src/nova-cli/index.ts`
  - CLI 실행 진입점
- `src/nova-cli/bootstrap.ts`
  - 설정 로드, backend 연결, Ink mount
- `package.json`
  - `"nova:cli": "tsx src/nova-cli/index.ts"`

## 13. 판단

이 프로젝트에서는 NOVA CLI를 기존 `src/cli` 하위에 조각내어 넣기보다 `src/nova-cli`라는 독립 vertical slice로 두는 편이 낫다.

이유:

- Ink UI, 통합 게이트웨이, diff 렌더러가 기존 단순 CLI 유틸과 성격이 다르다.
- NCO 백엔드 코드와 순환 의존을 줄일 수 있다.
- Nova-AX 연동이 추가되면서 `src/cli`보다 더 넓은 앱 계층이 필요하다.

단, failover 정책과 mesh/session 모델은 기존 코드를 적극 재사용하는 것이 맞다.
