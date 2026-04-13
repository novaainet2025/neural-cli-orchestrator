/** GET /monitor — NCO Live Monitor (실시간 대시보드) */
export function getMonitorHTML(wsPort: number, apiPort: number): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>NCO Live Monitor</title>
<style>
/* ══ Webflow-Inspired NCO Monitor ══════════════════════
   Design: Glassmorphism + AX Accessibility
   Font: Inter (variable), fallback system sans-serif
   ════════════════════════════════════════════════════════ */
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');

/* ── Reset & Base ───────────────────────────────────── */
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg-primary:#0a0e1a;--bg-secondary:#111827;--bg-tertiary:#1a2137;
  --bg-glass:rgba(17,24,39,.72);--bg-glass-hover:rgba(26,33,55,.85);
  --border-subtle:rgba(99,115,146,.15);--border-hover:rgba(99,115,146,.3);
  --text-primary:#f1f5f9;--text-secondary:#94a3b8;--text-muted:#64748b;
  --accent-blue:#3b82f6;--accent-blue-soft:rgba(59,130,246,.15);
  --accent-green:#22c55e;--accent-green-soft:rgba(34,197,94,.12);
  --accent-amber:#f59e0b;--accent-amber-soft:rgba(245,158,11,.12);
  --accent-red:#ef4444;--accent-red-soft:rgba(239,68,68,.12);
  --accent-purple:#a78bfa;--accent-purple-soft:rgba(167,139,250,.12);
  --radius-sm:6px;--radius-md:10px;--radius-lg:14px;--radius-xl:18px;
  --shadow-sm:0 1px 3px rgba(0,0,0,.3),0 1px 2px rgba(0,0,0,.2);
  --shadow-md:0 4px 14px rgba(0,0,0,.35);
  --shadow-lg:0 10px 40px rgba(0,0,0,.4);
  --shadow-glow-blue:0 0 20px rgba(59,130,246,.15);
  --shadow-glow-green:0 0 20px rgba(34,197,94,.12);
  --transition-fast:.15s cubic-bezier(.4,0,.2,1);
  --transition-smooth:.25s cubic-bezier(.4,0,.2,1);
}
*{user-select:none}
body{font-family:'Inter',system-ui,-apple-system,sans-serif;background:var(--bg-primary);color:var(--text-primary);font-size:13px;height:100vh;display:flex;flex-direction:column;overflow:hidden;-webkit-font-smoothing:antialiased;letter-spacing:-.01em}
/* AX: Focus ring */
:focus-visible{outline:2px solid var(--accent-blue);outline-offset:2px;border-radius:var(--radius-sm)}

/* ── Header ─────────────────────────────────────────── */
.header{background:var(--bg-glass);backdrop-filter:blur(16px) saturate(1.4);-webkit-backdrop-filter:blur(16px) saturate(1.4);padding:10px 20px;border-bottom:1px solid var(--border-subtle);display:flex;justify-content:space-between;align-items:center;flex-shrink:0;height:48px;box-shadow:var(--shadow-sm)}
.header h1{font-size:15px;font-weight:600;color:var(--text-primary);letter-spacing:-.02em}
.header h1::before{content:'';display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--accent-blue);margin-right:8px;box-shadow:var(--shadow-glow-blue);vertical-align:middle}
.hdr-right{display:flex;gap:12px;align-items:center;font-size:12px;font-weight:400}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:4px;flex-shrink:0;transition:var(--transition-fast)}
.dot.on{background:var(--accent-green);box-shadow:0 0 8px rgba(34,197,94,.5)}
.dot.off{background:var(--accent-red);box-shadow:0 0 8px rgba(239,68,68,.4)}
.badge{padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;letter-spacing:.02em;transition:var(--transition-fast)}
.badge.ok{background:var(--accent-green-soft);color:var(--accent-green);border:1px solid rgba(34,197,94,.25)}
.badge.err{background:var(--accent-red-soft);color:var(--accent-red);border:1px solid rgba(239,68,68,.25)}
.badge.mesh{background:var(--accent-blue-soft);color:var(--accent-blue);border:1px solid rgba(59,130,246,.25)}
.hdr-sep{width:1px;height:18px;background:var(--border-subtle);margin:0 2px}

/* ── Body: 3-pane resizable layout ──────────────────── */
.body{flex:1;display:flex;overflow:hidden;min-height:0;gap:1px;background:var(--border-subtle)}

/* Panels */
.pane{display:flex;flex-direction:column;overflow:hidden;min-width:120px;background:var(--bg-primary)}
.pane-left{width:var(--w-left,260px);flex-shrink:0}
.pane-center{flex:1;min-width:200px}
.pane-right{width:var(--w-right,340px);flex-shrink:0}

/* Drag handles */
.resizer{width:5px;background:transparent;cursor:col-resize;flex-shrink:0;position:relative;transition:var(--transition-fast);z-index:5}
.resizer:hover,.resizer.dragging{background:var(--accent-blue)}
.resizer::after{content:'';position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:3px;height:40px;border-radius:2px;background:var(--text-muted);opacity:.3;transition:var(--transition-fast)}
.resizer:hover::after{opacity:0}

/* Pane header */
.ph{padding:8px 14px;color:var(--text-muted);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid var(--border-subtle);display:flex;justify-content:space-between;align-items:center;flex-shrink:0;background:var(--bg-secondary);height:36px}
.ph .ph-title{display:flex;align-items:center;gap:6px}
.ph .ph-cnt{font-size:11px;padding:2px 8px;border-radius:20px;background:var(--accent-blue-soft);color:var(--accent-blue);font-weight:700}
.ph-toggle{cursor:pointer;color:var(--text-muted);font-size:11px;padding:2px 6px;border-radius:var(--radius-sm);transition:var(--transition-fast)}
.ph-toggle:hover{color:var(--text-primary);background:rgba(255,255,255,.05)}

/* Collapsible section */
.section{display:flex;flex-direction:column;overflow:hidden;transition:flex .25s ease}
.section.collapsed .section-body{display:none}
.section.collapsed .ph-toggle{transform:rotate(-90deg)}
.section-body{overflow-y:auto;flex:1}

