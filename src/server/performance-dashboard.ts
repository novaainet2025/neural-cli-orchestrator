export function getPerformanceDashboardHTML(): string {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NCO 목표·성과 지휘 대시보드</title>
  <style>
    :root{color-scheme:dark;--bg:#071019;--panel:#101d29;--line:#263a4a;--text:#edf5f7;--muted:#9bb0ba;--cyan:#44d7c7;--amber:#ffbf69;--red:#ff6b6b;--blue:#6aa9ff}
    *{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top left,#123142 0,var(--bg) 42%);color:var(--text);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{width:min(1240px,calc(100% - 32px));margin:32px auto 64px}h1{font-size:clamp(24px,4vw,40px);line-height:1.15;margin:0 0 8px}h2{font-size:18px;margin:0 0 16px}.eyebrow{color:var(--cyan);font-weight:800;letter-spacing:.12em;text-transform:uppercase}.subtitle,.muted{color:var(--muted)}
    .toolbar,.panel,.card,.flow-step{background:rgba(16,29,41,.94);border:1px solid var(--line);border-radius:16px}.toolbar{display:flex;flex-wrap:wrap;gap:12px;padding:16px;margin:24px 0}.toolbar label{display:grid;gap:5px;color:var(--muted);font-size:12px}.toolbar select,.toolbar button{min-width:150px;border:1px solid var(--line);border-radius:9px;background:#091520;color:var(--text);padding:9px 11px}.toolbar button{min-width:auto;cursor:pointer;border-color:#2d8d87}.toolbar button:hover{background:#123b3b}
    .cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.card{padding:18px}.card strong{display:block;font-size:26px;margin-top:6px}.ok{color:var(--cyan)}.warn{color:var(--amber)}.bad{color:var(--red)}
    .flow{display:grid;grid-template-columns:1fr auto 1fr auto 1fr auto 1fr;align-items:center;gap:8px;margin:18px 0}.flow-step{padding:16px;min-height:94px}.flow-step b{display:block;margin-bottom:5px}.arrow{color:var(--cyan);font-size:22px}
    .grid{display:grid;grid-template-columns:minmax(0,2fr) minmax(280px,1fr);gap:16px}.panel{padding:18px;overflow:hidden}.chart-wrap{overflow-x:auto}svg{display:block;width:100%;min-width:560px;height:320px}.axis{stroke:#496273;stroke-width:1}.gridline{stroke:#1f3443;stroke-width:1}.goal-line{fill:none;stroke:var(--cyan);stroke-width:3}.task-line{fill:none;stroke:var(--amber);stroke-width:3;stroke-dasharray:8 5}.point-goal{fill:var(--cyan)}.point-task{fill:var(--amber)}.chart-label{fill:var(--muted);font-size:11px}.legend{display:flex;gap:18px;color:var(--muted);font-size:13px}.legend i{display:inline-block;width:18px;height:3px;margin:0 7px 3px 0}.legend .goal{background:var(--cyan)}.legend .task{background:var(--amber)}
    .audit-status{font-size:30px;font-weight:900;margin:6px 0}.audit-list{padding-left:20px;color:var(--muted)}.audit-list li{margin:7px 0}
    .table-wrap{overflow:auto;margin-top:16px}.table-wrap table{width:100%;border-collapse:collapse;min-width:760px}.table-wrap th,.table-wrap td{text-align:left;padding:10px;border-bottom:1px solid var(--line);white-space:nowrap}.table-wrap th{color:var(--muted);font-size:12px}.empty{padding:42px 12px;text-align:center;color:var(--muted)}
    @media(max-width:900px){.cards{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}.flow{grid-template-columns:1fr}.arrow{transform:rotate(90deg);text-align:center}}@media(max-width:520px){main{width:min(100% - 18px,1240px);margin-top:20px}.cards{grid-template-columns:1fr}.toolbar select{min-width:calc(50vw - 34px)}}
  </style>
</head>
<body>
<main>
  <div class="eyebrow">Supreme Commander Operations</div>
  <h1>NCO 목표·성과 지휘 대시보드</h1>
  <p class="subtitle">모든 활성 회사와 팀의 목표 → 실행 → 보고 → 총지휘 점검 흐름을 같은 근거에서 확인합니다.</p>

  <section class="toolbar" aria-label="성과 흐름 필터">
    <label>주기<select id="period"><option value="daily">매일</option><option value="weekly">매주</option><option value="monthly">매월</option></select></label>
    <label>대상 종류<select id="kind"><option value="">전체</option><option value="organization">회사</option><option value="team">팀</option></select></label>
    <label>대상<select id="subject"><option value="">전체</option></select></label>
    <button id="refresh" type="button">새로고침</button>
  </section>

  <section class="cards" aria-label="핵심 운영 지표">
    <article class="card"><span class="muted">목표 커버리지</span><strong id="goalCoverage">—</strong></article>
    <article class="card"><span class="muted">성과보고 커버리지</span><strong id="reportCoverage">—</strong></article>
    <article class="card"><span class="muted">태스크 성공률</span><strong id="successRate">—</strong></article>
    <article class="card"><span class="muted">최근 실패</span><strong id="failedTasks">—</strong></article>
  </section>

  <section class="flow" aria-label="운영 흐름">
    <div class="flow-step"><b>1. 목표</b><span id="flowGoal" class="muted">자동 목표를 확인 중</span></div><div class="arrow" aria-hidden="true">→</div>
    <div class="flow-step"><b>2. 실행</b><span id="flowExecution" class="muted">실제 태스크를 집계</span></div><div class="arrow" aria-hidden="true">→</div>
    <div class="flow-step"><b>3. 성과 보고</b><span id="flowReport" class="muted">근거와 개선 방향 기록</span></div><div class="arrow" aria-hidden="true">→</div>
    <div class="flow-step"><b>4. 총지휘 점검</b><span id="flowAudit" class="muted">예약·실패·누락 검사</span></div>
  </section>

  <section class="grid">
    <article class="panel">
      <h2>성과 흐름</h2>
      <div class="legend"><span><i class="goal"></i>목표 달성률</span><span><i class="task"></i>태스크 성공률</span></div>
      <div class="chart-wrap"><svg id="chart" viewBox="0 0 760 320" role="img" aria-labelledby="chartTitle chartDesc"><title id="chartTitle">주기별 성과 흐름</title><desc id="chartDesc">목표 달성률과 태스크 성공률을 백분율로 비교합니다.</desc></svg></div>
      <p id="historyNote" class="muted"></p>
    </article>
    <article class="panel">
      <h2>최종 지휘관 운영 점검</h2>
      <div id="auditStatus" class="audit-status">확인 중</div>
      <div id="auditTime" class="muted"></div>
      <ul id="auditEvidence" class="audit-list"></ul>
    </article>
  </section>

  <section class="panel" style="margin-top:16px">
    <h2>기간별 근거 표</h2>
    <div class="table-wrap"><table>
      <thead><tr><th>기간</th><th>대상 보고</th><th>목표 달성률</th><th>태스크 성공률</th><th>완료</th><th>실패</th><th>업무보고 제출률</th></tr></thead>
      <tbody id="rows"></tbody>
    </table></div>
    <p id="freshness" class="muted"></p>
  </section>
</main>
<script>
const $ = id => document.getElementById(id);
const pct = value => Number.isFinite(Number(value)) ? Number(value).toFixed(1) + '%' : '—';
const text = (id,value) => { $(id).textContent = value; };
let catalog = [];

function statusClass(el, value) {
  el.className = value === 'pass' ? 'audit-status ok' : value === 'fail' ? 'audit-status bad' : 'audit-status warn';
}
function svgNode(name, attrs, content) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', name);
  Object.entries(attrs || {}).forEach(([key,value]) => node.setAttribute(key,String(value)));
  if (content !== undefined) node.textContent = content;
  return node;
}
function drawChart(series) {
  const svg = $('chart'); while (svg.lastChild && !['title','desc'].includes(svg.lastChild.tagName)) svg.removeChild(svg.lastChild);
  const w=760,h=320,l=54,r=22,t=25,b=48,iw=w-l-r,ih=h-t-b;
  [0,25,50,75,100].forEach(v => {
    const y=t+ih-(v/100)*ih;
    svg.append(svgNode('line',{x1:l,y1:y,x2:w-r,y2:y,class:'gridline'}));
    svg.append(svgNode('text',{x:l-10,y:y+4,'text-anchor':'end',class:'chart-label'},v+'%'));
  });
  svg.append(svgNode('line',{x1:l,y1:t,x2:l,y2:h-b,class:'axis'}));
  svg.append(svgNode('line',{x1:l,y1:h-b,x2:w-r,y2:h-b,class:'axis'}));
  if (!series.length) {
    svg.append(svgNode('text',{x:w/2,y:h/2,'text-anchor':'middle',class:'chart-label'},'아직 생성된 기간 데이터가 없습니다.'));
    return;
  }
  const x=i => series.length===1 ? l+iw/2 : l+(i/(series.length-1))*iw;
  const y=v => t+ih-(Math.max(0,Math.min(100,Number(v)||0))/100)*ih;
  const points=field => series.map((d,i)=>x(i)+','+y(d[field])).join(' ');
  svg.append(svgNode('polyline',{points:points('goalAttainmentPct'),class:'goal-line'}));
  svg.append(svgNode('polyline',{points:points('taskSuccessRatePct'),class:'task-line'}));
  series.forEach((d,i)=>{
    svg.append(svgNode('circle',{cx:x(i),cy:y(d.goalAttainmentPct),r:4,class:'point-goal'}));
    svg.append(svgNode('circle',{cx:x(i),cy:y(d.taskSuccessRatePct),r:4,class:'point-task'}));
    svg.append(svgNode('text',{x:x(i),y:h-b+22,'text-anchor':'middle',class:'chart-label'},d.periodKey));
  });
}
function renderRows(series) {
  const body=$('rows'); body.replaceChildren();
  if (!series.length) {
    const td=document.createElement('td'); td.colSpan=7; td.className='empty'; td.textContent='데이터가 없습니다.';
    const tr=document.createElement('tr'); tr.append(td); body.append(tr); return;
  }
  series.slice().reverse().forEach(row=>{
    const tr=document.createElement('tr');
    [row.periodKey,row.subjectReports,pct(row.goalAttainmentPct),pct(row.taskSuccessRatePct),row.taskCompleted,row.failedTasks,pct(row.workReportSubmissionRatePct)].forEach(value=>{
      const td=document.createElement('td'); td.textContent=String(value ?? '—'); tr.append(td);
    }); body.append(tr);
  });
}
function renderCatalog(items) {
  catalog=items; const kind=$('kind').value; const selected=$('subject').value;
  $('subject').replaceChildren(new Option('전체',''));
  items.filter(x=>!kind||x.kind===kind).forEach(x=>$('subject').append(new Option(x.name+' · '+x.kind,x.id)));
  if ([...$('subject').options].some(o=>o.value===selected)) $('subject').value=selected;
}
async function load() {
  const query=new URLSearchParams({period:$('period').value,limit:'12'});
  if ($('kind').value) query.set('subjectKind',$('kind').value);
  if ($('subject').value) query.set('subjectId',$('subject').value);
  try {
    const [flowRes,auditRes]=await Promise.all([fetch('/api/performance-flow?'+query),fetch('/api/commander/operations?limit=12')]);
    if (!flowRes.ok||!auditRes.ok) throw new Error('API 응답 오류');
    const flow=await flowRes.json(), audit=await auditRes.json(), coverage=flow.currentCoverage||{}, latest=audit.latest;
    renderCatalog(flow.subjects||catalog); drawChart(flow.series||[]); renderRows(flow.series||[]);
    text('goalCoverage',pct(coverage.goalCoveragePct)); text('reportCoverage',pct(coverage.reportCoveragePct));
    const last=(flow.series||[]).at(-1)||{};
    text('successRate',pct(last.taskSuccessRatePct)); text('failedTasks',String(last.failedTasks??0));
    text('flowGoal',(coverage.goalsPresent??0)+' / '+(coverage.goalsExpected??0)+' 목표');
    text('flowExecution',(last.taskCompleted??0)+' 완료 · '+(last.failedTasks??0)+' 실패');
    text('flowReport',(coverage.reportsPresent??0)+' / '+(coverage.reportsExpected??0)+' 성과보고');
    text('flowAudit',latest ? latest.status.toUpperCase() : '점검 기록 없음');
    text('historyNote',(flow.series||[]).length<3?'자동 이력이 아직 짧습니다. 주기마다 누적되며, 표와 함께 실제 관측값만 표시합니다.':'최근 '+flow.series.length+'개 기간을 표시합니다.');
    text('freshness','생성 시각: '+(flow.generatedAt||'—')+' · 시간대: Asia/Seoul · 원천: tasks, team_goals, work_reports, performance_reports');
    const auditEl=$('auditStatus'), list=$('auditEvidence'); list.replaceChildren();
    if (latest) {
      auditEl.textContent=latest.status.toUpperCase(); statusClass(auditEl,latest.status);
      text('auditTime',latest.audit_time+' · '+latest.source);
      (latest.evidence||[]).slice(0,8).forEach(item=>{const li=document.createElement('li');li.textContent=item;list.append(li)});
    } else { auditEl.textContent='기록 없음'; statusClass(auditEl,'attention'); text('auditTime',''); }
  } catch(error) {
    text('auditStatus','불러오기 실패'); statusClass($('auditStatus'),'fail'); text('auditTime',error instanceof Error?error.message:String(error));
  }
}
$('kind').addEventListener('change',()=>{renderCatalog(catalog);$('subject').value='';load()});
$('period').addEventListener('change',load); $('subject').addEventListener('change',load); $('refresh').addEventListener('click',load);
load();
</script>
</body>
</html>`;
}
