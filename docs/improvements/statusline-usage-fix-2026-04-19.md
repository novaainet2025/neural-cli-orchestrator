# 개선: Statusline 사용량 표시 버그 3건 수정

**날짜**: 2026-04-19 | **브랜치**: platform/mac

## 문제

1. **Bar 미표시**: `9%`인데 `░░░░░░░░` — 정수 나눗셈 절삭(`9*8/100=0`)
2. **숫자 고착**: 실제 20%인데 1시간 전 캐시값 9% 계속 표시 — 갱신 로직 없음
3. **고정 색상**: 1일=초록, 주별=파랑으로 고정 — 위험도 미반영

## 수정

| 항목 | 내용 |
|------|------|
| `make_bar()` | `(pct*w+99)/100` 올림 — 1%라도 최소 1칸 |
| `_refresh_usage_cache()` | TTL 180초 만료 시 OAuth API 자동 호출 |
| `color_for_pct()` | <50% 초록, 50-79% 노랑, ≥80% 빨강 |

## 수정 파일

- `.claude/hooks/nco-statusline.sh`
- `~/.claude/hooks/anthropic-usage-bars.inc.sh`
