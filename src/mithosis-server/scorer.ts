/**
 * Mithosis Scorer — NCO QualityGate와 동일한 척도로 출력 품질 평가
 * (공정한 비교를 위해 동일 알고리즘 사용)
 */

export type TaskType = 'general' | 'code' | 'design' | 'review' | 'verify' | 'research' | 'ui' | 'media';

export interface ScoreResult {
  score: number;
  passed: boolean;
  completeness: number;
  structure: number;
  relevance: number;
  confidence: number;
}

const TASK_KEYWORDS: Record<TaskType, RegExp[]> = {
  code:     [/```/, /function|const|let|var|class|import|export|async/, /return|if|for/],
  design:   [/아키텍처|architecture|interface|schema|구조|설계/, /단계|phase|layer/, /고려사항|trade.?off/],
  review:   [/문제|issue|버그|bug|개선|improvement/, /추천|recommend|제안/],
  verify:   [/테스트|test|검증|verify|통과|pass/, /결과|result|확인/],
  research: [/분석|analysis|결론|conclusion|요약|summary/, /참고|source/],
  ui:       [/컴포넌트|component|레이아웃|layout|스타일|style/, /사용자|user/],
  media:    [/이미지|image|영상|video|생성|generate/],
  general:  [/.+/],
};

export function scoreOutput(output: string, prompt: string, taskType: TaskType = 'general', threshold = 55): ScoreResult {
  const len = output.trim().length;
  const hasError = /\[ERROR\]|error:|exception:|traceback/i.test(output);

  // 1. 완성도 (30점)
  let completeness = 0;
  if (!hasError) {
    if (len >= 2000) completeness = 30;
    else if (len >= 800) completeness = 25;
    else if (len >= 300) completeness = 18;
    else if (len >= 100) completeness = 10;
    else completeness = 3;
  }

  // 2. 구조 (25점)
  let structure = 0;
  if (/```[\s\S]+?```/m.test(output)) structure += 8;
  if (/^#{1,3} /m.test(output)) structure += 6;
  if (/^[-*] /m.test(output)) structure += 5;
  if (/^\d+\. /m.test(output)) structure += 3;
  if (/\*\*[^*]+\*\*/m.test(output)) structure += 3;
  structure = Math.min(25, structure);

  // 3. 관련성 (30점)
  const keywords = TASK_KEYWORDS[taskType] ?? TASK_KEYWORDS.general;
  const matched = keywords.filter(re => re.test(output)).length;
  const relevance = Math.round((matched / keywords.length) * 30);

  // 4. 확실성 (15점)
  let confidence = 15;
  const uncertain = (output.match(/모르겠|잘 모름|확실하지|uncertain|not sure|i don't know/gi) ?? []).length;
  confidence = Math.max(0, confidence - uncertain * 5);

  const score = Math.min(100, completeness + structure + relevance + confidence);
  return { score, passed: score >= threshold, completeness, structure, relevance, confidence };
}
