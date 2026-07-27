# NCO 통합 작업 이벤트 원장

NCO는 작업의 최종 결과만이 아니라 성공, 실패, 개선, 맥락, 주요 이슈,
충돌, 에러, 버그, 워크트리, Git 오류·충돌, 회귀를 하나의 append-only
SQLite 원장에 기록하고 Obsidian으로 내보낸다.

## 저장 계층

1. `work_events`: 수정·삭제가 DB 트리거로 차단된 원본 이벤트
2. `tasks`, `work_reports`, `improvement_notes`, `learning_events`,
   `decision_log`, `agent_actions`: 전체 본문과 기존 운영 데이터
3. Obsidian `07-SESSIONS/NCO-WORK-JOURNAL`: 작업별 전체 문서와 일일 이벤트
4. Obsidian `08-IMPROVEMENTS/NCO`: 문제·근본 원인·조치·검증

각 이벤트는 SQLite 삽입 순서(`rowid`) 기준의 `previous_hash`와
`content_hash`로 연결된다. 발생 시각순 체인이 아니다. 기존 기록의 정정은
UPDATE가 아니라 새 `correction:*` 이벤트로 추가한다. 토큰, 인증 헤더, 비밀번호,
API 키 형태의 값은 DB 입력과 Obsidian 출력 전에 제거한다.

## 자동 수집

- 이벤트 버스의 모든 이벤트
- 모든 작업 상태 전이
- 기존 작업·업무보고·개선노트·학습 이벤트·결정·에이전트 행동
- NCO와 Obsidian 저장소의 HEAD, 브랜치, ahead/behind, dirty 파일,
  워크트리 목록, 미해결 충돌, 진행 중인 merge/rebase/cherry-pick
- Git `user.name`/`user.email` 누락
- 기록 래퍼를 통과한 build/test 성공 및 회귀

`npm run journal:sync`는 기존 데이터의 멱등 backfill, Git 상태 관측,
Obsidian 증분 출력을 한 번에 수행한다.

## 외부 이벤트 기록

HTTP:

```bash
curl -X POST http://localhost:6200/api/work-events \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "operator",
    "category": "bug",
    "eventType": "bug:discovered",
    "severity": "warning",
    "title": "재현된 버그",
    "summary": "재현 조건과 영향",
    "detail": {"reproduction": ["step 1", "step 2"]},
    "evidence": [{"tier": "T1", "path": "/tmp/evidence.txt"}]
  }'
```

CLI:

```bash
npm run journal:record -- \
  --category bug \
  --event-type bug:discovered \
  --severity warning \
  --title "재현된 버그" \
  --summary "재현 조건과 영향"
```

조회:

```bash
curl 'http://localhost:6200/api/work-events?category=conflict&limit=100'
curl 'http://localhost:6200/api/work-events/coverage'
```

## 운영 원칙과 한계

- NCO 내부 이벤트는 자동 기록된다.
- NCO 밖에서 실행되는 임의의 셸 명령 실패는 운영체제가 자동으로 전달하지 않는다.
  외부 자동화는 HTTP/CLI 수집기를 사용하거나 기록 래퍼로 실행해야 한다.
- Git 상태 스캐너는 주기 사이에 생겼다가 사라진 충돌을 복원할 수 없다. 중요한 Git
  자동화는 실패 직후 `journal:record`를 호출해야 한다.
- 스캐너가 직전 주기의 충돌·merge/rebase 상태가 해소된 것을 확인하면
  `git:conflict_resolved` 이벤트를 추가한다.
- HTTP `detail`과 `evidence`의 합산 직렬화 크기는 256KiB로 제한한다.
- Obsidian 문서는 생성물이며 SQLite 원장이 기준 데이터다.
