---
created_at: 2026-06-29T04:13:12.203Z
updated_at: 2026-06-30T10:57:16.486Z
tags:
  - improvement
  - improvement-note
---
## 긴급 Subnote

- **일시**: 2026-06-30 KST
- **상태**: `remote-mlx` provider crash-loop 버그 수정 완료, `origin/main` 푸시 완료
- **커밋**: `2740be4` (`fix: healthCheck 없는 provider(remote-mlx) → NCO crash-loop 수정`)
- **원인**: `remote-mlx` provider에 `healthCheck` 필드가 없을 때 `src/agent/agent-manager.ts`가 `TypeError`로 크래시 루프 진입
- **수정 파일**:
  - `src/agent/agent-manager.ts` — `healthCheck` 없으면 `status=online` 처리 가드 추가
  - `cli-installs/mlx-watchdog.sh` — `_set_provider`가 `healthCheck: { url, timeout }` 자동 주입
  - `config/ai-providers.json` — `remote-mlx` 기본 `healthCheck` 추가
- **WSL 노드 적용 순서**:
  - `cd ~/project/nco && git pull origin main`
  - `pm2 restart mlx-watchdog || pm2 start cli-installs/mlx-watchdog.sh --name mlx-watchdog --interpreter bash`
  - `pm2 save`
- **검증 포인트**:
  - `config/ai-providers.json`의 `remote-mlx.healthCheck.url` 존재 확인
  - `pm2 logs mlx-watchdog` 에서 enable/disable 토글 후 NCO crash-loop 미발생 확인
  - MLX 온라인 시 `remote-mlx enabled=true`, 오프라인 시 자동 fallback 동작 확인

## 현재 상태 진단

- **전체 태스크**: 100
- **완료**: 77 (77%)
- **실패**: 22 (22%)
- **정체**: 1 (1%)
- **허위 보고**: 17건 (완료 77건 중 약 22%)
- **Obsidian 문서**: 10,793개
- **개선 노트**: 1,022개

## 핵심 개선 목표 (3가지)

1. **허위 보고 감소** – 자동 검증과 보고 시스템 강화
2. **실제 성공률 향상** – 실패 원인 분석 및 재시도 메커니즘 도입
3. **지식 베이스 효율화** – Obsidian 문서와 개선 노트 관리 자동화

## 구체적 실행 계획

### 목표 1: 허위 보고 감소
- **자동 검증 게이트**: 모든 에이전트 작업 완료 후 `tsc --noEmit` 및 통합 테스트 실행
- **슈퍼바이저 재검증 루프**: 검증 실패 시 자동 재시도 및 신뢰 점수 감소
- **보고 포맷 표준화**: `status: success|failure|invalid` 명시적 필드 추가

### 목표 2: 실제 성공률 향상
- **실패 원인 분류**: 로그 레벨을 `error`, `timeout`, `dependency` 로 라벨링
- **재시도 정책**: 3회까지 자동 재시도, 백오프 적용
- **에이전트 신뢰 점수**: 성공/실패 비율 기반 가중치 적용, 낮은 점수 에이전트는 인간 검토 필요

### 목표 3: 지식 베이스 효율화
- **문서 자동 태깅**: 새로운 개선 노트가 생성될 때 자동으로 `#improvement` 태그 추가
- **중복 감지**: 기존 문서와 유사도 0.9 이상이면 병합 알림
- **주기적 정리**: 매주 `obsidian-cli` 로 오래된 노트(30일 미사용) 압축 및 아카이브

## 자동화 가능한 부분
- **CI 파이프라인**에 검증 게이트 삽입 (`npm run lint && npm test`)
- **GitHub Actions** 로 실패 로그 수집 및 스코어보드 업데이트
- **Obsidian Sync Script** (`obsidian-cli sync`) 를 크론에 등록하여 매일 자동 동기화
- **재시도 로직**을 `src/utils/retry.ts` 로 모듈화하여 모든 에이전트가 재사용 가능하도록 함

