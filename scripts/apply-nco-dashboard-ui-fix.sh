#!/bin/bash
set -euo pipefail
ROOT="/Users/nova-ai/project/nco-dashboard"
python3 <<'PY'
from pathlib import Path

css_path = Path("/Users/nova-ai/project/nco-dashboard/src/App.css")
css = css_path.read_text()

old1 = """.refresh-btn:hover {
  color: #4CAF50;
  border-color: #4CAF5066;
}

.ws-dot {"""

new1 = """.refresh-btn:hover {
  color: #4CAF50;
  border-color: #4CAF5066;
}

/* 긴 한글 라벨은 aria-label/title로 유지하고, 좁은 데스크톱에서만 축약 표시 */
.top-bar-btn-text { display: inline; }

/* 키보드 탐색 시 브라우저 기본 outline과 일관된 포커스 링 */
.top-bar button:focus-visible,
.refresh-btn:focus-visible,
.graph-overlay-dock button:focus-visible,
.panel-collapse-toggle:focus-visible,
.graph-layout-controls input[type='range']:focus-visible {
  outline: 2px solid #a78bfa;
  outline-offset: 2px;
}

.ws-dot {"""

if old1 not in css:
    raise SystemExit('CSS block 1 not found')
css = css.replace(old1, new1, 1)

old2 = """@media (max-width: 760px) {
  .graph-overlay-dock.with-memory { right: 14px; top: 46px; }
  .graph-memory-overlay { transform: scale(.84); transform-origin: top right; }
  .graph-hud-stack { left: 14px; top: 52px; }
  .graph-hud-stack.with-activity { top: 220px; }
  .graph-activity-ticker { left: 14px; right: 48px; }
}

/* ── Graph Canvas ──────────────────── */"""

new2 = """@media (max-width: 760px) {
  .graph-overlay-dock.with-memory { right: 14px; top: 46px; }
  .graph-memory-overlay { transform: scale(.84); transform-origin: top right; }
  .graph-hud-stack { left: 14px; top: 52px; }
  .graph-hud-stack.with-activity { top: 220px; }
  .graph-activity-ticker { left: 14px; right: 48px; }
}

/* MEM+HUD 동시 펼침 시 우상단 도크·메모리 패널 겹침 방지 */
@media (max-width: 480px) {
  .graph-overlay-dock {
    top: auto;
    bottom: 12px;
    left: 14px;
    right: auto;
  }
  .graph-overlay-dock.with-memory {
    top: auto;
    bottom: 12px;
    left: 14px;
    right: auto;
  }
}

/* ── Graph Canvas ──────────────────── */"""

if old2 not in css:
    raise SystemExit('CSS block 2 not found')
css = css.replace(old2, new2, 1)

old3 = """/* 그래프 작업 공간을 우선한다. 보조 운영 지표는 좁은 폭에서만 감춘다. */
@media (min-width: 801px) and (max-width: 1320px) {
  .top-bar { gap: 7px; padding: 0 10px; }
  .top-bar-navigation { margin-left: 0; }
  .top-bar-optional { display: none !important; }
}"""

new3 = """/* 그래프 작업 공간을 우선한다. 보조 운영 지표는 좁은·중간 데스크톱(≤1480)에서 감춘다. */
@media (min-width: 801px) and (max-width: 1480px) {
  .top-bar { gap: 7px; padding: 0 10px; }
  .top-bar-navigation { margin-left: 0; }
  .top-bar-optional { display: none !important; }
  .top-bar-stat--updated { display: none; }
  .top-bar-btn-text { display: none; }
  .top-bar-actions .refresh-btn { padding: 3px 7px; font-size: 9px; }
}"""

if old3 not in css:
    raise SystemExit('CSS block 3 not found')
css = css.replace(old3, new3, 1)

css_path.write_text(css)
print('App.css updated')

tsx_path = Path("/Users/nova-ai/project/nco-dashboard/src/App.tsx")
tsx = tsx_path.read_text()

replacements = [
    ('<span className="top-bar-stat">업데이트 <span>{updatedAt}</span></span>',
     '<span className="top-bar-stat top-bar-stat--updated">업데이트 <span>{updatedAt}</span></span>'),
    ('>⊟ 그룹 접기</button>', '>⊟ <span className="top-bar-btn-text">그룹 접기</span></button>'),
    ('>⊞ 그룹 펼치기</button>', '>⊞ <span className="top-bar-btn-text">그룹 펼치기</span></button>'),
    ('<button onClick={refresh} className="refresh-btn">↺ 새로고침</button>',
     '<button onClick={refresh} className="refresh-btn" aria-label="새로고침">↺ <span className="top-bar-btn-text">새로고침</span></button>'),
]
for old, new in replacements:
    if old not in tsx:
        raise SystemExit(f'TSX not found: {old!r}')
    tsx = tsx.replace(old, new, 1)

tsx_path.write_text(tsx)
print('App.tsx updated')
PY
