function normalizeSection(text: string | undefined, fallback: string): string {
  const normalized = text?.trim();
  return normalized ? normalized : fallback;
}

function formatTeamDesignContext(teamDesignOutput: string | undefined): string {
  const design = normalizeSection(teamDesignOutput, '팀 설계 결과 없음');
  return `[팀 설계 결과]\n${design}`;
}

export function buildTeamProjectPrompts(projectPrompt: string, teamDesignOutput?: string) {
  const teamContext = formatTeamDesignContext(teamDesignOutput);
  const normalizedProjectPrompt = projectPrompt.trim();

  return {
    implementation: [
      '[Team-Project/구현] 다음 프로젝트를 구현하라.',
      `[프로젝트 요구사항]\n${normalizedProjectPrompt}`,
      teamContext,
      '[구현 지침]',
      '- 역할 분담을 반영해 실제 코드 변경과 테스트까지 진행하라.',
      '- 필요한 경우 팀 설계에서 정의된 병렬 작업 순서를 기준으로 구현 우선순위를 정하라.',
    ].join('\n\n'),
    review: [
      '[Team-Project/설계리뷰] 다음 프로젝트의 설계·보안 리스크를 미리 분석하라.',
      `[프로젝트 요구사항]\n${normalizedProjectPrompt}`,
      teamContext,
      '[리뷰 지침]',
      '- 팀 설계와 구현 계획의 불일치, 보안 리스크, 테스트 공백을 우선 식별하라.',
      '- 구현 전에 막아야 할 위험을 구체적으로 지적하라.',
    ].join('\n\n'),
  };
}
