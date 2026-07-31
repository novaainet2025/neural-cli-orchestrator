# Nova-AX 정기 감사 보고 — org_nco-government / company-scope

- 최종 판정: approved (6/6)
- 승인 runId: `vrun_5d26ae3d-d702-4d91-9093-bce581abbfbf`
- receiptId: `vrcpt_0c26a0c3-a470-4dff-8af0-afd07863c3c2`
- receipt consumption: `vuse_d4a2ca5e-5e2f-4dbd-b358-cff6409d3bfa`
- 완료 eventId: `audit-completion-29caa0c0-52d5-4269-98a2-5f32732ea888`
- audit_required directive: `vdir_4d570e05-ab03-4772-ae2d-a4f54b53ab83` (`completed`)

## 기관별 판정

| 기관 | 판정 | 실패 | 증거 참조 |
|---|---|---:|---|
| inspection | passed | 0 | `c13d81d90fa51ebf2e5f7d42adfd88f14d17cc7d69b23e44b89fdb95b7ce0985` |
| validation | passed | 0 | `c13d81d90fa51ebf2e5f7d42adfd88f14d17cc7d69b23e44b89fdb95b7ce0985` |
| measurement | passed | 0 | `829e966d05870391223047d4838f85383f6628b3cb6c6000620d03bfd795ea74` |
| performance | passed | 0 | `b3589b00ffccb479407e70ed1965c82ef89b1239fcaa86504ecb85fe0f156b94` |
| optimization | passed | 0 | `24f87b1aea61b3a87d029acfc8f53fe049ed611cfaae0269c22b0f83d812e914` |
| goal | passed | 0 | 위 4개 증거 해시 전부 |

## 반시드 루프

첫 실행 `vrun_8b895f99-b881-4592-ab1f-787cec7f1465`은 4/6으로 반려됐다.

- loopId: `vloop_367538a9-48b3-46d7-a59e-134fd33e449b`
- loop 상태: `completed`
- iteration: `1`
- attemptId: `vattempt_fa2cb0b7-08b1-4bbc-aeeb-858845762abb`
- attempt 판정: `approved`
- latestRunId: `vrun_5d26ae3d-d702-4d91-9093-bce581abbfbf`
- 조치: inspection 1건, validation 2건 모두 `resolved`
- 열린 company-scope loop: 0

## 결박 검증

운영 SQLite 원장에서 승인 run, receipt, consumption, completion event의
`taskId/companyId/teamId/actorId/evidenceDigest` 결박을 재조회했다.

- taskId: `task_jJHlFjEeTXAUXqOO`
- companyId: `org_nco-government`
- teamId: `company-scope`
- actorId: `cursor-agent`
- evidenceDigest: `2c3d24ea43b625c0fc28a7156a30649ab2021ca3dca0ef8f3d449fa2477c1717`
- 완료 이벤트 action: `task_complete`

독립 재검증 결과:

- NCO DB integrity: `ok`
- Nova-AX 운영 DB integrity: `ok`
- 증거 무결성 테스트: 5/5 pass
- 직접 관찰 artifact SHA-256과 inspection/validation 참조: 일치
- 테스트 로그 SHA-256과 performance 참조: 일치
- 운영 원장 교차검증 항목: 16/16 true

## 증거 경로

- 직접 관찰 산출물:
  `/Users/nova-ai/project/nova-ax/evidence/org_nco-government/company-scope/2026-07-30/company-scope-audit-bundle.json`
- 제출·HTTP 응답·loop attempt·완료 이벤트:
  `/Users/nova-ai/project/nco/data/nova-ax-audit-staging/org_nco-government/company-scope/2026-07-30/audit-submission-result.json`
- 검증 제출 payload:
  `/Users/nova-ai/project/nco/data/nova-ax-audit-staging/org_nco-government/company-scope/2026-07-30/verification-submission.json`
- 독립 테스트 로그:
  `/Users/nova-ai/project/nco/data/nova-ax-audit-staging/org_nco-government/company-scope/2026-07-30/verification-suite.log`
- 운영 원장 재수집:
  `/Users/nova-ai/project/nco/evidence/nova-ax/org_nco-government/company-scope/2026-07-30/ground-truth.json`
- 결박 판정:
  `/Users/nova-ai/project/nco/evidence/nova-ax/org_nco-government/company-scope/2026-07-30/ground-truth-check.json`

## 남은 실패

범위 내 검증 실패와 열린 반시드 루프는 없다.

현재 실행 셸에서는 Nova-AX `:6300` 직접 헬스 조회가 실패하고 PM2 pid가 살아 있지
않은 것으로 관찰됐다. 이 런타임 관찰은 이미 운영 원장에 소비된 승인 영수증과
완료 이벤트를 무효화하지 않지만, 서비스 상시성은 별도 운영 점검 대상이다.
