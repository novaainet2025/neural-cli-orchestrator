/** GET /monitor — single-page live dashboard (no build, no deps) */
export function getMonitorHTML(wsPort: number): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>NCO Live Monitor</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Cascadia Code','Fira Code',monospace;background:#0d1117;color:#c9d1d9;font-size:13px}
.header{background:#161b22;padding:10px 16px;border-bottom:1px solid #30363d;display:flex;justify-content:space-between;align-items:center}
.header h1{font-size:16px;color:#58a6ff}
.status{display:flex;gap:8px;align-items:center}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.dot.on{background:#3fb950}.dot.off{background:#f85149}
.grid{display:grid;grid-template-columns:280px 1fr;grid-template-rows:1fr 200px;height:calc(100vh - 42px)}
.panel{border:1px solid #30363d;overflow-y:auto;padding:8px}
.panel h3{color:#8b949e;font-size:11px;text-transform:uppercase;margin-bottom:6px;letter-spacing:1px}
.agents{grid-row:1/3}
.events{grid-column:2;grid-row:1}
.bottom{grid-column:2;grid-row:2;display:grid;grid-template-columns:1fr 1fr;gap:0}
.agent{padding:6px 8px;border-bottom:1px solid #21262d;display:flex;justify-content:space-between;align-items:center}
.agent .name{font-weight:bold;color:#c9d1d9}.agent .role{color:#8b949e;font-size:11px}
.agent .st{font-size:11px;padding:2px 6px;border-radius:3px}
.st.idle{background:#1f2937;color:#8b949e}
.st.working{background:#0d2818;color:#3fb950}
.st.discussing{background:#1c1d5e;color:#a5b4fc}
.st.error{background:#3d1111;color:#f85149}
.st.offline{background:#161b22;color:#484f58}
.evt{padding:4px 8px;border-bottom:1px solid #21262d;font-size:12px;display:flex;gap:8px}
.evt .time{color:#484f58;min-width:60px}
.evt .type{color:#d2a8ff;min-width:140px}
.evt .detail{color:#8b949e;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.input-bar{position:fixed;bottom:0;left:0;right:0;background:#161b22;border-top:1px solid #30363d;padding:8px 16px;display:flex;gap:8px}
.input-bar input{flex:1;background:#0d1117;border:1px solid #30363d;color:#c9d1d9;padding:6px 10px;border-radius:4px;font-family:inherit;font-size:13px}
.input-bar button{background:#238636;color:#fff;border:none;padding:6px 16px;border-radius:4px;cursor:pointer}
</style>
</head>
<body>
<div class="header">
  <h1>NCO Live Monitor</h1>
  <div class="status"><span class="dot" id="connDot"></span><span id="connText">connecting...</span></div>
</div>
<div class="grid">
  <div class="panel agents" id="agentPanel"><h3>Agents</h3><div id="agentList"></div></div>
  <div class="panel events"><h3>Event Stream</h3><div id="eventList"></div></div>
  <div class="bottom">
    <div class="panel"><h3>Active Discussions</h3><div id="discList">None</div></div>
    <div class="panel"><h3>Recent Artifacts</h3><div id="artList">None</div></div>
  </div>
</div>
<script>
const WS_URL='ws://localhost:${wsPort}';
let ws,agents={},events=[];
function connect(){
  ws=new WebSocket(WS_URL);
  ws.onopen=()=>{
    document.getElementById('connDot').className='dot on';
    document.getElementById('connText').textContent='connected';
  };
  ws.onclose=()=>{
    document.getElementById('connDot').className='dot off';
    document.getElementById('connText').textContent='disconnected';
    setTimeout(connect,3000);
  };
  ws.onmessage=(e)=>{
    try{const evt=JSON.parse(e.data);handleEvent(evt);}catch{}
  };
}
function handleEvent(evt){
  // Update agents
  if(evt.agentId&&evt.type.startsWith('agent:')){
    agents[evt.agentId]={...agents[evt.agentId],...evt,lastSeen:Date.now()};
    renderAgents();
  }
  if(evt.type&&evt.type.startsWith('action:')){
    agents[evt.agentId]={...agents[evt.agentId],status:'working',lastAction:evt.type,lastSeen:Date.now()};
    renderAgents();
  }
  // Add to event stream
  events.unshift(evt);
  if(events.length>200)events.length=200;
  renderEvents();
}
function renderAgents(){
  const list=document.getElementById('agentList');
  list.innerHTML=Object.entries(agents).map(([id,a])=>{
    const st=a.status||'offline';
    return '<div class="agent"><div><span class="name">'+id+'</span><br><span class="role">'+(a.role||'')+'</span></div><span class="st '+st+'">'+st+'</span></div>';
  }).join('');
}
function renderEvents(){
  const list=document.getElementById('eventList');
  list.innerHTML=events.slice(0,100).map(e=>{
    const t=new Date(e.timestamp||Date.now()).toLocaleTimeString('ko',{hour12:false});
    const agent=e.agentId||e.from||'';
    const detail=e.content||e.chunk||e.path||e.output||e.error||'';
    return '<div class="evt"><span class="time">'+t+'</span><span class="type">'+e.type+'</span><span class="detail">'+agent+(detail?' — '+String(detail).slice(0,80):'')+'</span></div>';
  }).join('');
}
// Initial load of agents via REST
fetch('/api/ai-providers/status').then(r=>r.json()).then(d=>{
  if(d.providers)Object.entries(d.providers).forEach(([id,s])=>{agents[id]=s;});
  renderAgents();
}).catch(()=>{});
connect();
</script>
</body>
</html>`;
}
