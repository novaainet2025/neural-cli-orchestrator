'use strict';

const { execFileSync } = require('node:child_process');
const { appendFileSync, mkdirSync } = require('node:fs');
const { homedir } = require('node:os');
const { dirname, join } = require('node:path');

const READ_ONLY_COMMANDS = new Set([
  'describe',
  'env',
  'help',
  'jlist',
  'list',
  'logs',
  'ls',
  'monit',
  'ping',
  'prettylist',
  'report',
  'show',
  'status',
  'version',
]);
const READ_ONLY_FLAGS = new Set(['-h', '--help', '-v', '--version']);
const AI_PROCESS_PATTERN = /(?:^|[\/\s])(codex|claude|opencode|cursor-agent|copilot|aider|hermes(?:-nco)?|ollama|openclaw|agy|gemini)(?:$|[\/\s])/i;
const DEFAULT_AUDIT_LOG = join(homedir(), '.claude', '.pm2-audit', 'pm2-audit.log');

function isReadOnlyInvocation(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return true;
  if (argv.some(arg => READ_ONLY_FLAGS.has(arg))) return true;

  const command = argv.find(arg => typeof arg === 'string' && arg.length > 0 && !arg.startsWith('-'));
  return command ? READ_ONLY_COMMANDS.has(command.toLowerCase()) : false;
}

function hasAiAncestor(chain) {
  return chain.some(entry => AI_PROCESS_PATTERN.test(entry.command || ''));
}

function readAncestorChain(startPid = process.ppid, maxDepth = 10) {
  const chain = [];
  let pid = Number(startPid);

  for (let depth = 0; Number.isInteger(pid) && pid > 1 && depth < maxDepth; depth += 1) {
    let output;
    try {
      output = execFileSync('/bin/ps', ['-o', 'pid=,ppid=,command=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      break;
    }
    if (!output) break;

    const match = output.match(/^\s*(\d+)\s+(\d+)\s+([\s\S]+)$/);
    if (!match) break;
    const entry = {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3],
    };
    chain.push(entry);
    pid = entry.ppid;
  }
  return chain;
}

function evaluateInvocation(argv, chain) {
  if (isReadOnlyInvocation(argv)) {
    return { allowed: true, reason: 'read_only' };
  }
  if (!hasAiAncestor(chain)) {
    return { allowed: true, reason: 'human_owned_terminal' };
  }
  return {
    allowed: false,
    reason: 'ai_caller_pm2_mutation',
    exitCode: 77,
  };
}

function appendAudit(argv, chain, decision, auditLog = process.env.PM2_AUDIT_LOG || DEFAULT_AUDIT_LOG) {
  try {
    mkdirSync(dirname(auditLog), { recursive: true });
    const lines = [
      `=== ${new Date().toISOString()} ===`,
      `  argv   : pm2 ${argv.join(' ')}`,
      `  cwd    : ${process.cwd()}`,
      `  pid/ppid: ${process.pid} / ${process.ppid}`,
      '  ancestor chain:',
      ...chain.map((entry, index) => `    [${index}] ${entry.pid} ${entry.ppid} ${entry.command.slice(0, 180)}`),
      `  decision: ${decision.allowed ? 'ALLOW' : 'DENY'} (${decision.reason})`,
      '',
    ];
    appendFileSync(auditLog, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // The guard decision must not depend on audit I/O availability.
  }
}

function enforce(argv = process.argv.slice(2)) {
  const chain = readAncestorChain();
  const decision = evaluateInvocation(argv, chain);
  if (decision.allowed) return decision;

  appendAudit(argv, chain, decision);
  process.stderr.write('pm2 mutation denied: AI callers cannot control the process supervisor; use a human-owned terminal\n');
  process.exit(decision.exitCode);
}

module.exports = {
  READ_ONLY_COMMANDS,
  evaluateInvocation,
  enforce,
  hasAiAncestor,
  isReadOnlyInvocation,
  readAncestorChain,
};
