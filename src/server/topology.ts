/**
 * NCO Topology Page — React Flow visualization of CLI sessions, agents, and mesh communication
 */
export function getTopologyHTML(wsPort: number, apiPort: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>NCO Topology</title>
<script src="https://unpkg.com/react@18/umd/react.production.min.js" crossorigin></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js" crossorigin></script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
<script src="https://unpkg.com/reactflow@11/dist/umd/index.js" crossorigin></script>
<script src="https://unpkg.com/dagre@0.8.5/dist/dagre.min.js"></script>
<link rel="stylesheet" href="https://unpkg.com/reactflow@11/dist/style.css">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body,#root{width:100%;height:100%;background:#070b11;font-family:'SF Mono',Monaco,monospace;color:#c9d1d9;overflow:hidden}
.topo-shell{display:flex;flex-direction:column;height:100vh;background:#070b11}
/* Header */
.topo-header{
  display:flex;align-items:center;gap:12px;
  padding:8px 16px;
  background:#0d1117;
  border-bottom:1px solid #1a2535;
  flex-shrink:0;z-index:10;
}
.topo-logo{font-size:13px;font-weight:700;color:#1f6feb;letter-spacing:.5px}
.topo-title{font-size:11px;color:#8b949e;letter-spacing:1.5px;text-transform:uppercase}
.topo-sep{flex:1}
.topo-stats{display:flex;gap:16px}
.topo-stat{display:flex;align-items:center;gap:5px;font-size:10px;color:#8b949e}
.topo-stat-val{color:#e6edf3;font-weight:600}
.topo-dot{width:6px;height:6px;border-radius:50%;background:#2da44e}
.topo-dot.warn{background:#d29922}
.topo-dot.err{background:#da3633}
.topo-actions{display:flex;gap:6px}
.topo-btn{
  padding:4px 10px;font-size:10px;border:1px solid #30363d;
  background:#161b22;color:#8b949e;cursor:pointer;border-radius:4px;
  transition:all .15s;
}
.topo-btn:hover{background:#1f6feb;border-color:#1f6feb;color:#fff}
.topo-btn.active{background:#1f6feb22;border-color:#1f6feb;color:#79c0ff}
/* Main */
.topo-main{display:flex;flex:1;min-height:0}
/* Flow */
.topo-flow{flex:1;position:relative}
.react-flow__background{background:#070b11}
.react-flow__minimap{border:1px solid #1a2535;border-radius:4px;overflow:hidden}
.react-flow__controls{border:1px solid #1a2535;border-radius:4px;overflow:hidden;background:#0d1117}
.react-flow__controls-button{background:#0d1117;border-bottom:1px solid #1a2535;fill:#8b949e;padding:5px}
.react-flow__controls-button:hover{background:#161b22;fill:#e6edf3}
/* Detail panel */
.topo-detail{
  width:280px;flex-shrink:0;
  background:#0d1117;border-left:1px solid #1a2535;
  display:flex;flex-direction:column;overflow:hidden;
}
.topo-detail.hidden{width:0;border:none}
.detail-header{
  padding:10px 12px;border-bottom:1px solid #1a2535;
  display:flex;align-items:center;justify-content:space-between;flex-shrink:0;
}
.detail-title{font-size:11px;font-weight:700;color:#e6edf3;letter-spacing:.5px}
.detail-close{background:none;border:none;color:#8b949e;cursor:pointer;font-size:14px;padding:0 2px}
.detail-close:hover{color:#e6edf3}
.detail-body{flex:1;overflow-y:auto;padding:10px 12px}
.detail-section{margin-bottom:14px}
.detail-section-title{font-size:9px;font-weight:700;color:#8b949e;letter-spacing:1px;text-transform:uppercase;margin-bottom:6px}
.detail-row{display:flex;align-items:flex-start;gap:6px;margin-bottom:4px;font-size:10px}
.detail-key{color:#8b949e;min-width:70px;flex-shrink:0}
.detail-val{color:#e6edf3;word-break:break-all}
.detail-badge{
  display:inline-flex;align-items:center;padding:1px 6px;
  border-radius:10px;font-size:9px;font-weight:600;
}
.detail-edge{
  display:flex;align-items:center;gap:6px;
  padding:4px 6px;margin-bottom:3px;
  border:1px solid #1a2535;border-radius:4px;background:#070b11;
  font-size:10px;
}
.detail-edge-arrow{color:#3fb950;font-size:9px}
.detail-msgs{max-height:200px;overflow-y:auto}
.detail-msg{
  padding:4px 6px;margin-bottom:3px;
  border-left:2px solid #1f6feb;
  background:#070b11;font-size:9px;color:#8b949e;
}
.detail-msg-from{color:#79c0ff;margin-bottom:2px;font-size:8px}
.detail-msg-content{color:#c9d1d9;word-break:break-all}
/* Legend */
.topo-legend{
  position:absolute;bottom:10px;left:10px;
  background:#0d1117cc;border:1px solid #1a2535;border-radius:6px;
  padding:8px 12px;z-index:5;font-size:9px;
}
.legend-title{color:#8b949e;letter-spacing:.8px;text-transform:uppercase;margin-bottom:6px;font-weight:700}
.legend-row{display:flex;align-items:center;gap:6px;margin-bottom:3px;color:#8b949e}
.legend-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
.legend-line{width:20px;height:2px;flex-shrink:0}
.legend-dashed{width:20px;height:0;border-top:2px dashed #30363d;flex-shrink:0}
/* Node styles (injected via foreignObject or custom renderers) */
.nco-node{
  padding:10px 14px;border-radius:8px;
  background:linear-gradient(135deg,#1a0a2e,#2d1b69);
  border:2px solid #7c3aed;box-shadow:0 0 16px #7c3aed44;
  display:flex;flex-direction:column;align-items:center;gap:4px;
  min-width:110px;cursor:pointer;transition:all .2s;
}
.nco-node:hover,.nco-node.selected{box-shadow:0 0 24px #7c3aed88;border-color:#a78bfa}
.nco-node-icon{font-size:18px}
.nco-node-label{font-size:11px;font-weight:700;color:#e9d5ff;letter-spacing:.3px}
.nco-node-sub{font-size:9px;color:#a78bfa}

.cli-node{
  padding:8px 12px;border-radius:6px;
  background:linear-gradient(135deg,#0a1628,#0d2137);
  border:1.5px solid #1f6feb;box-shadow:0 0 10px #1f6feb33;
  display:flex;flex-direction:column;gap:3px;
  min-width:130px;cursor:pointer;transition:all .2s;
}
.cli-node:hover,.cli-node.selected{box-shadow:0 0 18px #1f6feb66;border-color:#58a6ff}
.cli-node-top{display:flex;align-items:center;gap:6px}
.cli-node-icon{font-size:12px}
.cli-node-name{font-size:11px;font-weight:700;color:#e6edf3}
.cli-node-status{width:6px;height:6px;border-radius:50%;background:#2da44e;margin-left:auto;flex-shrink:0}
.cli-node-status.idle{background:#656d76}
.cli-node-status.busy{background:#d29922}
.cli-node-meta{font-size:9px;color:#8b949e;display:flex;gap:8px}
.cli-node-work{font-size:9px;color:#79c0ff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px}

.agent-node{
  padding:7px 10px;border-radius:5px;
  display:flex;flex-direction:column;gap:2px;
  min-width:100px;cursor:pointer;transition:all .2s;
  border:1.5px solid transparent;
}
.agent-node:hover,.agent-node.selected{filter:brightness(1.2)}
.agent-node-top{display:flex;align-items:center;gap:5px}
.agent-node-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.agent-node-name{font-size:10px;font-weight:700;color:#e6edf3}
.agent-node-role{font-size:8px;color:#8b949e}
.agent-node-tasks{font-size:8px}

/* Animated particles in edges */
.edge-particle{animation:edgePulse 1.5s ease-in-out infinite}
@keyframes edgePulse{0%,100%{opacity:.3}50%{opacity:1}}

/* Loading */
.topo-loading{
  position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
  display:flex;flex-direction:column;align-items:center;gap:12px;
  color:#8b949e;font-size:12px;
}
.topo-spinner{
  width:32px;height:32px;border:3px solid #1a2535;
  border-top-color:#1f6feb;border-radius:50%;
  animation:spin .8s linear infinite;
}
@keyframes spin{to{transform:rotate(360deg)}}

.react-flow__edge-path{stroke-width:1.5}
.react-flow__minimap-mask{fill:#070b11cc}
</style>
</head>
<body>
<div id="root"></div>

<script type="text/babel" data-presets="react">
const { useState, useEffect, useCallback, useRef, useMemo } = React;
const {
  ReactFlow, Background, Controls, MiniMap,
  useNodesState, useEdgesState, addEdge,
  getBezierPath, getStraightPath, getSmoothStepPath,
  MarkerType, Panel, useReactFlow, ReactFlowProvider,
  BaseEdge, EdgeLabelRenderer,
} = ReactFlow || window.ReactFlow;

const API = 'http://localhost:${apiPort}';
const WS_URL = 'ws://localhost:${wsPort}';

// ──────────────────────────────────────────────────────────────
// AGENT COLOR MAP
// ──────────────────────────────────────────────────────────────
const AGENT_COLORS = {
  opencode:       { bg:'#0f1f14', border:'#2da44e', dot:'#3fb950', role:'Architect' },
  gemini:         { bg:'#1a1400', border:'#d29922', dot:'#e3b341', role:'Designer' },
  codex:          { bg:'#0a1628', border:'#1f6feb', dot:'#58a6ff', role:'Engineer' },
  aider:          { bg:'#0f1628', border:'#388bfd', dot:'#79c0ff', role:'Engineer' },
  'cursor-agent': { bg:'#150b28', border:'#8957e5', dot:'#bc8cff', role:'Reviewer' },
  copilot:        { bg:'#0a1414', border:'#20b2aa', dot:'#39d353', role:'Researcher' },
  openrouter:     { bg:'#1a0f00', border:'#d4773a', dot:'#f0883e', role:'Generalist' },
  ollama:         { bg:'#140014', border:'#da3633', dot:'#f85149', role:'Validator' },
  default:        { bg:'#111820', border:'#30363d', dot:'#8b949e', role:'Agent' },
};

// ──────────────────────────────────────────────────────────────
// DAGRE LAYOUT
// ──────────────────────────────────────────────────────────────
function layoutNodes(nodes, edges, direction = 'TB') {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: direction,
    nodesep: 60,
    ranksep: 80,
    marginx: 40,
    marginy: 40,
  });

  nodes.forEach(n => {
    g.setNode(n.id, { width: n.data.__w || 150, height: n.data.__h || 70 });
  });
  edges.forEach(e => {
    g.setEdge(e.source, e.target);
  });

  dagre.layout(g);

  return nodes.map(n => {
    const pos = g.node(n.id);
    if (!pos) return n;
    return {
      ...n,
      position: {
        x: pos.x - (n.data.__w || 150) / 2,
        y: pos.y - (n.data.__h || 70) / 2,
      },
    };
  });
}

// ──────────────────────────────────────────────────────────────
// CUSTOM NODE: NCO Hub
// ──────────────────────────────────────────────────────────────
function NcoNode({ data, selected }) {
  return (
    <div className={'nco-node' + (selected ? ' selected' : '')} style={{minWidth: data.__w || 120}}>
      <div className="nco-node-icon">⬡</div>
      <div className="nco-node-label">NCO HUB</div>
      <div className="nco-node-sub">:{data.port}</div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// CUSTOM NODE: CLI Session
// ──────────────────────────────────────────────────────────────
function CliNode({ data, selected }) {
  const st = data.status === 'active' ? '' : data.status === 'busy' ? 'busy' : 'idle';
  return (
    <div className={'cli-node' + (selected ? ' selected' : '')} style={{minWidth: data.__w || 140}}>
      <div className="cli-node-top">
        <span className="cli-node-icon">⬜</span>
        <span className="cli-node-name">{data.label}</span>
        <span className={'cli-node-status ' + st}/>
      </div>
      <div className="cli-node-meta">
        <span>pid:{data.pid || '—'}</span>
        <span>{data.model || 'claude'}</span>
      </div>
      {data.work && <div className="cli-node-work" title={data.work}>{data.work}</div>}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// CUSTOM NODE: Agent
// ──────────────────────────────────────────────────────────────
function AgentNode({ data, selected }) {
  const c = AGENT_COLORS[data.agentType] || AGENT_COLORS.default;
  const taskColor = data.taskCount > 0 ? '#3fb950' : '#656d76';
  return (
    <div
      className={'agent-node' + (selected ? ' selected' : '')}
      style={{
        background: c.bg,
        borderColor: c.border,
        boxShadow: selected ? ('0 0 14px ' + c.dot + '66') : ('0 0 6px ' + c.dot + '22'),
        minWidth: data.__w || 110,
      }}
    >
      <div className="agent-node-top">
        <span className="agent-node-dot" style={{background: c.dot}}/>
        <span className="agent-node-name">{data.label}</span>
      </div>
      <div className="agent-node-role">{c.role}</div>
      <div className="agent-node-tasks" style={{color: taskColor}}>
        {data.taskCount > 0 ? data.taskCount + ' task(s) running' : 'idle'}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// CUSTOM EDGE: Mesh (animated)
// ──────────────────────────────────────────────────────────────
function MeshEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }) {
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const color = data?.color || '#1f6feb';
  const count = data?.count || 0;

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={{stroke: color, strokeWidth: 1.5, opacity: 0.7}} />
      {count > 0 && (
        <EdgeLabelRenderer>
          <div
            style={{
              position:'absolute',
              transform:\`translate(-50%, -50%) translate(\${labelX}px, \${labelY}px)\`,
              fontSize:8,
              background: color + '22',
              border: '1px solid ' + color,
              color: color,
              padding:'1px 4px',
              borderRadius:8,
              pointerEvents:'none',
              fontWeight:700,
            }}
            className="nodrag nopan"
          >
            {count}
          </div>
        </EdgeLabelRenderer>
      )}
      <circle r={4} fill={color} opacity={0.9}>
        <animateMotion dur="2s" repeatCount="indefinite" path={edgePath} />
      </circle>
    </>
  );
}

// ──────────────────────────────────────────────────────────────
// CUSTOM EDGE: Heartbeat (dashed)
// ──────────────────────────────────────────────────────────────
function HeartbeatEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition }) {
  const [edgePath] = getStraightPath({ sourceX, sourceY, targetX, targetY });
  return (
    <BaseEdge
      id={id}
      path={edgePath}
      style={{ stroke:'#30363d', strokeWidth:1, strokeDasharray:'4 4', opacity:0.5 }}
    />
  );
}

// ──────────────────────────────────────────────────────────────
// CUSTOM EDGE: Task (step, animated when active)
// ──────────────────────────────────────────────────────────────
function TaskEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }) {
  const [edgePath] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const active = data?.active;
  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: active ? '#d29922' : '#1a2535',
          strokeWidth: active ? 2 : 1,
          opacity: active ? 1 : 0.4,
        }}
        markerEnd={active ? { type: MarkerType.ArrowClosed, color:'#d29922' } : undefined}
      />
      {active && (
        <circle r={3} fill="#e3b341" opacity={0.9}>
          <animateMotion dur="1.2s" repeatCount="indefinite" path={edgePath} />
        </circle>
      )}
    </>
  );
}

// ──────────────────────────────────────────────────────────────
// NODE / EDGE TYPE REGISTRATIONS
// ──────────────────────────────────────────────────────────────
const nodeTypes = { nco: NcoNode, cli: CliNode, agent: AgentNode };
const edgeTypes = { mesh: MeshEdge, heartbeat: HeartbeatEdge, task: TaskEdge };

// ──────────────────────────────────────────────────────────────
// DATA FETCH
// ──────────────────────────────────────────────────────────────
async function fetchData() {
  const safe = async (url, def = null) => {
    try {
      const r = await fetch(url);
      return r.ok ? r.json() : def;
    } catch { return def; }
  };

  const [health, sessionsResp, daemonsResp, tasksResp] = await Promise.all([
    safe(API + '/health', {}),
    safe(API + '/api/mesh/sessions', {}),
    safe(API + '/api/daemons', {}),
    safe(API + '/api/tasks?limit=50', {}),
  ]);

  return {
    health,
    sessions: sessionsResp?.sessions ?? (Array.isArray(sessionsResp) ? sessionsResp : []),
    daemons:  daemonsResp?.daemons  ?? (Array.isArray(daemonsResp)  ? daemonsResp  : []),
    tasks:    tasksResp?.tasks      ?? (Array.isArray(tasksResp)     ? tasksResp    : []),
  };
}

// ──────────────────────────────────────────────────────────────
// BUILD TOPOLOGY
// ──────────────────────────────────────────────────────────────
function buildTopology(data, commMatrix) {
  const { sessions = [], daemons = [], tasks = [] } = data;
  const nodes = [];
  const edges = [];

  // 1) NCO Hub
  nodes.push({
    id: 'nco',
    type: 'nco',
    position: { x: 0, y: 0 },
    data: { port: 6200, __w: 120, __h: 72 },
  });

  // 2) CLI Sessions
  const sessionIds = new Set();
  (sessions || []).forEach(s => {
    const id = 'cli::' + (s.agentId || s.sessionId);
    sessionIds.add(id);
    nodes.push({
      id,
      type: 'cli',
      position: { x: 0, y: 0 },
      data: {
        label: s.agentId || s.sessionId,
        pid: s.pid,
        model: s.model,
        status: s.status || 'active',
        work: s.currentWork || s.description || '',
        _raw: s,
        __w: 150, __h: 72,
      },
    });
    // heartbeat edge: CLI → NCO
    edges.push({
      id: 'hb::' + id,
      source: id,
      target: 'nco',
      type: 'heartbeat',
      animated: false,
    });
  });

  // 3) Agents (from daemons list)
  const knownAgents = new Set();
  (daemons || []).forEach(d => {
    const agentType = d.provider || d.agent || d.name || 'default';
    const nodeId = 'agent::' + agentType;
    if (knownAgents.has(nodeId)) return;
    knownAgents.add(nodeId);

    const activeTasks = (tasks || []).filter(t =>
      (t.assigned_to === agentType || t.provider === agentType || t.agent === agentType) &&
      (t.status === 'running' || t.status === 'active')
    );

    nodes.push({
      id: nodeId,
      type: 'agent',
      position: { x: 0, y: 0 },
      data: {
        label: agentType,
        agentType,
        taskCount: activeTasks.length,
        _daemon: d,
        _tasks: activeTasks,
        __w: 120, __h: 64,
      },
    });

    // task edge: NCO → Agent
    edges.push({
      id: 'task::' + nodeId,
      source: 'nco',
      target: nodeId,
      type: 'task',
      data: { active: activeTasks.length > 0 },
    });
  });

  // 3.5) CLI→Agent spawn edges (from tasks with spawned_by_cli)
  const cliAgentEdgeKeys = new Set();
  (tasks || []).forEach(t => {
    if (!t.spawned_by_cli || !t.assigned_to) return;
    const srcId = 'cli::' + t.spawned_by_cli;
    const dstId = 'agent::' + t.assigned_to;
    const srcExists = nodes.some(n => n.id === srcId);
    const dstExists = nodes.some(n => n.id === dstId);
    if (!srcExists || !dstExists) return;

    const edgeKey = srcId + '→' + dstId;
    if (cliAgentEdgeKeys.has(edgeKey)) {
      // bump count on existing edge
      const ex = edges.find(e => e.id === 'spawn::' + edgeKey);
      if (ex) ex.data.count = (ex.data.count || 1) + 1;
      return;
    }
    cliAgentEdgeKeys.add(edgeKey);
    edges.push({
      id: 'spawn::' + edgeKey,
      source: srcId,
      target: dstId,
      type: 'mesh',
      data: {
        count: 1,
        color: '#a78bfa',
        label: 'spawn',
        msgs: [],
      },
    });
  });

  // 4) Mesh communication edges (CLI ↔ CLI)
  const meshColors = {
    info:     '#1f6feb',
    warn:     '#d29922',
    error:    '#da3633',
    request:  '#8957e5',
    conflict: '#da3633',
    default:  '#3fb950',
  };

  Object.entries(commMatrix).forEach(([key, val]) => {
    const { from, to, count, msgType } = val;
    const srcId = 'cli::' + from;
    const dstId = to === '*' ? 'nco' : 'cli::' + to;
    const color = meshColors[msgType] || meshColors.default;

    // Only add edge if both nodes exist
    const srcExists = nodes.some(n => n.id === srcId);
    const dstExists = nodes.some(n => n.id === dstId);
    if (!srcExists || !dstExists) return;

    const edgeId = 'mesh::' + key;
    // Update if already exists
    const existing = edges.find(e => e.id === edgeId);
    if (existing) {
      existing.data = { ...existing.data, count, color };
    } else {
      edges.push({
        id: edgeId,
        source: srcId,
        target: dstId,
        type: 'mesh',
        data: { count, color, msgs: val.msgs || [] },
      });
    }
  });

  // 5) Dagre layout
  const laid = layoutNodes(nodes, edges, 'TB');
  return { nodes: laid, edges };
}

// ──────────────────────────────────────────────────────────────
// DETAIL PANEL
// ──────────────────────────────────────────────────────────────
function DetailPanel({ node, edge, edges, commMatrix, onClose }) {
  if (!node && !edge) return null;

  const render = () => {
    if (node) {
      const type = node.type;
      const d = node.data;

      if (type === 'nco') {
        return (
          <>
            <div className="detail-section">
              <div className="detail-section-title">NCO Hub</div>
              <div className="detail-row"><span className="detail-key">API Port</span><span className="detail-val">{d.port}</span></div>
              <div className="detail-row"><span className="detail-key">WS Port</span><span className="detail-val">${wsPort}</span></div>
            </div>
          </>
        );
      }

      if (type === 'cli') {
        const r = d._raw || {};
        const meshEdges = edges.filter(e => e.type === 'mesh' && (e.source === node.id || e.target === node.id));
        const agentId = r.agentId || r.sessionId;
        const myMsgs = Object.entries(commMatrix)
          .filter(([k]) => k.startsWith(agentId + '::') || k.endsWith('::' + agentId))
          .flatMap(([, v]) => v.msgs || [])
          .slice(-10);

        return (
          <>
            <div className="detail-section">
              <div className="detail-section-title">CLI Session</div>
              <div className="detail-row"><span className="detail-key">Agent ID</span><span className="detail-val">{r.agentId || '—'}</span></div>
              <div className="detail-row"><span className="detail-key">Session ID</span><span className="detail-val">{r.sessionId || '—'}</span></div>
              <div className="detail-row"><span className="detail-key">PID</span><span className="detail-val">{r.pid || '—'}</span></div>
              <div className="detail-row"><span className="detail-key">Model</span><span className="detail-val">{r.model || 'claude'}</span></div>
              <div className="detail-row"><span className="detail-key">Status</span><span className="detail-val">{r.status || 'active'}</span></div>
              {d.work && <div className="detail-row"><span className="detail-key">Work</span><span className="detail-val">{d.work}</span></div>}
            </div>
            {meshEdges.length > 0 && (
              <div className="detail-section">
                <div className="detail-section-title">Mesh Connections ({meshEdges.length})</div>
                {meshEdges.map(e => (
                  <div key={e.id} className="detail-edge">
                    <span style={{color: e.data?.color || '#1f6feb', fontSize:9}}>●</span>
                    <span className="detail-edge-arrow">{e.source === node.id ? '→' : '←'}</span>
                    <span style={{color:'#c9d1d9',fontSize:9}}>{e.source === node.id ? e.target.replace('cli::','') : e.source.replace('cli::','')}</span>
                    <span style={{marginLeft:'auto',color:'#8b949e',fontSize:9}}>{e.data?.count || 0}msg</span>
                  </div>
                ))}
              </div>
            )}
            {myMsgs.length > 0 && (
              <div className="detail-section">
                <div className="detail-section-title">Recent Messages</div>
                <div className="detail-msgs">
                  {myMsgs.map((m, i) => (
                    <div key={i} className="detail-msg">
                      <div className="detail-msg-from">{new Date(m.time).toLocaleTimeString()}</div>
                      <div className="detail-msg-content">{(m.content || '').slice(0, 80)}{(m.content || '').length > 80 ? '…' : ''}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        );
      }

      if (type === 'agent') {
        const c = AGENT_COLORS[d.agentType] || AGENT_COLORS.default;
        return (
          <>
            <div className="detail-section">
              <div className="detail-section-title">Agent</div>
              <div className="detail-row"><span className="detail-key">Name</span><span className="detail-val">{d.label}</span></div>
              <div className="detail-row"><span className="detail-key">Role</span><span className="detail-val">{c.role}</span></div>
              <div className="detail-row">
                <span className="detail-key">Status</span>
                <span className="detail-badge" style={{background: c.dot + '22', border:'1px solid ' + c.dot, color: c.dot}}>
                  {d.taskCount > 0 ? 'active' : 'idle'}
                </span>
              </div>
              {d.taskCount > 0 && <div className="detail-row"><span className="detail-key">Tasks</span><span className="detail-val">{d.taskCount} running</span></div>}
            </div>
            {(d._tasks || []).length > 0 && (
              <div className="detail-section">
                <div className="detail-section-title">Active Tasks</div>
                {d._tasks.map((t, i) => (
                  <div key={i} className="detail-edge" style={{flexDirection:'column',gap:2}}>
                    <span style={{color:'#e6edf3',fontSize:9,fontWeight:700}}>{t.id ? t.id.slice(-8) : '—'}</span>
                    <span style={{color:'#8b949e',fontSize:9}}>{(t.prompt || '').slice(0,60)}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        );
      }
    }

    if (edge) {
      return (
        <div className="detail-section">
          <div className="detail-section-title">Edge</div>
          <div className="detail-row"><span className="detail-key">Type</span><span className="detail-val">{edge.type}</span></div>
          <div className="detail-row"><span className="detail-key">From</span><span className="detail-val">{edge.source}</span></div>
          <div className="detail-row"><span className="detail-key">To</span><span className="detail-val">{edge.target}</span></div>
          {edge.data?.count > 0 && <div className="detail-row"><span className="detail-key">Messages</span><span className="detail-val">{edge.data.count}</span></div>}
          {edge.data?.msgs?.length > 0 && (
            <>
              <div className="detail-section-title" style={{marginTop:8}}>Recent Messages</div>
              <div className="detail-msgs">
                {(edge.data.msgs || []).slice(-8).map((m, i) => (
                  <div key={i} className="detail-msg">
                    <div className="detail-msg-from">{new Date(m.time).toLocaleTimeString()}</div>
                    <div className="detail-msg-content">{(m.content || '').slice(0,80)}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      );
    }
  };

  const title = node
    ? (node.type === 'nco' ? 'NCO Hub' : node.type === 'cli' ? 'CLI: ' + node.data.label : 'Agent: ' + node.data.label)
    : 'Edge';

  return (
    <div className="topo-detail">
      <div className="detail-header">
        <span className="detail-title">{title}</span>
        <button className="detail-close" onClick={onClose}>✕</button>
      </div>
      <div className="detail-body">{render()}</div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// MAIN APP
// ──────────────────────────────────────────────────────────────
function TopologyInner() {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [commMatrix, setCommMatrix] = useState({});
  const [selected, setSelected] = useState(null); // {type:'node'|'edge', data}
  const [stats, setStats] = useState({ sessions:0, agents:0, tasks:0, msgs:0 });
  const [loading, setLoading] = useState(true);
  const [autoLayout, setAutoLayout] = useState(true);
  const wsRef = useRef(null);
  const commRef = useRef({});
  const lastDataRef = useRef({ sessions:[], daemons:[], tasks:[] });

  // WebSocket for real-time mesh events
  useEffect(() => {
    const connect = () => {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onmessage = evt => {
        try {
          const ev = JSON.parse(evt.data);
          if (ev.type === 'mesh:message' && ev.data) {
            const m = ev.data;
            const from = m.fromAgent || m.from_agent || '?';
            const to = m.to || '*';
            const key = from + '::' + to;
            const msgType = m.messageType || m.type || 'info';
            const content = m.content || '';
            const entry = commRef.current[key] || { from, to, count:0, lastTime:Date.now(), msgs:[], msgType };
            entry.count++;
            entry.lastTime = Date.now();
            entry.msgType = msgType;
            entry.msgs = [...(entry.msgs || []).slice(-19), { time:Date.now(), content, msgType }];
            commRef.current = { ...commRef.current, [key]: entry };
            setCommMatrix({ ...commRef.current });
            setStats(s => ({ ...s, msgs: s.msgs + 1 }));
          }
        } catch {}
      };

      ws.onclose = () => { setTimeout(connect, 3000); };
      ws.onerror = () => { ws.close(); };
    };

    connect();
    return () => { wsRef.current?.close(); };
  }, []);

  // Poll topology data
  const refresh = useCallback(async () => {
    try {
      const data = await fetchData();
      lastDataRef.current = data;
      const { nodes: n, edges: e } = buildTopology(data, commRef.current);
      setNodes(n);
      setEdges(e);
      setStats({
        sessions: (data.sessions || []).length,
        agents: (data.daemons || []).length,
        tasks: (data.tasks || []).filter(t => t.status === 'running' || t.status === 'active').length,
        msgs: Object.values(commRef.current).reduce((a, v) => a + (v.count || 0), 0),
      });
      setLoading(false);
    } catch(err) {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const iv = setInterval(refresh, 5000);
    return () => clearInterval(iv);
  }, [refresh]);

  // Re-apply mesh edges when commMatrix changes (real-time WS events)
  useEffect(() => {
    if (nodes.length === 0) return;
    // Reuse cached data so srcExists/dstExists checks pass for existing nodes
    const { edges: e } = buildTopology(lastDataRef.current, commRef.current);
    setEdges(prev => {
      const nonMesh = prev.filter(e => e.type !== 'mesh');
      const meshEdges = e.filter(e => e.type === 'mesh');
      return [...nonMesh, ...meshEdges];
    });
  }, [commMatrix]);

  const onNodeClick = useCallback((_, node) => {
    setSelected(s => s?.type === 'node' && s.data.id === node.id ? null : { type:'node', data:node });
  }, []);

  const onEdgeClick = useCallback((_, edge) => {
    setSelected(s => s?.type === 'edge' && s.data.id === edge.id ? null : { type:'edge', data:edge });
  }, []);

  const onPaneClick = useCallback(() => setSelected(null), []);

  const handleRelayout = useCallback(() => {
    setNodes(prev => layoutNodes(prev, edges, 'TB'));
  }, [edges]);

  const selNode = selected?.type === 'node' ? nodes.find(n => n.id === selected.data.id) : null;
  const selEdge = selected?.type === 'edge' ? edges.find(e => e.id === selected.data.id) : null;

  // Highlight selected node's edges
  const styledEdges = useMemo(() => {
    if (!selNode) return edges;
    return edges.map(e => ({
      ...e,
      style: {
        ...e.style,
        opacity: (e.source === selNode.id || e.target === selNode.id) ? 1 : 0.15,
      },
    }));
  }, [edges, selNode]);

  return (
    <div className="topo-shell">
      {/* Header */}
      <div className="topo-header">
        <span className="topo-logo">⬡ NCO</span>
        <span className="topo-title">Topology</span>
        <div className="topo-sep"/>
        <div className="topo-stats">
          <div className="topo-stat">
            <span className="topo-dot"/>
            <span>Sessions</span>
            <span className="topo-stat-val">{stats.sessions}</span>
          </div>
          <div className="topo-stat">
            <span className="topo-dot warn"/>
            <span>Agents</span>
            <span className="topo-stat-val">{stats.agents}</span>
          </div>
          <div className="topo-stat">
            <span className="topo-dot"/>
            <span>Active Tasks</span>
            <span className="topo-stat-val">{stats.tasks}</span>
          </div>
          <div className="topo-stat">
            <span className="topo-dot" style={{background:'#8957e5'}}/>
            <span>Mesh Msgs</span>
            <span className="topo-stat-val">{stats.msgs}</span>
          </div>
        </div>
        <div className="topo-actions">
          <button className="topo-btn" onClick={handleRelayout}>Re-layout</button>
          <button className="topo-btn" onClick={refresh}>Refresh</button>
          <button
            className={'topo-btn' + (selected ? ' active' : '')}
            onClick={() => setSelected(null)}
          >Clear</button>
        </div>
      </div>

      <div className="topo-main">
        <div className="topo-flow">
          {loading && (
            <div className="topo-loading">
              <div className="topo-spinner"/>
              <span>Loading topology…</span>
            </div>
          )}
          <ReactFlow
            nodes={nodes}
            edges={styledEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            onPaneClick={onPaneClick}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.2}
            maxZoom={2}
            defaultEdgeOptions={{ animated: false }}
          >
            <Background color="#1a2535" gap={24} size={1} />
            <Controls showInteractive={false} />
            <MiniMap
              nodeColor={n => {
                if (n.type === 'nco') return '#7c3aed';
                if (n.type === 'cli') return '#1f6feb';
                const c = AGENT_COLORS[n.data?.agentType] || AGENT_COLORS.default;
                return c.dot;
              }}
              maskColor="#070b11cc"
              style={{ background:'#0d1117', border:'1px solid #1a2535' }}
            />
          </ReactFlow>

          {/* Legend */}
          <div className="topo-legend">
            <div className="legend-title">Legend</div>
            <div className="legend-row"><span className="legend-dot" style={{background:'#7c3aed'}}/><span>NCO Hub</span></div>
            <div className="legend-row"><span className="legend-dot" style={{background:'#1f6feb'}}/><span>CLI Session</span></div>
            <div className="legend-row"><span className="legend-dot" style={{background:'#3fb950'}}/><span>Agent</span></div>
            <div className="legend-row"><span className="legend-dashed"/><span>Heartbeat</span></div>
            <div className="legend-row"><span className="legend-line" style={{background:'#1f6feb'}}/><span>Mesh Msg</span></div>
            <div className="legend-row"><span className="legend-line" style={{background:'#d29922'}}/><span>Active Task</span></div>
            <div className="legend-row"><span className="legend-line" style={{background:'#a78bfa'}}/><span>CLI→Agent Spawn</span></div>
          </div>
        </div>

        <DetailPanel
          node={selNode}
          edge={selEdge}
          edges={edges}
          commMatrix={commMatrix}
          onClose={() => setSelected(null)}
        />
      </div>
    </div>
  );
}

function TopologyApp() {
  return (
    <ReactFlowProvider>
      <TopologyInner />
    </ReactFlowProvider>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<TopologyApp />);
</script>
</body>
</html>`;
}
