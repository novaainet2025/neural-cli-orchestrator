# NCO Dashboard — PhysicsGraph v3 전면 설계서

> 작성: 2026-07-01 | 대상: `src/server/monitor.ts` — `renderMeshGraph()` + `renderTopology()` 통합
> 스타일 참조: Obsidian Graph View (v1.6), GitHub Copilot Radar

---

## 1. 문제 진단 (v2 기능 상실 원인)

| 항목 | v2 (정상) | v2→v3 전환 중 상실 | 원인 분석 |
|------|-----------|-------------------|-----------|
| 노드 크기 | r=42 (로고+배지 표시 가능) | r=20 (텍스트 불가) | canvas 2D `devicePixelRatio` 미보정 |
| 클러스터 hull | SVG `<polygon>` convex hull | 제거됨 | 물리 시뮬 도입 시 정적 좌표 의존 로직 깨짐 |
| 클릭 피드백 | 선택 링 + 엣지 하이라이트 | 반응 없음 | canvas hit-test 좌표계 오류 (DPR 2배 오차) |
| 원격 세션 | 별도 아이콘 (🌐) | 로컬과 동일 | `session.remote` 플래그 미전달 |
| 물리 안정성 | 정적 원형 배치 | 진동·발산 | 감쇠 계수 없음, 척력 과도 |

---

## 2. v3 아키텍처 개요

```
renderPhysicsGraph()   ← 기존 renderMeshGraph() 대체
  │
  ├── PhysicsEngine (순수 JS, RAF 기반)
  │     ├── Node[]     — 위치·속도·질량
  │     ├── Edge[]     — 스프링 상수
  │     └── tick()     — Verlet Integration, 60fps 캡
  │
  ├── CanvasRenderer   ← canvas 2D, DPR-correct
  │     ├── drawHull() — 클러스터 볼록껍질 (α-shape)
  │     ├── drawEdge() — 베지어 곡선 + 파티클
  │     └── drawNode() — 원 + 배지 + 텍스트
  │
  └── HitTest (pointer events)
        ├── nodeAt(x, y) — DPR 보정 좌표
        └── panZoom()    — wheel + drag
```

### 2.1 기존 코드와의 관계

- **데이터 소스** (변경 없음): `meshSessions`, `COMM_MATRIX`, `CLI_TASK_LINKS`, `LANE_EVENTS`
- **색상 함수** (재사용): `agentColor()`, `resolveWorkMode()`, `meshHealth()`
- **진입점** 변경: `_graphRafLoop` → `renderPhysicsGraph()` 호출로 교체
- **HTML 컨테이너**: `<div id="graphSvg">` → `<canvas id="physicsCanvas">` 교체

---

## 3. 물리 시뮬레이션 명세

### 3.1 힘 모델 (Barnes-Hut 근사 불필요, n≤20 예상)

```
총 힘 = 척력 + 인력 + 중심 끌림 + 감쇠

척력 (쿨롱 유사):  F = k_rep * m_i * m_j / d²   (d_min = 40px)
인력 (스프링):     F = -k_spring * (d - rest_len)  rest_len = 120px
중심 끌림:         F = -k_center * pos            (항상 (cx, cy) 방향)
감쇠:             v *= damping                     (매 tick)
```

### 3.2 파라미터 (조정 가능, CSS 변수로 노출)

```javascript
const PHYSICS = {
  k_rep:     800,    // 척력 강도  (v2 발산 원인: 2000+)
  k_spring:  0.035,  // 인력 강도
  k_center:  0.012,  // 중심 당김  (외곽 노드 탈출 방지)
  damping:   0.82,   // 감쇠 (0.8~0.9 권장, 1.0이면 진동)
  rest_len:  130,    // 엣지 자연 길이 (px)
  dt:        0.95,   // 적분 시간 스텝
  max_v:     8,      // 속도 클램핑 (발산 방지)
  settle_ms: 2000,   // 이 시간 후 damping 강화 → 0.92
};
```

### 3.3 Verlet Integration (핵심)

