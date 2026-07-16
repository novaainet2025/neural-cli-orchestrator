/**
 * echo-filter.ts — 에이전트 출력에 "에코된 소스코드/상태 리포트" 라인을 식별하는 공용 필터
 * ------------------------------------------------------------------------------------
 * 배경(2026-07-15, 오탐 1~5호 T1 실증): NCO 내부 코드를 다루는 태스크에서 에이전트가
 * 오류 분류기 정규식 소스나 상태 브리프("gate=probe(quota)")를 인용/에코하면,
 * 텍스트 기반 실패 분류기가 이를 실제 프로바이더 오류로 오인해 서킷을 열거나
 * 태스크를 failed로 마킹했다. 실패 신호 스캔 전에 이런 라인을 제외해야 한다.
 *
 * 단일 소스: orchestrated-loop.ts:26의 ECHO_LINE_RE(3세대, claude-2)와 동일 패턴.
 * 두 파일이 이 모듈을 공유하도록 수렴 예정 — 패턴 수정은 반드시 여기서만.
 */

export const ECHO_LINE_RE =
  /gate=|sr=\d+%|\bprobe\(|[\w@./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|py|go|rs|md|txt):\d+|\b(?:const|let|var|function|import|export|return)\b|=>|\(\?:/i;

/** 에코로 판정되는 라인을 제거한 텍스트를 반환 (라인 구조 보존). */
export function stripEchoLines(text: string): string {
  return text
    .split('\n')
    .filter(line => !ECHO_LINE_RE.test(line))
    .join('\n');
}