/* ── Right top: SERVER AGENTS ────────────────────────── */
#sec-agents{background:var(--bg-primary);border-bottom:1px solid var(--border-subtle)}
#sec-agents .ph{background:var(--bg-secondary);border-bottom:1px solid var(--border-subtle)}
#sec-agents .ph .ph-title{color:var(--text-muted)}
.ag{padding:8px 14px;border-bottom:1px solid var(--border-subtle);display:flex;justify-content:space-between;align-items:center;transition:var(--transition-fast);cursor:default}
.ag:hover{background:var(--bg-glass-hover)}
.ag.flash{background:rgba(59,130,246,.08)}
.ag-left{display:flex;align-items:center;gap:8px;overflow:hidden;flex:1}
.ag-icon{width:8px;height:8px;border-radius:50%;flex-shrink:0;background:var(--text-muted);transition:var(--transition-fast)}
.ag-name{font-weight:600;font-size:12px;white-space:nowrap;color:var(--text-secondary)}
.ag-sub{color:var(--text-muted);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.ag-task{color:var(--accent-blue);font-size:10px;background:var(--accent-blue-soft);padding:2px 6px;border-radius:var(--radius-sm);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:80px}

/* Agent type badges (CLI / API) */
.ag-type{font-size:9px;padding:2px 6px;border-radius:20px;font-weight:600;flex-shrink:0;letter-spacing:.03em}
.ag-type.cli{background:var(--accent-blue-soft);color:var(--accent-blue);border:1px solid rgba(59,130,246,.2)}
.ag-type.api{background:var(--accent-green-soft);color:var(--accent-green);border:1px solid rgba(34,197,94,.2)}

/* Agent status pills — refined */
.st{font-size:10px;padding:3px 8px;border-radius:20px;font-weight:600;white-space:nowrap;flex-shrink:0;letter-spacing:.01em;transition:var(--transition-fast)}
.st.idle{background:rgba(100,116,139,.1);color:var(--text-muted);border:1px solid var(--border-subtle)}
.st.working,.st.thinking{background:var(--accent-green-soft);color:var(--accent-green);border:1px solid rgba(34,197,94,.2)}
.st.discussing{background:var(--accent-purple-soft);color:var(--accent-purple);border:1px solid rgba(167,139,250,.2)}
.st.coding{background:var(--accent-blue-soft);color:var(--accent-blue);border:1px solid rgba(59,130,246,.2)}
.st.reviewing{background:var(--accent-purple-soft);color:#c4b5fd;border:1px solid rgba(196,181,253,.2)}
.st.waiting{background:var(--accent-amber-soft);color:var(--accent-amber);border:1px solid rgba(245,158,11,.2)}
.st.error,.st.isolated{background:var(--accent-red-soft);color:var(--accent-red);border:1px solid rgba(239,68,68,.2)}
.st.offline{background:rgba(100,116,139,.05);color:rgba(100,116,139,.4);border:1px solid rgba(100,116,139,.1)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.55}}
.st.working,.st.thinking,.st.coding,.st.discussing{animation:pulse 2.2s ease-in-out infinite}

/* ── Divider ── */
.agents-tab-divider{height:1px;background:var(--border-subtle);flex-shrink:0}

/* ── Left pane: CLI TERMINALS ─────────────────────────── */
.pane-left{background:var(--bg-primary)}
#sec-mesh{background:transparent;flex:1}
#sec-mesh .ph{background:var(--bg-secondary);border-bottom:1px solid rgba(59,130,246,.15)}
#sec-mesh .ph .ph-title{color:var(--accent-blue);font-size:11px;font-weight:600}
#sec-mesh .section-body{background:transparent}

/* Mesh node = glass card */
.mesh-node{
  margin:6px 8px;
  border-radius:var(--radius-md);
  border:1px solid var(--border-subtle);
  background:var(--bg-glass);
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  transition:all .25s ease;
  position:relative;
  overflow:hidden;
}
.mesh-node:hover{border-color:var(--border-hover);box-shadow:var(--shadow-md);transform:translateY(-1px)}
.mesh-node.new-flash{animation:meshFlash .8s ease-out}
@keyframes meshFlash{0%{border-color:var(--accent-blue);box-shadow:var(--shadow-glow-blue)}100%{border-color:var(--border-subtle);box-shadow:none}}

/* Mode accent bar — top edge gradient */
.mesh-node::before{content:'';position:absolute;left:0;right:0;top:0;height:2px;border-radius:var(--radius-md) var(--radius-md) 0 0}
.mesh-node.mode-solo::before{background:linear-gradient(90deg,var(--accent-blue),#60a5fa)}
.mesh-node.mode-mesh::before{background:linear-gradient(90deg,var(--accent-green),#4ade80);box-shadow:0 2px 12px rgba(34,197,94,.2)}
.mesh-node.mode-waiting::before{background:var(--text-muted)}
.mesh-node.mode-reviewing::before{background:linear-gradient(90deg,#a78bfa,#c4b5fd)}
.mesh-node.mode-blocked::before{background:linear-gradient(90deg,var(--accent-red),#f87171);box-shadow:0 2px 12px rgba(239,68,68,.2)}

.mn-inner{padding:10px 12px 8px}
.mn-row1{display:flex;align-items:center;gap:6px}
.mn-agent{font-weight:700;font-size:13px;color:var(--text-primary)}
.mn-pid{color:var(--text-muted);font-size:10px;margin-left:auto;font-variant-numeric:tabular-nums;opacity:.6}

/* Work mode badge — pill */
.wm-badge{font-size:10px;font-weight:600;padding:3px 10px;border-radius:20px;letter-spacing:.02em;white-space:nowrap;flex-shrink:0}
.wm-solo{background:var(--accent-blue-soft);color:var(--accent-blue);border:1px solid rgba(59,130,246,.25)}
.wm-mesh{background:var(--accent-green-soft);color:var(--accent-green);border:1px solid rgba(34,197,94,.25);animation:pulse 2.5s ease-in-out infinite}
.wm-waiting{background:rgba(100,116,139,.08);color:var(--text-muted);border:1px solid var(--border-subtle)}
.wm-idle{background:rgba(100,116,139,.05);color:rgba(100,116,139,.4);border:1px solid rgba(100,116,139,.1)}
.wm-reviewing{background:var(--accent-purple-soft);color:var(--accent-purple);border:1px solid rgba(167,139,250,.25)}
.wm-blocked{background:var(--accent-red-soft);color:var(--accent-red);border:1px solid rgba(239,68,68,.25)}
.wm-done{background:var(--accent-green-soft);color:var(--accent-green);border:1px solid rgba(34,197,94,.2);opacity:.75}

/* Done state */
.mesh-node.mode-done{opacity:.6;transition:opacity 1s}
.mesh-node.mode-done::before{background:var(--accent-green)}
.mesh-node.mode-done .mn-inner{filter:saturate(.5)}
.mesh-node.fading-out{opacity:0!important;transition:opacity 2s ease-out}
.done-elapsed{color:rgba(34,197,94,.5);font-size:10px}

.mn-row2{display:flex;align-items:center;gap:6px;margin-top:6px}
.mn-work{color:var(--text-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;line-height:1.5}
.mn-collab{color:var(--accent-green);font-size:10px;background:var(--accent-green-soft);padding:2px 6px;border-radius:20px;white-space:nowrap;flex-shrink:0;border:1px solid rgba(34,197,94,.2)}

/* H3: Progressive disclosure — hide details by default, reveal on hover */
.mn-file{color:#30363d;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:3px;
  max-height:0;opacity:0;transition:max-height .22s ease,opacity .18s,margin-top .18s;margin-top:0}
.mn-file-name{color:#484f58}
.mn-meta{display:flex;align-items:center;gap:6px;font-size:9px;color:#484f58;padding-top:4px;border-top:1px solid #0f1a2a;
  max-height:0;opacity:0;transition:max-height .22s ease,opacity .18s,margin-top .18s;margin-top:0;overflow:hidden}
/* Expand on hover */
.mesh-node:hover .mn-file{max-height:38px;opacity:1;margin-top:4px}
.mesh-node:hover .mn-meta{max-height:38px;opacity:1;margin-top:4px}
/* Blocked nodes: always show conflicts expanded */
.mesh-node.mode-blocked .mn-conflicts{max-height:none;opacity:1}
.mn-meta-branch{color:#6e7681}
.mn-meta-time{color:#484f58;margin-left:auto}
.mn-meta-task{color:#58a6ff;background:#0d1e3d;padding:1px 4px;border-radius:2px}

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
.ev{padding:6px 14px;border-bottom:1px solid var(--border-subtle);display:grid;grid-template-columns:56px 90px 160px 1fr;gap:6px;font-size:12px;line-height:1.6;transition:var(--transition-fast);cursor:pointer}
.ev:hover{background:rgba(255,255,255,.03)}
.ev.new{background:rgba(59,130,246,.06)}
.ev .e-time{color:var(--text-muted);font-variant-numeric:tabular-nums;font-size:11px}
.ev .e-agent{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary)}
.ev .e-type{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.ev .e-msg{color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;user-select:text}
.e-type.action{color:var(--accent-green)}.e-type.task{color:var(--accent-blue)}.e-type.discussion{color:var(--accent-purple)}
.e-type.message{color:var(--accent-amber)}.e-type.system{color:var(--accent-red)}.e-type.agent{color:#c4b5fd}
.e-type.mesh{color:#93c5fd}
.ev.focused{background:rgba(59,130,246,.1)!important}

/* ── Event filter bar ────────────────────────────────── */
.evt-filters{display:flex;gap:4px;align-items:center;flex-wrap:wrap}
.ef-btn{padding:4px 10px;border-radius:20px;font-size:11px;cursor:pointer;background:transparent;border:1px solid var(--border-subtle);color:var(--text-muted);font-family:inherit;transition:var(--transition-fast);font-weight:500}
.ef-btn:hover{border-color:var(--border-hover);color:var(--text-secondary);background:rgba(255,255,255,.03)}
.ef-btn.active{background:var(--accent-blue-soft);border-color:rgba(59,130,246,.3);color:var(--accent-blue)}
.focus-badge{padding:3px 10px;border-radius:20px;font-size:10px;background:var(--accent-purple-soft);color:var(--accent-purple);border:1px solid rgba(167,139,250,.2);cursor:pointer;display:flex;align-items:center;gap:4px;font-weight:500}
.focus-badge:hover{border-color:rgba(167,139,250,.4)}
.ph-filters{padding:6px 14px;display:flex;gap:6px;align-items:center;border-bottom:1px solid var(--border-subtle);flex-wrap:wrap;flex-shrink:0;background:var(--bg-secondary)}

/* ── Modal overlay — frosted glass ───────────────────── */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);z-index:200;display:flex;align-items:center;justify-content:center;animation:fadeIn .2s}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
.modal-box{background:var(--bg-secondary);border:1px solid var(--border-subtle);border-radius:var(--radius-lg);padding:20px 24px;max-width:660px;width:90%;max-height:80vh;overflow-y:auto;box-shadow:var(--shadow-lg)}
.modal-hdr{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px}
.modal-title{font-size:14px;font-weight:600;color:var(--text-primary);flex:1;line-height:1.5}
.modal-close{cursor:pointer;color:var(--text-muted);font-size:20px;line-height:1;padding:4px 6px;flex-shrink:0;transition:var(--transition-fast);border-radius:var(--radius-sm)}
.modal-close:hover{color:var(--accent-red);background:var(--accent-red-soft)}
.modal-meta{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
.modal-body{color:var(--text-secondary);font-size:12px;line-height:1.8;white-space:pre-wrap;word-break:break-word;user-select:text;background:var(--bg-primary);padding:12px 14px;border-radius:var(--radius-md);border:1px solid var(--border-subtle)}
.modal-stream{color:var(--accent-green);font-size:11px;line-height:1.7;white-space:pre-wrap;word-break:break-word;user-select:text;background:var(--accent-green-soft);padding:10px 14px;border-radius:var(--radius-md);border:1px solid rgba(34,197,94,.15);margin-top:8px}

/* ── Sessions tab enhancements ───────────────────────── */
.sc-stats{display:flex;gap:4px;margin-left:auto;flex-shrink:0}
.sc-stat{font-size:9px;padding:1px 5px;border-radius:3px;font-weight:700;cursor:default}
.sc-stat.run{background:#0d1e3d;color:#58a6ff;border:1px solid #1f6feb44}
.sc-stat.done{background:#0d2818;color:#3fb950;border:1px solid #23863644}
.sc-stat.fail{background:#3d1111;color:#f85149;border:1px solid #f8514944}
.task-timeline{display:flex;align-items:center;gap:2px;padding:3px 0;overflow:hidden}
.tl-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0;cursor:pointer;transition:transform .15s;border:1px solid transparent}
.tl-dot:hover{transform:scale(1.4)}
.tl-line{flex:1;height:1px;background:#1a2540;min-width:6px;max-width:18px}
.st-stream{color:#3fb950;font-size:9px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;user-select:text;opacity:.8}
.st-task{cursor:pointer}

/* ── Right: Tab panel ────────────────────────────────── */
.tab-bar{display:flex;border-bottom:1px solid var(--border-subtle);flex-shrink:0;background:var(--bg-secondary);overflow-x:auto;gap:2px;padding:0 4px}
.tab{padding:8px 12px;color:var(--text-muted);cursor:pointer;font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:.04em;border-bottom:2px solid transparent;white-space:nowrap;transition:var(--transition-fast);border-radius:var(--radius-sm) var(--radius-sm) 0 0}
.tab:hover{color:var(--text-secondary);background:rgba(255,255,255,.03)}
.tab.active{color:var(--accent-blue);border-bottom-color:var(--accent-blue);background:rgba(59,130,246,.06)}
.tab-content{flex:1;overflow-y:auto;padding:10px}

/* Overview tab */
.ov-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:10px;margin-bottom:14px}
.ov-kpi{background:var(--bg-glass);border:1px solid var(--border-subtle);border-radius:var(--radius-md);padding:14px 10px;text-align:center;transition:var(--transition-fast);backdrop-filter:blur(4px)}
.ov-kpi:hover{border-color:var(--border-hover);box-shadow:var(--shadow-sm)}
.ov-kpi-val{font-size:24px;font-weight:700;font-variant-numeric:tabular-nums;line-height:1.2;background:linear-gradient(135deg,var(--text-primary),var(--accent-blue));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.ov-kpi-label{font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;margin-top:6px;font-weight:500}
.ov-kpi-sub{font-size:10px;color:var(--text-muted);margin-top:3px;opacity:.7}
.ov-section{margin-top:8px}
.ov-section-hdr{font-size:10px;color:#8b949e;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid #21262d}
.ov-feed{max-height:200px;overflow-y:auto}
.ov-feed-item{display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid #161b22;font-size:10px}
.ov-feed-icon{color:#484f58;font-size:11px}
.ov-feed-type{color:#58a6ff;font-weight:600;min-width:70px}
.ov-feed-time{color:#484f58;font-size:9px;margin-left:auto;font-variant-numeric:tabular-nums}
.ov-feed-msg{color:#8b949e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px}
.ov-empty{color:#30363d;font-size:10px;text-align:center;padding:12px}

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

/* ── Sessions tab ────────────────────────────────────── */
.sc-card{background:#0a1020;border:1px solid #1a2540;border-radius:6px;margin-bottom:6px;overflow:hidden}
.sc-hdr{display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--bg-secondary);border-bottom:1px solid var(--border-subtle);flex-wrap:wrap}
.sc-tasks{padding:6px 8px}
.sc-empty{padding:12px;color:var(--text-muted);font-size:11px;text-align:center;font-style:italic;opacity:.6}
.st-task{padding:8px;border-bottom:1px solid var(--border-subtle);border-radius:var(--radius-sm);margin-bottom:3px;background:var(--bg-glass);transition:var(--transition-fast)}
.st-task:last-child{border-bottom:none;margin-bottom:0}
.st-task:hover{background:var(--bg-glass-hover)}
.st-task-hdr{display:flex;align-items:center;gap:6px;font-size:12px}
.st-task-prompt{color:var(--text-secondary);font-size:11px;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;user-select:text}
.st-progress-outer{height:4px;background:rgba(100,116,139,.15);border-radius:10px;margin-top:6px;overflow:hidden}
.st-progress-inner{height:100%;background:linear-gradient(90deg,var(--accent-blue),#60a5fa);border-radius:10px;transition:width .5s ease}
.sc-unattr-hdr{margin:10px 0 6px;font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid var(--border-subtle);padding-bottom:5px;display:flex;justify-content:space-between;font-weight:500}

/* Empty states */
.empty{padding:32px;color:var(--text-muted);text-align:center;font-size:12px;opacity:.7}

/* ── Flow tab ───────────────────────────────────────── */
.flow-grid{display:flex;flex-wrap:wrap;gap:6px;padding:8px 6px;border-bottom:2px solid #21262d;min-height:80px}
.flow-node{flex:1;min-width:80px;max-width:150px;border:1px solid #1a2540;border-radius:6px;overflow:hidden;background:#080e1a;transition:border-color .2s,box-shadow .2s}
.flow-node:hover{border-color:#388bfd55;box-shadow:0 0 8px #388bfd11}
.fn-hdr{padding:5px 7px;display:flex;align-items:center;gap:4px;border-bottom:1px solid #0f1a2a;background:#0a1020}
.fn-name{font-weight:700;font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fn-pid{color:#21262d;font-size:9px;font-variant-numeric:tabular-nums}
.fn-body{padding:4px 7px}
.fn-wm{font-size:9px;color:#484f58;margin-bottom:3px}
.fn-io{display:flex;gap:3px;flex-wrap:wrap;margin-top:2px}
.fn-out{font-size:9px;padding:1px 5px;border-radius:3px;background:#0d1e3d;color:#58a6ff;border:1px solid #1f6feb44}
.fn-in{font-size:9px;padding:1px 5px;border-radius:3px;background:#0d2818;color:#3fb950;border:1px solid #23863644}
.fn-bc{font-size:9px;padding:1px 5px;border-radius:3px;background:#241900;color:#d29922;border:1px solid #d2992244}
.fn-last{font-size:9px;color:#484f58;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-top:3px;border-top:1px solid #0f1a2a;font-style:italic}
.flow-matrix-wrap{padding:7px 8px;border-bottom:1px solid #21262d}
.flow-matrix-title{font-size:9px;color:#484f58;text-transform:uppercase;letter-spacing:1px;margin-bottom:5px}
.flow-matrix{display:grid;gap:1px;overflow-x:auto}
.fm-cell{font-size:9px;padding:2px 4px;border-radius:2px;text-align:center;min-width:26px;min-height:18px;display:flex;align-items:center;justify-content:center}
.fm-cell.hdr{color:#484f58;font-weight:700;background:transparent;font-size:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fm-cell.self{background:#161b22;color:#21262d}
.fm-cell.has-msg{cursor:pointer;font-weight:700}
.fm-cell.ti{background:#0d1e3d55;color:#58a6ff}
.fm-cell.tw{background:#24190055;color:#d29922}
.fm-cell.tc{background:#2a080855;color:#f85149;animation:pulse 1.5s infinite}
.fm-cell.tr{background:#1e104055;color:#a5b4fc}
.fm-cell.tm{background:#1a1a2a55;color:#8b949e}
@keyframes flowBlink{0%,100%{opacity:1}50%{opacity:.3}}
.fm-cell.fresh{animation:flowBlink .4s 3}
.deleg-section{padding:5px 8px;border-bottom:1px solid #21262d}
.deleg-hdr{font-size:9px;color:#484f58;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px}
.deleg-row{display:grid;grid-template-columns:70px 14px 70px 1fr 54px;gap:4px;padding:2px 0;font-size:10px;border-bottom:1px solid #0d1117;align-items:center}
.deleg-row:last-child{border-bottom:none}
.deleg-from,.deleg-to{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.deleg-arrow{color:#484f58;text-align:center;font-size:10px}
.deleg-task{color:#8b949e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.deleg-status{font-size:8px;padding:1px 4px;border-radius:2px;text-align:center;font-weight:700;white-space:nowrap}
.flow-log-hdr{padding:4px 8px 3px;font-size:9px;color:#484f58;text-transform:uppercase;letter-spacing:1px;border-top:1px solid #21262d;display:flex;justify-content:space-between}
.flow-log{padding:2px 8px 6px}
.flow-msg-row{display:grid;grid-template-columns:48px 1fr 10px 1fr 1.8fr;gap:4px;padding:2px 0;font-size:10px;border-bottom:1px solid #0d1117;align-items:center}
.flow-msg-row:last-child{border-bottom:none}
.flow-msg-row:hover{background:#161b22;border-radius:2px;padding-left:3px}
.fm-time2{color:#30363d;font-variant-numeric:tabular-nums;font-size:9px}
.fm-fromA{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fm-arr{font-size:11px;text-align:center;line-height:1}
.fm-toA{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fm-body{color:#6e7681;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;user-select:text}

/* ── Mesh Network Graph ──────────────────────────────── */
.graph-section{flex-shrink:0;display:flex;flex-direction:column;border-bottom:2px solid #1a2535;position:relative;height:28px;overflow:hidden;background:#05080e;transition:height .2s}
.graph-section.expanded{height:180px}
.graph-ph{padding:4px 10px;color:#6e7681;font-size:9px;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #1a2535;display:flex;justify-content:space-between;align-items:center;flex-shrink:0;background:#080c12;height:24px}
.graph-ph-title{display:flex;align-items:center;gap:6px}
.graph-svg-wrap{flex:1;overflow:hidden;background:#05080e;position:relative}
.graph-node text{pointer-events:none}
.graph-node:hover>circle:first-of-type{filter:brightness(1.4)}
/* Graph detail panel (overlays graph) */
.graph-detail{position:absolute;top:4px;right:6px;width:190px;background:#0a0e14ee;border:1px solid #30363d;border-radius:6px;padding:9px 10px;z-index:10;backdrop-filter:blur(6px);max-height:calc(100% - 10px);overflow-y:auto;box-shadow:0 4px 20px #00000066}
.gd-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:7px}
.gd-name{font-size:12px;font-weight:700;letter-spacing:.3px}
.gd-close{color:#484f58;font-size:12px;cursor:pointer;padding:1px 5px;border-radius:3px;line-height:1}
.gd-close:hover{color:#c9d1d9;background:#21262d}
.gd-stat{font-size:9px;color:#6e7681;margin-bottom:6px;display:flex;gap:8px;flex-wrap:wrap}
.gd-work{font-size:10px;color:#c9d1d9;margin-bottom:7px;border-left:2px solid;padding-left:6px;line-height:1.45;word-break:break-word}
.gd-section-hdr{font-size:8px;color:#30363d;text-transform:uppercase;letter-spacing:.8px;margin:7px 0 3px;border-bottom:1px solid #21262d;padding-bottom:2px}
.gd-row{font-size:9px;padding:2px 0;color:#8b949e;display:flex;gap:4px;align-items:baseline;overflow:hidden}
.gd-row-time{color:#21262d;flex-shrink:0;font-variant-numeric:tabular-nums}
.gd-row-dir{flex-shrink:0;font-weight:700}
.gd-row-body{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
/* ── Topology View ───────────────────────────────────── */
.topo-wrap{flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden;background:#05080e;position:relative}
.topo-svg-area{flex:1;overflow:hidden;position:relative;cursor:grab}
.topo-svg-area:active{cursor:grabbing}
.topo-svg-area svg{width:100%;height:100%}
/* tooltip */
.topo-tooltip{
  position:absolute;pointer-events:none;display:none;
  background:#0d1117;border:1px solid #30363d;border-radius:6px;
  padding:8px 10px;font-size:9px;z-index:20;max-width:200px;
  box-shadow:0 4px 16px #00000088;
}
.topo-tooltip .tt-title{font-weight:700;color:#e6edf3;margin-bottom:4px;font-size:10px}
.topo-tooltip .tt-row{display:flex;gap:6px;color:#8b949e;margin-bottom:2px}
.topo-tooltip .tt-key{min-width:48px;flex-shrink:0}
.topo-tooltip .tt-val{color:#c9d1d9;word-break:break-all}
/* event strip */
.evt-strip{height:24px;flex-shrink:0;border-top:1px solid #1a2535;background:#05080e;display:flex;align-items:center;padding:0 8px;gap:6px;overflow:hidden;font-size:10px}
.es-sep{color:#21262d;flex-shrink:0}
.es-item{display:flex;align-items:center;gap:3px;white-space:nowrap;overflow:hidden;flex-shrink:0;max-width:240px;background:#0a1020;padding:1px 5px;border-radius:3px}
.es-from{font-weight:700}
.es-arr{color:#484f58}
.es-body{color:#484f58;overflow:hidden;text-overflow:ellipsis}
.sl-log-panel{display:none;flex-direction:column;max-height:35%;flex-shrink:0;border-top:2px solid #1a2535;overflow:hidden}
.sl-log-panel.open{display:flex}

/* ── Input bar ───────────────────────────────────────── */
.input-bar{height:44px;background:var(--bg-glass);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-top:1px solid var(--border-subtle);padding:6px 16px;display:flex;gap:10px;align-items:center;flex-shrink:0}
.input-bar select{background:var(--bg-primary);border:1px solid var(--border-subtle);color:var(--text-primary);padding:5px 8px;border-radius:var(--radius-sm);font-size:12px;font-family:inherit;cursor:pointer;user-select:auto;transition:var(--transition-fast)}
.input-bar select:focus{outline:none;border-color:var(--accent-blue);box-shadow:0 0 0 3px rgba(59,130,246,.15)}
.input-bar input{flex:1;background:var(--bg-primary);border:1px solid var(--border-subtle);color:var(--text-primary);padding:6px 12px;border-radius:var(--radius-sm);font-family:inherit;font-size:13px;user-select:auto;transition:var(--transition-fast)}
.input-bar input:focus{border-color:var(--accent-blue);outline:none;box-shadow:0 0 0 3px rgba(59,130,246,.15)}
.input-bar input::placeholder{color:var(--text-muted)}
.send-btn{background:linear-gradient(135deg,var(--accent-blue),#2563eb);color:#fff;border:none;padding:6px 18px;border-radius:var(--radius-sm);cursor:pointer;font-size:12px;font-weight:600;font-family:inherit;transition:var(--transition-fast);white-space:nowrap;box-shadow:0 2px 8px rgba(59,130,246,.3)}
.send-btn:hover{box-shadow:0 4px 16px rgba(59,130,246,.4);transform:translateY(-1px)}
.send-btn:active{transform:translateY(0)}
.mesh-send-btn{background:var(--accent-blue-soft);color:var(--accent-blue);border:1px solid rgba(59,130,246,.25);padding:5px 12px;border-radius:var(--radius-sm);cursor:pointer;font-size:11px;font-weight:500;font-family:inherit;transition:var(--transition-fast);white-space:nowrap}
.mesh-send-btn:hover{background:rgba(59,130,246,.2);border-color:rgba(59,130,246,.4)}

/* ── Swimlane Timeline (Flow tab) ───────────────────── */
.sw-wrap{padding:6px 8px 5px;border-bottom:2px solid #21262d;background:#060a12}
.sw-wrap.sw-empty{color:#1f6feb44;font-size:11px;text-align:center;padding:14px;font-style:italic}
.sw-title{font-size:9px;color:#484f58;text-transform:uppercase;letter-spacing:1px;margin-bottom:5px;display:flex;justify-content:space-between}
.sw-chart{display:flex;align-items:stretch;overflow:hidden;border:1px solid #1a2535;border-radius:4px;background:#080c14}
.sw-labels{display:flex;flex-direction:column;flex-shrink:0;width:70px;background:#080c14;border-right:1px solid #1a2535}
.sw-label-hdr{height:18px;flex-shrink:0;border-bottom:1px solid #1a2535}
.sw-label{display:flex;align-items:center;padding:0 5px;font-size:9px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-bottom:1px solid #0f1520;flex-shrink:0;cursor:default}
.sw-label:last-child{border-bottom:none}
.sw-svg-wrap{flex:1;overflow:hidden;min-width:0}
.sw-svg-wrap svg{display:block}
.sw-legend{display:flex;gap:8px;flex-wrap:wrap;padding:5px 2px 2px;font-size:9px}
.sw-leg-item{display:flex;align-items:center;gap:3px;color:#6e7681}
.sw-leg-sq{width:8px;height:8px;border-radius:1px;flex-shrink:0;opacity:0.85}
.sw-leg-lbl{letter-spacing:.2px}

/* ── F2: Session Comparison ─────────────────────────── */
.cmp-bar{display:flex;align-items:center;gap:6px;padding:5px 8px;border-bottom:1px solid #21262d;background:#0d1117;flex-shrink:0}
.cmp-btn{background:#1f6feb;color:#fff;border:none;border-radius:3px;font-size:10px;padding:3px 10px;cursor:pointer;transition:background .15s}
.cmp-btn:hover{background:#388bfd}
.cmp-btn:disabled{opacity:.35;cursor:default}
.cmp-reset{background:transparent;color:#484f58;border:1px solid #30363d;border-radius:3px;font-size:10px;padding:2px 8px;cursor:pointer}
.cmp-reset:hover{color:#8b949e}
.cmp-sel-count{font-size:10px;color:#8b949e}
.cmp-container{display:flex;gap:0;flex:1;min-height:0;overflow:hidden}
.cmp-panel{flex:1;overflow-y:auto;border-right:1px solid #21262d;padding:10px}
.cmp-panel:last-child{border-right:none}
.cmp-ph{font-size:9px;font-weight:700;color:#484f58;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px}
.cmp-meta{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px}
.cmp-badge{font-size:10px;padding:2px 7px;border-radius:3px;font-weight:600}
.cmp-badge.ok{background:#23863622;color:#3fb950;border:1px solid #23863644}
.cmp-badge.warn{background:#d2992222;color:#d29922;border:1px solid #d2992244}
.cmp-badge.info{background:#1f6feb22;color:#58a6ff;border:1px solid #1f6feb44}
.cmp-diff{background:#ff7b0022;color:#ff7b00;border:1px solid #ff7b0044;font-size:10px;padding:2px 7px;border-radius:3px}
.cmp-topic{font-size:12px;font-weight:700;color:#e6edf3;margin-bottom:8px;line-height:1.4;border-left:2px solid #1f6feb;padding-left:8px}
.cmp-msgs{border-top:1px solid #21262d;padding-top:8px}
.cmp-msg{padding:5px 0;border-bottom:1px solid #0d1117;font-size:10px}
.cmp-msg-hdr{display:flex;gap:6px;align-items:baseline;margin-bottom:2px}
.cmp-msg-who{font-weight:700;font-size:10px}
.cmp-msg-time{font-size:9px;color:#30363d;font-family:monospace}
.cmp-msg-body{color:#8b949e;line-height:1.5}
.disc-item{cursor:pointer;transition:background .1s}
.disc-item.sel-1{border-left:2px solid #1f6feb;background:#1f6feb0a}
.disc-item.sel-2{border-left:2px solid #3fb950;background:#3fb9500a}
.disc-chk{width:14px;height:14px;cursor:pointer;accent-color:#1f6feb;flex-shrink:0;margin-right:4px}
/* ── OVERVIEW Tab ─────────────────────────────────── */
.ov-layout{display:grid;grid-template-columns:200px 1fr 220px;gap:8px;padding:8px;height:100%;box-sizing:border-box;min-height:0}
.ov-panel{background:#0d1117;border:1px solid #21262d;border-radius:6px;overflow:hidden;display:flex;flex-direction:column;min-height:0}
.ov-ph{font-size:9px;font-weight:700;color:#484f58;letter-spacing:1px;text-transform:uppercase;padding:6px 8px;border-bottom:1px solid #21262d;flex-shrink:0}
/* Agent Grid */
.ag-card{padding:6px 8px;border-bottom:1px solid #161b22;transition:background .15s}
.ag-card:hover{background:#161b22}
.ag-card.st-working{border-left:2px solid #58a6ff}
.ag-card.st-queued{border-left:2px solid #d29922}
.ag-card.st-zombie{border-left:2px solid #f85149;background:#1a0808}
.ag-card.st-error{border-left:2px solid #f85149}
.ag-card.st-idle{border-left:2px solid #21262d}
.ag-name{font-size:10px;font-weight:700;margin-bottom:3px}
.ag-bar-wrap{height:4px;background:#1a2535;border-radius:2px;margin-bottom:3px}
.ag-bar-fill{height:4px;border-radius:2px;transition:width .4s}
.ag-meta{display:flex;gap:6px;font-size:9px;color:#484f58}
.ag-meta b{font-size:9px}
/* Task Bar */
.tb-wrap{padding:5px 8px;display:flex;align-items:center;gap:8px;font-size:9px;border-top:1px solid #21262d;flex-shrink:0}
.tb-seg{display:flex;align-items:center;gap:3px}
.tb-sq{width:8px;height:8px;border-radius:2px;flex-shrink:0}
.tb-rate{margin-left:auto;color:#3fb950;font-weight:700;font-size:10px}
/* Live Feed */
.lf-list{overflow-y:auto;flex:1;min-height:0}
.lf-item{display:flex;align-items:baseline;gap:5px;padding:3px 8px;border-bottom:1px solid #0d1117;font-size:10px;line-height:1.4}
.lf-item:hover{background:#161b22}
.lf-time{color:#30363d;font-size:9px;font-family:monospace;flex-shrink:0}
.lf-icon{flex-shrink:0;width:12px;text-align:center}
.lf-agent{font-size:9px;font-weight:700;flex-shrink:0;max-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lf-text{color:#8b949e;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lf-ok .lf-icon{color:#3fb950}.lf-ok .lf-agent{color:#3fb950}
.lf-err .lf-icon{color:#f85149}.lf-err .lf-agent{color:#f85149}
.lf-run .lf-icon{color:#58a6ff}.lf-run .lf-agent{color:#58a6ff}
.lf-warn .lf-icon{color:#d29922}.lf-warn .lf-agent{color:#d29922}
.lf-dim .lf-icon{color:#484f58}.lf-dim .lf-agent{color:#484f58}
/* Comm graph (center panel) */
.ov-graph{flex:1;overflow:hidden;min-height:0;position:relative}
.ov-bottom{flex-shrink:0}
/* Anomaly Alerts */
.alert-panel{position:fixed;top:44px;right:8px;z-index:200;display:flex;flex-direction:column;gap:4px;pointer-events:none;max-width:260px}
.alert-card{pointer-events:all;display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:6px;font-size:11px;line-height:1.4;cursor:pointer;transition:opacity .2s;border:1px solid}
.alert-card.critical{background:#1a0a0a;border-color:#f8514966;color:#ffa8a8}
.alert-card.warning{background:#1a140a;border-color:#d2992266;color:#ffd08a}
.alert-card:hover{opacity:.75}
.alert-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0;margin-top:3px}
.alert-dot.critical{background:#f85149;box-shadow:0 0 4px #f85149}
.alert-dot.warning{background:#d29922;box-shadow:0 0 4px #d29922}
@media(prefers-reduced-motion:reduce){.alert-dot{box-shadow:none}}
/* Scrollbar — subtle & refined */
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:rgba(100,116,139,.25);border-radius:10px}
::-webkit-scrollbar-thumb:hover{background:rgba(100,116,139,.4)}
*{scrollbar-width:thin;scrollbar-color:rgba(100,116,139,.25) transparent}
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
    <div class="hdr-sep"></div>
    <div id="sysHealth" style="display:flex;align-items:center;gap:6px;font-size:9px;color:#484f58">
      <span id="redisStatus" title="Redis">⬡ –</span>
      <span id="uptime" title="Uptime">↑ –</span>
      <span id="queueDepth" title="Task Queue" style="display:none">Q:<span id="qDepthVal">0</span></span>
    </div>
    <div class="hdr-sep"></div>
    <a href="/topology" target="_blank" style="font-size:9px;padding:2px 8px;border:1px solid #30363d;border-radius:3px;color:#8b949e;text-decoration:none;background:#161b22;transition:all .15s" onmouseover="this.style.background='#1f6feb';this.style.borderColor='#1f6feb';this.style.color='#fff'" onmouseout="this.style.background='#161b22';this.style.borderColor='#30363d';this.style.color='#8b949e'">⬡ Topology ↗</a>
  </div>
</div>

<div id="alert-panel" class="alert-panel"></div>
<!-- ── Body ── -->
<div class="body" id="body">

  <!-- LEFT pane: CLI TERMINALS -->
  <div class="pane pane-left" id="pane-left">
    <div class="section" id="sec-mesh" style="flex:1;min-height:0">
      <div class="ph" style="height:auto;padding:6px 10px;flex-direction:column;align-items:flex-start;gap:2px">
        <div style="display:flex;width:100%;align-items:center">
          <div class="ph-title">
            <span style="font-size:11px">⬡</span>
            <span style="font-size:10px;font-weight:700;letter-spacing:.8px">CLI TERMINALS</span>
            <span class="ph-cnt" id="meshNodeCount" style="background:#0d1e3d;color:#58a6ff;border:1px solid #1f6feb44">0</span>
          </div>
          <span class="ph-toggle" style="margin-left:auto" onclick="toggleSection('sec-mesh')" title="접기/펼치기">▾</span>
        </div>
        <div style="font-size:9px;color:#1f6feb66;letter-spacing:.3px">사람이 직접 실행한 외부 CLI 세션</div>
      </div>
      <div class="section-body" id="meshNodeList"><div class="mesh-empty">활성 세션 없음<br><span style="font-size:9px">/nco-mesh ping 으로 등록</span></div></div>
    </div>
  </div>

  <!-- Resizer L -->
  <div class="resizer" id="resizer-l" title="드래그하여 크기 조절"></div>

  <!-- CENTER pane: Mesh Graph + Topology -->
  <div class="pane pane-center">

    <!-- ── Mesh Network Graph ── -->
    <div class="graph-section" id="graphSection">
      <div class="graph-ph">
        <div class="graph-ph-title">
          <span style="font-size:11px;color:#1f6feb">⬡</span>
          <span style="font-weight:700;color:#8b949e;letter-spacing:.5px">MESH NETWORK</span>
          <span id="graphNodeCount" style="font-size:9px;color:#1f6feb;background:#0d1e3d;padding:1px 5px;border-radius:3px;border:1px solid #1f6feb44">0</span>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <span id="graphEdgeCount" style="font-size:9px;color:#21262d">0 links</span>
          <button class="ef-btn" onclick="toggleGraphSection()" id="graphToggleBtn" title="그래프 접기/펼치기">▸</button>
        </div>
      </div>
      <div class="graph-svg-wrap" id="graphSvgWrap" style="display:none">
        <div id="graphSvg" style="width:100%;height:100%">
          <div style="display:flex;align-items:center;justify-content:center;height:100%;color:#1f6feb22;font-size:11px">
            세션 없음 — /nco-mesh ping 으로 등록
          </div>
        </div>
        <div class="graph-detail" id="graphDetail" style="display:none"></div>
        <div class="graph-legend">
          <span style="color:#58a6ff">● info</span>
          <span style="color:#d29922">● warn</span>
          <span style="color:#f85149">● conflict</span>
          <span style="color:#a5b4fc">● request</span>
        </div>
      </div>
    </div>

    <!-- ── Topology View ── -->
    <div class="ph" style="flex-shrink:0;flex-wrap:wrap;gap:4px">
      <div class="ph-title" style="flex-shrink:0">
        <span style="font-size:11px;color:#7c3aed">◈</span>
        <span style="font-weight:700;color:#8b949e;letter-spacing:.5px">TOPOLOGY</span>
        <span id="topoNodeCount" style="font-size:9px;color:#7c3aed;background:#1a0a2e;padding:1px 5px;border-radius:3px;border:1px solid #7c3aed44">0 nodes</span>
      </div>
      <!-- Inline legend (replaces floating panel) -->
      <div style="display:flex;gap:8px;align-items:center;font-size:8px;color:#484f58;flex:1;flex-wrap:wrap">
        <span style="display:flex;align-items:center;gap:3px"><span style="width:8px;height:8px;border-radius:50%;background:#7c3aed;flex-shrink:0"></span>NCO</span>
        <span style="display:flex;align-items:center;gap:3px"><span style="width:8px;height:8px;border-radius:50%;background:#1f6feb;flex-shrink:0"></span>CLI</span>
        <span style="display:flex;align-items:center;gap:3px"><span style="width:8px;height:8px;border-radius:50%;background:#3fb950;flex-shrink:0"></span>Agent</span>
        <span style="display:flex;align-items:center;gap:3px"><span style="width:18px;border-top:2px dashed #e3b341;flex-shrink:0"></span>위임</span>
        <span style="display:flex;align-items:center;gap:3px"><span style="width:18px;border-top:1.5px solid #1f6feb88;flex-shrink:0"></span>Mesh</span>
        <span style="display:flex;align-items:center;gap:3px;color:#58a6ff">◉ pulse</span>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-shrink:0">
        <span id="nowTime" style="color:#388bfd;font-size:10px;font-variant-numeric:tabular-nums;font-weight:700;letter-spacing:.5px">--:--:--</span>
        <span id="topoEdgeCount" style="color:#484f58;font-size:10px">0 links</span>
        <button class="ef-btn" id="slLogBtn" onclick="toggleEventLog()" title="이벤트 로그 토글">Log ▾</button>
      </div>
    </div>
    <!-- Topology SVG -->
    <div class="topo-wrap">
      <div class="topo-svg-area" id="topoSvgArea">
        <svg id="topoSvg" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <marker id="arrowTask" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 Z" fill="#d29922" opacity="0.7"/>
            </marker>
            <marker id="arrowMesh" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 Z" fill="#1f6feb" opacity="0.8"/>
            </marker>
            <filter id="topoGlow">
              <feGaussianBlur stdDeviation="2.5" result="blur"/>
              <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>
          </defs>
          <g id="topoEdgeLayer"></g>
          <g id="topoParticleLayer"></g>
          <g id="topoNodeLayer"></g>
        </svg>
        <div class="topo-tooltip" id="topoTooltip"></div>
      </div>
      <div class="evt-strip" id="evtStrip">
        <span style="color:#21262d">이벤트 없음</span>
      </div>
    </div>
    <!-- Collapsible event log -->
    <div class="sl-log-panel" id="slLogPanel">
      <div class="ph-filters" id="evtFilterBar" style="flex-shrink:0">
        <div class="evt-filters">
          <button class="ef-btn active" data-ef="all" onclick="setEvtFilter('all')">All</button>
          <button class="ef-btn" data-ef="task" onclick="setEvtFilter('task')">Task</button>
          <button class="ef-btn" data-ef="mesh" onclick="setEvtFilter('mesh')">Mesh</button>
          <button class="ef-btn" data-ef="system" onclick="setEvtFilter('system')">System</button>
          <button class="ef-btn" data-ef="action" onclick="setEvtFilter('action')">Action</button>
          <button class="ef-btn" data-ef="discussion" onclick="setEvtFilter('discussion')">Discussion</button>
        </div>
        <span id="focusBadge" style="display:none" class="focus-badge" onclick="clearFocus()">
          <span id="focusBadgeText"></span><span>✕</span>
        </span>
      </div>
      <div class="evt-list" id="eventList" style="flex:1;overflow-y:auto"></div>
    </div>
  </div>

  <!-- Task detail modal -->
  <div id="taskModal" class="modal-overlay" style="display:none" onclick="if(event.target===this)closeModal()">
    <div class="modal-box">
      <div class="modal-hdr">
        <div class="modal-title" id="modalTitle">Task Detail</div>
        <span class="modal-close" onclick="closeModal()">✕</span>
      </div>
      <div class="modal-meta" id="modalMeta"></div>
      <div class="modal-body" id="modalBody"></div>
      <div class="modal-stream" id="modalStream" style="display:none"></div>
    </div>
  </div>

  <!-- Resizer R -->
  <div class="resizer" id="resizer-r" title="드래그하여 크기 조절"></div>

  <!-- RIGHT pane: Server Agents + Tabs -->
  <div class="pane pane-right" id="pane-right">

    <!-- Agents section (collapsible, top of right pane) -->
    <div class="section" id="sec-agents" style="flex-shrink:0;max-height:45%">
      <div class="ph" style="height:auto;padding:6px 10px;flex-direction:column;align-items:flex-start;gap:2px">
        <div style="display:flex;width:100%;align-items:center">
          <div class="ph-title">
            <span style="color:#484f58;font-size:9px;letter-spacing:1.5px;font-weight:700">BACKEND AGENTS</span>
            <span class="ph-cnt" id="agCnt" style="background:#161b22;color:#484f58">9</span>
          </div>
          <span class="ph-toggle" style="margin-left:auto" onclick="toggleSection('sec-agents')" title="접기/펼치기">▾</span>
        </div>
        <div style="font-size:9px;color:#30363d;letter-spacing:.3px">NCO가 관리하는 백엔드 에이전트</div>
      </div>
      <div class="section-body" id="agentList"></div>
    </div>

    <!-- Divider between agents and tabs -->
    <div class="agents-tab-divider"></div>

    <!-- Tab bar -->
    <div class="tab-bar" id="tabBar">
      <div class="tab active" data-tab="overview" onclick="switchTab('overview')">◈ Overview</div>
      <div class="tab" data-tab="mesh" onclick="switchTab('mesh')">⬡ Mesh</div>
      <div class="tab" data-tab="sessions" onclick="switchTab('sessions')">Sessions</div>
      <div class="tab" data-tab="messages" onclick="switchTab('messages')">Messages</div>
      <div class="tab" data-tab="discussions" onclick="switchTab('discussions')">Discussions</div>
      <div class="tab" data-tab="tasks" onclick="switchTab('tasks')">Tasks</div>
      <div class="tab" data-tab="flow" onclick="switchTab('flow')">⇄ Flow</div>
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
/** Fixed-size ring (500): logical index 0 = newest (same as former array after unshift). */
const EVENT_RING_CAP=500;
const events=(function(){
  const buf=new Array(EVENT_RING_CAP);
  let start=0,size=0;
  return{
    unshift(el){
      start=(start-1+EVENT_RING_CAP)%EVENT_RING_CAP;
      buf[start]=el;
      if(size<EVENT_RING_CAP)size++;
    },
    push(el){
      if(size<EVENT_RING_CAP){
        buf[(start+size)%EVENT_RING_CAP]=el;
        size++;
      }else{
        // Buffer full: overwrite newest (start), advance start to drop it
        buf[start]=el;
        start=(start+1)%EVENT_RING_CAP;
      }
    },
    get length(){return size;},
    filter(fn){
      const r=[];
      for(let i=0;i<size;i++){
        const e=buf[(start+i)%EVENT_RING_CAP];
        if(fn(e))r.push(e);
      }
      return r;
    }
  };
})();
let messages=[];
let discussions=[];
let tasks=[];
let allTasks=[];
let meshSessions={};
// Swimlane window state (persists between renders, changed by setSwWindow())
let _swWindow=300000; // default 5 min
// F2: Session Comparison state
let _selSessions=[];    // max 2 selected sessionIds for comparison
let _compView=false;    // true = show comparison layout
let _compData=null;     // {s1:{meta,msgs[]}, s2:{meta,msgs[]}}
// Live Feed — recent significant events for OVERVIEW tab (max 40)
const LIVE_FEED=[];
// Anomaly Detection state
let ANOMALY_ALERTS=[];
const _dismissedAlerts=new Set();
let meshMessages=[];
// Swimlane state
const LANE_EVENTS={}; // agentId → [{start,end,type,label}]
const MSG_ARROWS=[];  // [{from,to,time,msgType}]
const SL_WINDOW=120000; // 2min visible window
let _slLogOpen=false;
// Mesh Graph state
const COMM_MATRIX={}; // "from::to" → {from,to,count,lastTime,msgs:[{time,content,msgType}]}
// CLI→Agent task delegation tracking
const CLI_TASK_LINKS={}; // "cliId::agentName" → {cli,agent,count,lastTime,tasks:[{id,prompt,status,time}]}
let GRAPH_SELECTED=null; // agentId selected in graph
let _graphOpen=false; // 기본 접힘 — 토폴로지가 주 시각화
let evtFilter=localStorage.getItem('nco-evt-filter')||'all';
let focusAgent=null;
let _evtDomCount=0;
let _evtFilterKey='';
let activeTab='overview';

const UI_FLUSH_MS=16;
let _uiTimer=null;
let _uiFull=false,_uiMesh=false,_uiEvents=false,_uiTabMesh=false,_uiCounts=false;
let _uiMeshFlash=null;
function scheduleMonitorUi(p){
  if(p.full)_uiFull=true;
  if(p.mesh){_uiMesh=true;if(p.flashId)_uiMeshFlash=p.flashId;}
  if(p.events)_uiEvents=true;
  if(p.tabMesh)_uiTabMesh=true;
  if(p.counts)_uiCounts=true;
  if(_uiTimer!=null)return;
  _uiTimer=setTimeout(function(){
    _uiTimer=null;
    const flash=_uiMeshFlash;_uiMeshFlash=null;
    if(_uiMesh){renderMeshNodes(flash);updateCounts();_uiMesh=false;_uiCounts=false;}
    else if(_uiCounts){updateCounts();_uiCounts=false;}
    if(_uiFull){render();_uiFull=false;_uiEvents=false;_uiTabMesh=false;}
    else{
      if(_uiTabMesh&&activeTab==='mesh'){renderTab();_uiTabMesh=false;}
      if(_uiEvents){renderEvents();_uiEvents=false;}
    }
  },UI_FLUSH_MS);
}

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
    if(!handle)return;
    let startX, startSize;
    handle.addEventListener('mousedown',e=>{
      startX=e.clientX;
      startSize=getSize();
      handle.classList.add('dragging');
      document.body.style.cursor='col-resize';
      let onMove,onUp;
      onMove=e=>{
        try{
          const delta=e.clientX-startX;
          const newSize=Math.max(minSize, startSize+delta);
          setSize(newSize);
        }catch{}
      };
      onUp=()=>{
        handle.classList.remove('dragging');
        document.body.style.cursor='';
        document.removeEventListener('mousemove',onMove);
        document.removeEventListener('mouseup',onUp);
        try{
          const s=JSON.parse(localStorage.getItem('nco-monitor-sizes')||'{}');
          s.left=parseInt(paneL.style.width||'240');
          s.right=parseInt(paneR.style.width||'320');
          localStorage.setItem('nco-monitor-sizes',JSON.stringify(s));
        }catch{}
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
    if(!handle)return;
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
let _wsReconnectAttempts=0;
const _WS_MAX_RECONNECT=15;
function connect(){
  ws=new WebSocket(WS_URL);
  ws.onopen=()=>{
    _wsReconnectAttempts=0;
    el('wsDot').className='dot on';
    el('wsText').textContent='WS connected';
  };
  ws.onclose=()=>{
    el('wsDot').className='dot off';
    if(_wsReconnectAttempts>=_WS_MAX_RECONNECT){
      el('wsText').textContent='WS reconnect limit reached';
      return;
    }
    const delay=Math.min(30000,1000*Math.pow(2,_wsReconnectAttempts));
    _wsReconnectAttempts++;
    el('wsText').textContent='WS reconnecting ('+_wsReconnectAttempts+'/'+_WS_MAX_RECONNECT+')...';
    setTimeout(connect,delay);
  };
  ws.onerror=()=>{};
  ws.onmessage=e=>{ try{handleEvent(JSON.parse(e.data));}catch(err){console.warn('[NCO Monitor] WS parse error',err);} };
}

// ── Live Feed helper ─────────────────────────────────
function pushFeed(icon,agent,text,cls){
  LIVE_FEED.unshift({t:Date.now(),icon,agent:agent||'',text,cls:cls||''});
  if(LIVE_FEED.length>40)LIVE_FEED.length=40;
}

// ── Event Handler ─────────────────────────────────────
function handleEvent(evt){
  if(evt.type==='connected')return;

  if(evt.type==='mesh:session_update'){
    const s=evt.session;
    let flashId=null;
    let didMesh=false;
    if(s?.sessionId){
      didMesh=true;
      const isNew=!meshSessions[s.sessionId];
      meshSessions[s.sessionId]={...s,_updatedAt:Date.now()};
      if(isNew){
        flashId=s.sessionId;
        pushFeed('⬡',s.agentId||s.sessionId,'mesh 연결','lf-run');
      }
      // Check for file conflicts with other sessions
      if((s.currentFiles||[]).length>0){
        Object.values(meshSessions).forEach(other=>{
          if(other.sessionId===s.sessionId)return;
          const shared=(s.currentFiles||[]).filter(f=>(other.currentFiles||[]).includes(f));
          if(shared.length)pushFeed('⚡',s.agentId||'','파일 충돌: '+shared.map(f=>f.split('/').pop()).slice(0,2).join(', '),'lf-warn');
        });
      }
    }
    events.unshift({...evt,agentId:evt.session?.agentId||'mesh',_isMesh:true});
    scheduleMonitorUi({mesh:didMesh,flashId:flashId,tabMesh:activeTab==='mesh',events:true,counts:true});
    return;
  }
  if(evt.type==='mesh:session_disconnected'){
    const _dAgent=meshSessions[evt.sessionId]?.agentId||evt.sessionId;
    delete meshSessions[evt.sessionId];
    pushFeed('⬡',_dAgent,'mesh 연결 해제','lf-dim');
    events.unshift({...evt,agentId:'mesh',_isMesh:true});
    scheduleMonitorUi({mesh:true,tabMesh:activeTab==='mesh',events:true,counts:true});
    return;
  }
  if(evt.type==='mesh:message'){
    // Support both wrapped (evt.message) and top-level field formats
    const m=evt.message||((evt.fromAgent||evt.from)?{
      from:evt.from,fromAgent:evt.fromAgent,to:evt.to,
      content:evt.content||'',messageType:evt.messageType||'info',
      createdAt:evt.createdAt||new Date().toISOString()
    }:null);
    if(m){ meshMessages.unshift(m); if(meshMessages.length>200)meshMessages.length=200; }
    events.unshift({...evt,agentId:m?.fromAgent||m?.from_agent||'mesh',_isMesh:true});
    // Track in COMM_MATRIX for graph visualization (resolve sessionId → agentId)
    if(m){
      const _gf=m.fromAgent||m.from_agent||'?';
      const _gtRaw=m.to||m.to_session||'*';
      const _gt=_gtRaw==='*'?'*':(meshSessions[_gtRaw]?.agentId||_gtRaw);
      const _gtype=m.messageType||m.type||'info';
      addCommEdge(_gf,_gt,m.content||'',_gtype);
    }
    flashTab('mesh');
    scheduleMonitorUi({tabMesh:activeTab==='mesh',events:true});
    return;
  }

  events.unshift(evt);

  // ── Swimlane lane event tracking ──────────────────────
  {const _a=evt.agentId||evt.from;
  if(_a&&_a!=='system'&&_a!=='user'){
    addLaneEvt(_a,classifyEvt(evt),evt.type+(evt.taskId?' ['+String(evt.taskId).slice(0,6)+']':''));
  }}
  if(evt._isMesh&&evt.type==='mesh:message'&&evt.message){
    const _m=evt.message;
    const _mf=_m.fromAgent||_m.from_agent||'?';
    const _mt2=_m.to||'*';
    const _mtype=_m.messageType||_m.type||'info';
    addMsgArrow(_mf,_mt2,_mtype);
    addLaneEvt(_mf,'msg','→'+(_mt2==='*'?'ALL':String(_mt2).slice(0,8)));
    if(_mt2&&_mt2!=='*')addLaneEvt(_mt2,'msg','←'+String(_mf).slice(0,8));
  }

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
    // 토론 참여 에이전트 → 토폴로지 에지 활성화
    if(evt.type==='discussion:provider_started'&&evt.agentId){
      addCliTaskLink('NCO',evt.agentId,evt.sessionId||'disc','💬 토론 참여','running');
    }
    if(evt.type==='discussion:provider_completed'&&evt.agentId){
      addCliTaskLink('NCO',evt.agentId,evt.sessionId||'disc','💬 토론 완료','completed');
    }
    if(evt.type==='discussion:started'&&evt.participants){
      (evt.participants||[]).forEach(p=>addCliTaskLink('NCO',p,evt.sessionId||'disc','💬 '+((evt.topic||'').slice(0,30)),'running'));
    }
    // 토론 메시지를 통신 라인(meshMessages + commMatrix)에 반영
    if(evt.type==='discussion:provider_completed'&&evt.agentId&&evt.content){
      const dm={from:evt.agentId,fromAgent:evt.agentId,to:'discussion',
        content:(evt.content||'').slice(0,200),messageType:'discussion',
        createdAt:evt.timestamp||new Date().toISOString()};
      meshMessages.unshift(dm); if(meshMessages.length>200)meshMessages.length=200;
      addCommEdge(evt.agentId,'discussion',dm.content,'discussion');
      addLaneEvt(evt.agentId,'msg','💬→discussion');
      pushFeed('💬',evt.agentId,(evt.content||'').slice(0,60),'lf-msg');
    }
    if(evt.type==='discussion:message'&&evt.from&&evt.content){
      const dm2={from:evt.from,fromAgent:evt.from,to:'discussion',
        content:(evt.content||'').slice(0,200),messageType:'discussion',
        createdAt:evt.timestamp||new Date().toISOString()};
      meshMessages.unshift(dm2); if(meshMessages.length>200)meshMessages.length=200;
      addCommEdge(evt.from,'discussion',dm2.content,'discussion');
    }
  }

  if(evt.type==='task:created'||evt.type==='task:started'){
    tasks.unshift({id:evt.taskId,agent:evt.agentId,status:'running',time:evt.timestamp});
    if(tasks.length>50)tasks.length=50;
    // Track CLI→Agent delegation: match event sessionId/pid to mesh session
    if(evt.agentId&&evt.taskId){
      const srcSess=Object.values(meshSessions).find(s=>s.sessionId===evt.sessionId||String(s.pid)===String(evt.pid));
      if(srcSess)addCliTaskLink(srcSess.agentId,evt.agentId,evt.taskId,evt.prompt||'',evt.status||'running');
    }
    pushFeed('→',evt.agentId,'태스크 시작'+(evt.prompt?' — '+evt.prompt.slice(0,30):''),'lf-run');
    setTimeout(pollTasks, 500);
  }
  if(evt.type==='task:completed'){
    const t=tasks.find(t=>t.id===evt.taskId);if(t){t.status='completed';t.output=(evt.output||'').slice(0,300);}
    const at=allTasks.find(t=>t.id===evt.taskId);if(at)at.status='completed';
    Object.values(CLI_TASK_LINKS).forEach(l=>{const tk=l.tasks.find(t=>t.id===evt.taskId);if(tk)tk.status='completed';});
    pushFeed('✓',evt.agentId,'완료','lf-ok');
  }
  if(evt.type==='task:failed'){
    const t=tasks.find(t=>t.id===evt.taskId);if(t){t.status='failed';t.error=evt.error;}
    const at=allTasks.find(t=>t.id===evt.taskId);if(at)at.status='failed';
    Object.values(CLI_TASK_LINKS).forEach(l=>{const tk=l.tasks.find(t=>t.id===evt.taskId);if(tk)tk.status='failed';});
    pushFeed('✗',evt.agentId,'실패'+(evt.error?' — '+String(evt.error).slice(0,30):''),'lf-err');
  }

  scheduleMonitorUi({full:true});
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

// ── Swimlane helpers ──────────────────────────────────
function classifyEvt(evt){
  const t=evt.type||'';
  if(t.includes('streaming'))return 'stream';
  if(t.startsWith('action:'))return 'tool';
  if(t==='task:started'||t==='task:created')return 'think';
  if(t==='task:completed')return 'done';
  if(t==='task:failed')return 'err';
  if(t.includes('rate_limit')||t.includes('fallback'))return 'wait';
  if(t.includes('mesh:message')||t.startsWith('message:'))return 'msg';
  return 'think';
}
function addLaneEvt(agentId,type,label){
  if(!agentId||agentId==='system'||agentId==='user'||agentId==='monitor')return;
  if(!LANE_EVENTS[agentId])LANE_EVENTS[agentId]=[];
  const arr=LANE_EVENTS[agentId];
  const now=Date.now();
  if(type==='done'||type==='err')arr.forEach(e=>{if(!e.end&&e.type!=='msg')e.end=now;});
  const last=arr[arr.length-1];
  if(last&&!last.end&&last.type===type&&type!=='msg'&&type!=='done'&&type!=='err')return;
  arr.push({start:now,end:(type==='done'||type==='err'||type==='msg')?now+300:null,type,label:label||type});
  LANE_EVENTS[agentId]=arr.filter(e=>now-(e.end||e.start)<300000);
}
function addMsgArrow(from,to,msgType){
  if(!from||from==='monitor')return;
  MSG_ARROWS.push({from,to:to||'*',time:Date.now(),msgType:msgType||'info'});
  if(MSG_ARROWS.length>300)MSG_ARROWS.shift();
}
function getLaneChip(agentId){
  const arr=LANE_EVENTS[agentId]||[];
  const now=Date.now();
  const active=arr.filter(e=>!e.end||now-e.start<4000);
  if(!active.length)return{cls:'ch-idle',txt:'IDLE'};
  const t=active[active.length-1].type;
  return({stream:{cls:'ch-stream',txt:'STREAM'},tool:{cls:'ch-tool',txt:'TOOL'},
    think:{cls:'ch-tx',txt:'TX'},wait:{cls:'ch-wait',txt:'WAIT'},
    err:{cls:'ch-err',txt:'ERR'},done:{cls:'ch-done',txt:'DONE'},
    msg:{cls:'ch-rx',txt:'MSG'}})[t]||{cls:'ch-idle',txt:'IDLE'};
}
function toggleEventLog(){
  _slLogOpen=!_slLogOpen;
  const p=document.getElementById('slLogPanel');
  const b=document.getElementById('slLogBtn');
  if(p)p.classList.toggle('open',_slLogOpen);
  if(b)b.textContent=_slLogOpen?'Log ▴':'Log ▾';
  if(_slLogOpen)renderEvents(true);
}

// ── Topology state ────────────────────────────────────
const TOPO_PARTICLES={}; // edgeKey → [{t:0..1, speed}]
let _topoSelected=null; // agentId
const AGENT_COLORS_MAP={
  opencode:'#2da44e', gemini:'#d29922', codex:'#1f6feb',
  aider:'#388bfd', 'cursor-agent':'#8957e5', copilot:'#20b2aa',
  openrouter:'#d4773a', vllm:'#da3633',
};
function topoAgentColor(id){return AGENT_COLORS_MAP[id]||agentColor(id)||'#30363d';}

// ── Render topology ───────────────────────────────────
let _prevTopoHash='', _prevTopoW=0, _prevTopoH=0;
let _lastCliNodes=[], _lastAgNodes=[], _lastActiveTasks=[];
function renderTopology(){
  const svg=document.getElementById('topoSvg');
  const area=document.getElementById('topoSvgArea');
  const nowEl=document.getElementById('nowTime');
  const stripEl=document.getElementById('evtStrip');
  if(!svg||!area)return;

  if(nowEl)nowEl.textContent=new Date().toLocaleTimeString('ko',{hour12:false});

  const W=area.offsetWidth||600;
  const H=area.offsetHeight||300;
  svg.setAttribute('viewBox','0 0 '+W+' '+H);

  // State-hash guard: skip full SVG rebuild when nothing structural changed (~80% of ticks)
  const _activeTasks=allTasks.filter(t=>t.status==='running'||t.status==='active'||t.status==='queued');
  const _topoHash=Object.keys(meshSessions).join(',')+
    '|'+Object.keys(agents).join(',')+
    '|'+Object.keys(CLI_TASK_LINKS).join(',')+
    '|'+Object.keys(COMM_MATRIX).join(',')+
    '|'+_activeTasks.map(t=>t.id+':'+t.status).join(',')+
    '|'+(_topoSelected||'');
  const _sizeChanged=(W!==_prevTopoW||H!==_prevTopoH);
  if(_topoHash===_prevTopoHash && !_sizeChanged){
    // Tooltip still works using cached node positions from last full render
    renderTopoTooltip(_lastCliNodes,_lastAgNodes,_lastActiveTasks);
    return;
  }
  _prevTopoHash=_topoHash; _prevTopoW=W; _prevTopoH=H;

  // ── Compute node positions (3-layer hierarchy) ──
  const PAD=24;
  const sessions=Object.values(meshSessions);
  const agentNames=Object.keys(agents).filter(Boolean);
  const activeTasks=_activeTasks; // reuse from hash-guard computation above

  // CLI→Agent delegation edges are tracked in the global CLI_TASK_LINKS (populated by handleEvent + pollTasks)

  // Layer Y positions — extra margin for agent metric bar
  const Y0=PAD+24;           // NCO Hub (top)
  const Y1=H*0.42;           // CLI Sessions (upper-mid, 42% from top)
  const Y2=H-PAD-44;         // Agents (bottom — 44px margin for stats bar)

  // NCO node
  const ncoX=W/2, ncoY=Y0;
  const ncoR=20;

  // CLI session positions
  const cliSpacing=Math.min(130, (W-PAD*2)/Math.max(sessions.length,1));
  const cliNodes=sessions.map((s,i)=>{
    const x=PAD+cliSpacing*0.5+cliSpacing*i;
    return {id:'cli::'+s.agentId, agentId:s.agentId, session:s, x:Math.min(x,W-PAD), y:Y1};
  });

  // Agent positions
  const agSpacing=Math.min(100,(W-PAD*2)/Math.max(agentNames.length,1));
  const agNodes=agentNames.map((name,i)=>{
    const x=PAD+agSpacing*0.5+agSpacing*i;
    return {id:'agent::'+name, name, x:Math.min(x,W-PAD), y:Y2};
  });

  // Cache node arrays for hash-guard early-return tooltip path
  _lastCliNodes=cliNodes; _lastAgNodes=agNodes; _lastActiveTasks=activeTasks;

  // ── Build SVG (array-based for efficient concatenation) ──
  const _edgeParts=[];
  const _nodeParts=[];
  const _particleParts=[];

  const meshColors={info:'#1f6feb',warning:'#d29922',conflict:'#f85149',request:'#a5b4fc',error:'#f85149'};
  // B: File type → color mapping for diff visualization
  function fileTypeColor(fname){
    const ext=(fname||'').split('.').pop().toLowerCase();
    const map={ts:'#a5b4fc',tsx:'#a5b4fc',js:'#f0db4f',jsx:'#f0db4f',
      py:'#3572A5',sh:'#56d364',md:'#8b949e',json:'#d29922',
      css:'#e879f9',html:'#f87171',go:'#00acd7',rs:'#f74c00'};
    return map[ext]||'#58a6ff';
  }
  // B: Compute file type summary for a file list (top 3 unique extensions)
  function fileTypeSummary(files){
    if(!files||!files.length)return '';
    const exts=[...new Set(files.map(f=>(f||'').split('.').pop().toLowerCase()).filter(Boolean))].slice(0,3);
    return exts.map(e=>'<tspan fill="'+fileTypeColor('a.'+e)+'" font-size="5.5">'+e+'</tspan>').join(' ');
  }

  // pulse phase: 0..1 cycle every 2s, used for ripple animations (③)
  const _tpNow=Date.now();
  const _phase=(_tpNow%2000)/2000;
  const _slowPhase=(_tpNow%4000)/4000;

  // ① Routing path highlight — when CLI has active delegation, draw CLI→NCO→Agent glow path
  Object.values(CLI_TASK_LINKS).forEach(link=>{
    const cliN=cliNodes.find(c=>c.agentId===link.cli);
    const agN=agNodes.find(a=>a.name===link.agent);
    if(!cliN||!agN)return;
    const running=link.tasks.some(t=>t.status==='running'||t.status==='assigned'||t.status==='queued');
    if(!running||Date.now()-link.lastTime>120000)return;
    // Glow path: CLI → NCO Hub
    _edgeParts.push(
      '<line x1="'+cliN.x+'" y1="'+(cliN.y-19)+'" x2="'+ncoX+'" y2="'+(ncoY+ncoR)+'"'+
      ' stroke="#e3b341" stroke-width="3" opacity="0.12" stroke-linecap="round"/>'+
      // Glow path: NCO Hub → Agent
      '<line x1="'+ncoX+'" y1="'+(ncoY+ncoR)+'" x2="'+agN.x+'" y2="'+(agN.y-15)+'"'+
      ' stroke="#e3b341" stroke-width="3" opacity="0.12" stroke-linecap="round"/>');
    // "via NCO" routing label at NCO Hub
    _edgeParts.push(
      '<text x="'+(ncoX+ncoR+4)+'" y="'+(ncoY+4)+'" font-size="6" fill="#e3b341" opacity="0.7">ROUTE</text>');
  });

  // 1. Heartbeat edges: NCO ↔ CLI (with directional arrow showing CLI reports up)
  cliNodes.forEach(c=>{
    const health=meshHealth(c.session.lastHeartbeat);
    const strokeColor=health==='active'?'#388bfd':health==='idle'?'#d29922':'#f85149';
    const op=health==='active'?'0.7':health==='idle'?'0.45':'0.3';
    // NCO → CLI (downward config/command line)
    _edgeParts.push(
      '<line x1="'+ncoX+'" y1="'+(ncoY+ncoR)+'" x2="'+c.x+'" y2="'+(c.y-19)+'"'+
      ' stroke="'+strokeColor+'" stroke-width="1" stroke-dasharray="4 4" opacity="'+op+'"/>');
    // CLI → NCO (upward heartbeat line with arrow)
    _edgeParts.push(
      '<line x1="'+c.x+'" y1="'+(c.y-19)+'" x2="'+ncoX+'" y2="'+(ncoY+ncoR)+'"'+
      ' stroke="'+strokeColor+'" stroke-width="1.5" opacity="'+(health==='active'?'0.6':'0.3')+'"'+
      ' marker-end="url(#arrowMesh)"/>');
  });

  // 2. NCO → Agent backbone edges (thin, always visible)
  agNodes.forEach(a=>{
    const hasIncoming=Object.values(CLI_TASK_LINKS).some(l=>l.agent===a.name&&Date.now()-l.lastTime<120000&&l.tasks.some(t=>t.status==='running'||t.status==='assigned'));
    const isActive=activeTasks.some(t=>t.provider===a.name||t.agent===a.name)||hasIncoming;
    const stroke=isActive?'#d29922':'#1a2535';
    const opacity=isActive?'0.7':'0.25';
    const w=isActive?1.5:1;
    const mk=isActive?' marker-end="url(#arrowTask)"':'';
    _edgeParts.push(
      '<line x1="'+ncoX+'" y1="'+(ncoY+ncoR)+'" x2="'+a.x+'" y2="'+(a.y-15)+'"'+
      ' stroke="'+stroke+'" stroke-width="'+w+'" opacity="'+opacity+'"'+mk+'/>');
    if(isActive){
      const key='task::'+a.name;
      if(!TOPO_PARTICLES[key]) TOPO_PARTICLES[key]=[{t:0,speed:0.007+Math.random()*0.005}];
      TOPO_PARTICLES[key].forEach(p=>{
        p.t=(p.t+p.speed)%1;
        const px=ncoX+(a.x-ncoX)*p.t;
        const py=(ncoY+ncoR)+(a.y-15-(ncoY+ncoR))*p.t;
        _particleParts.push('<circle cx="'+px+'" cy="'+py+'" r="2.5" fill="#e3b341" opacity="0.9"/>');
      });
    }
  });

  // 3. CLI→Agent delegation edges (from CLI_TASK_LINKS) — ② 파일 플로우 정보 포함
  Object.values(CLI_TASK_LINKS).forEach(link=>{
    const cliN=cliNodes.find(c=>c.agentId===link.cli);
    const agN=agNodes.find(a=>a.name===link.agent);
    if(!cliN||!agN)return;
    const fresh=Date.now()-link.lastTime<120000;
    if(!fresh)return;
    const running=link.tasks.some(t=>t.status==='running'||t.status==='active'||t.status==='queued'||t.status==='assigned');
    const color=running?'#e3b341':'#484f58';
    const bw=running?2:1;
    const op=running?0.9:0.35;
    _edgeParts.push(
      '<line x1="'+cliN.x+'" y1="'+(cliN.y+19)+'" x2="'+agN.x+'" y2="'+(agN.y-15)+'"'+
      ' stroke="'+color+'" stroke-width="'+bw+'" stroke-dasharray="5 3" opacity="'+op+'"'+
      (running?' marker-end="url(#arrowTask)"':'')+'/>');
    const midX=(cliN.x+agN.x)/2;
    const midY=((cliN.y+19)+(agN.y-15))/2;
    const topTask=link.tasks[0];
    // ② File flow badge: prompt + file count + file type color dots (B)
    if(topTask){
      const snippet=escHtml((topTask.prompt||'').slice(0,12));
      const statusIcon=topTask.status==='running'||topTask.status==='assigned'?'\u25B6':topTask.status==='completed'?'\u2713':'\u2717';
      const cliSess=cliN.session;
      const files=cliSess.currentFiles||[];
      const fileCount=files.length;
      // B: Show up to 3 file-type colored dots on the edge badge
      let fileDots='';
      files.slice(0,4).forEach((f,fi)=>{
        const fc=fileTypeColor(f);
        fileDots+='<circle cx="'+(midX-14+fi*8)+'" cy="'+(midY+12)+'" r="2.5" fill="'+fc+'" opacity="0.9" title="'+escHtml(f)+'"/>';
      });
      if(files.length>4)fileDots+='<text x="'+(midX+22)+'" y="'+(midY+15)+'" font-size="5" fill="#484f58">+'+( files.length-4)+'</text>';
      const badgeH=fileCount>0?22:15;
      _edgeParts.push(
        '<rect x="'+(midX-34)+'" y="'+(midY-10)+'" width="68" height="'+badgeH+'" rx="3"'+
        ' fill="#080c12" stroke="'+color+'" stroke-width="0.7" opacity="0.95"/>'+
        '<text x="'+midX+'" y="'+(midY-1)+'" text-anchor="middle" font-size="6.5" fill="'+color+'">'+
        statusIcon+' '+snippet+(topTask.prompt&&topTask.prompt.length>12?'\u2026':'')+'</text>'+
        (fileCount>0?
          '<text x="'+(midX-30)+'" y="'+(midY+7)+'" font-size="5.5" fill="#58a6ff">'+(fileCount)+'\u25a4</text>'+
          fileDots
        :
          '<text x="'+midX+'" y="'+(midY+7)+'" text-anchor="middle" font-size="5.5" fill="#484f58">'+
          escHtml(link.cli)+'\u2192'+escHtml(link.agent)+'</text>'
        ));
    }
    if(running){
      const pkey='clt::'+link.cli+'::'+link.agent;
      if(!TOPO_PARTICLES[pkey])TOPO_PARTICLES[pkey]=[{t:Math.random(),speed:0.009+Math.random()*0.006}];
      TOPO_PARTICLES[pkey].forEach(p=>{
        p.t=(p.t+p.speed)%1;
        const px=cliN.x+(agN.x-cliN.x)*p.t;
        const py=(cliN.y+19)+(agN.y-15-(cliN.y+19))*p.t;
        _particleParts.push('<circle cx="'+px+'" cy="'+py+'" r="2.5" fill="#e3b341" opacity="0.95"/>');
      });
    }
  });

  // 4. Mesh edges: CLI ↔ CLI (from COMM_MATRIX)
  Object.values(COMM_MATRIX).forEach(e=>{
    const src=cliNodes.find(c=>c.agentId===e.from);
    if(!src)return;
    let dst;
    if(e.to==='*'){dst={x:ncoX,y:ncoY};}
    else{dst=cliNodes.find(c=>c.agentId===e.to);}
    if(!dst)return;
    const color=meshColors[e.msgs[0]?.msgType]||meshColors[e.msgType]||'#3fb950';
    const fresh=Date.now()-e.lastTime<30000;
    const op=fresh?'0.85':'0.3';
    const w=fresh?2:1;
    const mx=(src.x+dst.x)/2;
    const my=Math.min(src.y,dst.y)-40;
    _edgeParts.push(
      '<path d="M'+src.x+','+(src.y)+' Q'+mx+','+my+' '+dst.x+','+dst.y+'"'+
      ' fill="none" stroke="'+color+'" stroke-width="'+w+'" opacity="'+op+'"'+
      (fresh?' marker-end="url(#arrowMesh)"':'')+'/>');
    if(fresh){
      const key='mesh::'+e.from+'::'+e.to;
      if(!TOPO_PARTICLES[key]) TOPO_PARTICLES[key]=[{t:0,speed:0.012+Math.random()*0.008}];
      TOPO_PARTICLES[key].forEach(p=>{
        p.t=(p.t+p.speed)%1;
        const t=p.t;
        const px=(1-t)*(1-t)*src.x+2*(1-t)*t*mx+t*t*dst.x;
        const py=(1-t)*(1-t)*src.y+2*(1-t)*t*my+t*t*dst.y;
        _particleParts.push('<circle cx="'+px+'" cy="'+py+'" r="2" fill="'+color+'" opacity="0.9"/>');
      });
    }
  });

  // 5. NCO Hub node — ③ pulse ring if any active delegations
  const ncoHasActive=Object.values(CLI_TASK_LINKS).some(l=>l.tasks.some(t=>t.status==='running'||t.status==='assigned'));
  const isSelected=_topoSelected==='nco';
  const glowFilter=isSelected?' filter="url(#topoGlow)"':'';
  if(ncoHasActive){
    // ③ Routing pulse: expanding ring around NCO hub
    const pr=ncoR+4+_phase*10;
    const po=(1-_phase)*0.4;
    _nodeParts.push('<circle cx="'+ncoX+'" cy="'+ncoY+'" r="'+pr+'" fill="none" stroke="#e3b341" stroke-width="1.5" opacity="'+po+'"/>');
  }
  _nodeParts.push(
    '<g class="topo-node" data-tid="nco" onclick="topoSelect(this.dataset.tid)" style="cursor:pointer"'+glowFilter+'>'+
    '<circle cx="'+ncoX+'" cy="'+ncoY+'" r="'+ncoR+'" fill="#1a0a2e" stroke="'+(isSelected?'#a78bfa':ncoHasActive?'#c4b5fd':'#7c3aed')+'" stroke-width="'+(isSelected||ncoHasActive?2.5:1.5)+'"/>'+
    '<text x="'+ncoX+'" y="'+(ncoY-5)+'" text-anchor="middle" font-size="10" fill="#e9d5ff" font-weight="700">NCO</text>'+
    '<text x="'+ncoX+'" y="'+(ncoY+6)+'" text-anchor="middle" font-size="6.5" fill="'+(ncoHasActive?'#e3b341':'#a78bfa')+'">'+
    (ncoHasActive?'ROUTING':'ROUTER')+'</text>'+
    '</g>');

  // 5b. CLI Session nodes — ③ heartbeat ripple + ② file count display
  const nodeW=86, nodeH=38;
  cliNodes.forEach(c=>{
    const s=c.session;
    const color=topoAgentColor(c.agentId)||'#1f6feb';
    const h=meshHealth(s.lastHeartbeat);
    const dotColor=h==='active'?'#2da44e':h==='idle'?'#d29922':'#f85149';
    const sel=_topoSelected===c.agentId;
    const gf=sel?' filter="url(#topoGlow)"':'';
    const bw=sel?2:1.5;
    const bc=sel?color:color+'88';
    const myLinks=Object.values(CLI_TASK_LINKS).filter(l=>l.cli===c.agentId&&Date.now()-l.lastTime<120000);
    const activeLinks=myLinks.filter(l=>l.tasks.some(t=>t.status==='running'||t.status==='assigned'||t.status==='queued'));
    const files=s.currentFiles||[];
    const fileCount=files.length;
    // ③ Heartbeat ripple ring for active sessions
    if(h==='active'){
      const pr=(nodeW/2+2)+_phase*6;
      const po=(1-_phase)*0.35;
      _nodeParts.push('<rect x="'+(c.x-pr)+'" y="'+(c.y-pr*0.5)+'" width="'+(pr*2)+'" height="'+(pr)+'"'+
        ' rx="6" fill="none" stroke="'+color+'" stroke-width="1" opacity="'+po+'"/>');
    } else if(h==='idle'){
      const pr=(nodeW/2+1)+_slowPhase*3;
      const po=(1-_slowPhase)*0.2;
      _nodeParts.push('<rect x="'+(c.x-pr)+'" y="'+(c.y-pr*0.5)+'" width="'+(pr*2)+'" height="'+(pr)+'"'+
        ' rx="6" fill="none" stroke="'+color+'" stroke-width="0.8" opacity="'+po+'"/>');
    }
    _nodeParts.push(
      '<g class="topo-node" data-tid="'+escHtml(c.agentId)+'" onclick="topoSelect(this.dataset.tid)" style="cursor:pointer"'+gf+'>'+
      '<rect x="'+(c.x-nodeW/2)+'" y="'+(c.y-nodeH/2)+'" width="'+nodeW+'" height="'+nodeH+'"'+
      ' rx="5" fill="#0a1628" stroke="'+bc+'" stroke-width="'+bw+'"/>'+
      '<circle cx="'+(c.x-nodeW/2+9)+'" cy="'+(c.y-nodeH/2+9)+'" r="3" fill="'+dotColor+'"/>'+
      '<text x="'+c.x+'" y="'+(c.y-6)+'" text-anchor="middle" font-size="9" font-weight="700" fill="'+color+'">'+escHtml(c.agentId)+'</text>'+
      '<text x="'+c.x+'" y="'+(c.y+5)+'" text-anchor="middle" font-size="7" fill="#8b949e">pid:'+escHtml(String(s.pid||'—'))+'</text>'+
      // ② File count badge (bottom-right) — shows count + first filename hint
      (fileCount>0?
        '<rect x="'+(c.x+nodeW/2-22)+'" y="'+(c.y+nodeH/2-13)+'" width="21" height="12" rx="2" fill="#0d2137" stroke="#1f6feb44" stroke-width="0.5"/>'+
        '<text x="'+(c.x+nodeW/2-11)+'" y="'+(c.y+nodeH/2-4)+'" text-anchor="middle" font-size="6.5" fill="#58a6ff">'+fileCount+'\u25a4</text>':'')+
      // Active delegation badge (top-right yellow circle)
      (activeLinks.length>0?
        '<circle cx="'+(c.x+nodeW/2-4)+'" cy="'+(c.y-nodeH/2+4)+'" r="6" fill="#e3b341" opacity="0.95"/>'+
        '<text x="'+(c.x+nodeW/2-4)+'" y="'+(c.y-nodeH/2+7.5)+'" text-anchor="middle" font-size="7" fill="#080c12" font-weight="700">'+activeLinks.length+'</text>':'')+
      '</g>');
    // ② File flow: show first 2 filenames as tiny labels above CLI node when selected
    if(sel&&fileCount>0){
      files.slice(0,2).forEach((f,fi)=>{
        const fname=f.replace(/^.*[\\/]/,'').slice(0,16);
        _nodeParts.push(
          '<rect x="'+(c.x-34)+'" y="'+(c.y-nodeH/2-13-fi*10)+'" width="68" height="9" rx="2"'+
          ' fill="#0d1117" stroke="#1f6feb44" stroke-width="0.5" opacity="0.9"/>'+
          '<text x="'+c.x+'" y="'+(c.y-nodeH/2-6-fi*10)+'" text-anchor="middle" font-size="6" fill="#79c0ff">\u25a4 '+escHtml(fname)+'</text>');
      });
      if(fileCount>2){
        _nodeParts.push(
          '<text x="'+c.x+'" y="'+(c.y-nodeH/2-9-2*10)+'" text-anchor="middle" font-size="6" fill="#484f58">\u2026+'+(fileCount-2)+' more</text>');
      }
    }
  });

  // 6. Agent nodes — ③ active pulse ring + C 품질 메트릭
  const agR=14;
  agNodes.forEach(a=>{
    const color=topoAgentColor(a.name);
    const sel=_topoSelected===a.name;
    const gf=sel?' filter="url(#topoGlow)"':'';
    const hasIncoming=Object.values(CLI_TASK_LINKS).some(l=>l.agent===a.name&&Date.now()-l.lastTime<120000&&l.tasks.some(t=>t.status==='running'||t.status==='assigned'));
    const isActive=activeTasks.some(t=>t.provider===a.name||t.agent===a.name)||hasIncoming;
    const stroke=sel?color:isActive?color:color+'55';
    const bw=sel?2.5:isActive?2:1.5;
    const taskCount=activeTasks.filter(t=>t.provider===a.name||t.agent===a.name).length;
    // C: Quality metrics from AGENT_STATS
    const stats=AGENT_STATS[a.name];
    const successRate=stats&&stats.total>0?Math.round(stats.completed/stats.total*100):null;
    const barW=agR*2; // full bar = node diameter
    // ③ Agent pulse ring when active
    if(isActive){
      const pr=agR+3+_phase*8;
      const po=(1-_phase)*0.45;
      _nodeParts.push('<circle cx="'+a.x+'" cy="'+a.y+'" r="'+pr+'" fill="none" stroke="'+color+'" stroke-width="1.5" opacity="'+po+'"/>');
    }
    _nodeParts.push(
      '<g class="topo-node" data-tid="'+escHtml(a.name)+'" onclick="topoSelect(this.dataset.tid)" style="cursor:pointer"'+gf+'>'+
      '<circle cx="'+a.x+'" cy="'+a.y+'" r="'+agR+'" fill="#050810" stroke="'+stroke+'" stroke-width="'+bw+'"/>'+
      (isActive?'<circle cx="'+a.x+'" cy="'+a.y+'" r="'+(agR+5)+'" fill="none" stroke="'+color+'" stroke-width="0.8" opacity="0.25" stroke-dasharray="3 3"/>':'')+
      '<text x="'+a.x+'" y="'+(a.y+3)+'" text-anchor="middle" font-size="7" fill="'+color+'" font-weight="700">'+escHtml(a.name.slice(0,8))+'</text>'+
      // C: Success rate mini-bar below node name
      (stats&&stats.total>0?
        '<rect x="'+(a.x-agR)+'" y="'+(a.y+agR+2)+'" width="'+barW+'" height="3" rx="1.5" fill="#1a2535"/>'+
        '<rect x="'+(a.x-agR)+'" y="'+(a.y+agR+2)+'" width="'+(barW*stats.completed/stats.total)+'" height="3" rx="1.5" fill="'+(successRate>75?'#3fb950':successRate>50?'#d29922':'#f85149')+'"/>'+
        '<text x="'+a.x+'" y="'+(a.y+agR+11)+'" text-anchor="middle" font-size="5.5" fill="#8b949e">'+stats.total+'t '+successRate+'%</text>'
      :'')+
      // Active task count badge
      (taskCount>0?'<text x="'+(a.x+agR-2)+'" y="'+(a.y-agR+4)+'" font-size="7" fill="#e3b341" font-weight="700">'+taskCount+'</text>':'')+
      // ① Incoming CLI delegation label
      (hasIncoming?
        '<text x="'+a.x+'" y="'+(a.y-agR-4)+'" text-anchor="middle" font-size="5.5" fill="#e3b341" opacity="0.85">'+
        Object.values(CLI_TASK_LINKS).filter(l=>l.agent===a.name&&l.tasks.some(t=>t.status==='running'||t.status==='assigned')).map(l=>l.cli).slice(0,2).join(',')+'</text>':'')+
      '</g>');
  });

  // Evict stale TOPO_PARTICLES (memory leak fix — keys were never deleted)
  { const _tpNow=Date.now();
    Object.keys(TOPO_PARTICLES).forEach(k=>{
      if(k.startsWith('task::')){
        const agName=k.slice(6);
        if(!activeTasks.some(t=>(t.provider===agName||t.agent===agName)&&(t.status==='running'||t.status==='active')))
          delete TOPO_PARTICLES[k];
      } else if(k.startsWith('clt::')){
        const parts=k.split('::'); // ['clt', cliId, agentName]
        const linkKey=(parts[1]||'')+'::'+( parts[2]||'');
        if(!CLI_TASK_LINKS[linkKey]||_tpNow-CLI_TASK_LINKS[linkKey].lastTime>300000)
          delete TOPO_PARTICLES[k];
      } else if(k.startsWith('mesh::')){
        const cmKey=k.slice(6); // 'from::to'
        if(!COMM_MATRIX[cmKey]||_tpNow-COMM_MATRIX[cmKey].lastTime>30000)
          delete TOPO_PARTICLES[k];
      }
    });
  }

  // Update DOM — batch to minimize reflows
  requestAnimationFrame(()=>{
    const el_e=document.getElementById('topoEdgeLayer');
    const el_p=document.getElementById('topoParticleLayer');
    const el_n=document.getElementById('topoNodeLayer');
    if(el_e)el_e.innerHTML=_edgeParts.join('');
    if(el_p)el_p.innerHTML=_particleParts.join('');
    if(el_n)el_n.innerHTML=_nodeParts.join('');
  });

  // Counters
  const nc=document.getElementById('topoNodeCount');
  const ec=document.getElementById('topoEdgeCount');
  if(nc)nc.textContent=(1+cliNodes.length+agNodes.length)+' nodes';
  if(ec)ec.textContent=(Object.keys(COMM_MATRIX).length+Object.keys(CLI_TASK_LINKS).length)+' links';

  // Tooltip on click (from topoSelect)
  renderTopoTooltip(cliNodes,agNodes,activeTasks);

  // Event strip ticker (4 most recent events)
  if(stripEl){
    const recentEvts=[];
    events.filter(e=>{if(recentEvts.length<4){recentEvts.push(e);return true;}return false;});
    const stripHtml=recentEvts.map(e=>{
      const agent=e.agentId||e.from||'?';
      const t=new Date(e.timestamp||Date.now()).toLocaleTimeString('ko',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
      const detail=String(e.content||e.chunk||e.type||'').slice(0,28);
      return '<span class="es-item">'+
        '<span style="color:#1f6feb44;font-variant-numeric:tabular-nums">'+t+'</span>'+
        '<span class="es-from" style="color:'+agentColor(agent)+'">'+escHtml(agent)+'</span>'+
        '<span class="es-arr">›</span>'+
        '<span class="es-body">'+escHtml(detail)+'</span>'+
      '</span><span class="es-sep">│</span>';
    }).join('');
    stripEl.innerHTML=stripHtml||'<span style="color:#1a2535">이벤트 없음</span>';
  }
}

function topoSelect(id){
  _topoSelected=_topoSelected===id?null:id;
}

function renderTopoTooltip(cliNodes,agNodes,activeTasks){
  const tt=document.getElementById('topoTooltip');
  if(!tt)return;
  if(!_topoSelected){tt.style.display='none';return;}

  let html='';
  if(_topoSelected==='nco'){
    html='<div class="tt-title">⬡ NCO Hub</div>'+
      '<div class="tt-row"><span class="tt-key">API</span><span class="tt-val">:6200</span></div>'+
      '<div class="tt-row"><span class="tt-key">WS</span><span class="tt-val">:6201</span></div>'+
      '<div class="tt-row"><span class="tt-key">Sessions</span><span class="tt-val">'+cliNodes.length+'</span></div>'+
      '<div class="tt-row"><span class="tt-key">Agents</span><span class="tt-val">'+agNodes.length+'</span></div>'+
      '<div class="tt-row"><span class="tt-key">Links</span><span class="tt-val">'+(Object.keys(COMM_MATRIX).length+Object.keys(CLI_TASK_LINKS).length)+'</span></div>';
  } else {
    const cliNode=cliNodes.find(c=>c.agentId===_topoSelected);
    const agNode=agNodes.find(a=>a.name===_topoSelected);
    if(cliNode){
      const s=cliNode.session;
      const h=meshHealth(s.lastHeartbeat);
      const msgOut=Object.values(COMM_MATRIX).filter(e=>e.from===_topoSelected).reduce((a,e)=>a+e.count,0);
      const msgIn=Object.values(COMM_MATRIX).filter(e=>e.to===_topoSelected).reduce((a,e)=>a+e.count,0);
      const myLinks=Object.values(CLI_TASK_LINKS).filter(l=>l.cli===_topoSelected&&Date.now()-l.lastTime<300000);
      const activeLinks=myLinks.filter(l=>l.tasks.some(t=>t.status==='running'||t.status==='assigned'||t.status==='queued'));
      const files=(s.currentFiles||[]);
      html='<div class="tt-title" style="color:'+topoAgentColor(_topoSelected)+'">'+escHtml(_topoSelected)+'</div>'+
        '<div class="tt-row"><span class="tt-key">PID</span><span class="tt-val">'+escHtml(String(s.pid||'—'))+'</span></div>'+
        '<div class="tt-row"><span class="tt-key">Model</span><span class="tt-val">'+escHtml(s.model||'claude')+'</span></div>'+
        '<div class="tt-row"><span class="tt-key">Health</span><span class="tt-val" style="color:'+(h==='active'?'#3fb950':h==='idle'?'#d29922':'#f85149')+'">'+h+'</span></div>'+
        '<div class="tt-row"><span class="tt-key">Msgs ↑</span><span class="tt-val">'+msgOut+'</span></div>'+
        '<div class="tt-row"><span class="tt-key">Msgs ↓</span><span class="tt-val">'+msgIn+'</span></div>'+
        (s.currentWork?'<div class="tt-row"><span class="tt-key">Work</span><span class="tt-val">'+escHtml((s.currentWork||'').slice(0,40))+'</span></div>':'')+
        (files.length>0
          ?'<div class="tt-sep" style="margin:4px 0;border-top:1px solid #30363d"></div>'+
            '<div class="tt-row"><span class="tt-key" style="color:#58a6ff">FILES ('+files.length+')</span></div>'+
            files.slice(0,4).map(f=>{
              const fname=f.replace(/^.*[\\/]/,'');
              return '<div class="tt-row" style="padding-left:6px">'+
                '<span style="font-size:9px;color:#79c0ff;font-family:monospace">◤ '+escHtml(fname)+'</span>'+
              '</div>';
            }).join('')+
            (files.length>4?'<div class="tt-row" style="padding-left:6px"><span style="font-size:9px;color:#484f58">…+'+(files.length-4)+' more</span></div>':'')
          :'')+
        (myLinks.length>0
          ?'<div class="tt-sep" style="margin:4px 0;border-top:1px solid #30363d"></div>'+
            '<div class="tt-row"><span class="tt-key" style="color:#e3b341">DELEGATED ('+activeLinks.length+' active)</span></div>'+
            myLinks.slice(0,4).map(link=>{
              const liveTask=link.tasks.find(t=>t.status==='running'||t.status==='assigned')||link.tasks[0];
              const sColor=liveTask&&(liveTask.status==='running'||liveTask.status==='assigned')?'#e3b341':liveTask&&liveTask.status==='completed'?'#3fb950':'#f85149';
              const sIcon=liveTask&&(liveTask.status==='running'||liveTask.status==='assigned')?'\\u25b6':liveTask&&liveTask.status==='completed'?'\\u2713':'\\u2717';
              return '<div class="tt-row">'+
                '<span class="tt-key" style="color:'+topoAgentColor(link.agent)+'">\\u2192'+escHtml(link.agent)+'</span>'+
                '<span class="tt-val" style="font-size:9px;color:'+sColor+'">'+sIcon+' '+escHtml((liveTask&&liveTask.prompt||'').slice(0,24))+'</span>'+
              '</div>';
            }).join('')
          :'');
    } else if(agNode){
      const myTasks=activeTasks.filter(t=>t.provider===agNode.name||t.agent===agNode.name);
      const incomingLinks=Object.values(CLI_TASK_LINKS).filter(l=>l.agent===agNode.name&&Date.now()-l.lastTime<300000);
      const activeIncoming=incomingLinks.filter(l=>l.tasks.some(t=>t.status==='running'||t.status==='assigned'||t.status==='queued'));
      const st=AGENT_STATS[agNode.name];
      const sr=st&&st.total>0?Math.round(st.completed/st.total*100):null;
      html='<div class="tt-title" style="color:'+topoAgentColor(agNode.name)+'">'+escHtml(agNode.name)+'</div>'+
        '<div class="tt-row"><span class="tt-key">Status</span><span class="tt-val" style="color:'+(myTasks.length>0?'#3fb950':activeIncoming.length>0?'#e3b341':'#484f58')+'">'+
          (myTasks.length>0?myTasks.length+' active':activeIncoming.length>0?'queued':'idle')+'</span></div>'+
        (st?'<div class="tt-row"><span class="tt-key">Tasks</span><span class="tt-val">'+st.total+' total</span></div>'+
          '<div class="tt-row"><span class="tt-key">Success</span><span class="tt-val" style="color:'+(sr>75?'#3fb950':sr>50?'#d29922':'#f85149')+'">'+sr+'%</span></div>'+
          (st.failed>0?'<div class="tt-row"><span class="tt-key">Failed</span><span class="tt-val" style="color:#f85149">'+st.failed+'</span></div>':''):'')+
        (incomingLinks.length>0
          ?'<div class="tt-sep" style="margin:4px 0;border-top:1px solid #30363d"></div>'+
            '<div class="tt-row"><span class="tt-key" style="color:#e3b341">FROM CLI ('+activeIncoming.length+' active)</span></div>'+
            incomingLinks.slice(0,4).map(link=>{
              const liveTask=link.tasks.find(t=>t.status==='running'||t.status==='assigned')||link.tasks[0];
              const sColor=liveTask&&(liveTask.status==='running'||liveTask.status==='assigned')?'#e3b341':liveTask&&liveTask.status==='completed'?'#3fb950':'#f85149';
              return '<div class="tt-row">'+
                '<span class="tt-key" style="color:'+topoAgentColor(link.cli)+'">'+escHtml(link.cli)+'\\u2192</span>'+
                '<span class="tt-val" style="font-size:9px;color:'+sColor+'">'+escHtml((liveTask&&liveTask.prompt||'').slice(0,28))+'</span>'+
              '</div>';
            }).join('')
          :'')+
        (myTasks.length>0
          ?'<div class="tt-sep" style="margin:4px 0;border-top:1px solid #30363d"></div>'+
            myTasks.slice(0,3).map(t=>{
              const fromLink=incomingLinks.find(l=>l.tasks.some(lt=>lt.id===t.id));
              return '<div class="tt-row">'+
                (fromLink?'<span class="tt-key" style="color:'+topoAgentColor(fromLink.cli)+'">'+escHtml(fromLink.cli)+'\\u2192</span>':'<span class="tt-key">Task</span>')+
                '<span class="tt-val">'+escHtml((t.prompt||t.id||'').slice(0,30))+'</span>'+
                '<span style="margin-left:4px;font-size:9px;color:'+(t.status==='running'?'#3fb950':t.status==='streaming'?'#a5b4fc':'#8b949e')+'">'+t.status+'</span>'+
              '</div>';
            }).join('')
          :'');
    }
  }

  if(!html){tt.style.display='none';return;}
  tt.innerHTML=html;
  tt.style.display='block';
  // Position: top-left to avoid covering right-side agent nodes
  tt.style.top='8px';
  tt.style.left='8px';
  tt.style.right='auto';
  tt.style.bottom='auto';
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
  idle:      '유휴',
  reviewing: '코드리뷰',
  blocked:   '블로킹',
  done:      '✓ 완료',
  autonomous:'자율작업',
};
const WM_CSS={
  solo:'wm-solo', mesh:'wm-mesh', waiting:'wm-waiting', idle:'wm-idle',
  reviewing:'wm-reviewing', blocked:'wm-blocked', done:'wm-done', autonomous:'wm-solo',
};

// Track done-session fade-out timers
const doneTimers = {};
function scheduleDoneFadeOut(sessionId, completedAt){
  if(doneTimers[sessionId]) return;
  const elapsed = completedAt ? Date.now()-new Date(completedAt).getTime() : 0;
  const remaining = Math.max(0, 30000 - elapsed); // 30s display window
  doneTimers[sessionId] = setTimeout(()=>{
    const node = document.getElementById('mn-'+sessionId);
    if(node){ node.classList.add('fading-out'); }
    setTimeout(()=>{
      delete meshSessions[sessionId];
      delete doneTimers[sessionId];
      renderMeshNodes();
      updateCounts();
      if(activeTab==='mesh') renderTab();
    }, 2000);
  }, remaining);
}

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
  // Separate active vs done sessions
  const activeSessions=sessions.filter(s=>resolveWorkMode(s)!=='done');
  const doneSessions=sessions.filter(s=>resolveWorkMode(s)==='done');

  // Schedule fade-outs for done sessions
  doneSessions.forEach(s=>scheduleDoneFadeOut(s.sessionId, s.completedAt));

  const renderSession=(s)=>{
    const h=meshHealth(s.lastHeartbeat);
    const wm=resolveWorkMode(s);
    const isDone=wm==='done';
    const files=(s.currentFiles||[]);
    const fname=files.length?escHtml(files[0].split('/').pop()||'')+(files.length>1?' +<span style="color:#1f6feb88">'+( files.length-1)+'</span>':''):'';
    const collab=(s.collaborators||[]);
    const conflicts=isDone?[]:(s.activeConflicts||[]);
    const workText=isDone?(s.completedWork||'작업 완료'):s.currentWork;

    // Done state: show elapsed since completion
    const doneElapsed=isDone&&s.completedAt
      ?'<span class="done-elapsed">'+timeAgo(s.completedAt)+' 완료 · 곧 제거됨</span>'
      :'';

    return '<div class="mesh-node mode-'+wm+'" id="mn-'+s.sessionId+'">'+
      '<div class="mn-inner">'+
        '<div class="mn-row1">'+
          (isDone?'<span style="color:#3fb950;font-size:9px">✓</span>':hDot(h))+
          '<span class="mn-agent" style="color:'+(isDone?'#3fb95088':agentColor(s.agentId))+'">'+escHtml(s.agentId)+'</span>'+
          '<span class="wm-badge '+(WM_CSS[wm]||'wm-idle')+'">'+(WM_LABEL[wm]||wm)+'</span>'+
          (isDone?doneElapsed:conflictBadgeHtml(conflicts))+
          '<span class="mn-pid">'+s.pid+'</span>'+
        '</div>'+
        (workText
          ?'<div class="mn-row2">'+
              '<span class="mn-work" style="'+(isDone?'text-decoration:line-through;opacity:.5':'')+'">'+escHtml(workText.slice(0,52))+'</span>'+
              (!isDone&&collab.length?'<span class="mn-collab">⬡'+collab.length+'</span>':'')+
            '</div>':
          (!isDone&&collab.length?'<div class="mn-row2"><span class="mn-collab">⬡ '+escHtml(collab.slice(0,2).join(', '))+(collab.length>2?' +더보기':'')+'</span></div>':'')
        )+
        (!isDone?conflictRowsHtml(conflicts):'')+
        (!isDone&&fname?'<div class="mn-file"><span style="color:#21262d">▸</span> <span class="mn-file-name">'+fname+'</span></div>':'')+
        '<div class="mn-meta">'+
          '<span class="mn-meta-branch">⎇ '+escHtml(s.branch||'main')+'</span>'+
          (s.taskId?'<span class="mn-meta-task">'+s.taskId.slice(0,10)+'</span>':'')+
          '<span class="mn-meta-time">'+timeAgo(s.lastHeartbeat)+'</span>'+
        '</div>'+
      '</div>'+
    '</div>';
  };

  list.innerHTML=activeSessions.map(renderSession).join('')+
    (doneSessions.length
      ?'<div style="margin:6px 6px 2px;font-size:9px;color:#23863655;letter-spacing:1px;text-transform:uppercase">최근 완료</div>'+
        doneSessions.map(renderSession).join('')
      :'');
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
    const agType=a.type||'cli'; // 'cli' = NCO-loop driven, 'api' = API call only
    return '<div class="ag" id="ag-'+a.id+'">'+
      '<div class="ag-left">'+
        '<span class="ag-icon" style="background:'+dotColor(st)+'"></span>'+
        '<span class="ag-name" style="color:'+agentColor(a.id)+'">'+a.id+'</span>'+
        '<span class="ag-type '+agType+'">'+agType.toUpperCase()+'</span>'+
        (shortEvent?'<span class="ag-sub">'+escHtml(shortEvent.slice(0,16))+'</span>':'')+
        (a.currentTask?'<span class="ag-task">'+escHtml(a.currentTask.slice(0,12))+'</span>':'')+
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

// ── Event type category ───────────────────────────────
function getTypeCategory(e){
  if(e._isMesh)return 'mesh';
  if(e.type.startsWith('action:'))return 'action';
  if(e.type.startsWith('task:'))return 'task';
  if(e.type.startsWith('discussion:'))return 'discussion';
  if(e.type.startsWith('message:'))return 'message';
  if(e.type.startsWith('system:'))return 'system';
  return 'agent';
}
function getFilteredEvents(){
  return events.filter(e=>{
    if(focusAgent&&(e.agentId||e.from)!==focusAgent&&!e.type?.startsWith('system:'))return false;
    if(evtFilter==='all')return true;
    return getTypeCategory(e)===evtFilter;
  });
}
function setEvtFilter(f){
  evtFilter=f;
  localStorage.setItem('nco-evt-filter',f);
  document.querySelectorAll('.ef-btn').forEach(b=>{
    b.classList.toggle('active',b.dataset.ef===f);
  });
  _evtDomCount=0;_evtFilterKey='';
  renderEvents(true);
}
function setFocusAgent(aid){
  focusAgent=aid;
  const badge=el('focusBadge');
  if(aid){badge.style.display='flex';el('focusBadgeText').textContent='⬡ '+aid;}
  else{badge.style.display='none';}
  _evtDomCount=0;_evtFilterKey='';
  renderEvents(true);
}
function clearFocus(){setFocusAgent(null);}
function slLaneFocus(id){setFocusAgent(focusAgent===id?null:id);}

// ── Render: Events (center) ───────────────────────────
function makeEventRow(e,isFirst){
  const div=document.createElement('div');
  const agent=e.agentId||e.from||'';
  const tc=getTypeCategory(e);
  div.className='ev'+(isFirst?' new':'');
  const t=new Date(e.timestamp||Date.now()).toLocaleTimeString('ko',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const detail=e.content||e.chunk||e.path||e.output||e.error||e.topic||
    (e.session?e.session.agentId+' '+e.session.status:'')||
    (e.message?e.message.fromAgent+'→'+e.message.to:'')||'';
  div.innerHTML='<span class="e-time">'+t+'</span>'+
    '<span class="e-agent" style="color:'+(e._isMesh?'#79c0ff':agentColor(agent))+'">'+escHtml(agent)+'</span>'+
    '<span class="e-type '+tc+'">'+escHtml(e.type)+'</span>'+
    '<span class="e-msg">'+escHtml(String(detail).slice(0,120))+'</span>';
  if(agent){
    div.title='클릭: '+agent+' 포커스';
    div.addEventListener('click',()=>setFocusAgent(focusAgent===agent?null:agent));
    if(focusAgent===agent)div.classList.add('focused');
  }
  return div;
}
function renderEvents(rebuild){
  const filtered=getFilteredEvents();
  const list=el('eventList');
  const fkey=evtFilter+'|'+(focusAgent||'');
  if(rebuild||fkey!==_evtFilterKey){
    list.innerHTML='';_evtDomCount=0;_evtFilterKey=fkey;
  }
  // Viewport-based limit: render only what's visible + buffer
  const evtItemH=24;
  const visibleCount=list.clientHeight>0?Math.ceil(list.clientHeight/evtItemH)+10:100;
  const maxShow=Math.min(Math.max(visibleCount,30),200);
  const show=filtered.slice(0,maxShow);
  const newCount=show.length;
  if(newCount>_evtDomCount){
    const newEvts=show.slice(0,newCount-_evtDomCount);
    const frag=document.createDocumentFragment();
    newEvts.forEach((e,i)=>frag.appendChild(makeEventRow(e,i===0&&_evtDomCount===0)));
    list.prepend(frag);
    while(list.children.length>maxShow)list.removeChild(list.lastChild);
  }
  _evtDomCount=Math.min(newCount,maxShow);
  const suffix=filtered.length<events.length?' ('+filtered.length+' shown)':'';
  const evtCountEl=el('evtCount');
  if(evtCountEl)evtCountEl.textContent=events.length+' events'+suffix;
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
    if(_compView&&_compData){
      content.style.display='flex';content.style.flexDirection='column';
      content.innerHTML=compareHtml();
    } else {
      content.style.display='';
      const selBar='<div class="cmp-bar">'+
        '<span class="cmp-sel-count">'+(_selSessions.length===0?'세션을 선택해 비교':_selSessions.length+'/2 선택됨')+'</span>'+
        '<button class="cmp-btn" onclick="fetchAndCompare()" '+ (_selSessions.length!==2?'disabled':'')+'>나란히 비교</button>'+
        (_selSessions.length>0?'<button class="cmp-reset" onclick="_selSessions=[];renderTab()">선택 해제</button>':'')+
      '</div>';
      content.innerHTML=selBar+(discussions.length
        ? discussions.map(d=>{
            const selIdx=_selSessions.indexOf(d.sessionId);
            const selCls=selIdx===0?' sel-1':selIdx===1?' sel-2':'';
            const cr=Math.round((d.consensusRate||0)*100);
            const crCls=cr>=70?'ok':cr>=40?'warn':'info';
            const sid=escHtml(d.sessionId||'');
            return '<div class="disc-item'+selCls+'" style="display:flex;align-items:flex-start;gap:6px;padding:8px">'+
              '<input type="checkbox" class="disc-chk" '+(selIdx>=0?'checked':'')+
                ' onchange="toggleSessionSel(\\''+sid+'\\')">'+
              '<div style="flex:1;min-width:0;cursor:pointer" onclick="toggleDiscDetail(\\''+sid+'\\')">'+
                '<div class="dt">'+escHtml(d.mode||'')+': '+escHtml((d.topic||'').slice(0,70))+'</div>'+
                '<div class="dm" style="display:flex;flex-wrap:wrap;gap:4px;margin-top:3px">'+
                  '<span class="cmp-badge info">'+escHtml(d.status||'')+'</span>'+
                  '<span class="cmp-badge '+crCls+'">합의 '+cr+'%</span>'+
                  '<span class="cmp-badge info">R'+( d.currentRound||0)+'</span>'+
                  (d.participants||[]).map(p=>'<span class="cmp-badge info" style="font-size:9px">'+escHtml(p)+'</span>').join('')+
                '</div>'+
              '</div>'+
            '</div>'+
            '<div id="disc-detail-'+sid+'" class="disc-detail" style="display:none;padding:4px 12px 12px 32px"></div>';
          }).join('')
        : '<div class="empty">No discussions yet</div>');
    }

  }else if(activeTab==='sessions'){
    const sessions=Object.values(meshSessions);
    // Index allTasks for fast lookup
    const taskById={};
    const tasksByWorkspace={};
    const tasksByAgent={};
    allTasks.forEach(t=>{
      taskById[t.id]=t;
      const wid=t.workspace_id;
      if(wid&&wid!=='default'){
        if(!tasksByWorkspace[wid])tasksByWorkspace[wid]=[];
        tasksByWorkspace[wid].push(t);
      }
      // Fallback: index by assigned_to agent name
      const ag=t.assigned_to||t.spawned_by_cli;
      if(ag){
        if(!tasksByAgent[ag])tasksByAgent[ag]=[];
        tasksByAgent[ag].push(t);
      }
    });

    const statusColor=(s)=>({running:'#58a6ff',streaming:'#a5b4fc',completed:'#3fb950',
      failed:'#f85149',cancelled:'#484f58',pending:'#d29922',assigned:'#79c0ff',reviewing:'#d2a8ff'}[s]||'#8b949e');

    const renderSessionTask=(t)=>{
      const sc=statusColor(t.status);
      const progress=Math.min(100,Math.max(0,t.progress||0));
      const showBar=['running','streaming'].includes(t.status)&&progress>0;
      const streamPrev=t.response&&['running','streaming'].includes(t.status)?t.response.slice(-100):'';
      return '<div class="st-task" data-tid="'+escHtml(t.id||'')+'" onclick="showTaskModal(this.dataset.tid)">'+
        '<div class="st-task-hdr">'+
          '<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:'+sc+'22;color:'+sc+';border:1px solid '+sc+'44;font-weight:700">'+escHtml(t.status||'?')+'</span>'+
          '<span style="color:'+agentColor(t.assigned_to||'')+'">'+escHtml(t.assigned_to||'unassigned')+'</span>'+
          (t.mode&&t.mode!=='task'?'<span style="color:#484f58;font-size:9px;background:#161b22;padding:1px 4px;border-radius:2px">'+escHtml(t.mode)+'</span>':'')+
          '<span style="color:#30363d;font-size:10px;margin-left:auto;font-variant-numeric:tabular-nums">'+escHtml((t.id||'').slice(0,10))+'</span>'+
        '</div>'+
        '<div class="st-task-prompt" title="'+escHtml(t.prompt||'')+'">'+escHtml((t.prompt||'').slice(0,90))+'</div>'+
        (streamPrev?'<div class="st-stream">↳ '+escHtml(streamPrev)+'</div>':'')+
        (showBar?'<div class="st-progress-outer"><div class="st-progress-inner" style="width:'+progress+'%"></div></div>':'')+
        '<div style="font-size:9px;color:#30363d;margin-top:3px">'+
          (t.created_at?timeAgo(t.created_at):'')+
          (progress>0&&!showBar?'<span style="margin-left:6px;color:#484f58">'+progress.toFixed(0)+'%</span>':'')+
        '</div>'+
      '</div>';
    };

    const attributedIds=new Set();
    let html='';

    if(!sessions.length){
      html='<div class="empty">활성 CLI 세션 없음<br><span style="font-size:10px;margin-top:4px;display:block">/nco-mesh ping 으로 세션을 등록하세요</span></div>';
    }else{
      sessions.forEach(s=>{
        const wm=resolveWorkMode(s);
        const h=meshHealth(s.lastHeartbeat);
        // Collect tasks for this session
        const taskMap=new Map();
        if(s.taskId&&taskById[s.taskId]) taskMap.set(s.taskId,taskById[s.taskId]);
        (tasksByWorkspace[s.sessionId]||[]).forEach(t=>taskMap.set(t.id,t));
        // Fallback: match tasks assigned to this session's agent
        (tasksByAgent[s.agentId]||[]).forEach(t=>taskMap.set(t.id,t));
        const sessionTasks=Array.from(taskMap.values())
          .sort((a,b)=>new Date(b.created_at||0).getTime()-new Date(a.created_at||0).getTime());
        sessionTasks.forEach(t=>attributedIds.add(t.id));
        const stats={run:0,done:0,fail:0};
        sessionTasks.forEach(t=>{
          if(['running','streaming','assigned','pending'].includes(t.status))stats.run++;
          else if(t.status==='completed')stats.done++;
          else if(t.status==='failed')stats.fail++;
        });
        const timeline=sessionTasks.slice(0,8).map((t,i)=>{
          const tc=statusColor(t.status);
          const icon=t.status==='completed'?'●':t.status==='failed'?'✗':['running','streaming'].includes(t.status)?'▶':'○';
          return (i>0?'<span class="tl-line"></span>':'')+
            '<span class="tl-dot" style="background:'+tc+';border-color:'+tc+'44" title="'+escHtml((t.prompt||'').slice(0,50))+'" data-tid="'+escHtml(t.id||'')+'" onclick="event.stopPropagation();showTaskModal(this.dataset.tid)">'+icon+'</span>';
        }).join('');
        html+='<div class="sc-card">'+
          '<div class="sc-hdr">'+
            hDot(h)+
            '<span style="color:'+agentColor(s.agentId)+';font-weight:700;font-size:12px">'+escHtml(s.agentId)+'</span>'+
            '<span class="wm-badge '+(WM_CSS[wm]||'wm-idle')+'" style="font-size:9px;padding:1px 6px">'+(WM_LABEL[wm]||wm)+'</span>'+
            '<span style="color:#30363d;font-size:10px">PID '+s.pid+'</span>'+
            '<div class="sc-stats">'+
              (stats.run?'<span class="sc-stat run">▶ '+stats.run+'</span>':'')+
              (stats.done?'<span class="sc-stat done">✓ '+stats.done+'</span>':'')+
              (stats.fail?'<span class="sc-stat fail">✗ '+stats.fail+'</span>':'')+
            '</div>'+
            '<span style="color:#484f58;font-size:9px">⎇ '+escHtml(s.branch||'main')+'</span>'+
          '</div>'+
          (timeline?'<div class="task-timeline" style="padding:4px 8px;border-bottom:1px solid #0f1a2a">'+timeline+'</div>':'')+
          (s.currentWork?'<div style="font-size:10px;color:#8b949e;padding:3px 10px;border-bottom:1px solid #0f1a2a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+escHtml(s.currentWork.slice(0,70))+'</div>':'')+
          '<div class="sc-tasks">'+
            (sessionTasks.length?sessionTasks.map(renderSessionTask).join(''):'<div class="sc-empty">연결된 작업 없음</div>')+
          '</div>'+
        '</div>';
      });
    }

    // Unattributed tasks
    const unattr=allTasks.filter(t=>!attributedIds.has(t.id));
    if(unattr.length){
      html+='<div class="sc-unattr-hdr"><span>미연결 작업</span><span>'+unattr.length+'</span></div>'+
        unattr.slice(0,20).map(renderSessionTask).join('');
    }

    if(!html)html='<div class="empty">세션 또는 작업 없음</div>';
    content.innerHTML=html;

  }else if(activeTab==='tasks'){
    const sc2=(s)=>({running:'#58a6ff',streaming:'#a5b4fc',completed:'#3fb950',failed:'#f85149',pending:'#d29922',assigned:'#79c0ff',cancelled:'#484f58'})[s]||'#8b949e';
    content.innerHTML=allTasks.length
      ? allTasks.map(t=>{
          const c=sc2(t.status);
          const prog=t.progress||0;
          const isActive=['running','streaming','assigned'].includes(t.status);
          return '<div class="task-item" data-tid="'+escHtml(t.id||'')+'" onclick="showTaskModal(this.dataset.tid)" style="cursor:pointer">'+
            '<div class="th2">'+
              '<span class="ta" style="color:'+agentColor(t.assigned_to||t.agent||'')+'">'+escHtml(t.assigned_to||t.agent||'?')+'</span>'+
              '<span style="flex:1;font-size:10px;color:#8b949e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+escHtml((t.prompt||'').slice(0,50))+'</span>'+
              '<span style="font-size:9px;padding:1px 6px;border-radius:3px;background:'+c+'22;color:'+c+';border:1px solid '+c+'44;white-space:nowrap">'+escHtml(t.status||'?')+'</span>'+
            '</div>'+
            (isActive&&prog>0?'<div class="st-progress-outer"><div class="st-progress-inner" style="width:'+prog+'%"></div></div>':'')+
            (t.response?'<div class="tb">'+escHtml((t.response||'').slice(-150))+'</div>':'')+
          '</div>';
        }).join('')
      : '<div class="empty">No tasks yet</div>';

  }else if(activeTab==='flow'){
    content.innerHTML=renderFlowTab();
  }else if(activeTab==='overview'){
    content.innerHTML=renderOverviewTab();
  }
}

// ── Flow tab renderer ─────────────────────────────────
// ── Mesh Network Graph ────────────────────────────────

function addCommEdge(from,to,content,msgType){
  const key=from+'::'+to;
  if(!COMM_MATRIX[key])COMM_MATRIX[key]={from,to,count:0,lastTime:0,msgs:[]};
  const e=COMM_MATRIX[key];
  e.count++;e.lastTime=Date.now();
  e.msgs.unshift({time:Date.now(),content,msgType});
  if(e.msgs.length>20)e.msgs.pop();
}

function addCliTaskLink(cliAgentId,agentName,taskId,prompt,status){
  if(!cliAgentId||!agentName)return;
  const key=cliAgentId+'::'+agentName;
  if(!CLI_TASK_LINKS[key])CLI_TASK_LINKS[key]={cli:cliAgentId,agent:agentName,count:0,lastTime:0,tasks:[]};
  const link=CLI_TASK_LINKS[key];
  link.lastTime=Date.now();
  const existing=link.tasks.find(t=>t.id===taskId);
  if(existing){existing.status=status;}
  else{
    link.count++;
    link.tasks.unshift({id:taskId,prompt:(prompt||'').slice(0,60),status,time:Date.now()});
    if(link.tasks.length>5)link.tasks.length=5;
  }
}
// Timer-based cleanup (every 60s) instead of O(N) on every add call
setInterval(()=>{
  const now=Date.now();
  Object.keys(COMM_MATRIX).forEach(k=>{if(now-COMM_MATRIX[k].lastTime>600000)delete COMM_MATRIX[k];});
  Object.keys(CLI_TASK_LINKS).forEach(k=>{if(now-CLI_TASK_LINKS[k].lastTime>300000)delete CLI_TASK_LINKS[k];});
},60000);

function toggleGraphSection(){
  _graphOpen=!_graphOpen;
  const wrap=el('graphSvgWrap');
  const gs=el('graphSection');
  const btn=el('graphToggleBtn');
  if(gs)gs.classList.toggle('expanded',_graphOpen);
  if(wrap)wrap.style.display=_graphOpen?'':'none';
  if(btn)btn.textContent=_graphOpen?'▾':'▸';
}

function renderMeshGraph(){
  const svgDiv=el('graphSvg');
  if(!svgDiv||!_graphOpen)return;
  const sessions=Object.values(meshSessions);
  const n=sessions.length;
  const nc=el('graphNodeCount'),ec=el('graphEdgeCount');
  if(nc)nc.textContent=n;

  if(!n){
    svgDiv.innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#1f6feb22;font-size:11px">세션 없음 — /nco-mesh ping 으로 등록</div>';
    if(ec)ec.textContent='0 links';
    return;
  }

  const W=svgDiv.offsetWidth||600;
  const H=svgDiv.offsetHeight||188;
  if(W<20||H<20)return;
  const cx=W/2,cy=H/2;
  const nodeR=Math.min(28,Math.max(15,Math.floor(80/Math.max(1,n))));
  const rr=Math.min(cx-nodeR-20,cy-nodeR-16);

  // Circular layout
  const pos={};
  if(n===1){
    pos[sessions[0].agentId]={x:cx,y:cy,session:sessions[0]};
  }else{
    sessions.forEach((s,i)=>{
      const a=(2*Math.PI*i/n)-Math.PI/2;
      pos[s.agentId]={x:cx+rr*Math.cos(a),y:cy+rr*Math.sin(a),session:s};
    });
  }

  const now=Date.now();
  const edges=Object.values(COMM_MATRIX).filter(e=>{
    const hasFrom=!!pos[e.from];
    const hasTo=e.to==='*'||!!pos[e.to];
    return hasFrom&&hasTo&&now-e.lastTime<600000;
  });
  if(ec)ec.textContent=edges.length+' links';

  const ECOL={info:'#1f6feb',warning:'#d29922',conflict:'#f85149',request:'#a5b4fc'};

  let svg='<svg viewBox="0 0 '+W+' '+H+'" width="'+W+'" height="'+H+'" style="display:block;background:#05080e">';

  // Defs: arrow markers + glow
  svg+='<defs>';
  Object.entries(ECOL).forEach(([t,c])=>{
    svg+='<marker id="mk-'+t+'" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="strokeWidth">'+
      '<path d="M0,0 L7,3.5 L0,7 Z" fill="'+c+'" opacity="0.75"/>'+
    '</marker>';
  });
  svg+='<filter id="glow" x="-50%" y="-50%" width="200%" height="200%">'+
    '<feGaussianBlur stdDeviation="2" result="b"/>'+
    '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>'+
  '</filter>';
  svg+='</defs>';

  // Subtle grid
  svg+='<g opacity="0.025">';
  for(let gx=0;gx<W;gx+=36)svg+='<line x1="'+gx+'" y1="0" x2="'+gx+'" y2="'+H+'" stroke="#58a6ff" stroke-width="0.5"/>';
  for(let gy=0;gy<H;gy+=36)svg+='<line x1="0" y1="'+gy+'" x2="'+W+'" y2="'+gy+'" stroke="#58a6ff" stroke-width="0.5"/>';
  svg+='</g>';

  // Edges
  edges.forEach((e,ei)=>{
    const fp=pos[e.from];
    const tp=e.to==='*'?{x:cx,y:cy}:pos[e.to];
    if(!fp||!tp)return;
    const fresh=now-e.lastTime<15000;
    const type=e.msgs[0]?.msgType||'info';
    const color=ECOL[type]||'#30363d';
    const mId='mk-'+(ECOL[type]?type:'info');
    const pid='ep'+ei;

    // Quadratic curve offset (for bidirectional distinction)
    const dx=tp.x-fp.x,dy=tp.y-fp.y;
    const len=Math.sqrt(dx*dx+dy*dy)||1;
    const ox=(dy/len)*14,oy=-(dx/len)*14;
    const mx=(fp.x+tp.x)/2+ox,my=(fp.y+tp.y)/2+oy;
    const d='M'+fp.x.toFixed(1)+','+fp.y.toFixed(1)+
      ' Q'+mx.toFixed(1)+','+my.toFixed(1)+
      ' '+tp.x.toFixed(1)+','+tp.y.toFixed(1);

    const opacity=fresh?0.85:0.28;
    const sw=fresh?2.5:1;
    svg+='<path id="'+pid+'" d="'+d+'" stroke="'+color+'" stroke-width="'+sw+
      '" fill="none" opacity="'+opacity+'" marker-end="url(#'+mId+')"'+
      (fresh?'':' stroke-dasharray="4 3"')+'/>';

    // Animated particle on fresh edges
    if(fresh){
      const dur=(0.9+Math.random()*0.5).toFixed(2);
      svg+='<circle r="3.5" fill="'+color+'" filter="url(#glow)" opacity="0.9">'+
        '<animateMotion dur="'+dur+'s" repeatCount="indefinite">'+
          '<mpath href="#'+pid+'"/>'+
        '</animateMotion>'+
      '</circle>';
    }

    // Count label at midpoint
    const lx=(mx+ox*0.3).toFixed(1),ly=(my+oy*0.3-3).toFixed(1);
    svg+='<text x="'+lx+'" y="'+ly+'" text-anchor="middle" fill="'+color+'" font-size="8" opacity="'+(fresh?0.9:0.4)+'">'+e.count+'</text>';
  });

  // Nodes
  Object.entries(pos).forEach(([agId,p])=>{
    const s=p.session;
    const color=agentColor(agId);
    const wm=resolveWorkMode(s);
    const h=meshHealth(s.lastHeartbeat);
    const active=wm!=='done'&&wm!=='idle';
    const sel=GRAPH_SELECTED===agId;
    const px=p.x.toFixed(1),py=p.y.toFixed(1);
    const totalOut=Object.values(COMM_MATRIX).filter(e=>e.from===agId).reduce((s,e)=>s+e.count,0);

    svg+='<g class="graph-node" onclick="selectGraphNode('+JSON.stringify(agId)+')" style="cursor:pointer">';

    // Pulse ring for active sessions
    if(active){
      svg+='<circle cx="'+px+'" cy="'+py+'" r="'+nodeR+'" fill="none" stroke="'+color+'" stroke-width="0.6">'+
        '<animate attributeName="r" values="'+nodeR+';'+(nodeR+11)+'" dur="2.2s" repeatCount="indefinite" calcMode="ease-out"/>'+
        '<animate attributeName="opacity" values="0.45;0" dur="2.2s" repeatCount="indefinite"/>'+
      '</circle>';
    }

    // Selection dashed ring
    if(sel){
      svg+='<circle cx="'+px+'" cy="'+py+'" r="'+(nodeR+7)+'" fill="none" stroke="'+color+'" stroke-width="1.5" stroke-dasharray="3 2" opacity="0.7">'+
        '<animateTransform attributeName="transform" type="rotate"'+
          ' from="0 '+px+' '+py+'" to="360 '+px+' '+py+'" dur="7s" repeatCount="indefinite"/>'+
      '</circle>';
    }

    // Main circle
    svg+='<circle cx="'+px+'" cy="'+py+'" r="'+nodeR+'" fill="'+(sel?color+'1a':'#05080e')+
      '" stroke="'+color+'" stroke-width="'+(sel?2.5:1.5)+'"/>';

    // Health dot (top-right corner)
    const hdC=h==='ok'?'#3fb950':h==='stale'?'#d29922':'#f85149';
    svg+='<circle cx="'+(p.x+nodeR-3).toFixed(1)+'" cy="'+(p.y-nodeR+3).toFixed(1)+
      '" r="3.5" fill="'+hdC+'" stroke="#05080e" stroke-width="1"/>';

    // Outgoing count badge (top-left)
    if(totalOut>0){
      const bx=(p.x-nodeR+3).toFixed(1),by=(p.y-nodeR+3).toFixed(1);
      svg+='<circle cx="'+bx+'" cy="'+by+'" r="5.5" fill="#1f6feb" stroke="#05080e" stroke-width="1"/>'+
        '<text x="'+bx+'" y="'+(p.y-nodeR+6.5).toFixed(1)+'" text-anchor="middle" fill="#fff" font-size="6.5" font-weight="700">'+Math.min(totalOut,99)+'</text>';
    }

    // Agent name + work mode
    const short=agId.length>9?agId.slice(0,8)+'\u2026':agId;
    svg+='<text x="'+px+'" y="'+(p.y-4).toFixed(1)+'" text-anchor="middle" fill="'+color+'" font-size="9" font-weight="600">'+escHtml(short)+'</text>';
    svg+='<text x="'+px+'" y="'+(p.y+8.5).toFixed(1)+'" text-anchor="middle" fill="#484f58" font-size="7.5">'+escHtml(WM_LABEL[wm]||wm)+'</text>';

    svg+='</g>';
  });

  svg+='</svg>';
  svgDiv.innerHTML=svg;
  renderGraphDetail();
}

function selectGraphNode(agId){
  GRAPH_SELECTED=GRAPH_SELECTED===agId?null:agId;
  renderMeshGraph();
}

function renderGraphDetail(){
  const panel=el('graphDetail');
  if(!panel)return;
  if(!GRAPH_SELECTED){panel.style.display='none';return;}

  const agId=GRAPH_SELECTED;
  const s=Object.values(meshSessions).find(x=>x.agentId===agId);
  if(!s){panel.innerHTML='<div style="color:#f85149;font-size:10px">세션 없음</div>';panel.style.display='block';return;}

  const color=agentColor(agId);
  const wm=resolveWorkMode(s);
  const h=meshHealth(s.lastHeartbeat);

  const outEdges=Object.values(COMM_MATRIX).filter(e=>e.from===agId);
  const inEdges=Object.values(COMM_MATRIX).filter(e=>e.to===agId||e.to==='*'&&e.from!==agId);
  const totalOut=outEdges.reduce((acc,e)=>acc+e.count,0);
  const totalIn=inEdges.reduce((acc,e)=>acc+e.count,0);

  // All messages sorted newest first
  const allMsgs=[...outEdges,...inEdges]
    .flatMap(e=>e.msgs.map(m=>({...m,_from:e.from,_to:e.to})))
    .sort((a,b)=>b.time-a.time);

  // Recent lane events
  const recentEvts=(LANE_EVENTS[agId]||[]).slice(-6).reverse();

  const fmt=t=>new Date(t).toLocaleTimeString('ko',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});

  panel.style.display='block';
  panel.innerHTML=
    '<div class="gd-hdr">'+
      '<span class="gd-name" style="color:'+color+'">'+escHtml(agId)+'</span>'+
      '<span class="gd-close" onclick="GRAPH_SELECTED=null;renderMeshGraph()">✕</span>'+
    '</div>'+
    '<div class="gd-stat">'+
      '<span style="color:'+(h==='ok'?'#3fb950':'#d29922')+'">⬤ '+h+'</span>'+
      '<span>'+escHtml(WM_LABEL[wm]||wm)+'</span>'+
      '<span style="color:#484f58">pid '+s.pid+'</span>'+
    '</div>'+
    '<div class="gd-stat">'+
      '<span style="color:#58a6ff">↑ '+totalOut+' 발신</span>'+
      '<span style="color:#3fb950">↓ '+totalIn+' 수신</span>'+
    '</div>'+
    (s.currentWork
      ?'<div class="gd-work" style="border-color:'+color+'55">'+escHtml(s.currentWork.slice(0,90))+'</div>'
      :'')+

    // Connection list
    ([...outEdges.map(e=>({dir:'out',other:e.to,count:e.count,lastTime:e.lastTime})),
      ...inEdges.map(e=>({dir:'in',other:e.from,count:e.count,lastTime:e.lastTime}))]
      .sort((a,b)=>b.lastTime-a.lastTime).length
      ?'<div class="gd-section-hdr">연결 ('+([...outEdges,...inEdges].length)+')</div>'+
        [...outEdges.map(e=>({dir:'out',other:e.to,cnt:e.count,fresh:Date.now()-e.lastTime<15000})),
         ...inEdges.map(e=>({dir:'in',other:e.from,cnt:e.count,fresh:Date.now()-e.lastTime<15000}))]
        .map(c=>'<div class="gd-row">'+
          '<span class="gd-row-dir" style="color:'+(c.dir==='out'?'#58a6ff':'#3fb950')+'">'+(c.dir==='out'?'→':'←')+'</span>'+
          '<span style="color:'+agentColor(c.other==='*'?'ALL':c.other)+'">'+escHtml(c.other==='*'?'ALL':c.other)+'</span>'+
          '<span class="gd-row-time" style="margin-left:auto">'+c.cnt+'건'+(c.fresh?' <span style="color:#58a6ff">●</span>':'')+'</span>'+
        '</div>').join('')
      :'')+

    // Recent events from swimlane
    (recentEvts.length
      ?'<div class="gd-section-hdr">이벤트</div>'+
        recentEvts.map(e=>'<div class="gd-row">'+
          '<span class="gd-row-time">'+fmt(e.start)+'</span>'+
          '<span class="gd-row-body">'+escHtml(e.label||e.type||'')+'</span>'+
        '</div>').join('')
      :'')+

    // Message log
    (allMsgs.length
      ?'<div class="gd-section-hdr">메시지 ('+allMsgs.length+'건)</div>'+
        '<div style="max-height:110px;overflow-y:auto">'+
        allMsgs.slice(0,15).map(m=>{
          const isOut=m._from===agId;
          const other=isOut?(m._to==='*'?'ALL':m._to):m._from;
          const tc={info:'#1f6feb',warning:'#d29922',conflict:'#f85149',request:'#a5b4fc'}[m.msgType]||'#484f58';
          return '<div class="gd-row" title="'+escHtml(m.content||'')+'">'+
            '<span class="gd-row-time">'+fmt(m.time)+'</span>'+
            '<span class="gd-row-dir" style="color:'+(isOut?'#58a6ff':'#3fb950')+'">'+
              (isOut?'→':'←')+' '+
            '</span>'+
            '<span style="color:'+agentColor(other)+';flex-shrink:0">'+escHtml(other)+'</span>'+
            '<span style="color:'+tc+';flex-shrink:0;margin-left:2px;font-size:8px">['+escHtml(m.msgType||'info')+']</span>'+
            '<span class="gd-row-body">'+escHtml((m.content||'').slice(0,35))+'</span>'+
          '</div>';
        }).join('')+
        '</div>'
      :'');
}

// ── H4: Agent Swimlane Timeline ──────────────────────
function setSwWindow(ms){_swWindow=ms;renderTab();}

// ── Overview Tab ───────────────────────────────────────
function renderOverviewTab(){
  const now=Date.now();

  // ── 1. Agent Grid (left panel) ──────────────────────
  const agentIds=new Set([...Object.keys(agents),...Object.keys(AGENT_STATS)]);
  let agGridHtml='';
  agentIds.forEach(id=>{
    const ag=agents[id]||{};
    const st=AGENT_STATS[id]||{total:0,completed:0,failed:0,running:0};
    const meshSess=Object.values(meshSessions).find(s=>s.agentId===id);
    const isZombie=meshSess&&meshSess.lastHeartbeat&&now-Number(meshSess.lastHeartbeat)>120000;
    const hasAnomaly=ANOMALY_ALERTS.some(a=>a.agentId===id&&a.sev==='critical');
    const successRate=st.total>0?Math.round(st.completed/st.total*100):null;
    const barColor=successRate===null?'#484f58':successRate>=80?'#3fb950':successRate>=50?'#d29922':'#f85149';
    let stClass='st-idle';
    if(isZombie)stClass='st-zombie';
    else if(ag.status==='working'||st.running>0)stClass='st-working';
    else if(ag.status==='error')stClass='st-error';
    const queuedCnt=allTasks.filter(t=>(t.assigned_to===id||t.provider===id)&&t.status==='queued').length;
    if(queuedCnt>0&&stClass==='st-idle')stClass='st-queued';
    const color=topoAgentColor(id)||agentColor(id)||'#8b949e';
    const stateLabel=isZombie?'💀 zombie':st.running>0?'● working':queuedCnt>0?'◆ Q:'+queuedCnt:'○ idle';
    const stateColor=isZombie?'#f85149':st.running>0?'#58a6ff':queuedCnt>0?'#d29922':'#30363d';
    agGridHtml+='<div class="ag-card '+stClass+'">'+
      '<div class="ag-name" style="color:'+color+'">'+escHtml(id)+(hasAnomaly?' <span style="color:#f85149">⚠</span>':'')+'</div>'+
      (successRate!==null?'<div class="ag-bar-wrap"><div class="ag-bar-fill" style="width:'+successRate+'%;background:'+barColor+'"></div></div>':'<div style="height:4px;margin-bottom:3px"></div>')+
      '<div class="ag-meta"><span style="color:'+stateColor+'">'+stateLabel+'</span>'+(successRate!==null?'<span style="margin-left:auto;color:'+barColor+';font-weight:700">'+successRate+'%</span>':'')+'</div>'+
      '<div class="ag-meta"><span title="완료">✓'+st.completed+'</span><span title="실패" style="color:#f8514988">✗'+st.failed+'</span><span title="전체">∑'+st.total+'</span></div>'+
    '</div>';
  });
  if(!agGridHtml)agGridHtml='<div style="padding:12px;font-size:10px;color:#484f58;text-align:center">에이전트 없음</div>';

  // ── 2. Comm Flow Graph (center, SVG) ─────────────────
  const VW=600,VH=200;
  const cliSessions=Object.values(meshSessions);
  const aiIds=[...agentIds].filter(id=>!cliSessions.find(s=>s.agentId===id));
  function nodeY(i,total,vh){return 24+i*(vh-48)/Math.max(total-1,1);}
  let gSvg='';
  const cliNodes=cliSessions.slice(0,7).map((s,i)=>({
    id:s.agentId||s.sessionId,x:55,y:nodeY(i,Math.min(cliSessions.length,7),VH),
    color:topoAgentColor(s.agentId)||agentColor(s.agentId)||'#58a6ff'
  }));
  const aiNodes=aiIds.slice(0,9).map((id,i)=>({
    id,x:VW-55,y:nodeY(i,Math.min(aiIds.length,9),VH),
    color:topoAgentColor(id)||agentColor(id)||'#8b949e'
  }));
  // Edges: CLI_TASK_LINKS (delegation)
  Object.values(CLI_TASK_LINKS).forEach(link=>{
    if(now-link.lastTime>30000&&!link.tasks.some(t=>t.status==='running'||t.status==='assigned'))return;
    const src=cliNodes.find(n=>n.id===link.cli)||aiNodes.find(n=>n.id===link.cli);
    const dst=aiNodes.find(n=>n.id===link.agent)||cliNodes.find(n=>n.id===link.agent);
    if(!src||!dst)return;
    const running=link.tasks.some(t=>t.status==='running'||t.status==='assigned');
    const failed=link.tasks.some(t=>t.status==='failed');
    const queued=link.tasks.some(t=>t.status==='queued');
    const ec=running?'#3fb950':failed?'#f85149':queued?'#d29922':'#484f58';
    const mx=(src.x+dst.x)/2;
    const cy=Math.min(src.y,dst.y)-16;
    gSvg+='<path d="M'+src.x+' '+src.y+' Q'+mx+' '+cy+' '+dst.x+' '+dst.y+'" fill="none" stroke="'+ec+'" stroke-width="'+(running?2:1)+'" opacity="0.65"'+(queued?' stroke-dasharray="4 3"':failed?' stroke-dasharray="2 3"':'')+'/>';
    if(running)gSvg+='<circle r="3" fill="'+ec+'" opacity="0.8"><animateMotion dur="1.4s" repeatCount="indefinite" path="M'+src.x+' '+src.y+' Q'+mx+' '+cy+' '+dst.x+' '+dst.y+'"/></circle>';
  });
  // Edges: COMM_MATRIX (mesh messages between sessions)
  Object.values(COMM_MATRIX).forEach(e=>{
    const src=cliNodes.find(n=>n.id===e.from)||aiNodes.find(n=>n.id===e.from);
    if(!src)return;
    let dst;
    if(e.to==='*'){dst={x:VW/2,y:VH/2,color:'#7c3aed'};}
    else{dst=cliNodes.find(n=>n.id===e.to)||aiNodes.find(n=>n.id===e.to);}
    if(!dst)return;
    const fresh=now-e.lastTime<30000;
    const ECOL2={info:'#1f6feb',warning:'#d29922',conflict:'#f85149',request:'#a5b4fc'};
    const lastType=e.msgs[0]?.msgType||'info';
    const ec=ECOL2[lastType]||'#1f6feb';
    const mx=(src.x+dst.x)/2;
    const cy2=Math.min(src.y,dst.y)-20;
    gSvg+='<path d="M'+src.x+' '+src.y+' Q'+mx+' '+cy2+' '+dst.x+' '+dst.y+'" fill="none" stroke="'+ec+'" stroke-width="'+(fresh?2:1)+'" opacity="'+(fresh?0.85:0.4)+'"'+(fresh?'':' stroke-dasharray="4 3"')+'/>';
    // Count label
    const lx=mx,ly=cy2-4;
    gSvg+='<text x="'+lx+'" y="'+ly+'" font-size="7" font-family="monospace" fill="'+ec+'" text-anchor="middle" opacity="'+(fresh?0.9:0.5)+'">'+e.count+'</text>';
    if(fresh)gSvg+='<circle r="2.5" fill="'+ec+'" opacity="0.85"><animateMotion dur="1.2s" repeatCount="indefinite" path="M'+src.x+' '+src.y+' Q'+mx+' '+cy2+' '+dst.x+' '+dst.y+'"/></circle>';
  });
  // Edges: Heartbeat links (CLI ↔ CLI via mesh — always show when multiple CLIs exist)
  if(cliNodes.length>=2){
    for(let i=0;i<cliNodes.length;i++){
      for(let j=i+1;j<cliNodes.length;j++){
        const a=cliNodes[i],b=cliNodes[j];
        // Skip if already has a COMM_MATRIX edge
        const hasEdge=Object.values(COMM_MATRIX).some(e=>
          (e.from===a.id&&e.to===b.id)||(e.from===b.id&&e.to===a.id));
        if(hasEdge)continue;
        const ha=meshHealth(cliSessions.find(s=>s.agentId===a.id)?.lastHeartbeat);
        const hb=meshHealth(cliSessions.find(s=>s.agentId===b.id)?.lastHeartbeat);
        const bothActive=ha==='active'&&hb==='active';
        const lineColor=bothActive?'#1f6feb':'#30363d';
        const lineOp=bothActive?0.35:0.15;
        gSvg+='<line x1="'+a.x+'" y1="'+a.y+'" x2="'+b.x+'" y2="'+b.y+'"'+
          ' stroke="'+lineColor+'" stroke-width="0.8" stroke-dasharray="2 3" opacity="'+lineOp+'"/>';
      }
    }
  }
  // File Conflict edges — orange arcs between CLI nodes sharing files
  for(let i=0;i<cliSessions.length;i++){
    for(let j=i+1;j<cliSessions.length;j++){
      const fa=cliSessions[i].currentFiles||[];
      const fb=cliSessions[j].currentFiles||[];
      const shared=fa.filter(f=>fb.includes(f));
      if(!shared.length)continue;
      const na=cliNodes.find(n=>n.id===(cliSessions[i].agentId||cliSessions[i].sessionId));
      const nb=cliNodes.find(n=>n.id===(cliSessions[j].agentId||cliSessions[j].sessionId));
      if(!na||!nb)continue;
      const tip='파일 충돌: '+shared.map(f=>f.split('/').pop()).slice(0,3).join(', ')+(shared.length>3?' +더보기':'');
      gSvg+='<path d="M'+na.x+' '+na.y+' Q'+(VW/2)+' '+(Math.min(na.y,nb.y)-30)+' '+nb.x+' '+nb.y+'" fill="none" stroke="#ff7b00" stroke-width="1.5" stroke-dasharray="3 2" opacity="0.85"><title>'+escHtml(tip)+'</title></path>';
      gSvg+='<text x="'+Math.round((na.x+nb.x)/2)+'" y="'+(Math.min(na.y,nb.y)-18)+'" font-size="8" font-family="monospace" fill="#ff7b00" text-anchor="middle" opacity="0.9">⚡'+shared.length+'</text>';
    }
  }
  // Nodes
  [...cliNodes,...aiNodes].forEach(n=>{
    const isW=(AGENT_STATS[n.id]?.running||0)>0;
    const isZ=cliSessions.find(s=>s.agentId===n.id&&s.lastHeartbeat&&now-Number(s.lastHeartbeat)>120000);
    const bc=isZ?'#f85149':isW?n.color:'#21262d';
    if(isW)gSvg+='<circle cx="'+n.x+'" cy="'+n.y+'" r="11" fill="'+n.color+'" opacity="0.07"><animate attributeName="r" values="9;13;9" dur="2s" repeatCount="indefinite"/></circle>';
    gSvg+='<circle cx="'+n.x+'" cy="'+n.y+'" r="8" fill="#0d1117" stroke="'+bc+'" stroke-width="1.5"/>'+
      '<text x="'+n.x+'" y="'+(n.y+3)+'" font-size="6" font-family="monospace" fill="'+n.color+'" text-anchor="middle">'+escHtml(n.id.slice(0,4))+'</text>'+
      '<text x="'+n.x+'" y="'+(n.y+14)+'" font-size="6.5" font-family="monospace" fill="#484f58" text-anchor="middle">'+escHtml(n.id.length>9?n.id.slice(0,8)+'\u2026':n.id)+'</text>';
  });
  if(cliNodes.length)gSvg+='<text x="55" y="12" font-size="7" font-family="monospace" fill="#484f58" text-anchor="middle">CLI</text>';
  if(aiNodes.length)gSvg+='<text x="'+(VW-55)+'" y="12" font-size="7" font-family="monospace" fill="#484f58" text-anchor="middle">AI</text>';
  const graphSvg='<svg viewBox="0 0 '+VW+' '+VH+'" style="width:100%;height:'+VH+'px;display:block">'+gSvg+'</svg>';

  // ── 3. Task Summary Bar ─────────────────────────────
  const qC=allTasks.filter(t=>t.status==='queued').length;
  const rC=allTasks.filter(t=>t.status==='running'||t.status==='assigned').length;
  const dC=allTasks.filter(t=>t.status==='completed').length;
  const fC=allTasks.filter(t=>t.status==='failed').length;
  const tot=qC+rC+dC+fC;
  const rate=tot>0?Math.round(dC/tot*100):0;
  const tbHtml='<div class="tb-wrap">'+
    '<div class="tb-seg"><div class="tb-sq" style="background:#d29922"></div><span style="color:#d29922">Q:'+qC+'</span></div>'+
    '<div class="tb-seg"><div class="tb-sq" style="background:#58a6ff"></div><span style="color:#58a6ff">R:'+rC+'</span></div>'+
    '<div class="tb-seg"><div class="tb-sq" style="background:#238636"></div><span style="color:#3fb950">✓'+dC+'</span></div>'+
    '<div class="tb-seg"><div class="tb-sq" style="background:#f85149"></div><span style="color:#f85149">✗'+fC+'</span></div>'+
    '<div class="tb-rate">'+rate+'%</div>'+
  '</div>';

  // ── 4. Live Feed (right panel) ──────────────────────
  function fmtTs2(t){const d=new Date(t);return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')+':'+String(d.getSeconds()).padStart(2,'0');}
  const feedItems=(LIVE_FEED.length?LIVE_FEED:[{t:now,icon:'·',agent:'',text:'이벤트 대기 중...',cls:'lf-dim'}]).slice(0,30);
  const lfHtml=feedItems.map(f=>
    '<div class="lf-item '+(f.cls||'')+'">'+
    '<span class="lf-time">'+fmtTs2(f.t)+'</span>'+
    '<span class="lf-icon">'+escHtml(f.icon)+'</span>'+
    (f.agent?'<span class="lf-agent" title="'+escHtml(f.agent)+'">'+escHtml(f.agent.length>10?f.agent.slice(0,9)+'\u2026':f.agent)+'</span>':'')+
    '<span class="lf-text">'+escHtml(f.text)+'</span>'+
    '</div>').join('');

  const anomalyBanner=ANOMALY_ALERTS.length
    ?'<div style="padding:4px 8px;background:#1a0808;border-bottom:1px solid #f8514933;font-size:9px;color:#f85149;flex-shrink:0">⚠ 이상 '+ANOMALY_ALERTS.length+'건</div>'
    :'';

  // ── Compose ─────────────────────────────────────────
  return '<div class="ov-layout">'+
    '<div class="ov-panel" style="overflow-y:auto">'+
      '<div class="ov-ph">에이전트 상태 <span style="color:#30363d;font-weight:400">'+[...agentIds].length+'</span></div>'+
      agGridHtml+
    '</div>'+
    '<div class="ov-panel">'+
      '<div class="ov-ph">통신 흐름</div>'+
      '<div style="flex:0 0 auto;overflow:hidden;border-bottom:1px solid #21262d">'+graphSvg+'</div>'+
      '<div style="flex:1;overflow:hidden;min-height:0">'+
        '<div style="padding:3px 8px;font-size:9px;color:#484f58;border-bottom:1px solid #161b22">활동 히트맵</div>'+
        '<div style="overflow:hidden">'+renderSwimlane()+'</div>'+
      '</div>'+
      tbHtml+
    '</div>'+
    '<div class="ov-panel">'+
      '<div class="ov-ph">실시간 이벤트</div>'+
      anomalyBanner+
      '<div class="lf-list">'+lfHtml+'</div>'+
    '</div>'+
  '</div>';
}

function renderSwimlane(){
  const now=Date.now();
  const SW_WIN=_swWindow;
  const winStart=now-SW_WIN;
  const N=30; // always 30 buckets
  const bucketMs=SW_WIN/N;

  // Only show agents with actual LANE_EVENTS data in the window (no phantom empty rows)
  const agentIds=Object.keys(LANE_EVENTS).filter(id=>
    LANE_EVENTS[id].some(e=>(e.end||e.start)>=winStart)
  );

  if(!agentIds.length){
    return '<div class="sw-wrap sw-empty">에이전트 활동 없음 — 태스크가 실행되면 히트맵이 표시됩니다</div>';
  }

  const ROW_H=20, HEADER_H=18, PAD_TOP=4;
  const totalH=HEADER_H+PAD_TOP+agentIds.length*ROW_H+4;
  const VW=1000;
  const bucketW=VW/N;
  const GAP=1.5;
  const bw=bucketW-GAP;

  // Event type priority for dominant-type selection per bucket
  const TYPE_PRI={err:6,done:5,tool:4,stream:3,think:2,msg:1,wait:0};
  const TYPE_COLOR={stream:'#a5b4fc',tool:'#3fb950',think:'#58a6ff',wait:'#d29922',err:'#f85149',done:'#238636',msg:'#79c0ff'};
  const IDLE='#0d1117';

  function fmtDur(ms){if(ms<1000)return ms+'ms';if(ms<60000)return (ms/1000).toFixed(1)+'s';return (ms/60000).toFixed(1)+'m';}
  function fmtTime(ts){const d=new Date(ts);return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')+':'+String(d.getSeconds()).padStart(2,'0');}

  // Label column
  let labelsHtml='<div class="sw-labels"><div class="sw-label-hdr"></div>';
  agentIds.forEach(id=>{
    const color=topoAgentColor(id)||agentColor(id)||'#8b949e';
    labelsHtml+='<div class="sw-label" style="color:'+color+';height:'+ROW_H+'px" title="'+escHtml(id)+'">'+
      escHtml(id.length>9?id.slice(0,8)+'\u2026':id)+'</div>';
  });
  labelsHtml+='</div>';

  // SVG
  let svg='';

  // Grid: 6 vertical dividers evenly spaced
  for(let g=1;g<=5;g++){
    const x=(g/6)*VW;
    svg+='<line x1="'+x+'" y1="0" x2="'+x+'" y2="'+totalH+'" stroke="#1a2535" stroke-width="1" opacity="0.6"/>';
  }
  // Time axis (7 labels: 0…6 sixths)
  for(let g=0;g<=6;g++){
    const x=(g/6)*VW;
    const label=fmtTime(winStart+(g/6)*SW_WIN);
    const anchor=g===0?'start':g===6?'end':'middle';
    svg+='<text x="'+x+'" y="'+(HEADER_H-3)+'" font-size="8" font-family="monospace" fill="#484f58" text-anchor="'+anchor+'">'+escHtml(label)+'</text>';
  }

  // Heatmap rows
  agentIds.forEach((id,rowIdx)=>{
    const y=HEADER_H+PAD_TOP+rowIdx*ROW_H;
    const midY=y+ROW_H/2;
    const bh=12;
    const by=midY-bh/2;
    const evts=LANE_EVENTS[id]||[];

    if(rowIdx%2===0) svg+='<rect x="0" y="'+y+'" width="'+VW+'" height="'+ROW_H+'" fill="#0a0e18" opacity="0.45"/>';

    for(let b=0;b<N;b++){
      const bStart=winStart+b*bucketMs;
      const bEnd=bStart+bucketMs;
      const x=b*bucketW+GAP/2;

      // Find dominant event type in this bucket
      let bestEvt=null, bestPri=-1;
      for(let i=0;i<evts.length;i++){
        const e=evts[i];
        const eEnd=e.end||now;
        if(e.start<bEnd&&eEnd>bStart){
          const pri=TYPE_PRI[e.type]??-1;
          if(pri>bestPri){bestEvt=e;bestPri=pri;}
        }
      }

      if(bestEvt){
        const color=TYPE_COLOR[bestEvt.type]||'#484f58';
        // Opacity encodes "how full" the bucket is (edge buckets may be partially covered)
        const coverage=Math.min(1,((Math.min(bestEvt.end||now,bEnd)-Math.max(bestEvt.start,bStart))/bucketMs));
        const opacity=Math.max(0.45, 0.45+coverage*0.5).toFixed(2);
        const tip=escHtml(id)+' | '+escHtml(bestEvt.type)+(bestEvt.label&&bestEvt.label!==bestEvt.type?' ('+escHtml(bestEvt.label)+')':'')+' | '+fmtTime(bStart)+' +'+fmtDur(bucketMs);
        svg+='<rect x="'+x+'" y="'+by+'" width="'+bw+'" height="'+bh+'" rx="1.5" fill="'+color+'" opacity="'+opacity+'"><title>'+tip+'</title></rect>';
      } else {
        svg+='<rect x="'+x+'" y="'+by+'" width="'+bw+'" height="'+bh+'" rx="1.5" fill="'+IDLE+'" opacity="0.8"/>';
      }
    }

    // Current-state dot on right edge for ongoing events
    const live=evts.find(e=>!e.end);
    if(live){
      const dotColor=TYPE_COLOR[live.type]||'#484f58';
      svg+='<circle cx="'+(VW-3)+'" cy="'+midY+'" r="3.5" fill="'+dotColor+'" opacity="0.95"><title>진행 중: '+escHtml(live.type)+'</title></circle>';
    }
  });

  // NOW line
  svg+='<line x1="'+(VW-1)+'" y1="'+HEADER_H+'" x2="'+(VW-1)+'" y2="'+totalH+'" stroke="#58a6ff" stroke-width="1.5" opacity="0.6"/>'+
       '<text x="'+(VW-3)+'" y="'+(HEADER_H-3)+'" font-size="7" font-family="monospace" fill="#58a6ff" text-anchor="end" opacity="0.6">NOW</text>';

  const svgHtml='<svg viewBox="0 0 '+VW+' '+totalH+'" preserveAspectRatio="none" style="width:100%;height:'+totalH+'px;display:block">'+svg+'</svg>';

  // Window selector buttons
  const winOpts=[[30000,'30s'],[60000,'1m'],[120000,'2m'],[300000,'5m']];
  const winBtns=winOpts.map(([ms,lbl])=>{
    const active=ms===SW_WIN;
    return '<button onclick="setSwWindow('+ms+')" style="background:'+(active?'#1f6feb':'transparent')+';color:'+(active?'#fff':'#484f58')+';border:1px solid '+(active?'#1f6feb':'#21262d')+';border-radius:3px;font-size:9px;padding:1px 6px;cursor:pointer;font-family:monospace;transition:all .15s">'+lbl+'</button>';
  }).join('');
  const winLabel=winOpts.find(([ms])=>ms===SW_WIN)?.[1]||'5m';

  const legendItems=[['stream','#a5b4fc'],['tool','#3fb950'],['think','#58a6ff'],['wait','#d29922'],['err','#f85149'],['done','#238636'],['msg','#79c0ff']];
  const legendHtml='<div class="sw-legend">'+
    legendItems.map(([t,c])=>'<span class="sw-leg-item"><span class="sw-leg-sq" style="background:'+c+'"></span><span class="sw-leg-lbl">'+t+'</span></span>').join('')+
  '</div>';

  return '<div class="sw-wrap">'+
    '<div class="sw-title">'+
      '<span>에이전트 활동 히트맵 <span style="color:#484f58;font-weight:400">(최근 '+winLabel+')</span></span>'+
      '<span style="display:flex;gap:3px;align-items:center"><span style="color:#484f58;font-size:9px;margin-right:4px">'+agentIds.length+' agents</span>'+winBtns+'</span>'+
    '</div>'+
    '<div class="sw-chart">'+labelsHtml+'<div class="sw-svg-wrap">'+svgHtml+'</div></div>'+
    legendHtml+
  '</div>';
}

function renderFlowTab(){
  const sessions=Object.values(meshSessions);
  const recentMsgs=meshMessages.slice(0,50);
  const sidToAgent={};
  sessions.forEach(s=>{sidToAgent[s.sessionId]=s.agentId;});
  function rTo(to){if(!to||to==='*')return '*';return sidToAgent[to]||to;}

  // Build pair map
  const pairMap={};
  recentMsgs.forEach(m=>{
    const from=m.fromAgent||m.from_agent||'?';
    const to=rTo(m.to||'*');
    if(from==='monitor')return;
    const key=from+'::'+to;
    if(!pairMap[key])pairMap[key]={from,to,count:0,lastTime:0,types:[]};
    pairMap[key].count++;
    const t=m.createdAt?new Date(m.createdAt).getTime():0;
    if(t>pairMap[key].lastTime)pairMap[key].lastTime=t;
    const mt=m.messageType||m.type||'info';
    if(!pairMap[key].types.includes(mt))pairMap[key].types.push(mt);
  });

  // 1. Session node grid
  const nodeHtml=sessions.length
    ?sessions.map(s=>{
        const h=meshHealth(s.lastHeartbeat);
        const wm=resolveWorkMode(s);
        const color=agentColor(s.agentId);
        const out=recentMsgs.filter(m=>(m.fromAgent||m.from_agent)===s.agentId);
        const inc=recentMsgs.filter(m=>{const to2=rTo(m.to||'*');return(to2===s.agentId||to2==='*')&&(m.fromAgent||m.from_agent)!==s.agentId;});
        const bc=recentMsgs.filter(m=>m.to==='*'&&(m.fromAgent||m.from_agent)===s.agentId);
        const last=[...out,...inc].sort((a,b)=>new Date(b.createdAt||0).getTime()-new Date(a.createdAt||0).getTime())[0];
        return '<div class="flow-node" style="border-color:'+color+'44">'+
          '<div class="fn-hdr" style="border-bottom-color:'+color+'22">'+hDot(h)+
            '<span class="fn-name" style="color:'+color+'">'+escHtml(s.agentId)+'</span>'+
            '<span class="fn-pid">'+s.pid+'</span></div>'+
          '<div class="fn-body">'+
            '<div class="fn-wm">'+escHtml(WM_LABEL[wm]||wm)+'</div>'+
            '<div class="fn-io">'+
              (out.length?'<span class="fn-out" title="송신">↑'+out.length+'</span>':'')+
              (inc.length?'<span class="fn-in" title="수신">↓'+inc.length+'</span>':'')+
              (bc.length?'<span class="fn-bc" title="브로드캐스트">⬡'+bc.length+'</span>':'')+
            '</div>'+
            (last?'<div class="fn-last">'+escHtml((last.content||'').slice(0,26))+'</div>':'')+
          '</div></div>';
      }).join('')
    :'<div style="color:#1f6feb44;font-size:11px;padding:12px;width:100%;text-align:center">활성 세션 없음 — /nco-mesh ping 으로 등록</div>';

  // 2. Communication matrix
  const allA=[...new Set(recentMsgs.flatMap(m=>[(m.fromAgent||m.from_agent||'?'),rTo(m.to||'*')]).filter(a=>a&&a!=='?'&&a!=='monitor'))];
  const mainA=allA.filter(a=>a!=='*');
  const hasBc=recentMsgs.some(m=>m.to==='*');
  let matrixHtml='';
  if(mainA.length>=2){
    const abbr=a=>escHtml(a.length>7?a.slice(0,6)+'…':a);
    const hRow='<div class="fm-cell hdr"></div>'+
      mainA.map(a=>'<div class="fm-cell hdr" title="'+escHtml(a)+'" style="color:'+agentColor(a)+'">'+abbr(a)+'</div>').join('')+
      (hasBc?'<div class="fm-cell hdr" style="color:#3fb950">ALL</div>':'');
    const rows=mainA.map(fa=>{
      const cells=mainA.map(ta=>{
        if(fa===ta)return '<div class="fm-cell self">·</div>';
        const p=pairMap[fa+'::'+ta];
        if(!p)return '<div class="fm-cell"></div>';
        const dom=p.types[0]||'info';
        const fresh=p.lastTime>Date.now()-30000;
        const cls={info:'ti',warning:'tw',conflict:'tc',request:'tr'}[dom]||'tm';
        return '<div class="fm-cell has-msg '+cls+(fresh?' fresh':'')+'" title="'+escHtml(fa)+'→'+escHtml(ta)+': '+p.count+'건">'+p.count+'</div>';
      }).join('');
      const bcp=pairMap[fa+'::*'];
      const bcCell=hasBc?(bcp?'<div class="fm-cell has-msg ti'+(bcp.lastTime>Date.now()-30000?' fresh':'')+'" title="broadcast '+bcp.count+'건">'+bcp.count+'</div>':'<div class="fm-cell"></div>'):'';
      return '<div class="fm-cell hdr" style="color:'+agentColor(fa)+'" title="'+escHtml(fa)+'">'+abbr(fa)+'</div>'+cells+bcCell;
    }).join('');
    const nc=mainA.length+1+(hasBc?1:0);
    matrixHtml='<div class="flow-matrix-wrap">'+
      '<div class="flow-matrix-title">통신 매트릭스 — 행(발신) × 열(수신), 숫자=메시지수</div>'+
      '<div class="flow-matrix" style="grid-template-columns:repeat('+nc+',minmax(26px,1fr))">'+hRow+rows+'</div>'+
      '<div style="margin-top:5px;display:flex;gap:8px;font-size:9px;flex-wrap:wrap">'+
        '<span style="color:#58a6ff">■ info</span><span style="color:#d29922">■ warning</span>'+
        '<span style="color:#f85149">■ conflict</span><span style="color:#a5b4fc">■ request</span>'+
        '<span style="color:#484f58;margin-left:4px">깜빡임=30초내 신규</span></div>'+
    '</div>';
  }else{
    matrixHtml='<div class="flow-matrix-wrap" style="color:#21262d;font-size:10px;text-align:center;padding:8px">'+
      (recentMsgs.length===0?'메시지 없음 — 매트릭스 표시 불가':'세션 2개 이상 필요 (현재 '+mainA.length+'개)')+'</div>';
  }

  // 3. AI delegation
  const recentT=allTasks.filter(t=>['running','streaming','completed','assigned','pending'].includes(t.status)).slice(0,10);
  const delegHtml=recentT.length
    ?'<div class="deleg-section"><div class="deleg-hdr">AI 위임 현황 (최근 '+recentT.length+'건)</div>'+
        recentT.map(t=>{
          const sc=({running:'#58a6ff',streaming:'#a5b4fc',completed:'#3fb950',assigned:'#79c0ff',pending:'#d29922'})[t.status]||'#8b949e';
          const fromId=t.workspace_id&&t.workspace_id!=='default'?t.workspace_id:'';
          const from=sidToAgent[fromId]||fromId||t.spawned_by_cli||'–';
          const to=t.assigned_to||'?';
          return '<div class="deleg-row">'+
            '<span class="deleg-from" style="color:'+agentColor(from)+'">'+escHtml(from)+'</span>'+
            '<span class="deleg-arrow">→</span>'+
            '<span class="deleg-to" style="color:'+agentColor(to)+'">'+escHtml(to)+'</span>'+
            '<span class="deleg-task">'+escHtml((t.prompt||'').slice(0,50))+'</span>'+
            '<span class="deleg-status" style="background:'+sc+'22;color:'+sc+';border:1px solid '+sc+'44">'+escHtml(t.status)+'</span>'+
          '</div>';
        }).join('')+'</div>'
    :'';

  // 4. Message flow log
  const logHtml=recentMsgs.length
    ?recentMsgs.slice(0,20).map(m=>{
        const from=m.fromAgent||m.from_agent||'?';
        const to=rTo(m.to||'*');
        const isBc=m.to==='*';
        const t=m.createdAt?new Date(m.createdAt).toLocaleTimeString('ko',{hour12:false}):'';
        const mt=m.messageType||m.type||'info';
        const tc={info:'#58a6ff',warning:'#d29922',conflict:'#f85149',request:'#a5b4fc'}[mt]||'#8b949e';
        return '<div class="flow-msg-row">'+
          '<span class="fm-time2">'+t+'</span>'+
          '<span class="fm-fromA" style="color:'+agentColor(from)+'">'+escHtml(from)+'</span>'+
          '<span class="fm-arr" style="color:'+tc+'">→</span>'+
          '<span class="fm-toA" style="color:'+(isBc?'#3fb950':agentColor(to))+'">'+escHtml(isBc?'ALL':to)+'</span>'+
          '<span class="fm-body">'+escHtml((m.content||'').slice(0,70))+'</span>'+
        '</div>';
      }).join('')
    :'<div class="empty" style="padding:12px">메시지 없음</div>';

  return renderSwimlane()+
    '<div class="flow-grid">'+nodeHtml+'</div>'+
    matrixHtml+delegHtml+
    '<div class="flow-log-hdr"><span>메시지 흐름</span><span style="color:#30363d">'+recentMsgs.length+'건</span></div>'+
    '<div class="flow-log">'+logHtml+'</div>';
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

// ── Task modal ────────────────────────────────────────
function showTaskModal(taskId){
  const t=allTasks.find(x=>x.id===taskId);
  if(!t)return;
  const sc=({running:'#58a6ff',streaming:'#a5b4fc',completed:'#3fb950',failed:'#f85149',pending:'#d29922'})[t.status]||'#8b949e';
  el('modalTitle').textContent=(t.prompt||'(no prompt)').slice(0,80);
  el('modalMeta').innerHTML=
    '<span style="font-size:9px;padding:1px 6px;border-radius:3px;background:'+sc+'22;color:'+sc+';border:1px solid '+sc+'44">'+escHtml(t.status)+'</span>'+
    '<span style="color:'+agentColor(t.assigned_to||'')+'">'+escHtml(t.assigned_to||'unassigned')+'</span>'+
    (t.mode&&t.mode!=='task'?'<span style="color:#484f58;font-size:10px">'+escHtml(t.mode)+'</span>':'')+
    '<span style="color:#30363d;font-size:10px">'+escHtml((t.id||'').slice(0,16))+'</span>'+
    (t.created_at?'<span style="color:#30363d;font-size:10px">'+timeAgo(t.created_at)+'</span>':'');
  el('modalBody').textContent=t.prompt||'(no prompt)';
  const stream=t.response||t.error||'';
  if(stream){el('modalStream').style.display='block';el('modalStream').textContent=stream.slice(-500);}
  else{el('modalStream').style.display='none';}
  el('taskModal').style.display='flex';
}
function closeModal(){el('taskModal').style.display='none';}

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

// ── Tasks polling ─────────────────────────────────────
// C: Per-agent quality metrics (computed from allTasks)
const AGENT_STATS={}; // agentId → {total,completed,failed,running,lastActive}

async function pollTasks(){
  try{
    const d=await(await fetch(API+'/api/tasks?limit=80')).json();
    allTasks=(d.tasks||[]);
    // Sync running/completed status into in-memory tasks list
    allTasks.forEach(t=>{
      const existing=tasks.find(x=>x.id===t.id);
      if(existing){ existing.status=t.status; if(t.response)existing.output=t.response.slice(0,300); }
      // Populate CLI→Agent links from spawned_by_cli field
      // spawned_by_cli may be agentId (e.g. 'claude-1') or sessionId (e.g. '335070')
      if(t.spawned_by_cli&&t.assigned_to){
        const sess=meshSessions[t.spawned_by_cli]
          ||Object.values(meshSessions).find(s=>s.agentId===t.spawned_by_cli);
        const cliId=sess?sess.agentId:t.spawned_by_cli;
        addCliTaskLink(cliId,t.assigned_to,t.id,t.prompt||'',t.status);
      }
    });
    // C: Compute per-agent stats
    Object.keys(AGENT_STATS).forEach(k=>delete AGENT_STATS[k]);
    allTasks.forEach(t=>{
      const a=t.assigned_to||t.provider;
      if(!a)return;
      if(!AGENT_STATS[a])AGENT_STATS[a]={total:0,completed:0,failed:0,running:0,lastActive:0};
      AGENT_STATS[a].total++;
      if(t.status==='completed')AGENT_STATS[a].completed++;
      else if(t.status==='failed')AGENT_STATS[a].failed++;
      else if(t.status==='running'||t.status==='assigned')AGENT_STATS[a].running++;
      if(t.updated_at){const ts=new Date(t.updated_at).getTime();if(ts>AGENT_STATS[a].lastActive)AGENT_STATS[a].lastActive=ts;}
    });
    if(activeTab==='sessions')renderTab();
    detectAnomalies();
  }catch(err){
    console.warn('[NCO Monitor] pollTasks failed',err);
  }
}

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
    el('apiDot').className='dot on';
  }catch(err){
    console.warn('[NCO Monitor] pollMesh failed',err);
    el('apiDot').className='dot off';
  }
}

/** Load recent mesh messages into COMM_MATRIX on init (so graph is populated immediately) */
async function loadRecentMessages(){
  try{
    const d=await(await fetch(API+'/api/mesh/messages?limit=50')).json();
    const msgs=d.messages||[];
    // Resolve session IDs to agent IDs using current meshSessions
    msgs.reverse().forEach(m=>{
      const fromAgent=m.from_agent||meshSessions[m.from_session]?.agentId||m.from_session||'?';
      const toRaw=m.to_session||'*';
      const toAgent=toRaw==='*'?'*':(meshSessions[toRaw]?.agentId||toRaw);
      const msgType=m.type||'info';
      const createdAt=new Date(m.created_at||Date.now()).getTime();
      // Only load messages from last 10 minutes
      if(Date.now()-createdAt<600000){
        addCommEdge(fromAgent,toAgent,m.content||'',msgType);
      }
    });
  }catch{}
}

// ── Init ──────────────────────────────────────────────
// ── F2: Session Comparison ─────────────────────────────
function toggleSessionSel(sid){
  const i=_selSessions.indexOf(sid);
  if(i>=0)_selSessions.splice(i,1);
  else if(_selSessions.length<2)_selSessions.push(sid);
  renderTab();
}
async function toggleDiscDetail(sid){
  const el=document.getElementById('disc-detail-'+sid);
  if(!el)return;
  if(el.style.display!=='none'){el.style.display='none';return;}
  el.innerHTML='<span style="color:#8b949e">로딩 중...</span>';
  el.style.display='block';
  try{
    const res=await fetch(API+'/api/discussions/'+encodeURIComponent(sid)+'/messages');
    const raw=await res.json();
    const msgs=Array.isArray(raw)?raw:(raw.messages||[]);
    if(!msgs.length){el.innerHTML='<span style="color:#484f58">메시지 없음</span>';return;}
    el.innerHTML=msgs.map(m=>{
      const from=m.agent_id||m.agentId||m.from||'?';
      const round=m.round!=null?'R'+m.round:'';
      const ct=(m.content||m.response||'').slice(0,500);
      const time=m.created_at?new Date(m.created_at).toLocaleTimeString('ko',{hour12:false}):'';
      return '<div style="border-left:2px solid '+agentColor(from)+';padding:4px 8px;margin:4px 0;font-size:11px">'+
        '<div style="display:flex;gap:6px;margin-bottom:2px">'+
          '<span style="color:'+agentColor(from)+';font-weight:bold">'+escHtml(from)+'</span>'+
          (round?'<span class="cmp-badge info" style="font-size:9px">'+round+'</span>':'')+
          '<span style="color:#484f58;margin-left:auto">'+time+'</span>'+
        '</div>'+
        '<div style="color:#c9d1d9;white-space:pre-wrap;word-break:break-word">'+escHtml(ct)+'</div>'+
      '</div>';
    }).join('');
  }catch(e){el.innerHTML='<span style="color:#f85149">로딩 실패: '+escHtml(String(e))+'</span>';}
}
async function fetchAndCompare(){
  if(_selSessions.length!==2){showToast('정확히 2개 세션을 선택하세요','warn');return;}
  const [id1,id2]=_selSessions;
  try{
    const [r1,r2]=await Promise.all([
      fetch(API+'/api/discussions/'+encodeURIComponent(id1)+'/messages').then(r=>r.json()),
      fetch(API+'/api/discussions/'+encodeURIComponent(id2)+'/messages').then(r=>r.json()),
    ]);
    const m1=discussions.find(d=>d.sessionId===id1)||{sessionId:id1};
    const m2=discussions.find(d=>d.sessionId===id2)||{sessionId:id2};
    _compData={s1:{meta:m1,msgs:r1.messages||[]},s2:{meta:m2,msgs:r2.messages||[]}};
    _compView=true;
    renderTab();
  }catch(e){showToast('세션 데이터 로드 실패','err');}
}
function exitCompare(){_compView=false;_compData=null;_selSessions=[];renderTab();}
function compareHtml(){
  if(!_compData)return '';
  const {s1,s2}=_compData;
  const cr1=Math.round((s1.meta?.consensusRate||0)*100);
  const cr2=Math.round((s2.meta?.consensusRate||0)*100);
  const crDiff=Math.abs(cr1-cr2);
  const ptColors=['#58a6ff','#3fb950','#a5b4fc','#d29922','#f85149','#79c0ff','#d2a8ff'];
  function ptColor(name,list){const i=list.indexOf(name);return ptColors[i>=0?i%ptColors.length:0];}
  function fmtTs(ts){if(!ts)return '';const d=new Date(ts);return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');}
  function panelHtml(sd,label){
    const pts=sd.meta?.participants||[];
    const cr=Math.round((sd.meta?.consensusRate||0)*100);
    const crCls=cr>=70?'ok':cr>=40?'warn':'info';
    return '<div class="cmp-panel">'+
      '<div class="cmp-ph">'+escHtml(label)+'</div>'+
      '<div class="cmp-topic">'+escHtml((sd.meta?.topic||sd.meta?.sessionId||'?').slice(0,80))+'</div>'+
      '<div class="cmp-meta">'+
        '<span class="cmp-badge info">'+escHtml(sd.meta?.mode||'?')+'</span>'+
        '<span class="cmp-badge '+crCls+'">합의 '+cr+'%</span>'+
        '<span class="cmp-badge info">라운드 '+(sd.meta?.currentRound||0)+'</span>'+
        pts.map(p=>'<span class="cmp-badge info" style="color:'+ptColor(p,pts)+'">'+escHtml(p)+'</span>').join('')+
      '</div>'+
      '<div class="cmp-msgs">'+
        (sd.msgs.length
          ?sd.msgs.slice(0,40).map(m=>{
            const pt=m.provider||m.participant||m.from||'?';
            const pc=ptColor(pt,pts);
            return '<div class="cmp-msg" style="border-left:2px solid '+pc+'22;padding-left:6px">'+
              '<div class="cmp-msg-hdr"><span class="cmp-msg-who" style="color:'+pc+'">'+escHtml(pt)+'</span>'+
              '<span class="cmp-msg-time">'+fmtTs(m.timestamp||m.created_at)+'</span></div>'+
              '<div class="cmp-msg-body">'+escHtml((m.content||m.message||'').slice(0,200))+'</div>'+
            '</div>';
          }).join('')
          :'<div style="color:#484f58;font-size:10px;padding:8px">메시지 없음</div>')+
      '</div>'+
    '</div>';
  }
  return '<div class="cmp-bar">'+
    '<span style="color:#8b949e;font-size:10px;font-weight:700">세션 비교</span>'+
    (crDiff>0?'<span class="cmp-diff">합의율 차이 '+crDiff+'%</span>':'')+
    '<button class="cmp-reset" onclick="exitCompare()">✕ 비교 종료</button>'+
  '</div>'+
  '<div class="cmp-container">'+panelHtml(s1,'Session A')+panelHtml(s2,'Session B')+'</div>';
}
function showToast(msg,type){
  const d=document.createElement('div');
  d.textContent=msg;
  d.style.cssText='position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:'+(type==='err'?'#f85149':type==='warn'?'#d29922':'#1f6feb')+';color:#fff;padding:8px 16px;border-radius:6px;font-size:11px;z-index:300;pointer-events:none;opacity:0;transition:opacity .2s';
  document.body.appendChild(d);
  requestAnimationFrame(()=>{d.style.opacity='1';setTimeout(()=>{d.style.opacity='0';setTimeout(()=>d.remove(),250);},2500);});
}
function detectAnomalies(){
  const now=Date.now();
  const alerts=[];
  // 1. 실패율 급증
  Object.keys(AGENT_STATS).forEach(id=>{
    const s=AGENT_STATS[id]||{}; const tot=s.total||0; const fail=s.failed||0;
    if(tot>=10&&fail/tot>=0.5) alerts.push({id:'spike-'+id,type:'spike',sev:'warning',msg:id+': 실패율 '+Math.round(fail/tot*100)+'% ('+fail+'/'+tot+')'});
  });
  // 2. 태스크 정체
  allTasks.forEach(t=>{
    if(t.status!=='running'&&t.status!=='streaming')return;
    const ts=new Date(t.updated_at).getTime(); if(!Number.isFinite(ts))return;
    if(now-ts>300000) alerts.push({id:'stall-'+t.id,type:'stall',sev:'critical',msg:'태스크 정체: '+(t.provider||t.assigned_to||'?')+' — '+Math.round((now-ts)/60000)+'분'});
  });
  // 3. Zombie 에이전트
  Object.values(meshSessions).forEach(s=>{
    const hb=Number(s.lastHeartbeat); if(!Number.isFinite(hb))return;
    if(now-hb>120000) alerts.push({id:'zombie-'+(s.sessionId||s.agentId),type:'zombie',sev:'critical',msg:'Zombie: '+(s.agentId||s.sessionId)+' ('+Math.round((now-hb)/60000)+'분 무응답)'});
  });
  // 4. 큐 정체
  const stuckQ=allTasks.filter(t=>{if(t.status!=='queued')return false;const ts=new Date(t.created_at).getTime();return Number.isFinite(ts)&&now-ts>600000;});
  if(stuckQ.length>=3) alerts.push({id:'queue-backup',type:'queue',sev:'warning',msg:'큐 정체: '+stuckQ.length+'개 10분+ 대기'});
  // 5. 오류 폭풍
  const recFails=allTasks.filter(t=>{if(t.status!=='failed')return false;const ts=new Date(t.updated_at).getTime();return Number.isFinite(ts)&&now-ts<60000;});
  const stormMap={}; recFails.forEach(t=>{const p=t.provider||t.assigned_to||'?';stormMap[p]=(stormMap[p]||0)+1;});
  Object.entries(stormMap).filter(([,c])=>c>=3).forEach(([p,c])=>alerts.push({id:'storm-'+p,type:'storm',sev:'critical',msg:'오류폭풍: '+p+' — 60초 내 '+c+'회 실패'}));
  // 6. 파일 충돌 — 두 CLI 세션이 같은 파일 수정 중
  const sessList=Object.values(meshSessions);
  for(let i=0;i<sessList.length;i++){
    for(let j=i+1;j<sessList.length;j++){
      const fa=sessList[i].currentFiles||[];
      const fb=sessList[j].currentFiles||[];
      const shared=fa.filter(f=>fb.includes(f));
      if(!shared.length)continue;
      const aA=sessList[i].agentId||sessList[i].sessionId;
      const aB=sessList[j].agentId||sessList[j].sessionId;
      const conflictId='file-conflict-'+[aA,aB].sort().join('::');
      alerts.push({id:conflictId,type:'conflict',sev:'critical',agentId:aA,msg:'파일 충돌: '+aA+' ↔ '+aB+' — '+shared.map(f=>f.split('/').pop()).slice(0,2).join(', ')+(shared.length>2?' +'+( shared.length-2)+'개':'')});
    }
  }
  ANOMALY_ALERTS=alerts.filter(a=>!_dismissedAlerts.has(a.id));
  renderAnomalyPanel();
}
function renderAnomalyPanel(){
  const panel=document.getElementById('alert-panel'); if(!panel)return;
  if(!ANOMALY_ALERTS.length){panel.innerHTML='';return;}
  const SEV_ICON={critical:'⚠',warning:'◆'};
  // XSS-safe: use data-alert-id + event delegation (no inline onclick)
  panel.innerHTML=ANOMALY_ALERTS.map(a=>
    '<div class="alert-card '+a.sev+'" data-alert-id="'+encodeURIComponent(a.id)+'" title="클릭하여 닫기">'+
    '<div class="alert-dot '+a.sev+'"></div>'+
    '<div><div style="font-weight:700;font-size:10px">'+(SEV_ICON[a.sev]||'!')+' '+a.type.toUpperCase()+'</div><div>'+escHtml(a.msg)+'</div></div>'+
    '</div>').join('');
  panel.querySelectorAll('.alert-card[data-alert-id]').forEach(card=>{
    card.addEventListener('click',()=>{
      _dismissedAlerts.add(decodeURIComponent(card.dataset.alertId||''));
      // Limit Set size to prevent unbounded growth
      if(_dismissedAlerts.size>500){const it=_dismissedAlerts.values();_dismissedAlerts.delete(it.next().value);}
      renderAnomalyPanel();
    },{once:true});
  });
}
async function init(){
  // Restore tab + filter
  const savedTab=localStorage.getItem('nco-active-tab');
  switchTab(savedTab||'overview');
  // Apply saved event filter button state
  document.querySelectorAll('.ef-btn').forEach(b=>{
    b.classList.toggle('active',b.dataset.ef===evtFilter);
  });

  try{
    const d=await(await fetch(API+'/api/daemons')).json();
    (d.daemons||[]).forEach(a=>{
      agents[a.id]={id:a.id,status:a.status,role:a.role,score:a.score,type:a.type||'cli',currentTask:a.currentTask,health:a.health};
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
  await loadRecentMessages();
  await pollTasks();
  render();
  connect();

  async function checkHealth(){
    try{
      const h=await(await fetch(API+'/health')).json();
      el('apiDot').className='dot on'; el('apiText').textContent='API healthy';
      const redis=h.runtime&&h.runtime.redis;
      el('redisStatus').textContent=(redis?'⬡ redis':'⬡ no-redis');
      el('redisStatus').style.color=(redis?'#3fb950':'#f85149');
      const up=h.runtime&&h.runtime.uptime;
      if(up!=null){const m=Math.floor(up/60);el('uptime').textContent='↑ '+(m<60?m+'m':Math.floor(m/60)+'h '+m%60+'m');el('uptime').style.color='#484f58';}
      const online=h.runtime&&h.runtime.agentsOnline||0;
      el('onlineCount').textContent=online+'/'+(h.providerCount||9);
      el('onlineCount').className='badge '+(online>0?'ok':'err');
    }
    catch{ el('apiDot').className='dot off'; el('apiText').textContent='API offline'; }
    detectAnomalies();
  }
  // Store interval handles so they can be cleared on WS close / page unload
  const _healthTimer=setInterval(checkHealth,10000);
  const _meshTimer=setInterval(pollMesh,15000);
  const _taskTimer=setInterval(pollTasks,10000);
  const _heartbeatTimer=setInterval(()=>{ renderMeshNodes(); if(activeTab==='mesh'||activeTab==='sessions'||activeTab==='overview')renderTab(); }, 10000);

  // Animation loops via requestAnimationFrame — aligned to vsync, skips hidden tabs
  let _lastTopoRender=0, _lastGraphRender=0;
  let _rafActive=true;
  window.addEventListener('beforeunload',()=>{_rafActive=false;});
  function _topoRafLoop(ts){
    if(!_rafActive)return;
    if(!document.hidden && ts-_lastTopoRender>=800){
      renderTopology(); _lastTopoRender=ts;
    }
    requestAnimationFrame(_topoRafLoop);
  }
  requestAnimationFrame(_topoRafLoop);
  function _graphRafLoop(ts){
    if(!_rafActive)return;
    if(!document.hidden && _graphOpen && ts-_lastGraphRender>=1000){
      renderMeshGraph(); _lastGraphRender=ts;
    }
    requestAnimationFrame(_graphRafLoop);
  }
  requestAnimationFrame(_graphRafLoop);

  // Pause polling when tab is hidden, resume on visibility
  document.addEventListener('visibilitychange',()=>{
    if(!document.hidden){ pollMesh(); pollTasks(); checkHealth(); }
  });

  // ── Keyboard Shortcuts ────────────────────────────────
  const TAB_KEYS={'1':'overview','2':'mesh','3':'sessions','4':'messages','5':'tasks','6':'flow'};
  document.addEventListener('keydown',e=>{
    if(e.target.tagName==='INPUT'||e.target.tagName==='SELECT'||e.target.tagName==='TEXTAREA')return;
    if(e.metaKey||e.ctrlKey||e.altKey)return;
    const k=e.key;
    // Escape: close modal + clear topology selection
    if(k==='Escape'){
      const modal=document.getElementById('nco-modal');
      if(modal){modal.remove();return;}
      if(_topoSelected){_topoSelected=null;return;}
      if(focusAgent){clearFocus();return;}
      return;
    }
    // 1-6: switch tabs
    if(TAB_KEYS[k]){switchTab(TAB_KEYS[k]);e.preventDefault();return;}
    // g/G: toggle mesh graph
    if(k==='g'||k==='G'){toggleGraphSection();return;}
    // f/F: clear event focus
    if(k==='f'||k==='F'){clearFocus();return;}
    // l/L: toggle event log
    if(k==='l'||k==='L'){toggleEventLog();return;}
    // ?: keyboard help overlay
    if(k==='?'){
      if(document.getElementById('kb-help'))return;
      const d=document.createElement('div');
      d.id='kb-help';
      d.style.cssText='position:fixed;inset:0;background:#000b;z-index:500;display:flex;align-items:center;justify-content:center';
      d.innerHTML='<div style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:18px 24px;min-width:300px;font-size:11px;line-height:2">'+
        '<div style="font-size:13px;font-weight:700;color:#58a6ff;margin-bottom:10px">⌨ 키보드 단축키</div>'+
        '<div style="display:grid;grid-template-columns:80px 1fr;gap:2px 12px;color:#8b949e">'+
        '<b style="color:#e3b341">1-6</b><span>탭 전환 (Mesh/Sessions/Messages/Discussions/Tasks/Flow)</span>'+
        '<b style="color:#e3b341">Esc</b><span>모달 닫기 / 포커스 해제 / 툴팁 닫기</span>'+
        '<b style="color:#e3b341">G</b><span>Mesh 그래프 토글</span>'+
        '<b style="color:#e3b341">F</b><span>이벤트 포커스 해제</span>'+
        '<b style="color:#e3b341">L</b><span>이벤트 로그 패널 토글</span>'+
        '<b style="color:#e3b341">?</b><span>이 도움말 표시</span>'+
        '</div>'+
        '<div style="margin-top:12px;color:#484f58;font-size:10px">클릭하거나 Esc로 닫기</div>'+
      '</div>';
      d.onclick=()=>d.remove();
      document.addEventListener('keydown',function esc(e2){if(e2.key==='Escape'){d.remove();document.removeEventListener('keydown',esc);}},{once:true});
      document.body.appendChild(d);
      return;
    }
  });

  await checkHealth();
  detectAnomalies();
}

init();
</script>
</body>
</html>`;
}