```javascript
function tick(nodes, edges) {
  // 척력 (O(n²), n≤20 이므로 충분)
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i+1; j < nodes.length; j++) {
      const dx = nodes[j].x - nodes[i].x;
      const dy = nodes[j].y - nodes[i].y;
      const d  = Math.sqrt(dx*dx + dy*dy) || 1;
      const dSafe = Math.max(d, 40);
      const f = PHYSICS.k_rep / (dSafe * dSafe);
      nodes[i].vx -= f * dx / d;  nodes[i].vy -= f * dy / d;
      nodes[j].vx += f * dx / d;  nodes[j].vy += f * dy / d;
    }
  }
  // 인력 (스프링)
  edges.forEach(e => {
    const a = nodes[e.source], b = nodes[e.target];
    const dx = b.x - a.x, dy = b.y - a.y;
    const d  = Math.sqrt(dx*dx + dy*dy) || 1;
    const f  = PHYSICS.k_spring * (d - PHYSICS.rest_len);
    a.vx += f * dx / d;  a.vy += f * dy / d;
    b.vx -= f * dx / d;  b.vy -= f * dy / d;
  });
  // 중심 끌림 + 감쇠 + 클램프
  nodes.forEach(n => {
    if (n.pinned) return;
    n.vx = (n.vx - PHYSICS.k_center * (n.x - cx)) * PHYSICS.damping;
    n.vy = (n.vy - PHYSICS.k_center * (n.y - cy)) * PHYSICS.damping;
    const speed = Math.sqrt(n.vx*n.vx + n.vy*n.vy);
    if (speed > PHYSICS.max_v) { n.vx *= PHYSICS.max_v/speed; n.vy *= PHYSICS.max_v/speed; }
    n.x += n.vx * PHYSICS.dt;
    n.y += n.vy * PHYSICS.dt;
    // 경계 반사 (캔버스 밖으로 나가지 않도록)
    const r = n.r;
    if (n.x < r)     { n.x = r;     n.vx =  Math.abs(n.vx) * 0.5; }
    if (n.x > W - r) { n.x = W - r; n.vx = -Math.abs(n.vx) * 0.5; }
    if (n.y < r)     { n.y = r;     n.vy =  Math.abs(n.vy) * 0.5; }
    if (n.y > H - r) { n.y = H - r; n.vy = -Math.abs(n.vy) * 0.5; }
  });
}
```

---

## 4. 노드 설계 (r=32 복원)

### 4.1 노드 반지름 기준

```
노드 수 n      반지름 r
  1 ~ 5        36px
  6 ~ 9        32px
 10 ~ 15       26px
 16+           20px  (최소 — 이 이하 금지)

계산: r = Math.max(20, Math.min(36, Math.floor(180 / Math.max(n, 5))))
```

### 4.2 노드 레이어 구성 (캔버스 draw 순서)

```
① 클러스터 hull 배경 (맨 아래)
② 맥박 링 (active 노드만, 애니메이션)
③ 선택 링 (selected 노드만, 회전 대시)
④ 노드 원 (fill + stroke)
⑤ 배지 레이어 (우상단: 헬스 dot, 좌상단: 메시지 수)
⑥ 텍스트 (이름 + 상태)
⑦ 원격 표시 (🌐 or 작은 지구 아이콘, r≥26일 때만)
```

### 4.3 노드 타입별 스타일

| 타입 | 판별 조건 | 테두리 스타일 | 내부 색상 |
|------|----------|--------------|---------|
| NCO Hub | `id === 'nco'` | 2px solid + glow | `#1a2137` + 청색 glow |
| 로컬 CLI | `!session.remote` | 1.5px solid | `#05080e` |
| 원격 CLI | `session.remote === true` | 2px dashed | `#05080e` |
| 오프라인 | `health === 'dead'` | 1px solid, opacity 0.4 | `#0a0f1a` |

### 4.4 배지 (r≥26 필수 조건)

