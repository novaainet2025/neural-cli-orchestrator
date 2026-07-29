# NCO AI 정부 기반 조직 헌장

> 창설일: 2026-07-26 (KST)
>
> 실행 원본: `db/migrations/086_nco_ai_government_foundation.sql`
>
> 범위: NCO에 필요한 5개 핵심 회사, 25개 팀, 권력분립, 자기개선·학습·협력·전문지식·자기점검 체계

## 결론

NCO의 핵심 기능을 다섯 회사로 분리한다.

| 회사 | 관리자 | 책임 | 금지 |
|---|---|---|---|
| NCO 지휘·오케스트레이션 회사 | `claude-code` | 목표, 우선순위, 배차, 협업, 사고지휘 | 자기 결정의 최종검증, 상시 직접 구현 |
| NCO 학습·진화 회사 | `opencode` | 학습, 기억, 평가, 개선안, 기술 전파 | 검증 없는 지식 승격, 프로덕션 자기변경 |
| NCO 전문기술 회사 | `codex` | 전문조사, 설계, 구현, 릴리스, 운영 | 자기 변경의 최종승인 |
| NCO 독립감사·안전 회사 | `cursor-agent` | 독립검증, 안전, 레드팀, 증거감사, 회복탄력성 | 수정 구현 소유, 근거 없는 면제 |
| NCO AI정부·공공행정 회사 | `retired-provider` | 헌정, 인간권리, HR, 자원, 투명성·이의제기 | 개별 기술 구현, 검증 면제, 인간 최종주권 침해 |

다섯 관리자는 모두 현재 `config/ai-providers.json`에서 활성화된 서로 다른 프로바이더다. 기존 리서치·자가개선·기술이식·웹스크래핑 회사는 삭제하거나 강제 이전하지 않는다. 새 회사는 NCO 전체의 헌정·통제 계층이며, 기존 회사는 도메인 실행조직으로 계속 활용한다.

## 25개 핵심 팀

### 1. NCO 지휘·오케스트레이션 회사

| 팀 | Lead | 상시 | 핵심 임무 |
|---|---|---:|---|
| Strategic Command | `claude-code` | 예 | 사용자 의도, 목표, 제약, 성공기준, 최종 지휘 |
| Mission Intake and Portfolio | `hermes` | 예 | 요청 정규화, 중복 제거, 우선순위, 소유팀 지정 |
| Orchestrator and Adaptive Routing | `hermes` | 예 | 회사·팀·프로바이더·모드·예산·폴백 배차 |
| Collaboration Mesh and Protocol | `ollama` | 예 | handoff, lease, 공유맥락, 충돌·통신 규약 |
| Incident and Continuity Command | `claude-code` | 요청 시 | 장애지휘, 중단, 복구, 롤백, 비상권한 제한 |

### 2. NCO 학습·진화 회사

| 팀 | Lead | 상시 | 핵심 임무 |
|---|---|---:|---|
| Continuous Learning | `ollama` | 예 | 결과·피드백·실패에서 검증된 교훈 추출 |
| Knowledge and Memory Stewardship | `ollama` | 예 | 지식 단일출처, provenance, 신선도, 검색·삭제 |
| Evaluation and Simulation | `retired-provider` | 예 | 기준선, eval, 반례, 회귀 한계, 재현성 |
| Self-Improvement Laboratory | `opencode` | 요청 시 | 개선 가설, 선택지, 부작용, 롤백 설계 |
| Skill Academy and Capability Transfer | `codex` | 요청 시 | 성공 절차의 기술화, 버전관리, 팀 간 전파 |

### 3. NCO 전문기술 회사

| 팀 | Lead | 상시 | 핵심 임무 |
|---|---|---:|---|
| Expert Council and Research | `retired-provider` | 요청 시 | 원자료 기반 전문지식, 불확실성, 반대 근거 |
| Systems Architecture | `opencode` | 요청 시 | 경계, 계약, 데이터 흐름, 실패·복구 설계 |
| Build and Automation | `codex` | 요청 시 | 승인 범위 구현, 테스트, 자동화, 롤백 |
| Integration and Release | `codex` | 요청 시 | 독립검증된 산출물 통합, 단계 배포·롤백 |
| Platform Reliability and Operations | `hermes` | 예 | PM2, 용량, 관측성, 백업, 복구 리허설 |

### 4. NCO 독립감사·안전 회사

