/** GET /monitor — NCO Live Monitor (실시간 대시보드) */
export function getMonitorHTML(wsPort: number, apiPort: number): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>NCO Live Monitor</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Cascadia Code','Fira Code',monospace;background:#0d1117;color:#c9d1d9;font-size:12px}

.header{background:#161b22;padding:8px 16px;border-bottom:1px solid #30363d;display:flex;justify-content:space-between;align-items:center}
.header h1{font-size:15px;color:#58a6ff}
.hdr-right{display:flex;gap:12px;align-items:center;font-size:11px}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:4px}
.dot.on{background:#3fb950}.dot.off{background:#f85149}.dot.warn{background:#d29922}
.badge{padding:1px 6px;border-radius:3px;font-size:10px}
.badge.ok{background:#0d2818;color:#3fb950}.badge.err{background:#3d1111;color:#f85149}

.grid{display:grid;grid-template-columns:260px 1fr 320px;height:calc(100vh - 76px)}

/* Left: Agents */
.agents{border-right:1px solid #30363d;overflow-y:auto}
.agents h3{padding:8px;color:#8b949e;font-size:10px;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #21262d}
.ag{padding:6px 8px;border-bottom:1px solid #161b22;display:flex;justify-content:space-between;align-items:center;transition:background .3s}
.ag.flash{background:#1c1d3e}
.ag .left{display:flex;flex-direction:column;gap:1px}
.ag .name{font-weight:bold;font-size:12px}.ag .role{color:#8b949e;font-size:10px}
.ag .task{color:#58a6ff;font-size:10px;margin-top:1px}
.st{font-size:10px;padding:2px 8px;border-radius:10px;font-weight:bold;min-width:60px;text-align:center}
.st.idle{background:#1f2937;color:#8b949e}
.st.working{background:#0d2818;color:#3fb950;animation:pulse 1.5s infinite}
.st.thinking{background:#0d2818;color:#3fb950;animation:pulse 1.5s infinite}
.st.discussing{background:#1c1d5e;color:#a5b4fc;animation:pulse 2s infinite}
.st.reviewing{background:#2d1b4e;color:#d2a8ff}
.st.waiting{background:#2d2305;color:#d29922}
.st.error{background:#3d1111;color:#f85149}
.st.isolated{background:#3d1111;color:#f85149}
.st.offline{background:#0d1117;color:#484f58}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.6}}

/* Center: Event Stream */
.events{overflow-y:auto;display:flex;flex-direction:column}
.events h3{padding:8px;color:#8b949e;font-size:10px;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #21262d;display:flex;justify-content:space-between}
.events h3 span{color:#484f58}
.evt-list{flex:1;overflow-y:auto}
.ev{padding:3px 8px;border-bottom:1px solid #0d1117;display:flex;gap:6px;font-size:11px;transition:background .5s}
.ev.new{background:#1c1d3e}
.ev .time{color:#484f58;min-width:55px;flex-shrink:0}
.ev .agent{min-width:80px;flex-shrink:0;font-weight:bold}
.ev .tp{min-width:150px;flex-shrink:0}
.ev .msg{color:#8b949e;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* Type colors */
.tp.action{color:#3fb950}.tp.task{color:#58a6ff}.tp.discussion{color:#a5b4fc}
.tp.message{color:#d29922}.tp.system{color:#f85149}.tp.agent{color:#d2a8ff}

/* Right: Details */
.right{border-left:1px solid #30363d;display:flex;flex-direction:column}
.right .tab-bar{display:flex;border-bottom:1px solid #21262d}
.right .tab{padding:6px 12px;color:#8b949e;cursor:pointer;font-size:10px;text-transform:uppercase;letter-spacing:1px;border-bottom:2px solid transparent}
.right .tab.active{color:#58a6ff;border-bottom-color:#58a6ff}
.right .tab-content{flex:1;overflow-y:auto;padding:8px}
.msg-item{padding:4px 0;border-bottom:1px solid #161b22}
.msg-item .from{color:#d29922;font-weight:bold;font-size:11px}
.msg-item .to{color:#8b949e;font-size:10px}
.msg-item .body{color:#c9d1d9;font-size:11px;margin-top:2px;white-space:pre-wrap;word-break:break-all}
.disc-item{padding:6px 0;border-bottom:1px solid #161b22}
.disc-item .topic{color:#a5b4fc;font-size:11px}
.disc-item .meta{color:#484f58;font-size:10px}

/* Bottom input */
.input-bar{height:34px;background:#161b22;border-top:1px solid #30363d;padding:4px 16px;display:flex;gap:8px;align-items:center}
.input-bar select{background:#0d1117;border:1px solid #30363d;color:#c9d1d9;padding:3px 6px;border-radius:4px;font-size:11px}
.input-bar input{flex:1;background:#0d1117;border:1px solid #30363d;color:#c9d1d9;padding:4px 10px;border-radius:4px;font-family:inherit;font-size:12px}
.input-bar input:focus{border-color:#58a6ff;outline:none}
.input-bar button{background:#238636;color:#fff;border:none;padding:4px 14px;border-radius:4px;cursor:pointer;font-size:11px}
.input-bar button:hover{background:#2ea043}

.counter{position:fixed;bottom:38px;right:8px;color:#484f58;font-size:10px}
</style>
</head>
<body>

<div class="header">
  <h1>NCO Live Monitor</h1>
  <div class="hdr-right">
    <div><span class="dot" id="wsDot"></span><span id="wsText">WS connecting...</span></div>
    <div><span class="dot" id="apiDot"></span><span id="apiText">API...</span></div>
    <div id="onlineCount" class="badge ok">0/9</div>
  </div>
</div>

<div class="grid">
  <!-- Left: Agents -->
  <div class="agents">
    <h3>Agents (9)</h3>
    <div id="agentList"></div>
  </div>

  <!-- Center: Events -->
  <div class="events">
    <h3>Event Stream <span id="evtCount">0</span></h3>
    <div class="evt-list" id="eventList"></div>
  </div>

  <!-- Right: Details -->
  <div class="right">
    <div class="tab-bar">
      <div class="tab active" data-tab="messages" onclick="switchTab('messages')">Messages</div>
      <div class="tab" data-tab="discussions" onclick="switchTab('discussions')">Discussions</div>
      <div class="tab" data-tab="tasks" onclick="switchTab('tasks')">Tasks</div>
    </div>
    <div class="tab-content" id="tabContent"></div>
  </div>
</div>

<!-- Input bar -->
<div class="input-bar">
  <select id="sendTarget">
    <option value="broadcast">Broadcast</option>
  </select>
  <input id="sendInput" placeholder="Send message or command..." onkeydown="if(event.key==='Enter')sendMsg()">
  <button onclick="sendMsg()">Send</button>
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
let activeTab='messages';

// ─── WebSocket ─────────────────────────
function connect(){
  ws=new WebSocket(WS_URL);
  ws.onopen=()=>{
    el('wsDot').className='dot on';
    el('wsText').textContent='WS connected';
  };
  ws.onclose=()=>{
    el('wsDot').className='dot off';
    el('wsText').textContent='WS disconnected';
    setTimeout(connect,3000);
  };
  ws.onerror=()=>{};
  ws.onmessage=(e)=>{
    try{handleEvent(JSON.parse(e.data));}catch{}
  };
}

// ─── Event Handler ─────────────────────
function handleEvent(evt){
  if(evt.type==='connected')return;

  // Add to event stream
  events.unshift(evt);
  if(events.length>500)events.length=500;

  // Update agent state from ANY event with agentId
  const aid=evt.agentId||evt.from;
  if(aid && aid!=='system' && aid!=='user'){
    if(!agents[aid])agents[aid]={id:aid};
    const ag=agents[aid];

    // Status inference from event type
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

  // Collect messages
  if(evt.type.startsWith('message:')){
    messages.unshift({from:evt.from,to:evt.to||'all',content:evt.content,type:evt.type,time:evt.timestamp});
    if(messages.length>100)messages.length=100;
  }

  // Collect discussion events
  if(evt.type.startsWith('discussion:')){
    const existing=discussions.find(d=>d.sessionId===evt.sessionId);
    if(existing){
      existing.lastEvent=evt.type;
      existing.lastUpdate=evt.timestamp;
      if(evt.consensusRate!==undefined)existing.consensusRate=evt.consensusRate;
      if(evt.round!==undefined)existing.currentRound=evt.round;
      if(evt.type==='discussion:completed')existing.status='completed';
    } else if(evt.type==='discussion:started'){
      discussions.unshift({sessionId:evt.sessionId,topic:evt.topic,mode:evt.mode,
        participants:evt.participants||[],status:'active',lastEvent:evt.type,
        lastUpdate:evt.timestamp,consensusRate:0,currentRound:0});
    }
  }

  // Collect tasks
  if(evt.type==='task:created'||evt.type==='task:started'){
    tasks.unshift({id:evt.taskId,agent:evt.agentId,status:'running',time:evt.timestamp});
    if(tasks.length>50)tasks.length=50;
  }
  if(evt.type==='task:completed'){
    const t=tasks.find(t=>t.id===evt.taskId);
    if(t){t.status='completed';t.output=(evt.output||'').slice(0,200);}
  }
  if(evt.type==='task:failed'){
    const t=tasks.find(t=>t.id===evt.taskId);
    if(t){t.status='failed';t.error=evt.error;}
  }

  render();
}

// ─── Render ────────────────────────────
function render(){
  renderAgents();
  renderEvents();
  renderTab();
  updateCounts();
}

function renderAgents(){
  const list=el('agentList');
  const sorted=Object.values(agents).sort((a,b)=>(b.score||0)-(a.score||0));
  list.innerHTML=sorted.map(a=>{
    const st=a.status||'offline';
    const task=a.currentTask?'<div class="task">'+a.currentTask.slice(0,20)+'</div>':'';
    const lastEvt=a.lastEvent?'<div class="role">'+a.lastEvent+'</div>':'';
    return '<div class="ag" id="ag-'+a.id+'"><div class="left"><span class="name">'+a.id+'</span><span class="role">'+(a.role||a.id)+'</span>'+task+lastEvt+'</div><span class="st '+st+'">'+st+'</span></div>';
  }).join('');

  // Flash animation
  sorted.forEach(a=>{
    if(a.lastEventAt && Date.now()-a.lastEventAt<2000){
      const el2=document.getElementById('ag-'+a.id);
      if(el2){el2.classList.add('flash');setTimeout(()=>el2.classList.remove('flash'),2000);}
    }
  });
}

function renderEvents(){
  const list=el('eventList');
  list.innerHTML=events.slice(0,200).map((e,i)=>{
    const t=new Date(e.timestamp||Date.now()).toLocaleTimeString('ko',{hour12:false});
    const agent=e.agentId||e.from||'';
    const detail=e.content||e.chunk||e.path||e.output||e.error||e.topic||'';
    const typeClass=e.type.startsWith('action:')?'action':
      e.type.startsWith('task:')?'task':
      e.type.startsWith('discussion:')?'discussion':
      e.type.startsWith('message:')?'message':
      e.type.startsWith('system:')?'system':'agent';
    const isNew=i===0?'new':'';
    return '<div class="ev '+isNew+'"><span class="time">'+t+'</span><span class="agent" style="color:'+agentColor(agent)+'">'+agent+'</span><span class="tp '+typeClass+'">'+e.type+'</span><span class="msg">'+String(detail).slice(0,100).replace(/</g,'&lt;')+'</span></div>';
  }).join('');
  el('evtCount').textContent=events.length;
}

function renderTab(){
  const content=el('tabContent');
  if(activeTab==='messages'){
    content.innerHTML=messages.length?messages.map(m=>
      '<div class="msg-item"><span class="from">'+m.from+'</span> <span class="to">→ '+(m.to||'all')+'</span> <span style="color:#484f58;font-size:10px">'+m.type+'</span><div class="body">'+(m.content||'').slice(0,300).replace(/</g,'&lt;')+'</div></div>'
    ).join(''):'<div style="color:#484f58;padding:20px">No messages yet</div>';
  } else if(activeTab==='discussions'){
    content.innerHTML=discussions.length?discussions.map(d=>
      '<div class="disc-item"><div class="topic">'+d.mode+': '+(d.topic||'').slice(0,60)+'</div><div class="meta">'+d.sessionId?.slice(0,16)+' | '+d.status+' | consensus: '+(d.consensusRate*100||0).toFixed(0)+'% | round: '+(d.currentRound||0)+' | '+((d.participants||[]).join(', '))+'</div></div>'
    ).join(''):'<div style="color:#484f58;padding:20px">No discussions yet</div>';
  } else if(activeTab==='tasks'){
    content.innerHTML=tasks.length?tasks.map(t=>
      '<div class="msg-item"><span class="from">'+(t.agent||'?')+'</span> <span class="to">'+t.id?.slice(0,16)+'</span> <span class="st '+(t.status||'')+'" style="font-size:10px">'+(t.status||'?')+'</span><div class="body">'+(t.output||t.error||'').slice(0,200).replace(/</g,'&lt;')+'</div></div>'
    ).join(''):'<div style="color:#484f58;padding:20px">No tasks yet</div>';
  }
}

function switchTab(tab){
  activeTab=tab;
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  document.querySelector('.tab[data-tab="'+tab+'"]').classList.add('active');
  renderTab();
}

function updateCounts(){
  const online=Object.values(agents).filter(a=>a.status&&a.status!=='offline').length;
  const total=Object.keys(agents).length||9;
  el('onlineCount').textContent=online+'/'+total;
  el('onlineCount').className='badge '+(online>0?'ok':'err');
}

// ─── Send Message (양방향) ─────────────
function sendMsg(){
  const input=el('sendInput');
  const target=el('sendTarget').value;
  const text=input.value.trim();
  if(!text)return;

  if(target==='broadcast'){
    ws.send(JSON.stringify({type:'discussion:intervene',sessionId:'global',content:text}));
    // Also via REST
    fetch(API+'/api/chat/messages',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({message:text,broadcast:true})});
  } else {
    fetch(API+'/api/task',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ai:target,prompt:text})});
  }
  input.value='';
}

// ─── Agent Color ───────────────────────
function agentColor(id){
  const colors={'claude-code':'#58a6ff','opencode':'#a5b4fc','gemini':'#3fb950',
    'codex':'#d2a8ff','aider':'#d29922','cursor-agent':'#f0883e','copilot':'#8b949e',
    'openrouter':'#79c0ff','vllm':'#56d364','system':'#f85149','user':'#d29922'};
  return colors[id]||'#8b949e';
}

function el(id){return document.getElementById(id);}

// ─── Initial Load ──────────────────────
async function init(){
  // Load agents from REST
  try{
    const daemons=await(await fetch(API+'/api/daemons')).json();
    (daemons.daemons||[]).forEach(d=>{
      agents[d.id]={id:d.id,status:d.status,role:d.role,score:d.score,
        currentTask:d.currentTask,health:d.health};
    });
    // Populate send target dropdown
    const sel=el('sendTarget');
    (daemons.daemons||[]).forEach(d=>{
      const opt=document.createElement('option');
      opt.value=d.id;opt.textContent=d.id+' ('+d.role+')';
      sel.appendChild(opt);
    });
  }catch{}

  // Load recent events
  try{
    const actions=await(await fetch(API+'/api/agent-actions?limit=50')).json();
    (actions.actions||[]).forEach(a=>{
      try{
        const detail=JSON.parse(a.detail_json||'{}');
        events.push({type:a.action_type,agentId:a.agent_id,timestamp:new Date(a.created_at).getTime(),...detail});
      }catch{}
    });
  }catch{}

  // Load discussions
  try{
    const discs=await(await fetch(API+'/api/discussions')).json();
    (discs.discussions||[]).forEach(d=>{
      discussions.push({sessionId:d.id,topic:d.topic,mode:d.mode,status:d.status,
        participants:JSON.parse(d.participants_json||'[]'),
        consensusRate:d.consensus_rate||0,currentRound:d.current_round||0});
    });
  }catch{}

  render();
  connect();

  // API health poll every 10s
  setInterval(async()=>{
    try{
      const h=await(await fetch(API+'/health')).json();
      el('apiDot').className='dot on';
      el('apiText').textContent='API healthy';
    }catch{
      el('apiDot').className='dot off';
      el('apiText').textContent='API offline';
    }
  },10000);
  // Trigger first check
  try{await fetch(API+'/health');el('apiDot').className='dot on';el('apiText').textContent='API healthy';}catch{el('apiDot').className='dot off';el('apiText').textContent='API offline';}
}

init();
</script>
</body>
</html>`;
}
