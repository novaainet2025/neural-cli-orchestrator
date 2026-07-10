/**
 * prompt-gate.ts — 5필드 구조화 지시 게이트 (하네스 v1)
 * ------------------------------------------------------------------
 * 소형모델 워커의 지시 오해석을 줄이기 위해 위임 프롬프트가
 * [컨텍스트]/[목표]/[제약]/[출력형식]/[검증기준] 5필드를 갖추도록
 * intake 시점에 검사(analyzePrompt)·보강(enrichPrompt)한다.
 *
 * 사용 예:
 *   const a = analyzePrompt('[컨텍스트] nco 백엔드\n[목표] 버그 수정');
 *   // a.score === 40, a.missing === ['제약','출력형식','검증기준']
 *   const p = enrichPrompt(prompt, { projectDir: '/x', taskType: 'bugfix' });
 *
 * 순수 함수 — 외부 의존성·상태 없음. (생성: mlx, 교정: claude-1 2026-07-09)
 */

interface SectionSpec {
  label: string;
  /** `[라벨]` 대괄호형, `라벨:` 콜론형, 영문 동의어 모두 인정 */
  pattern: RegExp;
  suggestion: string;
  defaultTemplate: (d: EnrichDefaults) => string;
}

export interface EnrichDefaults {
  projectDir?: string;
  taskType?: string;
}

const SECTIONS: readonly SectionSpec[] = [
  {
    label: '컨텍스트',
    pattern: /\[(컨텍스트|Context)\]|(?:^|\n)\s*(컨텍스트|Context)\s*:/i,
    suggestion: '[컨텍스트]에 대상 경로·현재 상태 등 최소 배경을 명시하세요.',
    defaultTemplate: d =>
      `[컨텍스트] 프로젝트: ${d.projectDir ?? '(미지정)'} / 작업 유형: ${d.taskType ?? '(미지정)'}`,
  },
  {
    label: '목표',
    pattern: /\[(목표|Objective|Goal)\]|(?:^|\n)\s*(목표|Objective|Goal)\s*:/i,
    suggestion: '[목표]에 수행할 행동 1개를 동사로 명시하세요.',
    defaultTemplate: () => '[목표] (자동 보강) 위 요청 내용을 단일 목표로 간주하고 수행.',
  },
  {
    label: '제약',
    pattern: /\[(제약|Constraints?)\]|(?:^|\n)\s*(제약|Constraints?)\s*:/i,
    suggestion: '[제약]에 수정 범위·금지 사항을 명시하세요.',
    defaultTemplate: () => '[제약] (자동 보강) 요청 범위 밖 파일 수정 금지. 기존 동작 회귀 금지.',
  },
  {
    label: '출력형식',
    pattern: /\[(출력형식|Output\s*Format)\]|(?:^|\n)\s*(출력형식|Output\s*Format)\s*:/i,
    suggestion: '[출력형식]에 기대 출력(diff/JSON/파일 목록)을 명시하세요.',
    defaultTemplate: () => '[출력형식] (자동 보강) 변경 파일 목록 + 핵심 diff 요약.',
  },
  {
    label: '검증기준',
    pattern: /\[(검증기준|Validation|Verification)\]|(?:^|\n)\s*(검증기준|Validation|Verification)\s*:/i,
    suggestion: '[검증기준]에 기계 판정 가능한 통과 조건(빌드/테스트)을 명시하세요.',
    defaultTemplate: d =>
      `[검증기준] (자동 보강) ${d.projectDir ? `cd ${d.projectDir} && ` : ''}빌드/타입체크 통과.`,
  },
];

export function analyzePrompt(prompt: string): {
  score: number;
  missing: string[];
  suggestions: string[];
} {
  const missingSpecs = SECTIONS.filter(s => !s.pattern.test(prompt));
  return {
    score: Math.round(((SECTIONS.length - missingSpecs.length) / SECTIONS.length) * 100),
    missing: missingSpecs.map(s => s.label),
    suggestions: missingSpecs.map(s => s.suggestion),
  };
}

export function enrichPrompt(prompt: string, defaults: EnrichDefaults): string {
  const missingSpecs = SECTIONS.filter(s => !s.pattern.test(prompt));
  if (missingSpecs.length === 0) return prompt;
  const block = [
    '',
    '--- 자동 보강 ---',
    ...missingSpecs.map(s => s.defaultTemplate(defaults)),
  ].join('\n');
  return prompt + block;
}
