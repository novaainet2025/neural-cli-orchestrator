/**
 * provider-drift.test.ts — 프로바이더 목록과 라우팅 코드의 드리프트 감시.
 *
 * 배경: 2026-07-29 nvidia 퇴출 때, config/ai-providers.json 에서 이미 사라진
 * copilot·aider 가 adaptive-scorer 의 prior 와 tier-policy 의 WORKER_TIER 에
 * 남아 있는 것이 발견됐다. 이런 유령 id 는 조용히 라우팅 후보에 섞이고,
 * 프로바이더를 뺄 때 "다 지웠다"는 착각을 만든다.
 *
 * 이 테스트가 지키는 것:
 *   1) 라우팅이 실제로 내놓는 후보에는 미등록 id 가 절대 없다 (엄격).
 *   2) 새 하드코딩으로 유령이 늘어나지 않는다 (기존 잔재는 아래 목록으로 동결).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  registeredProviderIds,
  filterRegistered,
  resolvePreference,
  capabilityRank,
  derivedTier,
  isRegistered,
} from '../src/core/provider-registry.js';
import { BRAIN_TIER, WORKER_TIER, LAYER_TIER_AGENTS, tierOf } from '../src/core/tier-policy.js';

const SRC = resolve(import.meta.dirname, '../src');

/**
 * config 에 없지만 src 에 아직 남아 있는 id 들(2026-07-29 기준 스냅샷).
 *
 * 대부분 과거 프로바이더(aider/copilot/openrouter/mlx/openclaw)이거나
 * 프로바이더가 아닌 토큰(openai=SDK 벤더명, vllm=로컬 서버 종류)이다.
 * 이 목록은 "이미 알고 있는 빚"이고, 여기 없는 새 id 가 등장하면 테스트가 깨진다.
 * 정리할 때는 목록에서 지우면 된다 — 다시 들어오면 실패한다.
 */
const KNOWN_LEGACY_IDS = new Set([
  'aider', 'copilot', 'openrouter', 'mlx', 'openclaw', 'openai', 'vllm',
  'gemini', 'gemini-deep', 'mithosis', 'miso', 'remote-mlx',
]);

/** 따옴표 안의 id 꼴 리터럴. */
const ID_LITERAL = /'([a-z][a-z0-9]*(?:-[a-z0-9]+)*)'/g;
/** 한 줄 배열 리터럴 — 라우팅 순서표는 거의 이 꼴이다. */
const ARRAY_LITERAL = /\[[^[\]\n]*\]/g;
/** 객체 리터럴 한 덩어리 — cold-start prior 처럼 id 를 키로 쓰는 표. */
const OBJECT_LITERAL = /\{[^{}\n]*\}/g;
/** 객체 키 꼴 (따옴표 있든 없든). */
const KEY_TOKEN = /(?:'([a-z][a-z0-9-]*)'|\b([a-z][a-z0-9-]*))\s*:/g;

/**
 * "프로바이더 목록"으로 보이는 덩어리에서 id 를 수집한다.
 *
 * 판별 근거: 라우팅 표는 프로바이더를 나란히 나열한다. 따라서 한 덩어리 안에
 * 등록된 프로바이더 id 가 하나라도 있으면, 같은 덩어리의 다른 id 토큰도
 * 프로바이더로 간주한다. 이 방식이라야 "아직 아무도 모르는 새 유령"도 잡힌다
 * (알려진 id 만 훑으면 신규 유령은 영원히 통과한다).
 */