| 팀 | Lead | 상시 | 핵심 임무 |
|---|---|---:|---|
| Independent Verification | `cursor-agent` | 예 | 수용검사 재실행, PASS·REJECT·BLOCKED 판정 |
| Security Privacy and Safety | `cursor-agent` | 예 | 보안, 개인정보, 권한, 공급망, 인간 영향 |
| Red Team and Adversarial Review | `retired-provider` | 요청 시 | 악용, 권한상승, 담합, 보상해킹, 정부 포획 |
| Evidence Audit and Compliance | `ollama` | 예 | 영수증, 출처, 승인, Gap, 잔여위험 감사 |
| Reliability and Resilience Review | `retired-provider` | 예 | SLO, 장애격리, 상태 신선도, 복구 증거 |

### 5. NCO AI정부·공공행정 회사

| 팀 | Lead | 상시 | 핵심 임무 |
|---|---|---:|---|
| Constitution and Policy | `retired-provider` | 예 | 목적, 권한경계, 금지행위, 개정·비상절차 |
| Rights Ethics and Human Sovereignty | `retired-provider` | 예 | 인간통제, 동의, 존엄, 공정, 이의제기 |
| HR Capability and Lifecycle | `cursor-agent` | 예 | 역할·역량·성과·승계·개선·소프트퇴출 |
| Treasury and Resource Stewardship | `hermes` | 요청 시 | 컴퓨트, 모델 호출, 예산, 쿼터, 용량 |
| Transparency Appeals and Public Record | `cursor-agent` | 예 | 결정기록, 정정 이력, 독립 재심, 이의제기 |

각 팀은 Lead를 포함한 등록 프로바이더 3명으로 구성된다. 프로바이더의 런타임 가용성은 로컬 정책·회로·쿼터에 따라 바뀔 수 있으며, 비가용 시에도 해당 팀에 선언된 다른 member 안에서만 failover하고 실행 가능한 member가 없으면 닫힌 상태로 실패한다. 상세 member 목록과 완전한 상시임무는 실행 원본 마이그레이션이 단일 진실 원천이다.

## 권력분립과 실행 흐름

1. AI정부 회사가 권한·정책·인간 최종주권 경계를 유지한다.
2. 지휘 회사가 요청을 미션으로 정규화하고 성공기준·소유권·중단조건을 정한다.
3. 학습 회사가 기존 근거·기억·평가 기준을 제공하고, 전문기술 회사가 설계·구현한다.
4. 독립감사 회사가 구현팀과 별도로 검증을 재실행한다.
5. 실패하면 지휘 회사가 수정 사이클을 재배차한다. 감사 회사가 직접 수정하지 않는다.
6. 통과하면 전문기술 회사가 단계적으로 릴리스하고, 감사 회사가 관찰창을 판정한다.
7. AI정부 회사가 중요한 결정과 이의제기 경로를 보존하고, 학습 회사가 검증된 결과만 지식화한다.

### 헌정 게이트

- 한 주체가 `지휘 + 구현 + 최종검증`을 동시에 소유할 수 없다.
- 구현팀의 테스트 성공은 독립검증을 대체하지 않는다.
- 고위험·파괴적 조치는 지휘 회사와 독립감사 회사의 두 열쇠가 필요하다.
- 감사 회사는 거부권을 가지지만 수정 구현을 직접 소유하지 않는다.
- 정책 변경은 제안, 영향평가, 독립감사, 기록을 거친다.
- 인간은 최종주권자이며 언제든 중단·수정·이의제기를 요구할 수 있다.
- 자연어 합의나 완료 보고는 T1 증거를 대체하지 않는다.

### 실행 불변조건

`src/core/company-orchestrator.ts`는 위 헌장을 다음 런타임 게이트로 강제한다.

- 5개 회사는 `pipeline` 모드만 허용한다. `parallel` 요청은 HTTP 400으로 거부한다.
- 회사별 manager가 창설 계약과 다르면 실행을 HTTP 409로 거부한다.
- 목표 분해 권한은 회사별 지정 manager에게만 있다. 지정 manager가 불가용하면 타 회사 manager로 권한을 넘기지 않고 결정론적 template 분해로 닫는다.
- 회사별 활성 팀은 승인된 5개와 정확히 일치해야 한다. 누락팀과 미승인 추가팀 모두 HTTP 409 대상이다.
- DB의 이름·생성순서와 관계없이 회사별 헌정 stage 순서를 고정한다.
- 일반 태스크 큐가 회사 밖 프로바이더로 자동 재위임하는 경로를 차단한다. 단계 failover는 선언된 팀 구성 안에서 처리한다.

