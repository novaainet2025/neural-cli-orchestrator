## 현재 상태 진단
- 전체 작업 100개 중 96개 완료, 0개 실패, 4개 지연(stuck) → 성공률 96%
- False report count 22 (잘못된 성공 보고) → 시스템 신뢰성 저하 위험
- Obsidian 문서 8,467개, 개선 노트 932개 존재 – 문서 관리·정비 필요

## 핵심 개선 목표 (3가지)
1. **신뢰성·검증 강화** – False report 감소, 실제 작업 상태 정확히 파악
2. **스루풋·자동화 확대** – Stuck 작업 자동 회복·분배, 반복 작업 자동화
3. **지식 관리 최적화** – Obsidian 문서와 개선 노트 체계화·연계

## 구체적 실행 계획
### 목표 1: 신뢰성·검증 강화
- **T1.1** 기존 `false_report_count` 검출 로직을 T1 증거 등급(파일/DB 직접 확인) 기반으로 수정
- **T1.2** 작업 완료 시 HTTP 200 응답 + DB 상태 확인을 검증 로깅에 추가
- **T1.3** 매 사이클 종료 시 `npm run test:integrity` 스크립트 도입 (검증 테스트 100% 통과 여부 확인)

### 목표 2: 스루풋·자동화 확대
- **T2.1** Stuck 작업 자동 감지 워커 (`src/core/worker/stuckWatcher.ts`) 구현 – 30초 이상 진행되지 않으면 재시도 또는 재배치
- **T2.2** 반복적인 `tasks_total` 증가 시 자동 스케일링 플래그 (Redis 기반 큐 길이 모니터링)
- **T2.3** CI 파이프라인에 `npm run lint && npm run build && npm test` 포함, 자동 배포 전 검증

### 목표 3: 지식 관리 최적화
- **T3.1** Obsidian 문서 메타데이터(`.obsidian` 폴더)와 개선 노트(파일명 규칙) 동기화 스크립트 (`scripts/syncObsidian.ts`)
- **T3.2** 문서 검색 인덱스 구축 – `gbrain` 툴 연계, 검색 효율 2배 향상 목표
- **T3.3** 매 사이클 말에 “Improvement Note Review” 미팅 템플릿 자동 생성 (`templates/meeting.md`)

## 자동화 가능한 부분
- 작업 상태 검증 및 보고 자동화 (GitHub Actions → `npm run test:integrity`)
- Stuck 작업 자동 복구 워커 및 재배치 로직
- Obsidian‑Improvement 노트 동기화 스크립트 – CI 단계에서 실행
- 지표 수집 및 대시보드 업데이트 (Prometheus exporter와 Grafana 대시보드)

## 다음 사이클 측정 지표
| 지표 | 목표 (다음 사이클) |
|------|-------------------|
| 성공률 | ≥ 98% |
| False report count | ≤ 5 |
| Stuck 작업 수 | 0 |
| 문서·노트 동기화 정확도 | 100% |
| 자동 복구 평균 소요시간 | < 10s |
| CI 검증 성공률 | 100% |

*위 내용은 Obsidian vault에 `Obsidian_NCO_Improvement_Strategy_2026-06-21.md` 로 저장됩니다.*