```
우상단 헬스 dot (r=4px):
  ok    → #3fb950 (green)
  stale → #d29922 (amber)
  dead  → #f85149 (red)
  stroke: #05080e 1.5px (배경과 구분)

좌상단 메시지 카운트 (totalOut > 0일 때):
  원 r=5.5px, fill=#1f6feb
  텍스트: Math.min(totalOut, 99), font=6.5px bold white

원격 아이콘 (r≥28, session.remote):
  하단 중앙: 🌐 font=9px (또는 SVG path)
  색: #58a6ff, opacity: 0.8
```

---

## 5. 클러스터 Hull (볼록껍질 복원)

### 5.1 클러스터 기준

```
1순위 — workMode 기반:
  'working' | 'thinking' | 'coding'  → "ACTIVE" 클러스터
  'discussing'                         → "DISCUSS" 클러스터
  'idle' | 'done'                      → "IDLE" 클러스터

2순위 — 같은 워크모드 노드가 2개 미만이면 hull 생략
```

### 5.2 Convex Hull 알고리즘 (Graham Scan, 인라인)

```javascript
function convexHull(pts) {
  if (pts.length < 3) return pts;
  pts = pts.slice().sort((a,b) => a.x-b.x || a.y-b.y);
  const cross = (O,A,B) => (A.x-O.x)*(B.y-O.y)-(A.y-O.y)*(B.x-O.x);
  const lo=[], hi=[];
  for (const p of pts) {
    while (lo.length>=2 && cross(lo[lo.length-2],lo[lo.length-1],p)<=0) lo.pop();
    lo.push(p);
  }
  for (let i=pts.length-1;i>=0;i--) {
    const p=pts[i];
    while (hi.length>=2 && cross(hi[hi.length-2],hi[hi.length-1],p)<=0) hi.pop();
    hi.push(p);
  }
  hi.pop(); lo.pop();
  return lo.concat(hi);
}
```

### 5.3 Hull 렌더링

```javascript
function drawHull(ctx, hullPts, color, label) {
  const PAD = 22; // hull ↔ 노드 간격
  // 팽창: 각 점을 centroid 기준으로 PAD만큼 바깥으로
  const cx_ = hullPts.reduce((s,p)=>s+p.x,0)/hullPts.length;
  const cy_ = hullPts.reduce((s,p)=>s+p.y,0)/hullPts.length;
  const expanded = hullPts.map(p=>{
    const dx=p.x-cx_, dy=p.y-cy_;
    const d=Math.sqrt(dx*dx+dy*dy)||1;
    return { x: p.x + dx/d*PAD, y: p.y + dy/d*PAD };
  });

  ctx.beginPath();
  ctx.moveTo(expanded[0].x, expanded[0].y);
  for (let i=1;i<expanded.length;i++) ctx.lineTo(expanded[i].x, expanded[i].y);
  ctx.closePath();

  // 반투명 fill
  ctx.fillStyle = color + '18'; // 약 9% opacity
  ctx.fill();
  // 점선 테두리
  ctx.strokeStyle = color + '55';
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);

  // 라벨 (hull 상단 중앙)
  if (label) {
    ctx.font = '600 9px Inter, system-ui';
    ctx.fillStyle = color + 'aa';
    ctx.textAlign = 'center';
    ctx.fillText(label, cx_, Math.min(...expanded.map(p=>p.y)) - 6);
  }
}
```

---

## 6. 엣지 설계

### 6.1 엣지 타입별 스타일

| 타입 | 색상 | 너비 | 스타일 | 파티클 |
|------|------|------|--------|--------|
| 최신 (< 15s) | ECOL[type] | 2.5px | 실선 | ✅ 3개 |
| 보통 (< 5m) | ECOL[type] | 1.5px | 실선 | ✅ 1개 |
| 오래된 (< 10m) | 50% opacity | 1px | 대시 (4 3) | ✗ |
| 만료 (> 10m) | 제거 | - | - | - |

### 6.2 베지어 곡선 (양방향 엣지 구분)

```javascript
// 직선 중점에서 수직 방향으로 offset → 방향 구분 가능
const dx = tp.x - fp.x, dy = tp.y - fp.y;
const len = Math.sqrt(dx*dx+dy*dy)||1;
const CURVE = 18; // 곡률
const ox = -(dy/len)*CURVE, oy = (dx/len)*CURVE;
const mx = (fp.x+tp.x)/2 + ox, my = (fp.y+tp.y)/2 + oy;

ctx.beginPath();
ctx.moveTo(fp.x, fp.y);
ctx.quadraticCurveTo(mx, my, tp.x, tp.y);
```

