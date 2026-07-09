import { describe, expect, it } from 'vitest';
import { buildTeamProjectPrompts } from './conductor-prompts.js';

describe('buildTeamProjectPrompts', () => {
  it('injects team design into implementation and review prompts', () => {
    const prompts = buildTeamProjectPrompts(
      '팀 만들어서 프로젝트 진행',
      '{"lead":"opencode","engineer":"codex","reviewer":"cursor-agent"}',
    );

    expect(prompts.implementation).toContain('[Team-Project/구현]');
    expect(prompts.implementation).toContain('[팀 설계 결과]');
    expect(prompts.implementation).toContain('"lead":"opencode"');
    expect(prompts.review).toContain('[Team-Project/설계리뷰]');
    expect(prompts.review).toContain('"reviewer":"cursor-agent"');
  });

  it('falls back cleanly when team design output is empty', () => {
    const prompts = buildTeamProjectPrompts('팀 만들어서 프로젝트 진행', '   ');

    expect(prompts.implementation).toContain('팀 설계 결과 없음');
    expect(prompts.review).toContain('팀 설계 결과 없음');
  });
});
