import { readFileSync } from 'fs';
const team = 'team_tech-port-02-safety-license';
const file = process.argv[2];
const data = JSON.parse(readFileSync(file, 'utf8'));
const report = (data.reports || []).find(
  (r) => r.subjectId === team || r.teamId === team,
);
console.log(JSON.stringify(report, null, 2));
