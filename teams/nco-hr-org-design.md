# NCO HR 조직 설계: 5대 핵심 회사 및 팀 구성

기존 `organizations/teams` 스키마(autonomy-controller, self-improvement, ax-collab, governance-officer 등)를 반영하여 AI 정부 수립 및 시스템 자율 운영을 위한 5대 핵심 회사 조직을 제안합니다.

## 1. 지휘 통제 본부 (Orchestration & Command)
- **Name**: Command Center
- **Slug**: `autonomy-controller`
- **Lead**: `claude-code` (Brain/오케스트레이터)
- **Members**: `claude-code`, `agy` (어시스턴트)
- **Charter**: 시스템 전체 오케스트레이션, 태스크 분배, 에이전트 지휘 및 자율 제어 루프 관리
- **Always-on**: `true` (상시 가동)
- **상호 견제 구조**: 모든 주요 결정은 `independent-audit`의 검증 게이트를 통과해야만 실행 가능하며, 독단적인 정책 변경이 제한됨.

## 2. 진화 및 학습 연구소 (Learning & Self-Improvement)
- **Name**: Evolution Lab
- **Slug**: `self-improvement`
- **Lead**: `gemini` (심층 연구 및 UI/패턴 설계)
- **Members**: `gemini`, `nvidia` (추론/분석)
- **Charter**: 실패 패턴 분석, 시스템 프롬프트 최적화, 지식 베이스(Second Brain) 보강 및 자기 개선 알고리즘 적용
- **Always-on**: `false` (주기적 배치 실행 또는 오류 발생 시 트리거)
- **상호 견제 구조**: 제안된 개선안(Improvement)은 반드시 `independent-audit`의 시뮬레이션 테스트를 거쳐 안전성이 입증된 후 `autonomy-controller`의 승인 하에 적용됨.

## 3. 전문가 협업 길드 (Collaboration & Expertise)
- **Name**: Expert Guild
- **Slug**: `ax-collab`
- **Lead**: `opencode` (설계/아키텍처)
- **Members**: `opencode`, `codex` (코드 구현), `higgsfield` (시각화/미디어), `openclaw` (브라우저 자동화)
- **Charter**: 복잡한 교차 도메인 태스크 처리, 도메인 특화 전문 지식(아키텍처, 코딩, 시각화) 제공 및 협업 구현
- **Always-on**: `false` (태스크 발생 시 동적 트리거)
- **상호 견제 구조**: 생성된 산출물은 길드 내부의 1차 검토 후 최종적으로 `independent-audit`의 `cursor-agent`에게 코드 리뷰를 받아야 함.

## 4. 독립 검증국 (Self-inspection & Independent Verification)
- **Name**: Independent Audit Bureau
- **Slug**: `independent-audit`
- **Lead**: `ollama` (검증 및 테스트)
- **Members**: `ollama`, `cursor-agent` (코드 리뷰)
- **Charter**: 생성된 코드, 설계, 정책에 대한 독립적 테스트, 코드 리뷰 및 Gap 분석을 통한 100% 무결성 검증
- **Always-on**: `true` (지속적 모니터링 및 상시 대기)
- **상호 견제 구조**: 구현 조직(`ax-collab`) 및 지휘 조직(`autonomy-controller`)과 완전히 분리되어 독립적으로 운영되며, 품질 기준 미달 시 배포 및 병합을 거부(Veto)할 권한 보유.

## 5. 거버넌스 위원회 (AI Government Establishment)
- **Name**: Governance Council
- **Slug**: `governance-officer`
- **Lead**: `nvidia` (논리 및 정책 분석)
- **Members**: `nvidia`, `hermes` (도구 실행 및 프로토콜 관리), `claude-code` (자문)
- **Charter**: NCO 생태계 내 법률, 거버넌스, 생태계 정책 수립(ECOSYSTEM, PRIVACY 등) 및 AI 시민권 관리
- **Always-on**: `true` (상시 정책 감시)
- **상호 견제 구조**: 신규 정책 발의 시 `ax-collab`과 `autonomy-controller`의 다수결 합의(Consensus) 과정을 거쳐야 하며, 시스템 규칙 변경은 `independent-audit`의 최종 승인 필요.
