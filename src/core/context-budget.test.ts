import { describe, expect, it } from 'vitest';
import {
  COMPRESS_TARGET_TOKENS,
  ContextBudget,
  DEFAULT_BUDGET_TOKENS,
  MAX_PLAN_CHARS,
  compressPlan,
  estimateTokens,
  summarize,
} from './context-budget.js';

describe('estimateTokens', () => {
  it('빈 문자열은 0 토큰', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('문자수/4 휴리스틱 (올림)', () => {
    expect(estimateTokens('a'.repeat(4))).toBe(1);
    expect(estimateTokens('a'.repeat(5))).toBe(2); // ceil(5/4)
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });

  it('비어있지 않으면 최소 1 토큰', () => {
    expect(estimateTokens('a')).toBe(1);
  });
});

describe('summarize', () => {
  it('목표 이하이면 원본을 그대로 반환', () => {
    const text = 'short text';
    expect(summarize(text, { targetChars: 100 })).toBe(text);
  });

  it('초과 시 앞/뒤 발췌 + 생략 마커를 삽입하고 결정론적', () => {
    const text = 'x'.repeat(1000);
    const out = summarize(text, { targetChars: 100, headRatio: 0.6 });
    expect(out).toContain('…[900 chars omitted]…'); // 1000 - 60 - 40
    expect(out).toBe(summarize(text, { targetChars: 100, headRatio: 0.6 })); // 결정론적
    // 발췌 부분은 원본의 접두/접미와 일치
    expect(out.startsWith('x'.repeat(60))).toBe(true);
    expect(out.endsWith('x'.repeat(40))).toBe(true);
  });

  it('생략된 문자수 회계가 정확', () => {
    const text = 'abcdefghij'.repeat(50); // 500자
    const out = summarize(text, { targetChars: 100, headRatio: 0.6 });
    const match = out.match(/…\[(\d+) chars omitted\]…/);
    expect(match).not.toBeNull();
    const omitted = Number(match![1]);
    expect(omitted).toBe(500 - 60 - 40);
  });
});

describe('compressPlan', () => {
  it('작은 plan은 원본 유지', () => {
    const text = 'small plan';
    expect(compressPlan(text)).toBe(text);
  });

  it('목표 토큰(~1500) 초과 plan은 압축', () => {
    const text = 'y'.repeat(COMPRESS_TARGET_TOKENS * 4 + 5000);
    const out = compressPlan(text);
    expect(out.length).toBeLessThan(text.length);
    expect(out).toContain('chars omitted');
    // 압축 결과는 대략 목표 토큰 근처
    expect(estimateTokens(out)).toBeLessThanOrEqual(COMPRESS_TARGET_TOKENS + 20);
  });

  it('100KB 초과 텍스트는 요약본으로 대체', () => {
    const text = 'z'.repeat(MAX_PLAN_CHARS + 1);
    const out = compressPlan(text);
    expect(out).toContain('chars omitted');
    expect(out.length).toBeLessThan(MAX_PLAN_CHARS);
  });
});

describe('ContextBudget', () => {
  it('기본 한도는 128k', () => {
    const b = new ContextBudget();
    expect(b.limit).toBe(DEFAULT_BUDGET_TOKENS);
  });

  it('add는 태스크별로 합산되고 total에 반영', () => {
    const b = new ContextBudget({ limit: 1000 });
    b.add('t1', 100);
    b.add('t1', 50);
    b.add('t2', 200);
    expect(b.usageOf('t1')).toBe(150);
    expect(b.usageOf('t2')).toBe(200);
    expect(b.total()).toBe(350);
    expect(b.remaining()).toBe(650);
  });

  it('addText는 추정하여 누적', () => {
    const b = new ContextBudget({ limit: 1000 });
    const added = b.addText('plan', 'a'.repeat(400)); // 100 토큰
    expect(added).toBe(100);
    expect(b.usageOf('plan')).toBe(100);
  });

  it('shouldCompact는 임계(기본 0.8) 이상에서 true', () => {
    const b = new ContextBudget({ limit: 1000, compactThreshold: 0.8 });
    b.add('t', 799);
    expect(b.shouldCompact()).toBe(false);
    b.add('t', 1); // 800 → 정확히 0.8
    expect(b.shouldCompact()).toBe(true);
  });

  it('isOverBudget는 한도 초과 시 true', () => {
    const b = new ContextBudget({ limit: 100 });
    b.add('t', 100);
    expect(b.isOverBudget()).toBe(false); // 같으면 초과 아님
    b.add('t', 1);
    expect(b.isOverBudget()).toBe(true);
    expect(b.remaining()).toBe(0); // 음수 클램프
  });

  it('breakdown/reset 동작', () => {
    const b = new ContextBudget();
    b.add('a', 10);
    b.add('b', 20);
    expect(b.breakdown()).toEqual([
      { taskId: 'a', tokens: 10 },
      { taskId: 'b', tokens: 20 },
    ]);
    b.reset();
    expect(b.total()).toBe(0);
  });

  it('잘못된 인자는 거부', () => {
    expect(() => new ContextBudget({ limit: 0 })).toThrow();
    expect(() => new ContextBudget({ compactThreshold: 1.5 })).toThrow();
    const b = new ContextBudget();
    expect(() => b.add('t', -1)).toThrow();
  });
});
