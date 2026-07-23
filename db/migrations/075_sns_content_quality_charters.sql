-- SNS 블로그 파이프라인 역할을 Google helpful content/E-E-A-T 기준으로 강화한다.
-- 실제 팀 ID와 teams.charter/updated_at 컬럼만 사용한다.
UPDATE teams
SET charter = 'nova-money-hub 블로그 주제를 기획한다. 각 기획에 검색의도, 타깃 독자의 구체 문제, 기존 글과 다른 차별점, 원문·데이터·실사례로 입증할 근거 계획, 독자가 얻을 실행 가능한 결과를 명시한다. 확인하지 않은 트렌드·검색량·수치·사례는 지어내지 말고 미확인과 필요한 조사 방법을 적는다.',
    updated_at = datetime('now')
WHERE id = 'team_content-planning';

UPDATE teams
SET charter = '@전담러너(daily-blog-promo.sh 07:10)가 nova-money-hub 최신 글의 실제 URL과 RSS 원문 내용을 근거로 Pinterest/Medium/X 홍보 패키지를 만든다. 독자 문제 해결, 깊이 있는 오리지널 관점, 원문에 있는 구체 데이터·실사례, E-E-A-T 신호와 한계를 포함하고 제목만으로 추측하거나 내용을 지어내지 않는다. 키워드 스터핑·과도한 해시태그·얇은 반복·일반론을 금지한다. team_content-quality 종합 80점 이상 PASS 후에만 패키지를 확정하며, 게시는 반드시 사람이 검토 후 수동으로 진행한다.',
    updated_at = datetime('now')
WHERE id = 'team_sns';

UPDATE teams
SET charter = 'content-quality PASS를 받은 최신 홍보 패키지를 게시 전 최종 감사한다. 원문 대비 거짓 수치·과장·맥락 왜곡, AI-spam·키워드 스터핑·얇은 반복, 해시태그·이모지 과다, Pinterest/Medium/X 채널 적합성, 각 X 문구 280자 미만, 전문적이고 데이터 기반인 브랜드 톤을 확인한다. 근거가 없으면 지어내지 말고 미확인으로 표시하며, 문제별 위치·이유·수정안을 제시한다. 감사 결과와 무관하게 자동 게시하지 않는다.',
    updated_at = datetime('now')
WHERE id = 'team_quality-audit';
