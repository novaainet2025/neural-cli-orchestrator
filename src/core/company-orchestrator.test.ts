import { describe, it, expect } from 'vitest';
import {
  rankTeam,
  orderTeams,
  resolveExecutor,
  resolveDecomposer,
  resolveDecomposers,
  parseDecomposition,
  parsePortDecision,
  buildDecompositionPrompt,
  allowQueueProviderFailover,
  scopeDecomposedSubtask,
  templateSubtask,
  isSubstantiveOutput,
  type TeamRow,
} from './company-orchestrator.js';

function team(partial: Partial<TeamRow> & { slug: string; name: string }): TeamRow {
  return {
    id: `team_${partial.slug}`,
    lead: null,
    charter: null,
    description: null,
    members: [],
    ...partial,
  };
}

describe('rankTeam', () => {
  it('기술 이식 회사의 번호 stage를 안전 순서 그대로 랭크', () => {
    expect(rankTeam(team({ slug: 'tech-port-03-recovery-checkpoint', name: '복구 지점팀' }))).toBe(3);
    expect(rankTeam(team({ slug: 'tech-port-08-migration-implementation', name: '이식 실행팀' }))).toBe(8);
  });
  it('research 팀들을 파이프라인 단계 순서로 랭크', () => {
    expect(rankTeam(team({ slug: 'research-strategy', name: '리서치 기획·전략팀' }))).toBe(1);
    expect(rankTeam(team({ slug: 'research-discovery', name: '탐색·수집팀' }))).toBe(2);
    expect(rankTeam(team({ slug: 'research-analysis', name: '분석·추론팀' }))).toBe(4);
    expect(rankTeam(team({ slug: 'research-verification', name: '검증·팩트체크팀' }))).toBe(5);
    expect(rankTeam(team({ slug: 'research-writing', name: '집필·리포팅팀' }))).toBe(6);
    expect(rankTeam(team({ slug: 'research-visualization', name: '시각화·미디어팀' }))).toBe(7);
  });

  it('cli 팀들도 설계→코어→qa 순서로 랭크', () => {
    expect(rankTeam(team({ slug: 'cli-design', name: 'CLI UI/UX 디자인팀' }))).toBe(1);
    expect(rankTeam(team({ slug: 'cli-core', name: 'CLI 코어 개발팀' }))).toBe(3);
    expect(rankTeam(team({ slug: 'cli-qa', name: 'CLI 검증/QA팀' }))).toBe(5);
  });

  it('매칭 안 되는 팀은 99', () => {
    expect(rankTeam(team({ slug: 'legal-counsel', name: 'Legal Counsel' }))).toBe(99);
  });

  it('charter에 타 단계 키워드가 섞여도 slug/name 기준으로만 랭크(오염 무시)', () => {
    // 실제 org_research charter 발췌: 분석팀 charter에 "수집자료", 전략팀에 "탐색수집팀 핸드오프"
    expect(rankTeam(team({
      slug: 'research-analysis', name: '분석·추론팀 (Analysis)',
      charter: '③ 심층 분석·추론. 수집자료→패턴 추론, 클레임을 검증팀 핸드오프',
    }))).toBe(4);
    expect(rankTeam(team({
      slug: 'research-strategy', name: '리서치 기획·전략팀',
      charter: '① 리서치 질문 정의·방법론 설계. 탐색수집팀 핸드오프',
    }))).toBe(1);
  });
});

describe('parsePortDecision', () => {
  it('명시적 단일 승인 또는 거부만 허용', () => {
    expect(parsePortDecision('요약\nPORT_DECISION: APPROVE\n근거')).toBe('approve');
    expect(parsePortDecision('PORT_DECISION: REJECT')).toBe('reject');
  });

  it('결정 누락·상충은 fail-closed undetermined', () => {
    expect(parsePortDecision('이식할 만해 보입니다')).toBe('undetermined');
    expect(parsePortDecision('PORT_DECISION: APPROVE\nPORT_DECISION: REJECT')).toBe('undetermined');
  });
});

describe('orderTeams', () => {
  it('랭크 오름차순으로 정렬하되 동률은 원래 순서 유지', () => {
    const input = [
      team({ slug: 'research-visualization', name: 'Viz' }),
      team({ slug: 'research-strategy', name: 'Strategy' }),
      team({ slug: 'research-analysis', name: 'Analysis' }),
      team({ slug: 'research-discovery', name: 'Discovery' }),
    ];
    const ordered = orderTeams(input).map((t) => t.slug);
    expect(ordered).toEqual([
      'research-strategy', 'research-discovery', 'research-analysis', 'research-visualization',
    ]);
  });

  it('미매칭 팀(99)은 뒤로 밀리되 서로 간엔 생성순 유지', () => {
    const input = [
      team({ slug: 'legal', name: 'Legal' }),
      team({ slug: 'research-strategy', name: 'Strategy' }),
      team({ slug: 'sales', name: 'Sales' }),
    ];
    expect(orderTeams(input).map((t) => t.slug)).toEqual(['research-strategy', 'legal', 'sales']);
  });
});