### 6.3 파티클 애니메이션

```javascript
// 각 파티클은 t: 0→1 (엣지 위 진행률)
// RAF 에서 매 프레임: t += speed (0.008~0.014)
// 좌표: quadratic bezier 공식으로 계산 (t 에 따라)
function bezierPoint(fp, cp, tp, t) {
  return {
    x: (1-t)*(1-t)*fp.x + 2*(1-t)*t*cp.x + t*t*tp.x,
    y: (1-t)*(1-t)*fp.y + 2*(1-t)*t*cp.y + t*t*tp.y,
  };
}
```

---

## 7. 상호작용 (HitTest + 줌/패닝)

### 7.1 DPR 보정 (v2 클릭 오류 근본 원인)

```javascript
// canvas 초기화 시 1회 설정
const dpr = window.devicePixelRatio || 1;
canvas.width  = W * dpr;
canvas.height = H * dpr;
canvas.style.width  = W + 'px';
canvas.style.height = H + 'px';
ctx.scale(dpr, dpr);

// 이벤트 좌표 변환
function toCanvasXY(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left),  // style px 기준 (이미 dpr 보정됨)
    y: (e.clientY - rect.top),
  };
}
```

### 7.2 줌 / 패닝 상태

```javascript
let VIEW = { x: 0, y: 0, scale: 1.0 };
const SCALE_MIN = 0.4, SCALE_MAX = 3.0;

// 캔버스 draw 시:
ctx.save();
ctx.translate(VIEW.x, VIEW.y);
ctx.scale(VIEW.scale, VIEW.scale);
// ... 모든 draw 여기서 ...
ctx.restore();

// HitTest 역변환:
function toWorldXY(e) {
  const {x,y} = toCanvasXY(e);
  return {
    x: (x - VIEW.x) / VIEW.scale,
    y: (y - VIEW.y) / VIEW.scale,
  };
}
```

### 7.3 클릭 피드백 (v2 상실 기능 복원)

```javascript
// 선택 상태 변수
let SELECTED_NODE = null;

canvas.addEventListener('click', e => {
  const {x, y} = toWorldXY(e);
  const hit = nodes.find(n => {
    const dx = n.x - x, dy = n.y - y;
    return dx*dx + dy*dy <= n.r * n.r;
  });
  SELECTED_NODE = (hit && hit.id !== SELECTED_NODE) ? hit.id : null;
  // 선택 시: 연결된 엣지 하이라이트 + 상세 패널 열기
  renderGraphDetail(SELECTED_NODE);
});

// draw 시 선택 표시:
// ① 선택된 노드: 회전 대시 링 (r+9, dash 3 2)
// ② 연결 엣지: opacity 1.0, 비연결: 0.15
// ③ 연결 노드: 정상, 비연결: opacity 0.3
```

### 7.4 드래그 (노드 고정)

```javascript
// mousedown → 노드 hit → dragNode = n; n.pinned = true
// mousemove → dragNode.x = wx; dragNode.y = wy; dragNode.vx = 0; dragNode.vy = 0
// mouseup   → dragNode.pinned = false; dragNode = null
```

---

## 8. 원격 세션 표시 (v2 상실 기능 복원)

### 8.1 데이터 판별

```javascript
// meshSessions[id].remote 플래그 확인
// 없으면 fallback: agentId에 'remote-' 접두어 포함 여부
const isRemote = s.remote === true || s.agentId?.startsWith('remote-');
```

### 8.2 시각 차별화

| 요소 | 로컬 | 원격 |
|------|------|------|
| 테두리 | solid | dashed (5 3) |
| 내부 아이콘 | 없음 | 🌐 (r≥28) |
| 색상 modifier | 기본 | +20% saturation |
| hull 분류 | 워크모드 기준 | "REMOTE" 별도 클러스터 |

---

## 9. RAF 루프 교체 방안

