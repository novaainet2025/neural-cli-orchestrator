#!/bin/bash
set -e
cd /Users/nova-ai/project/nco

echo "=== CMD 1 ==="
sqlite3 /Users/nova-ai/project/nco/db/nco.db "SELECT id, status, length(response), substr(response,1,200) as response_start, substr(response,-200) as response_end FROM tasks WHERE id='task_FIeI336uBZOo2b42';"

echo "=== CMD 2 ==="
wc -c /Users/nova-ai/project/nco/data/team-runner/team_research-visualization-2026-07-30.md

echo "=== CMD 3 ==="
node -e "
const fs=require('fs');
const {spawnSync}=require('child_process');
const file=fs.readFileSync('/Users/nova-ai/project/nco/data/team-runner/team_research-visualization-2026-07-30.md','utf8');
const r=spawnSync('sqlite3',['-json','/Users/nova-ai/project/nco/db/nco.db','SELECT response FROM tasks WHERE id=\"task_FIeI336uBZOo2b42\"'],{encoding:'utf8'});
const resp=JSON.parse(r.stdout)[0].response;
console.log('fileLen',file.length,'respLen',resp.length);
console.log('endsWith',file.endsWith(resp));
console.log('fileEnd',JSON.stringify(file.slice(-100)));
console.log('respEnd',JSON.stringify(resp.slice(-100)));
console.log('fileStart',JSON.stringify(file.slice(0,100)));
console.log('respStart',JSON.stringify(resp.slice(0,100)));
"