## 다음 사이클 측정 지표
- 허위 보고 비율 < 10%
- 전체 성공률 (검증 통과 기준) > 85%
- 평균 재시도 횟수 < 1.2회
- Obsidian 문서 중 중복 비율 < 5%
- 자동 정리된 노트 수 ≥ 200건/주

- **총 태스크**: 100
- **완료**: 76 (실제 성공률 76%)
- **실패**: 23
- **정체**: 1
- **허위 보고**: 17건 (완료 태스크 중 약 22%가 검증 실패)
- **Obsidian 문서**: 10,793개
- **개선 노트**: 1,022개
- **주요 리스크**: 허위 완료와 낮은 실질 성공률이 신뢰도와 리소스 효율성을 저해

## 핵심 개선 목표 (3가지)

1. **허위 보고 감소** – 자동 검증 및 재검증 메커니즘 도입으로 허위 완료 비율을 10% 이하로 낮춤
2. **실질 성공률 향상** – 완료 정의를 검증 통과 기반으로 전환하고, 실패 원인 분석 자동화
3. **지식베이스 효율화** – Obsidian 문서와 개선 노트 메타데이터 정리·중복 제거, 검색 성능 개선

## 구체적 실행 계획 (각 목표별)

### 1️⃣ 허위 보고 감소
- **자동 검증 게이트**: `gemma-gate-check`와 `tsc --noEmit` 및 테스트 스위트 실행을 태스크 완료 전 필수 단계로 삽입
- **Supervisor 재검증 루프**: 완료 태스크가 보고되면 2차 검증(HTTP health 체크, DB 상태) 수행, 실패 시 자동 재시도 및 에이전트 신뢰 점수 차감
- **모니터링**: 허위 보고 발생 시 알림 Slack/Discord webhook 전송, 월간 리포트 생성

### 2️⃣ 실질 성공률 향상
- **완료 기준 재정의**: `tasks_completed`를 *검증 통과* 태스크 수로 집계하도록 DB 스키마 및 로직 업데이트
- **실패 원인 자동 분류**: `src/core/errorClassifier.ts` 추가 – 오류 메시지 패턴 매칭으로 주요 원인(네트워크, DB, 코드 오류) 자동 라벨링
- **재시도 정책**: 동일 오류 3회 연속 발생 시 백오프 후 재시도, 이후에는 인간 검토 트리거

### 3️⃣ 지식베이스 효율화
- **메타데이터 스키마**: Obsidian 파일에 YAML front‑matter(`tags, created, updated, relevance`) 자동 삽입 스크립트 (`scripts/updateMetadata.ts`)
- **중복 탐지**: `rg` 기반 내용 유사도 검사 파이프라인 도입, 중복 문서 자동 병합 제안
- **검색 최적화**: `obsidian_vault/.obsidian/plugins/quick-search` 설정 조정, 인덱스 재생성 자동화 (cron weekly)

## 자동화 가능한 부분
- **CI 파이프라인**에 허위 보고 검증 단계 추가 (`.github/workflows/verify.yml`)
- **GitHook** (`pre-commit`)에서 `npm run lint && npm test && ./scripts/validate-task.ts` 실행
- **Cron 잡** (`crontab -e`)에 매일 02:00 UTC 실행: `node scripts/metadata-cleanup.js && node scripts/duplicate-check.js`
- **알림**: 허위 보고 >5건 시 `curl -X POST` 로 Slack webhook 호출 자동화

## 다음 사이클 측정 지표
- **허위 보고 비율**: 목표 ≤ 10% (전 Cycle 22% → 목표 10% 이하)
- **실질 성공률**: 목표 ≥ 85% (전 Cycle 76% → 목표 85% 이상)
- **정체 태스크**: 목표 ≤ 0.5% (전 Cycle 1% → 목표 0.5% 이하)
- **문서 검색 평균 응답 시간**: 목표 ≤ 200 ms
- **중복 문서 수**: 목표 5% 이하 감소

---
*이 문서는 Obsidian Vault의 `improvement_notes` 폴더에 저장됩니다.*
