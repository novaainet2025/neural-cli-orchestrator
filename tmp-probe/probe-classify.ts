import Database from 'better-sqlite3';
import { classifyFailedCompletionReason, classifyDeclaredPrerequisiteBlock } from '../src/server/gateway.js';
const db = new Database('db/nco.db', { readonly: true });
const row = db.prepare("select prompt, response from tasks where id='task_opcJbXioZ_RdGex8'").get() as any;
console.log('reason         =', classifyFailedCompletionReason(row.response, { prompt: row.prompt }));
console.log('reason(report) =', classifyFailedCompletionReason(row.response, { prompt: row.prompt, reportMode: true }));
console.log('prereqBlock    =', classifyDeclaredPrerequisiteBlock(row.response, { prompt: row.prompt }));