describe('resolveExecutor', () => {
  const known = new Set(['opencode', 'codex', 'ollama', 'nvidia']);
  it('lead 가 등록 프로바이더면 lead 사용', () => {
    expect(resolveExecutor(team({ slug: 'a', name: 'A', lead: 'codex' }), known)).toBe('codex');
  });
  it('lead 가 미등록이면 등록된 첫 member 사용', () => {
    expect(resolveExecutor(team({ slug: 'a', name: 'A', lead: 'mlx-instruct', members: ['bogus', 'nvidia'] }), known)).toBe('nvidia');
  });
  it('lead·member 모두 미등록이면 fallback(ollama)', () => {
    expect(resolveExecutor(team({ slug: 'a', name: 'A', lead: 'mlx-instruct', members: ['bogus'] }), known)).toBe('ollama');
  });

  it('리밋(서킷open) 걸린 lead 는 건너뛰고 가용한 member 사용', () => {
    // opencode 는 등록됐지만 현재 불가용 → member nvidia 로 폴백
    const avail = (id: string) => id !== 'opencode' && known.has(id);
    expect(resolveExecutor(
      team({ slug: 'a', name: 'A', lead: 'opencode', members: ['nvidia'] }), known, 'ollama', avail
    )).toBe('nvidia');
  });

  it('lead·member·fallback 전원 리밋이면 등록된 lead 라도 반환(디스패치 failover 에 위임)', () => {
    const avail = (_id: string) => false; // 전원 차단
    expect(resolveExecutor(
      team({ slug: 'a', name: 'A', lead: 'codex', members: ['nvidia'] }), known, 'ollama', avail
    )).toBe('codex');
  });
});

describe('resolveDecomposer', () => {
  const known = new Set(['opencode', 'claude-code', 'codex']);
  it('manager 토큰이 등록 프로바이더면 사용', () => {
    expect(resolveDecomposer('codex', known)).toBe('codex');
  });
  it('manager 가 "claude-1 (Commander)" 처럼 비프로바이더면 opencode 로 폴백', () => {
    expect(resolveDecomposer('claude-1 (Commander·두뇌)', known)).toBe('opencode');
  });
  it('알려진 게 없으면 null', () => {
    expect(resolveDecomposer('whatever', new Set())).toBeNull();
  });
});

describe('resolveDecomposers (후보 체인)', () => {
  it('manager 우선 + 선호순서, 중복 제거', () => {
    const known = new Set(['opencode', 'claude-code', 'nvidia', 'codex', 'ollama']);
    expect(resolveDecomposers('nvidia', known)).toEqual(['nvidia', 'opencode', 'claude-code', 'codex', 'ollama']);
  });
  it('manager 가 비프로바이더면 선호순서만', () => {
    const known = new Set(['opencode', 'ollama']);
    expect(resolveDecomposers('claude-1 (Commander)', known)).toEqual(['opencode', 'ollama']);
  });
  it('선호 목록에 없는 provider만 있으면 그거라도 1개 반환', () => {
    expect(resolveDecomposers(null, new Set(['weird-provider']))).toEqual(['weird-provider']);
  });
  it('아무것도 없으면 빈 배열', () => {
    expect(resolveDecomposers(null, new Set())).toEqual([]);
  });

  it('리밋(서킷open) 걸린 후보는 제외 — opencode 불가용이면 다음 순위부터', () => {
    const known = new Set(['opencode', 'claude-code', 'nvidia', 'ollama']);
    const avail = (id: string) => id !== 'opencode' && known.has(id);
    expect(resolveDecomposers('opencode', known, avail)).toEqual(['claude-code', 'nvidia', 'ollama']);
  });

  it('전원 리밋이면 등록된 것 중 하나라도 시도용으로 반환', () => {
    const known = new Set(['opencode', 'ollama']);
    const avail = (_id: string) => false;
    expect(resolveDecomposers('opencode', known, avail).length).toBe(1);
  });
});

