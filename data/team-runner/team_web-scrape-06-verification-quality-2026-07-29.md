# 06 Verification and Data Quality — 일일 산출물 (2026-07-29, ai=cursor-agent, taskId=task_H1OvaZAmaYm1Mmz_)

### 변경 파일 목록
- (이 턴에서 수정한 파일 없음 — 텍스트 전용·도구/명령 금지)

### 핵심 diff 요약
- 해당 없음 (코드/파일 미변경)

---

## (1) 오늘 관찰·분석 — 2026-07-29
**역할:** Code Reviewer / Data Quality 검증  
**근거 범위:** 주입된 실데이터만. 표본 원문·스크레이프 산출물·robots/도메인/상한 설정 파일은 **미주입**.

### 운영 지표 (주입값 대조)
| 소스 | 수치 | 해석 |
|------|------|------|
| `[tasks]` 최근 7일 | 전체=23, 완료=16, 실패성=7, 진행=0, 완료율=69.6% | 완료율 과반이나 실패성 7/23(≈30.4%)로 품질 게이트 통과 주장 불가 |
| `[/api/teams]` 누계 | 전체=23, 완료=16, 실패=7, 진행=0, 대기=0, 완료율=69.6% | tasks 집계와 일치 (동일 스냅샷으로 보임) |
| `[work_reports]` 최근 7일 | late=1, missed=2, submitted=7 | 제출 7 대비 late+missed=3 → 보고 규율 결함 신호 |
| agents | codex 태스크=2652·성공률=90%·24h실패=5 / cursor-agent=3635·95%·17 / agy=641·89%·0 | cursor-agent 24h실패=17이 상대적으로 높음 (원인·작업유형 **미확인**) |

### 데이터 불일치 (증거 기반)
- 프롬프트 **Team** 블록: `codex: idle`, `cursor-agent: working (task_H1OvaZAmaYm1Mmz_)`, `opencode: working`
- 주입 **`[/api/agents]`**: `codex: working`, `cursor-agent: idle`
- → 에이전트 상태 SSOT가 스냅샷 간 불일치. **어느 쪽이 최신인지는 미확인** (도구 재조회 금지 제약).

### DQ 체크리스트 (임무 06 필수항) — 전원 미확인
| 검증항 | 판정 | 이유 |
|--------|------|------|
| 필드 정확도 (원문 대조) | **미확인** | 표본 원문·추출 필드 쌍 미주입 |
| 완전성 | **미확인** | 필수 필드 스키마·누락률 수치 없음 |
| 중복률 | **미확인** | 중복 키/해시/카운트 없음 |
| 최신성 | **미확인** | crawl/수집 타임스탬프·원문 갱신일 없음 |
| 선택자 회복 | **미확인** | selector·DOM 스냅샷·회복 로그 없음 |
| robots 준수 | **미확인** | robots.txt·crawl 정책 증거 없음 |
| 허용 도메인 | **미확인** | allowlist 설정·위반 로그 없음 |
| 출력 상한 | **미확인** | max output/size 한도·초과 이벤트 없음 |
| 비신뢰 콘텐츠 표지 | **미확인** | untrusted/sanitized 마커 샘플 없음 |

**거부 사항:** 위 항목에 대해 “검증 완료/PASS/정상 유지” 주장은 **증거 없음으로 전부 거부**. 장기기억의 과거 06 Verification 응답도 T4(다른 에이전트 자연어)에 해당하며 오늘 근거로 채택하지 않음.

---

## (2) 현재 상태
- **업무 유형:** bugfix 컨텍스트로 보강됨 — 단, 어떤 버그·어떤 파일인지는 **미확인** (경로/재현 절차 미주입).
- **팀 태스크 건강도:** 7일 완료율 69.6%, 실패 7건 잔존. 진행·대기=0.
- **보고 품질:** work_reports late=1, missed=2 → 검증 영수증·정시 제출 체계에 갭.
- **데이터 품질 게이트:** **BLOCKED / 검증 불가** — 표본 원문 대조 자료 부재.
- **Evidence Tier:** **Tier 3** (주입된 API/집계 상태 문자열·카운트). 파일 본문·HTTP 실응답·DB row는 본 턴에서 **미관측** (도구 금지).
- **이 턴 수행하지 않은 것:** 파일 수정, 빌드, 테스트, git, 원문 대조, robots/도메인 실측 — 전부 미수행. 성공/완료로 표기하지 않음.

---

## (3) 다음에 필요한 작업 제안
1. **상태 SSOT 재조회 (T1):** `GET /api/agents`와 Team heartbeat를 동일 시각에 재수집해 codex/cursor-agent 상태 불일치 해소.
2. **표본 원문 팩 주입 (T1):** 도메인별 N≥3 표본에 대해 `{url, fetched_at, raw_excerpt, extracted_fields, selectors}`를 검증 입력으로 제공 — 그 전까지 06 게이트 PASS 금지.
3. **실패 7건 분류:** tasks 실패성 7의 `error_code`/`team_id`/`artifact_path` 목록 수집 → 데이터 품질 실패 vs 실행 실패 분리.
4. **cursor-agent 24h실패=17 원인 샘플링:** 최근 실패 로그 상위 유형·재현 1건 첨부 요구 (현재 원인 **미확인**).
5. **가드레일 정적 증거 첨부:** robots 정책, allowlist, output cap, untrusted 표지 적용 여부를 설정 파일 발췌 또는 HTTP 응답 헤더/필드로 제출 — 자연어 “유지됨”만으로는 반려.
6. **work_reports 규율:** missed=2·late=1 건의 task_id·마감시각·실제 제출시각 대조 후 재발 방지 규칙 제안 (수치만으로는 조치 소유자 **미확인**).

---

## 검증 영수증
- [변경] 없음 (텍스트 전용)
- [검증방법] 주입 실데이터 수치 대조만 수행. 도구/명령/파일 읽기 **미실행**
- [등급] T3 (집계·상태 문자열). 원문/파일/HTTP body = **미관측**
- [Gap] DQ 필수 9항 전원 미확인 → 데이터 품질 검증 완료율 **0%** (운영 지표 서술만 가능)
- [미검증항목] 필드정확도·완전성·중복률·최신성·선택자회복·robots·허용도메인·출력상한·비신뢰표지; 에이전트 상태 불일치의 진실값; bugfix 대상 파일/재현

done: 06 Verification and Data Quality — **REJECT/BLOCKED**. 운영 집계(tasks 23/16/7·69.6%, work_reports late1/missed2/submitted7, agents 수치)는 주입값과 일치 확인. 표본 원문 대조·가드레일 유지 증거 부재로 성공 주장 거부. [Evidence Tier 3] injected counters/status strings only; Tier 1 file/HTTP/DB unverified.