| 회사 | 강제 stage 순서 |
|---|---|
| 지휘 | strategic → intake → routing → collaboration → incident |
| 학습·진화 | learning → memory → evaluation → improvement → skills |
| 전문기술 | experts → architecture → build → release → reliability |
| 독립감사·안전 | safety → red-team → verification → resilience → audit |
| AI정부·공공행정 | constitution → rights → HR → treasury → transparency |

## 자기개선 폐루프

`관찰 → 학습 → 평가 → 개선안 → 지휘 승인 → 전문 구현 → 독립검증 → 단계 릴리스 → 감사 → 지식 승격`

이 루프에서 학습 회사는 개선안을 제안하지만 자기 코드를 직접 프로덕션에 반영하지 않는다. 전문기술 회사는 구현하지만 자기 변경을 최종 승인하지 않는다. 독립감사 회사는 판정하지만 수정 코드를 소유하지 않는다. 이 분리가 NCO의 자기개선을 자기정당화가 아닌 검증 가능한 진화로 만든다.

## 창설 목표

| 회사 | 최초 지표 | 목표 |
|---|---|---:|
| 지휘 | 소유자·제약·수용기준·독립판정이 있는 미션 | 95% |
| 학습 | 회귀 없이 재사용된 검증 학습 | 70% |
| 전문기술 | 최초 독립검증 통과 변경 | 90% |
| 독립감사 | T1 영수증·Gap·잔여위험이 있는 고위험 변경 | 100% |
| AI정부 | 권한기록·이의제기 경로가 있는 중요 결정 | 100% |

측정 전 현재값은 0이며 자동으로 달성 처리하지 않는다. HR은 25개 팀을 계속 평가할 수 있다. 권력분립과 연속성에 필요한 최소 9개 통제팀만 퇴출 보호되며, 나머지 팀은 성과에 따라 개선·보호관찰·소프트퇴출 대상이 된다.

## 기존 조직과의 관계

- `org_nco-self`: 새 학습·진화 회사의 개선안을 실행하는 기존 자기개선 전문회사로 활용할 수 있다.
- `org_research`: 전문기술 회사가 호출하는 도메인 리서치 실행회사다.
- `org_technology-porting`, `org_web-scraping`, `org_computer-use`: 지휘 회사가 목표별로 오케스트레이션하는 전문 실행회사다.
- `org_nco-triad-ultra`: 중요한 변경에서 지휘·구현·도전 검토를 제공하는 고성능 실행 셀이다.
- 기존 회사·팀의 소속, 활성상태, 헌장은 이번 창설에서 변경하지 않는다.

## 운영 명령

```bash
# 창설 마이그레이션 적용
npm run migrate

# 회사 확인
sqlite3 -json db/nco.db \
  "SELECT id,name,manager,parent_id FROM organizations WHERE id LIKE 'org_nco-%' ORDER BY id;"

# 25개 팀과 배치 확인
sqlite3 -json db/nco.db \
  "SELECT organization_id,count(*) AS teams FROM teams WHERE slug LIKE 'gov-%' GROUP BY organization_id;"

# 조직 단위 실행 예시
/nco-company run nco-command "요청을 검증 가능한 미션으로 분해하고 실행하라" --pipeline
```

DB의 회사·팀 레코드는 실행 구조를 제공하지만, 모든 상시팀의 자동 실행 주기를 새로 추가하지는 않는다. 실제 예약은 기존 NCO cron과 HR 생애주기 체계가 관리해야 하며, 비용·중복·폭주 위험을 검토한 뒤 별도로 확대한다.

## 설계 검증

- NCO Conductor 호출은 30초 동안 무응답이어서 규칙에 따라 직접 `opencode` 태스크로 폴백했다.
- NCO 설계 검토 태스크: `task_7Ua3hanwkqyN0imT`.
- 검토의 핵심인 지휘·학습·검증·정부의 권력분리는 반영했다.
- 검토가 제안한 비활성/미등록 실행자와 기존 리서치 회사 중복은 현재 DB·provider T1 조회를 근거로 제외했다.
- 자동 테스트는 회사 5개, 회사당 팀 5개, 총 25개, 활성 프로바이더, lead/member 일치, 권력분립 lead, 목표 5개, 보호팀 9개와 마이그레이션 재실행 안전성을 검증한다.