describe('parseDecomposition', () => {
  const teams = [team({ slug: 'a', name: 'A' }), team({ slug: 'b', name: 'B' })];
  it('순수 JSON 파싱', () => {
    expect(parseDecomposition('{"a":"작업A","b":"작업B"}', teams)).toEqual({ a: '작업A', b: '작업B' });
  });
  it('```json 코드펜스 제거', () => {
    const raw = '설명문\n```json\n{"a":"작업A","b":"작업B"}\n```\n뒷말';
    expect(parseDecomposition(raw, teams)).toEqual({ a: '작업A', b: '작업B' });
  });
  it('설명 사이 중괄호 추출 + 미등록 slug/빈값 제거', () => {
    const raw = '여기 있습니다: {"a":"작업A","zzz":"무시","b":""} 끝';
    expect(parseDecomposition(raw, teams)).toEqual({ a: '작업A' });
  });
  it('중첩 중괄호/문자열 내 괄호도 균형 추출', () => {
    const raw = '{"a":"코드 {block} 포함","b":"작업B"}';
    expect(parseDecomposition(raw, teams)).toEqual({ a: '코드 {block} 포함', b: '작업B' });
  });
  it('JSON 없음/파싱 실패 시 null', () => {
    expect(parseDecomposition('그냥 텍스트', teams)).toBeNull();
    expect(parseDecomposition('{깨진 json', teams)).toBeNull();
    expect(parseDecomposition('', teams)).toBeNull();
  });
});

describe('buildDecompositionPrompt', () => {
  it('목표·팀 slug·역할을 포함하고 JSON-only 지시', () => {
    const p = buildDecompositionPrompt('리서치 컴퍼니', '주제 X 리서치', [
      team({ slug: 'research-strategy', name: '전략팀', charter: '리서치 계획 수립', lead: 'opencode' }),
    ]);
    expect(p).toContain('주제 X 리서치');
    expect(p).toContain('research-strategy');
    expect(p).toContain('리서치 계획 수립');
    expect(p).toMatch(/JSON/);
  });
});

describe('isSubstantiveOutput (빈 산출물 게이트)', () => {
  it('실제 실패 사례: 수집팀 "done: verified" 45자 → 비실질', () => {
    expect(isSubstantiveOutput('done: [Evidence Tier 1] file/content verified')).toBe(false);
  });
  it('빈/공백/null → 비실질', () => {
    expect(isSubstantiveOutput('')).toBe(false);
    expect(isSubstantiveOutput(null)).toBe(false);
    expect(isSubstantiveOutput('   ')).toBe(false);
  });
  it('done: 서두 뒤 실질 본문이 충분하면 실질', () => {
    const body = 'done: 수집 완료\n\n' + '조달우수 지정제도 관련 조달청 고시 제2024-XX호, 신청자격, 심사기준, 제출서류를 다음과 같이 수집했다. '.repeat(4);
    expect(isSubstantiveOutput(body)).toBe(true);
  });
  it('짧은 실질 내용(200자 미만)도 비실질로 게이트', () => {
    expect(isSubstantiveOutput('조달우수는 조달청 제도다.')).toBe(false);
  });
});

describe('templateSubtask', () => {
  it('목표+역할 포함', () => {
    const s = templateSubtask(team({ slug: 'a', name: '분석팀', charter: '데이터 분석' }), '매출 분석');
    expect(s).toContain('매출 분석');
    expect(s).toContain('분석팀');
    expect(s).toContain('데이터 분석');
  });
});

describe('scopeDecomposedSubtask', () => {
  it('LLM 하위작업 앞에 원래 회사 목표를 강제 포함', () => {
    const s = scopeDecomposedSubtask(
      team({ slug: 'a', name: '분석팀', charter: '데이터 분석' }),
      'Cognee 부분 이식 검증',
      '공식 자료와 벤치마크를 조사한다.',
    );
    expect(s).toContain('[회사 목표] Cognee 부분 이식 검증');
    expect(s).toContain('[팀 하위작업: 분석팀]');
    expect(s).toContain('공식 자료와 벤치마크를 조사한다.');
  });

  it('분해 결과가 없으면 결정론적 템플릿 사용', () => {
    const s = scopeDecomposedSubtask(
      team({ slug: 'a', name: '분석팀', charter: '데이터 분석' }),
      'Cognee 부분 이식 검증',
    );
    expect(s).toContain('Cognee 부분 이식 검증');
    expect(s).toContain('데이터 분석');
  });
});

describe('allowQueueProviderFailover', () => {
  it('기술 이식 회사는 팀 밖 자동 재위임을 차단', () => {
    expect(allowQueueProviderFailover('technology-porting')).toBe(false);
  });

  it('일반 회사의 기존 failover 동작은 유지', () => {
    expect(allowQueueProviderFailover('research')).toBe(true);
  });
});
