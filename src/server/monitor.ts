/** GET /monitor — NCO Live Monitor (실시간 대시보드) */
export function getMonitorHTML(wsPort: number, apiPort: number): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>NCO Live Monitor</title>
<style>
/* ── Reset & Base ───────────────────────────────────── */
*{margin:0;padding:0;box-sizing:border-box;user-select:none}
body{font-family:'Cascadia Code','Fira Code',monospace;background:#0d1117;color:#c9d1d9;font-size:13px;height:100vh;display:flex;flex-direction:column;overflow:hidden}

/* ── Header ─────────────────────────────────────────── */
.header{background:#161b22;padding:7px 14px;border-bottom:1px solid #30363d;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;height:38px}
.header h1{font-size:14px;color:#58a6ff;letter-spacing:.5px}
.hdr-right{display:flex;gap:10px;align-items:center;font-size:11px}
.dot{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:3px;flex-shrink:0}
.dot.on{background:#3fb950}.dot.off{background:#f85149}
.badge{padding:2px 7px;border-radius:4px;font-size:10px;font-weight:600;letter-spacing:.3px}
.badge.ok{background:#0d2818;color:#3fb950;border:1px solid #238636}
.badge.err{background:#3d1111;color:#f85149;border:1px solid #f85149}
.badge.mesh{background:#0d1e3d;color:#58a6ff;border:1px solid #1f6feb}
.hdr-sep{width:1px;height:16px;background:#30363d}

/* ── Body: 3-pane resizable layout ──────────────────── */
.body{flex:1;display:flex;overflow:hidden;min-height:0}

/* Panels */
.pane{display:flex;flex-direction:column;overflow:hidden;min-width:120px}
.pane-left{width:var(--w-left,240px);flex-shrink:0}
.pane-center{flex:1;min-width:200px}
.pane-right{width:var(--w-right,320px);flex-shrink:0}

/* Drag handles */
.resizer{width:4px;background:#21262d;cursor:col-resize;flex-shrink:0;position:relative;transition:background .15s}
.resizer:hover,.resizer.dragging{background:#388bfd}
.resizer::after{content:'';position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:2px;height:30px;border-radius:1px;background:inherit;opacity:.6}

/* Pane header */
.ph{padding:6px 10px;color:#8b949e;font-size:10px;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #21262d;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;background:#0d1117;height:28px}
.ph .ph-title{display:flex;align-items:center;gap:5px}
.ph .ph-cnt{font-size:10px;padding:1px 5px;border-radius:3px;background:#161b22;color:#58a6ff;font-weight:600}
.ph-toggle{cursor:pointer;color:#484f58;font-size:10px;padding:1px 4px;border-radius:2px;transition:color .15s}
.ph-toggle:hover{color:#c9d1d9}

/* Collapsible section */
.section{display:flex;flex-direction:column;overflow:hidden;transition:flex .2s}
.section.collapsed .section-body{display:none}
.section.collapsed .ph-toggle{transform:rotate(-90deg)}
.section-body{overflow-y:auto;flex:1}

/* ── Right top: SERVER AGENTS ────────────────────────── */
/* Agents = NCO가 직접 오케스트레이션하는 서버 프로세스 */
#sec-agents{background:#0d1117;border-bottom:2px solid #21262d}
#sec-agents .ph{background:#0d1117;border-bottom:1px solid #21262d}
#sec-agents .ph .ph-title{color:#6e7681}
.ag{padding:5px 10px;border-bottom:1px solid #0f1117;display:flex;justify-content:space-between;align-items:center;transition:background .25s;cursor:default}
.ag:hover{background:#111720}
.ag.flash{background:#1a1d3e}
.ag-left{display:flex;align-items:center;gap:6px;overflow:hidden;flex:1}
.ag-icon{width:6px;height:6px;border-radius:50%;flex-shrink:0;background:#30363d}
.ag-name{font-weight:600;font-size:11px;white-space:nowrap;color:#8b949e}
.ag-sub{color:#484f58;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.ag-task{color:#1f6feb;font-size:9px;background:#0d1e3d;padding:1px 4px;border-radius:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:70px}

/* Agent status pills — compact */
.st{font-size:9px;padding:1px 6px;border-radius:3px;font-weight:700;white-space:nowrap;flex-shrink:0;letter-spacing:.2px}
.st.idle{background:#161b22;color:#484f58;border:1px solid #21262d}
.st.working,.st.thinking{background:#0d2818;color:#3fb950;border:1px solid #23863644}
.st.discussing{background:#1a1a4e;color:#a5b4fc;border:1px solid #5865f244}
.st.coding{background:#0d1e3d;color:#58a6ff;border:1px solid #1f6feb44}
.st.reviewing{background:#2a1a4a;color:#d2a8ff;border:1px solid #8957e544}
.st.waiting{background:#241e0a;color:#d29922;border:1px solid #d2992244}
.st.error,.st.isolated{background:#3d1111;color:#f85149;border:1px solid #f8514944}
.st.offline{background:#0d1117;color:#30363d;border:1px solid #21262d}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.st.working,.st.thinking,.st.coding,.st.discussing{animation:pulse 1.8s ease-in-out infinite}

/* ── Divider between agents section and tabs in right pane ── */
.agents-tab-divider{
  height:2px;
  background:#161b22;
  flex-shrink:0;
}

/* ── Left pane: CLI TERMINALS (full pane) ────────────── */
/* CLI Mesh = 외부에서 직접 실행 중인 CLI 터미널 세션 */
.pane-left{background:#060c18}
#sec-mesh{background:transparent;flex:1}
#sec-mesh .ph{background:#08112088;border-bottom:2px solid #1f6feb33}
#sec-mesh .ph .ph-title{color:#58a6ff;font-size:10px;font-weight:700}
#sec-mesh .section-body{background:transparent}

/* Mesh node = terminal card */
.mesh-node{
  margin:5px 6px;
  border-radius:6px;
  border:1px solid #1a2540;
  background:#0a1428;
  transition:border-color .2s, box-shadow .2s;
  position:relative;
  overflow:hidden;
}
.mesh-node:hover{border-color:#1f6feb66;box-shadow:0 0 8px #1f6feb22}
.mesh-node.new-flash{animation:meshFlash .8s ease-out}
@keyframes meshFlash{0%{border-color:#388bfd;box-shadow:0 0 12px #388bfd44}100%{border-color:#1a2540;box-shadow:none}}

/* Mode accent bar — top edge (more visible than left edge) */
.mesh-node::before{content:'';position:absolute;left:0;right:0;top:0;height:2px}
.mesh-node.mode-solo::before{background:#58a6ff}
.mesh-node.mode-mesh::before{background:#3fb950;box-shadow:0 2px 8px #3fb95055}
.mesh-node.mode-waiting::before{background:#484f58}
.mesh-node.mode-reviewing::before{background:#d2a8ff}
.mesh-node.mode-blocked::before{background:#f85149;box-shadow:0 2px 8px #f8514955}

.mn-inner{padding:7px 9px 6px}
.mn-row1{display:flex;align-items:center;gap:5px}
.mn-agent{font-weight:700;font-size:12px}
.mn-pid{color:#30363d;font-size:9px;margin-left:auto;font-variant-numeric:tabular-nums}

/* Work mode badge — prominent, pill shape */
.wm-badge{font-size:10px;font-weight:700;padding:2px 8px;border-radius:12px;letter-spacing:.3px;white-space:nowrap;flex-shrink:0}
.wm-solo{background:#0d2230;color:#58a6ff;border:1px solid #1f6feb66}
.wm-mesh{background:#0d2818;color:#3fb950;border:1px solid #23863666;animation:pulse 2.5s ease-in-out infinite}
.wm-waiting{background:#111820;color:#484f58;border:1px solid #21262d}
.wm-reviewing{background:#1e1040;color:#d2a8ff;border:1px solid #8957e566}
.wm-blocked{background:#2a0a0a;color:#f85149;border:1px solid #f8514966}

.mn-row2{display:flex;align-items:center;gap:5px;margin-top:5px}
.mn-work{color:#c9d1d9;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;line-height:1.4}
.mn-collab{color:#3fb950;font-size:9px;background:#0d1e10;padding:1px 5px;border-radius:3px;white-space:nowrap;flex-shrink:0;border:1px solid #23863633}
.mn-file{color:#30363d;font-size:10px;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:3px}
.mn-file-name{color:#484f58}
.mn-meta{display:flex;align-items:center;gap:6px;margin-top:4px;font-size:9px;color:#21262d;padding-top:4px;border-top:1px solid #0f1a2a}
.mn-meta-branch{color:#30363d}
.mn-meta-time{color:#21262d;margin-left:auto}
.mn-meta-task{color:#1f6feb88;background:#0d1e3d;padding:1px 4px;border-radius:2px}

/* Conflict indicators on mesh node cards */
.mn-conflicts{margin-top:5px;display:flex;flex-direction:column;gap:2px}
.mn-conflict-row{display:flex;align-items:flex-start;gap:4px;font-size:10px;line-height:1.4;padding:3px 6px;border-radius:3px}
.mn-conflict-row.sev-high{background:#2a0808;border-left:2px solid #f85149;color:#f85149}
.mn-conflict-row.sev-medium{background:#241900;border-left:2px solid #d29922;color:#d29922}
.mn-conflict-row.sev-low{background:#0a1020;border-left:2px solid #58a6ff55;color:#58a6ff88}
.mn-conflict-icon{flex-shrink:0;font-size:9px}

/* Conflict count badge on node header */
.mn-conflict-badge{font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;flex-shrink:0}
.mn-conflict-badge.has-high{background:#3d1111;color:#f85149;border:1px solid #f8514966;animation:pulse 2s ease-in-out infinite}
.mn-conflict-badge.has-medium{background:#241900;color:#d29922;border:1px solid #d2992266}
.mn-conflict-badge.has-low{background:#0d1e3d;color:#58a6ff88;border:1px solid #1f6feb33}

.th-dot{width:6px;height:6px;border-radius:50%;display:inline-block;flex-shrink:0}
.th-dot.active{background:#3fb950;box-shadow:0 0 4px #3fb95066}
.th-dot.idle{background:#d29922}
.th-dot.stale{background:#f85149;animation:pulse 2s infinite}
.mesh-empty{padding:18px 10px;color:#1f6feb44;font-size:11px;text-align:center;line-height:1.8;font-style:italic}

/* ── Conflict panel (right tab) ──────────────────────── */
.conflict-panel{background:#0a0e18;border:1px solid #1a2035;border-radius:6px;margin-bottom:8px;overflow:hidden}
.conflict-panel-hdr{display:flex;align-items:center;gap:6px;padding:6px 10px;background:#0f1525;border-bottom:1px solid #1a2035;font-size:11px;font-weight:700}
.conflict-panel-hdr.safe{color:#3fb950}
.conflict-panel-hdr.warn{color:#d29922}
.conflict-panel-hdr.danger{color:#f85149}
.conflict-entry{padding:6px 10px;border-bottom:1px solid #111828;font-size:11px;display:flex;flex-direction:column;gap:3px}
.conflict-entry:last-child{border-bottom:none}
.conflict-entry-hdr{display:flex;align-items:center;gap:5px}
.ce-type{font-size:9px;padding:1px 5px;border-radius:3px;font-weight:700;flex-shrink:0}
.ce-type.file{background:#2a0808;color:#f85149;border:1px solid #f8514955}
.ce-type.task{background:#241900;color:#d29922;border:1px solid #d2992255}
.ce-type.branch{background:#0d1e3d;color:#58a6ff;border:1px solid #1f6feb55}
.ce-sev{font-size:9px;flex-shrink:0}
.ce-sev.high{color:#f85149}.ce-sev.medium{color:#d29922}.ce-sev.low{color:#58a6ff88}
.ce-agent{font-weight:700;color:#c9d1d9}
.ce-detail{color:#6e7681;font-size:10px;line-height:1.5;padding-left:2px}
.ce-rec{color:#3fb95088;font-size:10px;line-height:1.5;padding:3px 6px;background:#0d1e10;border-radius:3px;border-left:2px solid #23863655}
.no-conflict{display:flex;align-items:center;gap:8px;padding:12px 10px;color:#3fb950;font-size:11px}

/* ── Center: Event Stream ────────────────────────────── */
.evt-list{flex:1;overflow-y:auto}
.ev{padding:3px 10px;border-bottom:1px solid #0d1117;display:grid;grid-template-columns:54px 90px 160px 1fr;gap:4px;font-size:11px;line-height:1.5;transition:background .4s}
.ev:hover{background:#161b22}
.ev.new{background:#16213e}
.ev .e-time{color:#484f58;font-variant-numeric:tabular-nums}
.ev .e-agent{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ev .e-type{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ev .e-msg{color:#6e7681;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;user-select:text}
.e-type.action{color:#3fb950}.e-type.task{color:#58a6ff}.e-type.discussion{color:#a5b4fc}
.e-type.message{color:#d29922}.e-type.system{color:#f85149}.e-type.agent{color:#d2a8ff}
.e-type.mesh{color:#79c0ff}

/* ── Right: Tab panel ────────────────────────────────── */
.tab-bar{display:flex;border-bottom:1px solid #21262d;flex-shrink:0;background:#0d1117;overflow-x:auto}
.tab{padding:6px 12px;color:#8b949e;cursor:pointer;font-size:10px;text-transform:uppercase;letter-spacing:.8px;border-bottom:2px solid transparent;white-space:nowrap;transition:color .15s}
.tab:hover{color:#c9d1d9}
.tab.active{color:#58a6ff;border-bottom-color:#388bfd;background:#0d1e3d20}
.tab-content{flex:1;overflow-y:auto;padding:8px}

/* Messages tab */
.msg-item{padding:5px 0;border-bottom:1px solid #161b22}
.msg-item .mh{display:flex;gap:5px;align-items:center;font-size:11px}
.msg-item .mfrom{color:#d29922;font-weight:700}
.msg-item .mto{color:#8b949e}
.msg-item .mtype{color:#484f58;font-size:10px;margin-left:auto}
.msg-item .mbody{color:#c9d1d9;font-size:11px;margin-top:3px;white-space:pre-wrap;word-break:break-all;user-select:text;line-height:1.5}

/* Mesh tab */
.mesh-msg{padding:6px 0;border-bottom:1px solid #161b22}
.mesh-msg .mh{display:flex;align-items:center;gap:5px;font-size:11px}
.mesh-msg .mfrom{color:#58a6ff;font-weight:700}
.mesh-msg .mto{color:#8b949e}
.mesh-msg .mtime{color:#484f58;font-size:10px;margin-left:auto;font-variant-numeric:tabular-nums}
.mesh-msg .mbody{color:#c9d1d9;font-size:11px;margin-top:3px;padding:4px 8px;background:#161b22;border-left:2px solid #30363d;border-radius:0 3px 3px 0;word-break:break-all;user-select:text;line-height:1.5}
.mesh-msg.type-request .mfrom{color:#a5b4fc}
.mesh-msg.type-warning .mbody{border-left-color:#d29922}
.mesh-msg.type-conflict .mbody{border-left-color:#f85149}

/* Terminal status (mesh tab) */
.term-panel{background:#0d1117;border-bottom:2px solid #21262d;padding:6px 8px;flex-shrink:0}
.term-panel .tp-title{color:#8b949e;font-size:10px;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;display:flex;justify-content:space-between}
.term-row{display:grid;grid-template-columns:7px 70px 110px 90px 1fr 72px;gap:5px;align-items:center;padding:4px 0;font-size:11px;border-bottom:1px solid #0d101700;transition:background .2s}
.term-row:hover{background:#161b22;border-radius:3px;padding-left:4px}
.term-row:last-child{border-bottom:none}
.term-pid{color:#484f58;font-size:10px;font-variant-numeric:tabular-nums}
.term-agent{font-weight:700}
.term-work{color:#8b949e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.term-health{font-size:10px;font-weight:700;white-space:nowrap;text-align:right}
.th-active-txt{color:#3fb950}.th-idle-txt{color:#d29922}.th-stale-txt{color:#f85149}

/* Discussion / Task tabs */
.disc-item{padding:6px 0;border-bottom:1px solid #161b22}
.disc-item .dt{color:#a5b4fc;font-size:11px;font-weight:600;user-select:text}
.disc-item .dm{color:#484f58;font-size:10px;margin-top:2px}
.task-item{padding:5px 0;border-bottom:1px solid #161b22}
.task-item .th2{display:flex;gap:6px;align-items:center;font-size:11px}
.task-item .ta{font-weight:700}
.task-item .tid{color:#484f58;font-size:10px}
.task-item .tb{color:#8b949e;font-size:11px;margin-top:3px;user-select:text}

/* Empty states */
.empty{padding:24px;color:#484f58;text-align:center;font-size:11px}

/* ── Input bar ───────────────────────────────────────── */
.input-bar{height:36px;background:#161b22;border-top:1px solid #30363d;padding:4px 12px;display:flex;gap:8px;align-items:center;flex-shrink:0}
.input-bar select{background:#0d1117;border:1px solid #30363d;color:#c9d1d9;padding:3px 6px;border-radius:4px;font-size:11px;font-family:inherit;cursor:pointer;user-select:auto}
.input-bar select:focus{outline:none;border-color:#58a6ff}
.input-bar input{flex:1;background:#0d1117;border:1px solid #30363d;color:#c9d1d9;padding:4px 10px;border-radius:4px;font-family:inherit;font-size:12px;user-select:auto}
.input-bar input:focus{border-color:#58a6ff;outline:none}
.send-btn{background:#238636;color:#fff;border:none;padding:4px 14px;border-radius:4px;cursor:pointer;font-size:11px;font-family:inherit;transition:background .15s;white-space:nowrap}
.send-btn:hover{background:#2ea043}
.mesh-send-btn{background:#1f6feb22;color:#58a6ff;border:1px solid #1f6feb;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:10px;font-family:inherit;transition:background .15s;white-space:nowrap}
.mesh-send-btn:hover{background:#1f6feb44}

/* Scrollbar */
::-webkit-scrollbar{width:5px;height:5px}
::-webkit-scrollbar-track{background:#0d1117}
::-webkit-scrollbar-thumb{background:#30363d;border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:#484f58}
</style>
</head>
<body>

<!-- ── Header ── -->
<div class="header">
  <h1>⬡ NCO Live Monitor</h1>
  <div class="hdr-right">
    <div style="display:flex;align-items:center"><span class="dot" id="wsDot"></span><span id="wsText" style="color:#8b949e">connecting…</span></div>
    <div class="hdr-sep"></div>
    <div style="display:flex;align-items:center"><span class="dot" id="apiDot"></span><span id="apiText" style="color:#8b949e">API…</span></div>
    <div class="hdr-sep"></div>
    <div id="meshCount" class="badge mesh">mesh 0</div>
    <div id="onlineCount" class="badge ok">0/9</div>
  </div>
</div>

<!-- ── Body ── -->
<div class="body" id="body">

  <!-- LEFT pane: CLI TERMINALS -->
  <div class="pane pane-left" id="pane-left">
    <div class="section" id="sec-mesh" style="flex:1;min-height:0">
      <div class="ph" style="height:30px">
        <div class="ph-title">
          <span style="font-size:11px">⬡</span>
          <span style="font-size:10px;font-weight:700;letter-spacing:.8px">CLI TERMINALS</span>
          <span class="ph-cnt" id="meshNodeCount" style="background:#0d1e3d;color:#58a6ff;border:1px solid #1f6feb44">0</span>
        </div>
        <span class="ph-toggle" onclick="toggleSection('sec-mesh')" title="접기/펼치기">▾</span>
      </div>
      <div class="section-body" id="meshNodeList"><div class="mesh-empty">활성 세션 없음<br><span style="font-size:9px">/nco-mesh ping 으로 등록</span></div></div>
    </div>
  </div>

  <!-- Resizer L -->
  <div class="resizer" id="resizer-l" title="드래그하여 크기 조절"></div>

  <!-- CENTER pane: Event Stream -->
  <div class="pane pane-center">
    <div class="ph">
      <div class="ph-title"><span>Event Stream</span></div>
      <span id="evtCount" style="color:#484f58;font-size:10px">0 events</span>
    </div>
    <div class="evt-list" id="eventList"></div>
  </div>

  <!-- Resizer R -->
  <div class="resizer" id="resizer-r" title="드래그하여 크기 조절"></div>

  <!-- RIGHT pane: Server Agents + Tabs -->
  <div class="pane pane-right" id="pane-right">

    <!-- Agents section (collapsible, top of right pane) -->
    <div class="section" id="sec-agents" style="flex-shrink:0;max-height:45%">
      <div class="ph" style="height:26px">
        <div class="ph-title">
          <span style="color:#484f58;font-size:9px;letter-spacing:1.5px;font-weight:700">SERVER AGENTS</span>
          <span class="ph-cnt" id="agCnt" style="background:#161b22;color:#484f58">9</span>
        </div>
        <span class="ph-toggle" onclick="toggleSection('sec-agents')" title="접기/펼치기">▾</span>
      </div>
      <div class="section-body" id="agentList"></div>
    </div>

    <!-- Divider between agents and tabs -->
    <div class="agents-tab-divider"></div>

    <!-- Tab bar -->
    <div class="tab-bar" id="tabBar">
      <div class="tab active" data-tab="mesh" onclick="switchTab('mesh')">⬡ Mesh</div>
      <div class="tab" data-tab="messages" onclick="switchTab('messages')">Messages</div>
      <div class="tab" data-tab="discussions" onclick="switchTab('discussions')">Discussions</div>
      <div class="tab" data-tab="tasks" onclick="switchTab('tasks')">Tasks</div>
    </div>
    <div class="tab-content" id="tabContent"></div>
  </div>

</div>

<!-- ── Input bar ── -->
<div class="input-bar">
  <select id="sendTarget" title="전송 대상 선택">
    <option value="broadcast">Broadcast</option>
  </select>
  <input id="sendInput" placeholder="메시지 또는 명령어 입력…" onkeydown="if(event.key==='Enter')sendMsg()" autocomplete="off">
  <button class="mesh-send-btn" onclick="sendMesh()" title="메시 브로드캐스트">⬡ Mesh</button>
  <button class="send-btn" onclick="sendMsg()">Send ↵</button>
</div>

<script>
const API='http://localhost:${apiPort}';
const WS_URL='ws://localhost:${wsPort}';
let ws;
let agents={};
let events=[];
let messages=[];
let discussions=[];
let tasks=[];
let meshSessions={};
let meshMessages=[];
let activeTab='mesh';

// ── Resizable panels ──────────────────────────────────
(function initResize(){
  const body=document.getElementById('body');
  const paneL=document.getElementById('pane-left');
  const paneR=document.getElementById('pane-right');

  // Restore saved sizes
  const saved=JSON.parse(localStorage.getItem('nco-monitor-sizes')||'{}');
  if(saved.left)paneL.style.width=saved.left+'px';
  if(saved.right)paneR.style.width=saved.right+'px';

  function makeDragger(resizerId, getSize, setSize, minSize){
    const handle=document.getElementById(resizerId);
    let startX, startSize;
    handle.addEventListener('mousedown',e=>{
      startX=e.clientX;
      startSize=getSize();
      handle.classList.add('dragging');
      document.body.style.cursor='col-resize';
      const onMove=e=>{
        const delta=e.clientX-startX;
        const newSize=Math.max(minSize, startSize+delta);
        setSize(newSize);
      };
      const onUp=()=>{
        handle.classList.remove('dragging');
        document.body.style.cursor='';
        document.removeEventListener('mousemove',onMove);
        document.removeEventListener('mouseup',onUp);
        // Save
        const s=JSON.parse(localStorage.getItem('nco-monitor-sizes')||'{}');
        s.left=parseInt(paneL.style.width||'240');
        s.right=parseInt(paneR.style.width||'320');
        localStorage.setItem('nco-monitor-sizes',JSON.stringify(s));
      };
      document.addEventListener('mousemove',onMove);
      document.addEventListener('mouseup',onUp);
      e.preventDefault();
    });
  }

  makeDragger('resizer-l',
    ()=>paneL.offsetWidth,
    w=>paneL.style.width=w+'px',
    120
  );
  // Right resizer: dragging LEFT increases width, dragging RIGHT decreases
  // So invert the delta for the right panel
  {
    const handle=document.getElementById('resizer-r');
    let startX, startSize;
    handle.addEventListener('mousedown',e=>{
      startX=e.clientX;
      startSize=paneR.offsetWidth;
      handle.classList.add('dragging');
      document.body.style.cursor='col-resize';
      const onMove=e=>{
        const delta=startX-e.clientX; // inverted: drag left = bigger right panel
        const newSize=Math.max(180, startSize+delta);
        paneR.style.width=newSize+'px';
      };
      const onUp=()=>{
        handle.classList.remove('dragging');
        document.body.style.cursor='';
        document.removeEventListener('mousemove',onMove);
        document.removeEventListener('mouseup',onUp);
        const s=JSON.parse(localStorage.getItem('nco-monitor-sizes')||'{}');
        s.left=parseInt(paneL.style.width||'240');
        s.right=parseInt(paneR.style.width||'320');
        localStorage.setItem('nco-monitor-sizes',JSON.stringify(s));
      };
      document.addEventListener('mousemove',onMove);
      document.addEventListener('mouseup',onUp);
      e.preventDefault();
    });
  }
})();

// ── Collapsible sections ──────────────────────────────
function toggleSection(id){
  const sec=document.getElementById(id);
  sec.classList.toggle('collapsed');
  localStorage.setItem('nco-sec-'+id, sec.classList.contains('collapsed')?'1':'0');
}
// Restore collapse state
['sec-agents','sec-mesh'].forEach(id=>{
  if(localStorage.getItem('nco-sec-'+id)==='1'){
    document.getElementById(id)?.classList.add('collapsed');
  }
});

// ── WebSocket ─────────────────────────────────────────
function connect(){
  ws=new WebSocket(WS_URL);
  ws.onopen=()=>{ el('wsDot').className='dot on'; el('wsText').textContent='WS connected'; };
  ws.onclose=()=>{ el('wsDot').className='dot off'; el('wsText').textContent='WS disconnected'; setTimeout(connect,3000); };
  ws.onerror=()=>{};
  ws.onmessage=e=>{ try{handleEvent(JSON.parse(e.data));}catch{} };
}

// ── Event Handler ─────────────────────────────────────
function handleEvent(evt){
  if(evt.type==='connected')return;

  if(evt.type==='mesh:session_update'){
    const s=evt.session;
    if(s?.sessionId){
      const isNew=!meshSessions[s.sessionId];
      meshSessions[s.sessionId]={...s,_updatedAt:Date.now()};
      renderMeshNodes(isNew?s.sessionId:null);
    }
    updateCounts();
    if(activeTab==='mesh')renderTab();
    events.unshift({...evt,agentId:evt.session?.agentId||'mesh',_isMesh:true});
    if(events.length>500)events.length=500;
    renderEvents();
    return;
  }
  if(evt.type==='mesh:session_disconnected'){
    delete meshSessions[evt.sessionId];
    renderMeshNodes();
    updateCounts();
    if(activeTab==='mesh')renderTab();
    events.unshift({...evt,agentId:'mesh',_isMesh:true});
    if(events.length>500)events.length=500;
    renderEvents();
    return;
  }
  if(evt.type==='mesh:message'){
    const m=evt.message;
    if(m){ meshMessages.unshift(m); if(meshMessages.length>200)meshMessages.length=200; }
    events.unshift({...evt,agentId:m?.fromAgent||'mesh',_isMesh:true});
    if(events.length>500)events.length=500;
    renderEvents();
    if(activeTab==='mesh')renderTab();
    flashTab('mesh');
    return;
  }

  events.unshift(evt);
  if(events.length>500)events.length=500;

  const aid=evt.agentId||evt.from;
  if(aid&&aid!=='system'&&aid!=='user'){
    if(!agents[aid])agents[aid]={id:aid};
    const ag=agents[aid];
    if(evt.type==='task:started'||evt.type.startsWith('action:'))ag.status='working';
    else if(evt.type==='task:completed')ag.status='idle';
    else if(evt.type==='task:failed')ag.status='error';
    else if(evt.type==='agent:status'||evt.type==='agent:online')ag.status=evt.status||'idle';
    else if(evt.type==='agent:offline')ag.status='offline';
    else if(evt.type.startsWith('discussion:provider_started'))ag.status='discussing';
    else if(evt.type.startsWith('discussion:provider_completed'))ag.status='idle';
    else if(evt.type==='system:rate_limit')ag.status='waiting';
    else if(evt.type==='system:fallback')ag.status='error';
    ag.lastEvent=evt.type;
    ag.lastEventAt=evt.timestamp||Date.now();
    if(evt.taskId)ag.currentTask=evt.taskId;
    if(evt.type==='task:completed'||evt.type==='task:failed')ag.currentTask=null;
  }

  if(evt.type.startsWith('message:')){
    messages.unshift({from:evt.from,to:evt.to||'all',content:evt.content,type:evt.type,time:evt.timestamp});
    if(messages.length>100)messages.length=100;
    if(activeTab==='messages')flashTab('messages');
  }

  if(evt.type.startsWith('discussion:')){
    const existing=discussions.find(d=>d.sessionId===evt.sessionId);
    if(existing){
      existing.lastEvent=evt.type; existing.lastUpdate=evt.timestamp;
      if(evt.consensusRate!==undefined)existing.consensusRate=evt.consensusRate;
      if(evt.round!==undefined)existing.currentRound=evt.round;
      if(evt.type==='discussion:completed')existing.status='completed';
    }else if(evt.type==='discussion:started'){
      discussions.unshift({sessionId:evt.sessionId,topic:evt.topic,mode:evt.mode,
        participants:evt.participants||[],status:'active',lastEvent:evt.type,
        lastUpdate:evt.timestamp,consensusRate:0,currentRound:0});
    }
  }

  if(evt.type==='task:created'||evt.type==='task:started'){
    tasks.unshift({id:evt.taskId,agent:evt.agentId,status:'running',time:evt.timestamp});
    if(tasks.length>50)tasks.length=50;
  }
  if(evt.type==='task:completed'){const t=tasks.find(t=>t.id===evt.taskId);if(t){t.status='completed';t.output=(evt.output||'').slice(0,300);}}
  if(evt.type==='task:failed'){const t=tasks.find(t=>t.id===evt.taskId);if(t){t.status='failed';t.error=evt.error;}}

  render();
}

// ── Tab flash ─────────────────────────────────────────
const tabNotify={};
function flashTab(tab){
  const el2=document.querySelector('.tab[data-tab="'+tab+'"]');
  if(!el2||activeTab===tab)return;
  el2.style.color='#58a6ff';
  clearTimeout(tabNotify[tab]);
  tabNotify[tab]=setTimeout(()=>{ if(activeTab!==tab)el2.style.color=''; },4000);
}

// ── Mesh helpers ──────────────────────────────────────
function meshHealth(hb){
  const d=Date.now()-new Date(hb||Date.now()).getTime();
  return d<60000?'active':d<180000?'idle':'stale';
}
function hDot(h){return '<span class="th-dot '+h+'"></span>';}
function hLabel(h){
  return h==='active'?'<span class="th-active-txt">● 응답중</span>':
         h==='idle'  ?'<span class="th-idle-txt">◐ 유휴</span>':
                      '<span class="th-stale-txt">○ 응답없음</span>';
}
function timeAgo(iso){
  const s=Math.floor((Date.now()-new Date(iso).getTime())/1000);
  return s<60?s+'s ago':s<3600?Math.floor(s/60)+'m ago':Math.floor(s/3600)+'h ago';
}

// Derive work mode if backend didn't set it
function resolveWorkMode(s){
  if(s.workMode && s.workMode!=='autonomous') return s.workMode;
  const collab=(s.collaborators||[]).length;
  if(collab>0||s.status==='discussing') return 'mesh';
  if(s.status==='reviewing') return 'reviewing';
  if(s.status==='idle'&&!s.currentWork) return 'waiting';
  if(['coding','thinking'].includes(s.status)) return 'solo';
  return 'waiting';
}

const WM_LABEL={
  solo:      '단독작업',
  mesh:      'Mesh 협업',
  waiting:   '대기',
  reviewing: '코드리뷰',
  blocked:   '블로킹',
  autonomous:'자율작업',
};
const WM_CSS={
  solo:'wm-solo', mesh:'wm-mesh', waiting:'wm-waiting',
  reviewing:'wm-reviewing', blocked:'wm-blocked', autonomous:'wm-solo',
};

// ── Conflict helpers ──────────────────────────────────
function conflictBadgeHtml(conflicts){
  if(!conflicts||!conflicts.length) return '';
  const hasHigh=conflicts.some(c=>c.severity==='high');
  const hasMed=conflicts.some(c=>c.severity==='medium');
  const cls=hasHigh?'has-high':hasMed?'has-medium':'has-low';
  const icon=hasHigh?'⚠':'⚡';
  return '<span class="mn-conflict-badge '+cls+'">'+icon+' '+conflicts.length+'</span>';
}
function conflictRowsHtml(conflicts){
  if(!conflicts||!conflicts.length) return '';
  const typeIcon={file:'📄',task:'♻',branch:'⎇'};
  const sevText={high:'위험',medium:'주의',low:'참고'};
  return '<div class="mn-conflicts">'+
    conflicts.slice(0,3).map(c=>
      '<div class="mn-conflict-row sev-'+c.severity+'">'+
        '<span class="mn-conflict-icon">'+(typeIcon[c.type]||'?')+'</span>'+
        '<span>'+escHtml(c.detail.slice(0,60))+'</span>'+
      '</div>'
    ).join('')+
    (conflicts.length>3?'<div style="font-size:9px;color:#484f58;padding:2px 6px">+'+( conflicts.length-3)+'개 더…</div>':'')+
  '</div>';
}

// ── Render: Mesh nodes (left panel) ──────────────────
function renderMeshNodes(flashId){
  const list=el('meshNodeList');
  const sessions=Object.values(meshSessions);
  el('meshNodeCount').textContent=sessions.length;

  // Auto-expand CLI Terminals section when there are active sessions
  const sec=document.getElementById('sec-mesh');
  if(sec&&sessions.length>0&&sec.classList.contains('collapsed')){
    sec.classList.remove('collapsed');
    localStorage.removeItem('nco-sec-sec-mesh');
  }

  if(!sessions.length){
    list.innerHTML='<div class="mesh-empty">활성 세션 없음<br><span style="font-size:9px">/nco-mesh ping 으로 등록</span></div>';
    return;
  }
  list.innerHTML=sessions.map(s=>{
    const h=meshHealth(s.lastHeartbeat);
    const wm=resolveWorkMode(s);
    const files=(s.currentFiles||[]);
    const fname=files.length?files[0].split('/').pop()+(files.length>1?' +<span style="color:#1f6feb88">'+( files.length-1)+'</span>':''):'';
    const collab=(s.collaborators||[]);
    const conflicts=(s.activeConflicts||[]);
    return '<div class="mesh-node mode-'+wm+'" id="mn-'+s.sessionId+'">'+
      '<div class="mn-inner">'+
        '<div class="mn-row1">'+
          hDot(h)+
          '<span class="mn-agent" style="color:'+agentColor(s.agentId)+'">'+escHtml(s.agentId)+'</span>'+
          '<span class="wm-badge '+(WM_CSS[wm]||'wm-waiting')+'">'+(WM_LABEL[wm]||wm)+'</span>'+
          conflictBadgeHtml(conflicts)+
          '<span class="mn-pid">'+s.pid+'</span>'+
        '</div>'+
        (s.currentWork
          ?'<div class="mn-row2">'+
              '<span class="mn-work">'+escHtml(s.currentWork.slice(0,52))+'</span>'+
              (collab.length?'<span class="mn-collab">⬡'+collab.length+'</span>':'')+
            '</div>':
          (collab.length?'<div class="mn-row2"><span class="mn-collab">⬡ '+escHtml(collab.slice(0,2).join(', '))+(collab.length>2?' +더보기':'')+'</span></div>':'')
        )+
        conflictRowsHtml(conflicts)+
        (fname?'<div class="mn-file"><span style="color:#21262d">▸</span> <span class="mn-file-name">'+fname+'</span></div>':'')+
        '<div class="mn-meta">'+
          '<span class="mn-meta-branch">⎇ '+escHtml(s.branch||'main')+'</span>'+
          (s.taskId?'<span class="mn-meta-task">'+s.taskId.slice(0,10)+'</span>':'')+
          '<span class="mn-meta-time">'+timeAgo(s.lastHeartbeat)+'</span>'+
        '</div>'+
      '</div>'+
    '</div>';
  }).join('');
  if(flashId){
    const node=document.getElementById('mn-'+flashId);
    if(node){node.classList.add('new-flash');setTimeout(()=>node.classList.remove('new-flash'),800);}
  }
}

// ── Render: Agents (left) ─────────────────────────────
function renderAgents(){
  const list=el('agentList');
  const sorted=Object.values(agents).sort((a,b)=>(b.score||0)-(a.score||0));
  el('agCnt').textContent=sorted.length||9;
  // Determine icon color by status
  const dotColor=(st)=>st==='working'||st==='coding'||st==='thinking'?'#3fb950':
    st==='discussing'?'#a5b4fc':st==='offline'||!st?'#21262d':
    st==='error'||st==='isolated'?'#f85149':'#d29922';
  list.innerHTML=sorted.map(a=>{
    const st=a.status||'offline';
    const shortEvent=a.lastEvent?(a.lastEvent.replace('action:','').replace('task:','').replace('agent:','').replace('discussion:','').replace('system:','')):'';
    return '<div class="ag" id="ag-'+a.id+'">'+
      '<div class="ag-left">'+
        '<span class="ag-icon" style="background:'+dotColor(st)+'"></span>'+
        '<span class="ag-name" style="color:'+agentColor(a.id)+'">'+a.id+'</span>'+
        (shortEvent?'<span class="ag-sub">'+escHtml(shortEvent.slice(0,18))+'</span>':'')+
        (a.currentTask?'<span class="ag-task">'+escHtml(a.currentTask.slice(0,14))+'</span>':'')+
      '</div>'+
      '<span class="st '+st+'">'+st+'</span>'+
    '</div>';
  }).join('');
  sorted.forEach(a=>{
    if(a.lastEventAt&&Date.now()-a.lastEventAt<2000){
      const n=document.getElementById('ag-'+a.id);
      if(n){n.classList.add('flash');setTimeout(()=>n.classList.remove('flash'),2000);}
    }
  });
}

// ── Render: Events (center) ───────────────────────────
function renderEvents(){
  const list=el('eventList');
  list.innerHTML=events.slice(0,300).map((e,i)=>{
    const t=new Date(e.timestamp||Date.now()).toLocaleTimeString('ko',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const agent=e.agentId||e.from||'';
    const detail=e.content||e.chunk||e.path||e.output||e.error||e.topic||
      (e.session?e.session.agentId+' '+e.session.status:'')||
      (e.message?e.message.fromAgent+'→'+e.message.to:'')||'';
    const tc=e._isMesh?'mesh':e.type.startsWith('action:')?'action':e.type.startsWith('task:')?'task':
      e.type.startsWith('discussion:')?'discussion':e.type.startsWith('message:')?'message':
      e.type.startsWith('system:')?'system':'agent';
    return '<div class="ev'+(i===0?' new':'')+'">'+
      '<span class="e-time">'+t+'</span>'+
      '<span class="e-agent" style="color:'+( e._isMesh?'#79c0ff':agentColor(agent))+'">'+escHtml(agent)+'</span>'+
      '<span class="e-type '+tc+'">'+escHtml(e.type)+'</span>'+
      '<span class="e-msg">'+escHtml(String(detail).slice(0,120))+'</span>'+
    '</div>';
  }).join('');
  el('evtCount').textContent=events.length+' events';
}

// ── Render: Tabs (right) ──────────────────────────────
function renderTab(){
  const content=el('tabContent');

  if(activeTab==='mesh'){
    const sessions=Object.values(meshSessions);

    // ── Terminal status bar ──
    const termBar=sessions.length
      ? '<div class="term-panel">'+
          '<div class="tp-title"><span>활성 CLI 터미널</span><span style="color:#3fb950">'+sessions.length+'개 온라인</span></div>'+
          sessions.map(s=>{
            const h=meshHealth(s.lastHeartbeat||new Date().toISOString());
            const wm=resolveWorkMode(s);
            const wmLabel=WM_LABEL[wm]||wm;
            const wmCss=WM_CSS[wm]||'wm-waiting';
            const conflicts=s.activeConflicts||[];
            const cbadge=conflictBadgeHtml(conflicts);
            return '<div class="term-row">'+
              hDot(h)+
              '<span class="term-pid">'+s.pid+'</span>'+
              '<span class="term-agent" style="color:'+agentColor(s.agentId)+'">'+escHtml(s.agentId)+'</span>'+
              '<span class="wm-badge '+wmCss+'" style="font-size:10px;padding:1px 6px">'+wmLabel+'</span>'+
              '<span class="term-work">'+escHtml((s.currentWork||'대기 중').slice(0,35))+'</span>'+
              cbadge+
              '<span class="term-health">'+hLabel(h)+'</span>'+
            '</div>';
          }).join('')+
        '</div>'
      : '<div class="term-panel"><div class="tp-title" style="color:#1f6feb44">활성 CLI 터미널 없음</div></div>';

    // ── Conflict analysis panel ──
    const allConflicts=sessions.flatMap(s=>(s.activeConflicts||[]).map(c=>({...c,fromSession:s.sessionId,fromAgent:s.agentId})));
    const conflictPanel=(()=>{
      const typeLabel={file:'파일 충돌',task:'작업 중복',branch:'브랜치 근접'};
      const sevLabel={high:'⚠ 위험',medium:'⚡ 주의',low:'• 참고'};
      const sevCls={high:'danger',medium:'warn',low:''};
      if(!allConflicts.length){
        return '<div class="conflict-panel">'+
          '<div class="conflict-panel-hdr safe">✓ 충돌 현황 — 이상 없음</div>'+
          '<div class="no-conflict"><span>✓</span><span>현재 작업 간 충돌 없음. 모든 CLI가 안전하게 작업 중입니다.</span></div>'+
        '</div>';
      }
      // Deduplicate by withSession+type
      const seen=new Set();
      const unique=allConflicts.filter(c=>{
        const k=c.fromSession+':'+c.withSession+':'+c.type;
        const kr=c.withSession+':'+c.fromSession+':'+c.type;
        if(seen.has(k)||seen.has(kr)) return false;
        seen.add(k); return true;
      });
      const hasHigh=unique.some(c=>c.severity==='high');
      const hasMed=unique.some(c=>c.severity==='medium');
      const hdrCls=hasHigh?'danger':hasMed?'warn':'safe';
      const hdrTxt=hasHigh?'⚠ 충돌 현황 — 즉시 조율 필요':hasMed?'⚡ 충돌 현황 — 주의 필요':'• 충돌 현황 — 경미한 사항';
      return '<div class="conflict-panel">'+
        '<div class="conflict-panel-hdr '+hdrCls+'">'+hdrTxt+' ('+unique.length+'건)</div>'+
        unique.map(c=>'<div class="conflict-entry">'+
          '<div class="conflict-entry-hdr">'+
            '<span class="ce-type '+c.type+'">'+(typeLabel[c.type]||c.type)+'</span>'+
            '<span class="ce-sev '+c.severity+'">'+(sevLabel[c.severity]||c.severity)+'</span>'+
            '<span class="ce-agent">'+escHtml(c.fromAgent)+'</span>'+
            '<span style="color:#484f58;font-size:10px">↔</span>'+
            '<span class="ce-agent">'+escHtml(c.withAgent)+'</span>'+
          '</div>'+
          '<div class="ce-detail">'+escHtml(c.detail)+'</div>'+
        '</div>').join('')+
      '</div>';
    })();

    // ── Messages ──
    const msgs=meshMessages.length
      ? meshMessages.map(m=>{
          const isBc=m.to==='*';
          const t=m.createdAt?new Date(m.createdAt).toLocaleTimeString('ko',{hour12:false}):'';
          const mtype=m.messageType||m.type||'info';
          return '<div class="mesh-msg type-'+mtype+'">'+
            '<div class="mh">'+
              '<span class="mfrom">'+escHtml(m.fromAgent||m.from_agent||'?')+'</span>'+
              '<span style="color:#484f58;font-size:11px">→</span>'+
              '<span class="mto">'+(isBc?'<span style="color:#3fb950">broadcast</span>':escHtml(m.to))+'</span>'+
              '<span style="color:#484f58;font-size:10px;padding:1px 5px;background:#161b22;border-radius:3px">'+mtype+'</span>'+
              '<span class="mtime">'+t+'</span>'+
            '</div>'+
            '<div class="mbody">'+escHtml((m.content||'').slice(0,400))+'</div>'+
          '</div>';
        }).join('')
      : '<div class="empty">메시지 없음<br><span style="font-size:10px;margin-top:4px;display:block">heartbeat 또는 /nco-mesh send 시 여기에 표시됩니다</span></div>';

    content.innerHTML=termBar+
      conflictPanel+
      '<div style="padding:5px 0 4px;color:#8b949e;font-size:10px;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #21262d;margin-bottom:5px;display:flex;justify-content:space-between">'+
        '<span>메시지 스트림</span><span style="color:#484f58">'+meshMessages.length+'</span></div>'+
      msgs;

  }else if(activeTab==='messages'){
    content.innerHTML=messages.length
      ? messages.map(m=>'<div class="msg-item"><div class="mh"><span class="mfrom">'+escHtml(m.from)+'</span><span style="color:#484f58">→</span><span class="mto">'+escHtml(m.to||'all')+'</span><span class="mtype">'+escHtml(m.type)+'</span></div><div class="mbody">'+escHtml((m.content||'').slice(0,400))+'</div></div>').join('')
      : '<div class="empty">No messages yet</div>';

  }else if(activeTab==='discussions'){
    content.innerHTML=discussions.length
      ? discussions.map(d=>'<div class="disc-item"><div class="dt">'+d.mode+': '+escHtml((d.topic||'').slice(0,70))+'</div><div class="dm">'+
          (d.sessionId||'').slice(0,16)+' · '+d.status+' · consensus '+(d.consensusRate*100||0).toFixed(0)+'% · round '+(d.currentRound||0)+'<br>'+
          (d.participants||[]).join(', ')+'</div></div>').join('')
      : '<div class="empty">No discussions yet</div>';

  }else if(activeTab==='tasks'){
    content.innerHTML=tasks.length
      ? tasks.map(t=>'<div class="task-item"><div class="th2"><span class="ta" style="color:'+agentColor(t.agent||'')+'">'+escHtml(t.agent||'?')+'</span><span class="tid">'+( t.id||'').slice(0,16)+'</span><span class="st '+(t.status||'')+'" style="font-size:10px;padding:1px 6px">'+(t.status||'?')+'</span></div>'+(t.output||t.error?'<div class="tb">'+escHtml((t.output||t.error||'').slice(0,300))+'</div>':'')+'</div>').join('')
      : '<div class="empty">No tasks yet</div>';
  }
}

function render(){ renderAgents(); renderEvents(); renderTab(); updateCounts(); }

function switchTab(tab){
  activeTab=tab;
  document.querySelectorAll('.tab').forEach(t=>{t.classList.remove('active');t.style.color='';});
  document.querySelector('.tab[data-tab="'+tab+'"]').classList.add('active');
  renderTab();
  localStorage.setItem('nco-active-tab',tab);
}

function updateCounts(){
  const online=Object.values(agents).filter(a=>a.status&&a.status!=='offline').length;
  const total=Object.keys(agents).length||9;
  el('onlineCount').textContent=online+'/'+total;
  el('onlineCount').className='badge '+(online>0?'ok':'err');
  const mc=Object.keys(meshSessions).length;
  el('meshCount').textContent='mesh '+mc;
  el('meshCount').className='badge '+(mc>0?'mesh':'err');
}

// ── Send functions ────────────────────────────────────
function sendMsg(){
  const input=el('sendInput'), target=el('sendTarget').value, text=input.value.trim();
  if(!text)return;
  if(target==='broadcast'){
    ws.send(JSON.stringify({type:'discussion:intervene',sessionId:'global',content:text}));
    fetch(API+'/api/chat/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:text,broadcast:true})});
  }else{
    fetch(API+'/api/task',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ai:target,prompt:text})});
  }
  input.value='';
}

function sendMesh(){
  const input=el('sendInput'), text=input.value.trim();
  if(!text)return;
  fetch(API+'/api/mesh/send',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({fromSessionId:'monitor',fromAgent:'monitor',toSessionId:'*',content:text,type:'info'})
  }).then(r=>r.json()).then(d=>{ input.value=''; if(activeTab==='mesh')pollMesh(); });
}

// ── Helpers ───────────────────────────────────────────
function agentColor(id){
  const c={'claude-code':'#58a6ff','claude-3':'#79c0ff','claude-4':'#79c0ff','claude-5':'#79c0ff',
    'opencode':'#a5b4fc','gemini':'#3fb950','codex':'#d2a8ff','aider':'#d29922',
    'cursor-agent':'#f0883e','copilot':'#8b949e','openrouter':'#79c0ff',
    'vllm':'#56d364','system':'#f85149','user':'#d29922','mesh':'#58a6ff','monitor':'#58a6ff'};
  return c[id]||'#8b949e';
}
function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function el(id){return document.getElementById(id);}

// ── Mesh polling ──────────────────────────────────────
async function pollMesh(){
  try{
    const d=await(await fetch(API+'/api/mesh/sessions')).json();
    const fresh={};
    (d.sessions||[]).forEach(s=>{ fresh[s.sessionId]=s; });
    Object.keys(meshSessions).forEach(id=>{ if(!fresh[id])delete meshSessions[id]; });
    Object.assign(meshSessions,fresh);
    renderMeshNodes();
    updateCounts();
    if(activeTab==='mesh')renderTab();
  }catch{}
}

// ── Init ──────────────────────────────────────────────
async function init(){
  // Restore tab
  const savedTab=localStorage.getItem('nco-active-tab');
  if(savedTab) switchTab(savedTab);

  try{
    const d=await(await fetch(API+'/api/daemons')).json();
    (d.daemons||[]).forEach(a=>{
      agents[a.id]={id:a.id,status:a.status,role:a.role,score:a.score,currentTask:a.currentTask,health:a.health};
    });
    const sel=el('sendTarget');
    (d.daemons||[]).forEach(a=>{
      const o=document.createElement('option'); o.value=a.id; o.textContent=a.id+' ('+a.role+')'; sel.appendChild(o);
    });
  }catch{}

  try{
    const d=await(await fetch(API+'/api/agent-actions?limit=80')).json();
    (d.actions||[]).forEach(a=>{
      try{ const det=JSON.parse(a.detail_json||'{}'); events.push({type:a.action_type,agentId:a.agent_id,timestamp:new Date(a.created_at).getTime(),...det}); }catch{}
    });
  }catch{}

  try{
    const d=await(await fetch(API+'/api/discussions')).json();
    (d.discussions||[]).forEach(d=>{
      discussions.push({sessionId:d.id,topic:d.topic,mode:d.mode,status:d.status,
        participants:JSON.parse(d.participants_json||'[]'),consensusRate:d.consensus_rate||0,currentRound:d.current_round||0});
    });
  }catch{}

  await pollMesh();
  render();
  connect();

  setInterval(async()=>{
    try{ await fetch(API+'/health'); el('apiDot').className='dot on'; el('apiText').textContent='API healthy'; }
    catch{ el('apiDot').className='dot off'; el('apiText').textContent='API offline'; }
  },10000);

  setInterval(pollMesh,15000);

  // Heartbeat refresh counter
  setInterval(()=>{ renderMeshNodes(); if(activeTab==='mesh')renderTab(); }, 10000);

  try{ await fetch(API+'/health'); el('apiDot').className='dot on'; el('apiText').textContent='API healthy'; }
  catch{ el('apiDot').className='dot off'; el('apiText').textContent='API offline'; }
}

init();
</script>
</body>
</html>`;
}
