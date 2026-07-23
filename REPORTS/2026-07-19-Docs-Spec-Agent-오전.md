# 2026년 7월 19일 오전 업무보고

- 팀: Docs & Spec Agent (`ax-docs`)
- 조직 경로: `nova-ax/ax-docs`
- 담당 영역: 명세 추적, 변경 이력 감시, 연동 규격 검토, 이전 안내서
- 기반 모델: `copilot`, `mlx`

## 오늘 수행한 핵심 업무

- 미커밋 구성과 구현 변경을 직접 검토했습니다. `hermes` 프로바이더는 API 방식에서 `codex` 명령 기반 CLI 방식으로 전환되었고, 모델은 `qwen3:30b-a3b`에서 `gpt-5.6-terra`로, 비용 표기는 무료에서 유료로 변경되었습니다.
- `src/utils/mlx-models.ts`에서 `hermes`가 MLX 별칭 대상에서 제거되었고, `src/agent/agent-manager.ts`와 `src/agent/orchestrated-loop.ts`에는 `hermes`를 `codex` 계열로 처리하는 분기가 추가된 것을 확인했습니다.
- `CLAUDE.md`에는 여전히 9개 에이전트라고 적혀 있으나 `config/ai-providers.json`의 `id` 항목은 13개로 집계되어 문서와 구성 사이의 불일치를 확인했습니다.
- `CHANGELOG`로 시작하는 파일 검색 결과가 없고, `src/server/monitor.ts`에서 `provider_failed` 참조가 검색되지 않아 변경 이력 및 실패 이벤트 가시성의 공백을 기록했습니다.

## 진행 중 이슈와 다음 액션

- `hermes` 전환 관련 네 파일은 미커밋 상태입니다. 최종 규격과 커밋 여부는 소스 소유 팀의 확인이 필요합니다.
- `CLAUDE.md`의 에이전트 수와 `hermes` 역할 설명을 현재 구성과 일치시키는 문서 정정안을 준비합니다.
- 변경 이력 파일 도입 여부를 결정한 뒤, 도입 시 `hermes` 백엔드 전환의 영향 범위와 이전 안내를 기록합니다.
- `provider_failed` 표시 여부는 관측성 담당 팀과 확인합니다.

## 변경 파일 목록

- `REPORTS/2026-07-19-Docs-Spec-Agent-오전.md`

## 핵심 변경 요약

- 오전 업무에서 확인한 명세·구성 불일치, 변경 이력 공백, 관측성 공백 및 후속 조치를 기록했습니다.
- 코드와 구성 파일은 수정하지 않았습니다.

## 검증 기록

- `npm run build`를 실행했고 출력은 다음과 같습니다.

```text
> neural-cli-orchestrator@1.0.0 build
> tsc
```

- 근거 등급 1: 위 타입 검사 출력, `config/ai-providers.json`과 관련 소스의 차이 내용, `CLAUDE.md` 내용, 파일 검색 결과를 직접 확인했습니다.

## 미검증·남은 항목

- `hermes`의 실제 명령 실행, 헬스 검사, 호출 성공 여부는 실행하지 않아 미검증입니다.
- 미커밋 변경의 최종 확정과 문서 정정 반영 여부는 미검증입니다.