### 9.1 기존 코드 (`_graphRafLoop`)

```javascript
// 현재:
function _graphRafLoop(ts) {
  if (!_rafActive) return;
  if (!document.hidden && _graphOpen && ts - _lastGraphRender >= 1000)
    renderMeshGraph();  // ← SVG 재생성, 1fps
  requestAnimationFrame(_graphRafLoop);
}
```

### 9.2 v3 교체

```javascript
// v3: 물리 시뮬 60fps, 렌더링은 변화 감지 후
let _physicsRunning = true;
let _lastPhysTick = 0;

function _physicsRafLoop(ts) {
  if (!_rafActive) return;
  if (!document.hidden && _graphOpen) {
    // 물리: 매 프레임 (60fps)
    if (ts - _lastPhysTick >= 16) {  // ~60fps
      tick(nodes, edges);             // 위치 업데이트
      _lastPhysTick = ts;
    }
    // 렌더: 매 프레임 (canvas는 가벼움)
    drawFrame(ctx, nodes, edges);
  }
  requestAnimationFrame(_physicsRafLoop);
}
requestAnimationFrame(_physicsRafLoop);
```

---

## 10. 구현 순서 (Phase)

```
Phase 1 — DPR 수정 + 노드 r 복원         [1파일, ~30줄]
  · canvas setup: dpr scale
  · r = Math.max(20, Math.floor(180/n))
  · HitTest 좌표 toWorldXY()
  · 예상 효과: 클릭 오류 즉시 해결, 배지 복원

Phase 2 — 물리 엔진 교체                   [renderMeshGraph 내부만]
  · PHYSICS 상수 객체
  · tick() 함수
  · _physicsRafLoop 교체 (1줄)
  · 예상 효과: 진동·발산 해결

Phase 3 — Hull 복원                        [drawHull() 추가]
  · convexHull() 인라인 (20줄)
  · 클러스터 분류 로직
  · drawHull() 렌더
  · 예상 효과: 클러스터 구분 복원

Phase 4 — 원격 세션 표시                   [노드 draw 수정]
  · isRemote 판별
  · dashed stroke + 🌐 아이콘
  · REMOTE hull 분리

Phase 5 — 줌/패닝                          [VIEW 상태 + 이벤트]
  · wheel → VIEW.scale
  · drag (배경) → VIEW.x/y
  · double-click → 리셋
```

---

## 11. 검증 기준

```
성공 조건:
  ✅ r≥26일 때 이름 텍스트 읽힘
  ✅ 헬스 배지(우상단 dot) 표시됨
  ✅ 노드 클릭 시 선택 링 표시 + 상세 패널 열림
  ✅ 원격 세션 노드에 dashed 테두리 + 🌐 아이콘
  ✅ 워크모드가 같은 노드 2개 이상 → hull 배경 표시
  ✅ 2초 내 물리 안정화 (진동 없음)
  ✅ 노드 10개에서 60fps 유지 (Chrome perf 탭)

실패 기준 (회귀 방지):
  ❌ 클릭 좌표 2배 오차 (DPR 미보정)
  ❌ 노드가 캔버스 밖으로 이탈
  ❌ hull이 노드 원과 겹침
  ❌ 메시지 없는 세션이 엣지 표시됨
```

---

## 12. 관련 파일

| 파일 | 변경 범위 |
|------|----------|
| `src/server/monitor.ts:2391` | `renderMeshGraph()` 전체 교체 → `renderPhysicsGraph()` |
| `src/server/monitor.ts:3791` | `_graphRafLoop` → `_physicsRafLoop` |
| `src/server/monitor.ts:2553` | `selectGraphNode()` → `SELECTED_NODE` 상태 업데이트 |
| `src/server/monitor.ts:2558` | `renderGraphDetail()` 재사용 (변경 최소) |
| `src/server/monitor.ts:~640` | `<div id="graphSvg">` → `<canvas id="physicsCanvas">` |

---

*이 설계서는 구현 전 NCO Commander 검토용입니다.*
*구현 위임: `Skill(nco-task) ai=codex "구현: PhysicsGraph v3 — 이 설계서 기반"*
