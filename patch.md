Improvement cycle=1/3.
Use actual NCO task evidence to identify the root cause and implement a bounded, reversible fix.
Run relevant tests/build, record evidence, and do not fabricate metrics.

[팀 하위작업: 자가개선팀]
무엇: 자가학습팀이 규명한 근본원인이 team-scorer.ts/task-intake/gateway의 코드 결함으로 확인될 경우에 한해, 해당 실패 유형(예: never-ran acked·heartbeat NULL 태스크나 silent-failure empty 형제 태스크)을 완료율/점수 산정에서 제외하는 bounded·reversible 패치를 작성하고, `npx tsc --noEmit`(오류 0) + 관련 vitest(team-scorer.test.ts 등) + `npm run build`로 검증.
왜: content-quality 팀의 점수 저하가 실제 성능이 아닌 산정 오류에서 왔다면 소스 수정으로 정직한 completion 반영이 필요.

[출력형식] (자동 보강) 변경 파일 목록 + 핵심 diff 요약.

[검증기준] (자동 보강) cd /Users/nova-ai/project/nco && 빌드/타입체크 통과.

[장기 기억 컨텍스트 (자동 검색됨)]
- [score:0.84,bm25] [task_gXOl0YfOzZpPeIPw] Q: [회사 목표] [HR DIRECTIVE] Improve team 고품질 검수팀 (content-quality, team_content-quality). Current score=88.8, completion=92.3%, sample=48h/13. Improvement cycle=1/3. Use actual NCO task evidence to identif