function collectProviderMentions(text: string, known: Set<string>): Set<string> {
  const found = new Set<string>();

  const scan = (chunks: RegExpMatchArray | null, extract: (chunk: string) => string[]): void => {
    for (const chunk of chunks ?? []) {
      const ids = extract(chunk);
      // 라우팅 표는 프로바이더를 여러 개 나란히 적는다. 등록 id 가 2개 이상일
      // 때만 "프로바이더 목록"으로 본다 — 1개면 역량 키워드 목록에 프로바이더
      // 이름이 하나 섞인 경우(intent-parser 등)와 구별되지 않는다.
      const hits = ids.filter((id) => known.has(id)).length;
      if (hits < 2) continue;
      // 목록의 과반이 프로바이더여야 한다. 그래야 프로바이더 2개 + 키워드 다수인
      // 혼합 배열을 라우팅 표로 오인하지 않는다.
      const recognised = ids.filter((id) => known.has(id) || KNOWN_LEGACY_IDS.has(id)).length;
      if (recognised * 2 <= ids.length) continue;
      for (const id of ids) found.add(id);
    }
  };

  scan(text.match(ARRAY_LITERAL), (chunk) =>
    [...chunk.matchAll(ID_LITERAL)].map((match) => match[1]));
  scan(text.match(OBJECT_LITERAL), (chunk) =>
    [...chunk.matchAll(KEY_TOKEN)].map((match) => match[1] ?? match[2]));

  return found;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

describe('provider registry — 라우팅 결과에 미등록 프로바이더가 없다', () => {
  it('tier 순서표는 등록된 프로바이더만 남긴다', () => {
    const known = registeredProviderIds();
    for (const id of filterRegistered(BRAIN_TIER)) expect(known.has(id)).toBe(true);
    for (const id of filterRegistered(WORKER_TIER)) expect(known.has(id)).toBe(true);
  });

  it('Commander 4-Layer 배정은 전부 등록된 프로바이더다', () => {
    const known = registeredProviderIds();
    for (const [layer, agents] of Object.entries(LAYER_TIER_AGENTS)) {
      for (const id of agents) {
        expect(known.has(id), `${layer} 계층의 '${id}' 가 config 에 없다`).toBe(true);
      }
      expect(agents.length, `${layer} 계층이 비었다`).toBeGreaterThan(0);
    }
  });

  it('capabilityRank 는 등록된 프로바이더만 반환한다', () => {
    const known = registeredProviderIds();
    for (const taskType of ['design', 'code', 'review', 'verify', 'research', 'ui', 'media', 'general'] as const) {
      for (const id of capabilityRank(taskType)) expect(known.has(id)).toBe(true);
    }
  });

  it('resolvePreference 는 퇴출 id 를 떨어뜨리고 신규 id 를 편입한다', () => {
    const anyRegistered = [...registeredProviderIds()][0];
    // 퇴출된 id 는 선언돼 있어도 결과에 남지 않는다
    expect(resolvePreference(['nvidia', anyRegistered])).toEqual([anyRegistered]);
    // 선언에 없어도 역량이 맞는 등록 프로바이더는 뒤에 편입된다
    const research = resolvePreference([anyRegistered], 'research');
    expect(research[0]).toBe(anyRegistered);
    expect(research.length).toBeGreaterThanOrEqual(1);
    // 중복은 제거된다
    expect(resolvePreference([anyRegistered, anyRegistered])).toEqual([anyRegistered]);
  });

  it('tierOf 는 순서표에 없는 등록 프로바이더도 config 기준으로 분류한다', () => {
    for (const id of registeredProviderIds()) {
      expect(tierOf(id), `${id} 의 tier 를 판정하지 못했다`).not.toBe('unknown');
    }
    expect(derivedTier('nvidia')).toBe('unknown');
    expect(isRegistered('nvidia')).toBe(false);
  });
});

describe('provider registry — 신규 하드코딩 드리프트 감시', () => {
  it('src 에 새로운 미등록 프로바이더 id 가 등장하지 않았다', () => {
    const known = registeredProviderIds();
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf-8');
      for (const id of collectProviderMentions(text, known)) {
        if (known.has(id) || KNOWN_LEGACY_IDS.has(id)) continue;
        offenders.push(`${file.replace(SRC, 'src')}: '${id}'`);
      }
    }

    expect(offenders, `미등록 프로바이더 id 가 src 에 하드코딩됐다:\n${offenders.join('\n')}`)
      .toEqual([]);
  });

  it('legacy 목록은 config 와 겹치지 않는다 (정리 후 목록 갱신 강제)', () => {
    const known = registeredProviderIds();
    const stale = [...KNOWN_LEGACY_IDS].filter((id) => known.has(id));
    expect(stale, `config 에 다시 등록된 id 는 legacy 목록에서 빼야 한다: ${stale.join(', ')}`)
      .toEqual([]);
  });
});
