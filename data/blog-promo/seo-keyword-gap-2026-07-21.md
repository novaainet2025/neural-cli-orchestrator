# 누락 SEO 키워드 갭 분석 — Nova Money Hub (2026-07-21)

- 데이터 소스 (T1):
  - 로컬 키워드 자산 6건: `data/blog-promo/2026-07-{07,09,10}.md` + `backlog-{ai-side-hustle,chatgpt-money-ideas,bitcoin-strategy}.md`
  - 블로그 실측: Blogger JSON 피드 전수 136/136건 (2026-07-21 조회, 제목·URL·라벨)
- 검색량/트래픽 수치는 **포함하지 않음** — Search Console·Ahrefs 등 미연동 (아래 미검증항목 참조)

---

## 1. 현재 키워드 자산 현황

로컬에 존재하는 SEO 키워드는 총 28개, 클러스터는 단 3개뿐:

| 클러스터 | 키워드 수 | 출처 |
|---|---|---|
| ChatGPT 수익화 | 13 | 2026-07-07.md, 2026-07-10.md, backlog-chatgpt |
| AI 사이드허슬/패시브인컴 | 10 | 2026-07-09.md, backlog-ai-side-hustle |
| Bitcoin/크립토 | 5 | backlog-bitcoin-strategy |

## 2. 발견된 갭 (전부 T1 실측 근거)

### G1 — 홍보 패키지 3건 전부 원문-키워드 불일치 (치명)
홍보 패키지가 참조하는 원문 URL 3건이 **모두 다른 주제로 재작성됨** (Blogger는 재작성 시 슬러그 유지):

| 패키지 | 원문 URL 슬러그 | 패키지 키워드 주제 | 현재 실제 제목 |
|---|---|---|---|
| 2026-07-10.md | chatgpt-prompts-for-making-money | ChatGPT prompts | How to Earn Passive Income Through Crypto Staking 2026 |
| 2026-07-09.md | ai-side-hustle-ideas-2026 | AI side hustles | How to Dollar Cost Average Bitcoin for Long Term Wealth in 2026 |
| 2026-07-07.md | how-to-use-chatgpt-prompts-for-making | ChatGPT prompts | How to Earn Passive Income Through Crypto Staking 2026 |

→ 기존 키워드 자산 28개 중 상당수가 **존재하지 않는 콘텐츠를 가리킴**. 내부링크 제안도 동일하게 무효.

### G2 — 제목 연도 스테일 "2024" 12건
2026년 시점에 제목에 "2024"가 남은 게시글 12건 (연도 키워드 상실 + CTR 저하 요인):
ChatGPT Prompts to Make Money in 2024 / AI Automation Side Income in 2024 (No Coding) / DeFi Explained Simply 2024 Guide / ChatGPT Side Hustle Machine (2024) / ChatGPT 7 Proven Strategies (2024) / AI Automation Free Tools 2024 / Best Dividend ETF 2024 / REITs vs Rental Property 2024 / DeFi 12%+ APY (2024) / $1,200/Month AI Automation (2024) / S&P 500 Long-Term Strategy (2024) / FIRE Build Wealth (2024)

### G3 — 제목 중복 (키워드 카니벌라이제이션) 9그룹 21건
동일 제목이 복수 URL에 존재 — 검색엔진이 어느 글을 랭킹할지 분산됨:
- x4: Freelance Writing Business Using AI Tools 2026
- x3: Crypto Staking 2026 / x3+x2: VOO vs SPY (표기만 다른 사실상 동일 제목 5건)
- x2: AI Digital Products / Paycheck to Paycheck / Invest $100 a Month / Midjourney Art / DCA Bitcoin

### G4 — 라벨(태그) 보일러플레이트
136건 대부분이 동일 5종 라벨('Finance Tips', 'Investing', 'Nova Money Lab', 'Personal Finance', 'Wealth Building')만 부착. 주제 라벨은 자동 잘림으로 파손됨('The Complete', 'Ai Side', 'The 2026' 등). 라벨 기반 토픽 허브/내부링크 구조 부재.

### G5 — 누락 키워드 클러스터 (블로그에 콘텐츠는 있으나 키워드 자산 0)
실측 게시글 기준, 아래 클러스터는 글이 존재하는데 SEO 키워드가 한 건도 정의돼 있지 않음:

| 누락 클러스터 | 해당 게시글 예 | 제안 키워드 (제목 기반 도출, 검색량 미검증) |
|---|---|---|
| ETF/인덱스 투자 | VOO vs VTI, QQQ vs SPY, Best ETFs 2026, DCA | best ETF to buy now 2026, VOO vs VTI comparison, ETF dollar cost averaging strategy, dividend ETF monthly income |
| 은퇴/절세 계좌 | 401(k), Backdoor Roth, FIRE, 4% rule | backdoor Roth IRA 2026, Roth IRA vs 401k, FIRE movement guide 2026, 4 percent rule retirement |
| 예산/신용 | Zero-based budget, 50/30/20, credit 580→700 | zero based budgeting for beginners, boost credit score fast 2026, 50 30 20 budget rule |
| 현금관리 | HYSA, CD ladder, cashback apps/cards | high yield savings account 2026, CD ladder strategy, best cashback credit cards 2026 |
| 크리에이터 수익화 | TikTok/YouTube monetization, affiliate | TikTok monetization guide 2026, YouTube monetization requirements, affiliate marketing for beginners 2026 |
| 크립토 확장 | staking, DeFi, NFT, altcoin, ETH vs BTC | crypto staking passive income 2026, DeFi yield farming risks, Ethereum vs Bitcoin 2026 |
| 부동산 | REITs vs rental, REITs $1000 | how to invest in REITs for beginners, REITs vs rental property |

## 3. 최적화 권고 (우선순위순)

1. **P0 — G1 정합화**: 홍보 패키지 3건을 폐기 또는 현재 실제 제목 기준으로 재생성. 내부링크 제안은 실측 URL 목록과 대조 후 갱신.
2. **P0 — G3 중복 해소**: 중복 21건 중 그룹당 1건만 남기고 나머지는 canonical 지정 또는 삭제/리다이렉트 (수동 검토 필요 — 삭제는 사람 승인 후).
3. **P1 — G2 연도 갱신**: "2024" 제목 12건 → "2026" 갱신 (본문 수치도 함께 검토).
4. **P1 — G5 키워드 자산 확충**: 위 7개 누락 클러스터에 클러스터당 5개 키워드 패키지 생성 (기존 daily-blog-promo.sh 파이프라인 재사용 가능).
5. **P2 — G4 라벨 체계 재정비**: 보일러플레이트 5종 → 토픽 라벨 체계(ETF/Retirement/Crypto/AI Income/Budgeting/Creator)로 교체.

## 4. 미검증항목
- 키워드 검색량·경쟁도·현재 랭킹 (Search Console/Ahrefs/SEMrush 미연동 — 제안 키워드는 실측 제목 기반 도출일 뿐 수요 정량화 안 됨)
- 게시글 본문 내부의 키워드 밀도/메타디스크립션 (피드는 제목·라벨만 제공, 본문 전수 분석 미수행)
- content-planning 팀 보고서(2026-07-21)의 "검색량 23%/15% 증가" 수치 — retired-local-provider 생성 T4, 근거 데이터 없음, 본 분석에 미사용
- 게시글 삭제/리다이렉트 실행 — 외부 시스템 변경이므로 사람 승인 전 미실행
