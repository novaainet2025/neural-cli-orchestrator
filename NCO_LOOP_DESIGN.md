# NCO Closed Self-Correction Loop 설계안 (Round 2)

## 1. 닫힌 자기교정 루프(Closed Loop) 상태머신 패턴
기존의 단발성(Open Loop) 실행을 대체하기 위해 `src/core/harness-orchestrator.ts`에 다음 상태머신을 내장합니다.
- **상태 흐름**: `PLAN` → `EXECUTE` → `VERIFY` → 분기(`pass: DONE` | `fail: DIAGNOSE` → `REFINE` → `EXECUTE`)
- **3요소 매핑**: 
  - **목적지 Rubric**: `PLAN` 단계에서 생성되는 명시적 검증 기준(테스트 코드, 체크리스트).
  - **피드백 현위치**: `VERIFY` 단계에서 실행된 도구(쉘, API)의 실제 출력값(Ground Truth).
  - **재탐색**: `DIAGNOSE` 단계에서 실패 원인을 파악하고 `REFINE`에서 계획을 수정하여 다시 `EXECUTE`로 진입.

## 2. 작업자와 검증자 분리 원칙 (Separation of Duties)
- **규칙**: 작업자(`EXECUTE`)와 검증자(`VERIFY`)는 절대 동일한 Provider 모델이 될 수 없도록 제한합니다.
- **배정 로직**: `src/core/smart-router.ts`를 확장하여, 작업자가 `codex`였다면 검증자는 반드시 `opencode` 등 타 모델로 강제 할당합니다. 이는 AI가 자신의 출력을 맹목적으로 옳다고 판정하는 확증편향을 원천 차단합니다.

## 3. 5단계 메모리 루프 배선 (Semantic Memory 연동)
기존 `src/core/semantic-memory.ts`의 단방향 저장을 루프형 지식체계로 배선합니다.
1. **[실패기록]**: `VERIFY` 실패 시점의 에러 로그와 컨텍스트를 메모리에 임시 적재.
2. **[원인조사]**: `DIAGNOSE` 상태의 에이전트가 실패기록을 분석해 근본 원인(Root Cause) 도출.
3. **[사실검증]**: `src/security/evidence-gate.ts`를 통해 추측이 아닌 T1 증거(파일, DB)로 원인을 확인.
4. **[규칙정제]**: 해결된 패턴을 일반화된 스킬(SSOT) 규칙으로 정제하여 영구 메모리에 업데이트.
5. **[다음작업 참조]**: 후속 `PLAN` 단계 진입 전 메모리를 검색(Retrieval)하여 동일 실패를 방지.

## 4. 적대적 검토 (Adversarial Review) 내장
- **위치**: `VERIFY` 직후, `src/core/quality-gate.ts`의 최종 검문소(Quality Gate)로 위치.
- **책임**: "이 작업은 반드시 실패 조건이 숨어있다"는 적대적 스탠스로 Edge Case, 리소스 누수, 보안 취약점을 공격적으로 탐색.
- **통과 기준**: 적대적 검토자가 제기한 취약점에 대해, 방어 로직이 구현되었음을 입증하는 **직접 증거(T1 실측 근거)**가 제시되어야만 `DONE` 상태로 전이. (자연어 주장은 기각)
