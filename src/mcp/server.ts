/**
 * NCO MCP Server — 26 tools for Claude Code integration
 * Wraps NCO API (localhost:6200) as MCP tools
 */

const NCO_API = process.env.NCO_API_URL || 'http://localhost:6200';
const TIMEOUT = 30_000;

async function ncoFetch(path: string, options?: RequestInit): Promise<any> {
  const url = `${NCO_API}${path}`;
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT) });
    return res.json();
  } catch {
    return { error: `NCO offline or unreachable: ${url}` };
  }
}

async function ncoPost(path: string, body: any): Promise<any> {
  return ncoFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ─── Tool Definitions ─────────────────────────────────
const TOOLS = [
  // Collaboration (6)
  { name: 'nco_task', description: 'Delegate task to a single AI agent', params: ['ai', 'prompt'] },
  { name: 'nco_parallel', description: 'Run task on multiple AIs in parallel', params: ['prompt', 'providers'] },
  { name: 'nco_discussion', description: 'Start multi-AI discussion', params: ['prompt', 'providers', 'maxRounds'] },
  { name: 'nco_consensus', description: 'AI consensus mode with voting', params: ['prompt', 'providers'] },
  { name: 'nco_hive', description: 'Hive mode — all 9 AIs as one', params: ['prompt'] },
  { name: 'nco_conductor', description: 'Smart auto-dispatch — analyzes complexity and picks best mode+AI', params: ['prompt'] },
  { name: 'nco_commander', description: 'Commander 4-Layer — Management→Information→Execution→Quality hierarchy', params: ['prompt'] },
  { name: 'nco_broadcast', description: 'Broadcast message to all AIs', params: ['message'] },
  // Status (6)
  { name: 'nco_status', description: 'System health check', params: [] },
  { name: 'nco_providers', description: 'List AI providers', params: [] },
  { name: 'nco_daemons', description: 'Daemon status', params: [] },
  { name: 'nco_health', description: 'Detailed health', params: [] },
  { name: 'nco_rate_limits', description: 'Rate limit status', params: [] },
  { name: 'nco_queue_metrics', description: 'Queue metrics', params: [] },
  // Sessions (3)
  { name: 'nco_list_sessions', description: 'List discussion sessions', params: [] },
  { name: 'nco_get_session', description: 'Get session details', params: ['sessionId'] },
  { name: 'nco_session_messages', description: 'Get session messages', params: ['sessionId'] },
  // Tasks (2)
  { name: 'nco_get_task', description: 'Get task status', params: ['taskId'] },
  { name: 'nco_list_tasks', description: 'List all tasks', params: [] },
  // System (3)
  { name: 'nco_start', description: 'Start NCO system', params: [] },
  { name: 'nco_stop', description: 'Stop NCO system', params: [] },
  { name: 'nco_verify', description: 'Verify NCO config', params: [] },
  // Agent (6)
  { name: 'nco_agent_start', description: 'Start autonomous agent', params: ['prompt', 'provider'] },
  { name: 'nco_agent_status', description: 'Agent session status', params: ['sessionId'] },
  { name: 'nco_agent_abort', description: 'Abort agent session', params: ['sessionId'] },
  { name: 'nco_agent_approve', description: 'Approve agent action', params: ['sessionId'] },
  { name: 'nco_agent_reject', description: 'Reject agent action', params: ['sessionId'] },
  { name: 'nco_agent_sessions', description: 'List agent sessions', params: [] },
  // Mesh (3)
  { name: 'nco_mesh_sessions', description: 'List active CLI sessions in mesh', params: [] },
  { name: 'nco_mesh_summary', description: 'Get work summary of all active CLIs', params: [] },
  { name: 'nco_mesh_send', description: 'Send message to CLI sessions', params: ['content', 'toSessionId'] },
  // Harness (1)
  { name: 'nco_harness', description: '자율 실행 하네스 — 요구사항을 100%까지 자동 반복 실행 (gap분석→계획→Commander→검증→품질점수 95점+ 루프)', params: ['requirement', 'maxIterations', 'scoreThreshold'] },
  // Natural Language (1)
  { name: 'nco_natural', description: 'Parse natural language to intent and execute appropriate tool', params: ['query', 'context'] },
  // Invocations (2)
  { name: 'nco_my_invocations', description: '내가 호출한 에이전트들의 현재 상태 조회', params: [] },
  { name: 'nco_invocations', description: '전체 에이전트 호출 현황 조회', params: ['limit'] },
  // ── Hermes/OpenClaw 이식 기능 ─────────────────────────
  // Web Search (Hermes)
  { name: 'nco_web_search', description: 'DuckDuckGo 웹 검색 — query, limit(default 10), lang', params: ['query', 'limit', 'lang'] },
  // Code Execution (Hermes)
  { name: 'nco_code_execute', description: '샌드박스 코드 실행 (bash/node/python) — language, code, stdin, timeoutMs', params: ['language', 'code', 'stdin', 'timeoutMs'] },
  // File Tools (Hermes)
  { name: 'nco_file_read', description: '파일 읽기 (라인 범위 지원) — path, startLine, endLine', params: ['path', 'startLine', 'endLine'] },
  { name: 'nco_file_write', description: '파일 쓰기/추가 — path, content, append', params: ['path', 'content', 'append'] },
  // Messaging (Hermes/OpenClaw)
  { name: 'nco_slack_send', description: 'Slack 메시지 전송 — webhookUrl, text, blocks', params: ['webhookUrl', 'text', 'blocks'] },
  { name: 'nco_telegram_send', description: 'Telegram 메시지 전송 — botToken, chatId, text, parseMode', params: ['botToken', 'chatId', 'text', 'parseMode'] },
  // Cron Scheduler (Hermes/OpenClaw)
  { name: 'nco_cron_list', description: '등록된 크론 작업 목록 조회', params: [] },
  { name: 'nco_cron_create', description: '크론 작업 생성 — schedule(크론식), description, taskType(nco_task|shell|webhook), payload(JSON), timezone', params: ['schedule', 'description', 'taskType', 'payload', 'timezone'] },
  { name: 'nco_cron_delete', description: '크론 작업 삭제 — id', params: ['id'] },
  { name: 'nco_cron_toggle', description: '크론 작업 활성화/비활성화 — id', params: ['id'] },
  // Webhook Manager (Hermes/OpenClaw)
  { name: 'nco_webhook_list', description: '등록된 웹훅 목록 조회', params: [] },
  { name: 'nco_webhook_register', description: '웹훅 등록 — path, method(POST), actionType(nco_task|forward|log), actionPayload(JSON), secret, description', params: ['path', 'method', 'actionType', 'actionPayload', 'description', 'secret'] },
  { name: 'nco_webhook_delete', description: '웹훅 삭제 — id', params: ['id'] },
  // Browser Tools (OpenClaw/Playwright)
  { name: 'nco_browser_navigate', description: 'Playwright 브라우저 페이지 탐색 — url, waitUntil(domcontentloaded), timeoutMs', params: ['url', 'waitUntil', 'timeoutMs'] },
  { name: 'nco_browser_screenshot', description: 'Playwright 스크린샷 캡처(base64 PNG) — url, fullPage(true), timeoutMs', params: ['url', 'fullPage', 'timeoutMs'] },
  { name: 'nco_browser_scrape', description: 'Playwright 웹 스크래핑 — url, selector(CSS), timeoutMs', params: ['url', 'selector', 'timeoutMs'] },
  { name: 'nco_browser_form', description: 'Playwright 폼 자동 작성/제출 — url, actions([{type,selector,value}]), submitSelector, returnContent', params: ['url', 'actions', 'submitSelector', 'timeoutMs', 'returnContent'] },
  { name: 'nco_browser_pdf', description: 'Playwright PDF 생성(base64) — url, timeoutMs', params: ['url', 'timeoutMs'] },
  // Extended Messaging
  { name: 'nco_discord_send', description: 'Discord 웹훅 메시지 전송 — webhookUrl(또는 DISCORD_WEBHOOK_URL env), content, username, embeds', params: ['webhookUrl', 'content', 'username', 'embeds'] },
  { name: 'nco_email_send', description: '이메일 전송(nodemailer) — to, subject, text, html, smtpUrl(또는 SMTP_URL env)', params: ['to', 'subject', 'text', 'html', 'from', 'smtpUrl'] },
  { name: 'nco_notify', description: '멀티채널 일괄 알림 — message, channels([slack,telegram,discord])', params: ['message', 'channels', 'slackUrl', 'telegramToken', 'telegramChatId', 'discordUrl'] },
  // File Tools
  { name: 'nco_file_list', description: '디렉터리 파일 목록 조회 — path, pattern(regex), recursive', params: ['path', 'pattern', 'recursive'] },
  // Backup / Checkpoint
  { name: 'nco_backup_create', description: 'SQLite+.env 백업 생성(tar.gz) — description', params: ['description'] },
  { name: 'nco_backup_list', description: '백업 목록 조회', params: [] },
  // Skills (동적 파이프라인)
  { name: 'nco_skill_list', description: '등록된 스킬 목록 조회', params: [] },
  { name: 'nco_skill_create', description: '스킬 생성 — name, description, triggerKeywords([]), pipeline([{step,agentId,promptTemplate}])', params: ['name', 'description', 'triggerKeywords', 'pipeline'] },
  { name: 'nco_skill_execute', description: '스킬 실행 — id, prompt, context', params: ['id', 'prompt', 'context'] },
  // Plugins
  { name: 'nco_plugin_list', description: '플러그인 목록 조회', params: [] },
  { name: 'nco_plugin_create', description: 'JS 플러그인 등록 — name, code, exports([])', params: ['name', 'code', 'exports', 'description'] },
  { name: 'nco_plugin_call', description: '플러그인 함수 호출(vm sandbox) — id, fn, args([])', params: ['id', 'fn', 'args'] },
  // Notion
  { name: 'nco_notion_create', description: 'Notion 페이지 생성 — databaseId, title, content', params: ['databaseId', 'title', 'content', 'properties'] },
  { name: 'nco_notion_query', description: 'Notion DB 쿼리 — databaseId, filter, pageSize', params: ['databaseId', 'filter', 'pageSize'] },
  // IMAP
  { name: 'nco_email_receive', description: 'IMAP 이메일 수신 — imapUrl(또는 IMAP_URL env), mailbox, limit, unseen', params: ['imapUrl', 'mailbox', 'limit', 'unseen'] },
];

// ─── Tool Handler ─────────────────────────────────────
async function handleTool(name: string, args: any): Promise<string> {
  switch (name) {
    // Collaboration
    case 'nco_task': {
      const _sid = process.env.NCO_SESSION_ID || String(process.ppid || process.pid);
      const _aid = process.env.NCO_NAME || 'claude-code';
      return JSON.stringify(await ncoPost('/api/task', { ai: args.ai, prompt: args.prompt, callerSessionId: _sid, callerAgentId: _aid }));
    }
    case 'nco_parallel': return JSON.stringify(await ncoPost('/api/realtime/parallel', { prompt: args.prompt, providers: args.providers }));
    case 'nco_discussion': return JSON.stringify(await ncoPost('/api/realtime/discussion', { prompt: args.prompt, providers: args.providers, maxRounds: args.maxRounds }));
    case 'nco_consensus': return JSON.stringify(await ncoPost('/api/realtime/consensus', { prompt: args.prompt, providers: args.providers }));
    case 'nco_hive': return JSON.stringify(await ncoPost('/api/realtime/discussion', { prompt: args.prompt, mode: 'hive' }));
    case 'nco_conductor': return JSON.stringify(await ncoPost('/api/conductor', { prompt: args.prompt }));
    case 'nco_commander': return JSON.stringify(await ncoPost('/api/commander', { prompt: args.prompt }));
    case 'nco_broadcast': return JSON.stringify(await ncoPost('/api/chat/messages', { message: args.message, broadcast: true }));
    // Status
    case 'nco_status': return JSON.stringify(await ncoFetch('/health'));
    case 'nco_providers': return JSON.stringify(await ncoFetch('/api/ai-providers'));
    case 'nco_daemons': return JSON.stringify(await ncoFetch('/api/daemons'));
    case 'nco_health': return JSON.stringify(await ncoFetch('/api/health'));
    case 'nco_rate_limits': return JSON.stringify(await ncoFetch('/api/rate-limits/state'));
    case 'nco_queue_metrics': return JSON.stringify(await ncoFetch('/api/queue/metrics'));
    // Sessions
    case 'nco_list_sessions': return JSON.stringify(await ncoFetch('/api/realtime-sessions'));
    case 'nco_get_session': return JSON.stringify(await ncoFetch(`/api/discussions/${args.sessionId}`));
    case 'nco_session_messages': return JSON.stringify(await ncoFetch(`/api/discussions/${args.sessionId}/messages`));
    // Tasks
    case 'nco_get_task': return JSON.stringify(await ncoFetch(`/api/tasks/${args.taskId}`));
    case 'nco_list_tasks': return JSON.stringify(await ncoFetch('/api/tasks'));
    // System
    case 'nco_start': return JSON.stringify(await ncoPost('/api/daemons/start-all', {}));
    case 'nco_stop': return JSON.stringify(await ncoPost('/api/daemons/stop-all', {}));
    case 'nco_verify': return JSON.stringify(await ncoFetch('/health'));
    // Agent
    case 'nco_agent_start': return JSON.stringify(await ncoPost('/api/agent/start', { prompt: args.prompt, provider: args.provider }));
    case 'nco_agent_status': return JSON.stringify(await ncoFetch(`/api/agent/${args.sessionId}/status`));
    case 'nco_agent_abort': return JSON.stringify(await ncoPost(`/api/agent/${args.sessionId}/abort`, {}));
    case 'nco_agent_approve': return JSON.stringify(await ncoPost(`/api/agent/${args.sessionId}/approve`, {}));
    case 'nco_agent_reject': return JSON.stringify(await ncoPost(`/api/agent/${args.sessionId}/reject`, {}));
    case 'nco_agent_sessions': return JSON.stringify(await ncoFetch('/api/agent/sessions'));
    // Mesh
    case 'nco_mesh_sessions': return JSON.stringify(await ncoFetch('/api/mesh/sessions'));
    case 'nco_mesh_summary': return JSON.stringify(await ncoFetch('/api/mesh/summary'));
case 'nco_mesh_send': {
      const mySessionId = process.env.NCO_SESSION_ID || String(process.ppid || process.pid);
      const myName = process.env.NCO_NAME || 'claude-code';
      return JSON.stringify(await ncoPost('/api/mesh/send', { fromSessionId: mySessionId, fromAgent: myName, toSessionId: args.toSessionId || '*', content: args.content }));
    }
    // Harness
    case 'nco_harness': return JSON.stringify(await ncoPost('/api/harness', {
      requirement: args.requirement,
      maxIterations: args.maxIterations ? Number(args.maxIterations) : undefined,
      scoreThreshold: args.scoreThreshold ? Number(args.scoreThreshold) : undefined,
    }));
    // Natural Language
    case 'nco_natural': return JSON.stringify(await ncoPost('/api/nlp/intent', { query: args.query, context: args.context }));
    // Invocations
    case 'nco_my_invocations': {
      const sessionId = process.env.NCO_SESSION_ID || String(process.ppid || process.pid);
      return JSON.stringify(await ncoFetch(`/api/invocations/session/${encodeURIComponent(sessionId)}`));
    }
    case 'nco_invocations': {
      const limit = args.limit ? `?limit=${encodeURIComponent(args.limit)}` : '';
      return JSON.stringify(await ncoFetch(`/api/invocations/overview${limit}`));
    }
    // ── Hermes/OpenClaw 이식 기능 ───────────────────────
    case 'nco_web_search':
      return JSON.stringify(await ncoPost('/api/tools/web-search', {
        query: args.query, limit: args.limit ? Number(args.limit) : 10, lang: args.lang,
      }));
    case 'nco_code_execute':
      return JSON.stringify(await ncoPost('/api/tools/code-execute', {
        language: args.language, code: args.code, stdin: args.stdin,
        timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : 10000,
      }));
    case 'nco_file_read':
      return JSON.stringify(await ncoPost('/api/tools/file-read', {
        path: args.path,
        startLine: args.startLine ? Number(args.startLine) : undefined,
        endLine: args.endLine ? Number(args.endLine) : undefined,
      }));
    case 'nco_file_write':
      return JSON.stringify(await ncoPost('/api/tools/file-write', {
        path: args.path, content: args.content,
        append: args.append === 'true' || args.append === true,
      }));
    case 'nco_slack_send':
      return JSON.stringify(await ncoPost('/api/tools/slack-send', {
        webhookUrl: args.webhookUrl, text: args.text,
        blocks: args.blocks ? JSON.parse(args.blocks) : undefined,
      }));
    case 'nco_telegram_send':
      return JSON.stringify(await ncoPost('/api/tools/telegram-send', {
        botToken: args.botToken, chatId: args.chatId,
        text: args.text, parseMode: args.parseMode || 'Markdown',
      }));
    case 'nco_cron_list':
      return JSON.stringify(await ncoFetch('/api/cron'));
    case 'nco_cron_create':
      return JSON.stringify(await ncoPost('/api/cron', {
        schedule: args.schedule, description: args.description,
        taskType: args.taskType || 'nco_task',
        payload: args.payload ? JSON.parse(args.payload) : {},
        timezone: args.timezone || 'UTC',
      }));
    case 'nco_cron_delete':
      return JSON.stringify(await ncoFetch(`/api/cron/${encodeURIComponent(args.id)}`, { method: 'DELETE' }));
    case 'nco_cron_toggle':
      return JSON.stringify(await ncoFetch(`/api/cron/${encodeURIComponent(args.id)}/toggle`, { method: 'PUT' }));
    case 'nco_webhook_list':
      return JSON.stringify(await ncoFetch('/api/webhook/routes'));
    case 'nco_webhook_register':
      return JSON.stringify(await ncoPost('/api/webhook/routes', {
        path: args.path, method: args.method || 'POST',
        actionType: args.actionType || 'log',
        actionPayload: args.actionPayload ? JSON.parse(args.actionPayload) : {},
        description: args.description, secret: args.secret,
      }));
    case 'nco_webhook_delete':
      return JSON.stringify(await ncoFetch(`/api/webhook/routes/${encodeURIComponent(args.id)}`, { method: 'DELETE' }));
    case 'nco_browser_navigate':
      return JSON.stringify(await ncoPost('/api/tools/browser-navigate', {
        url: args.url, waitUntil: args.waitUntil || 'domcontentloaded',
        timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : 30000,
      }));
    case 'nco_browser_screenshot':
      return JSON.stringify(await ncoPost('/api/tools/browser-screenshot', {
        url: args.url, fullPage: args.fullPage !== 'false',
        timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : 30000,
      }));
    case 'nco_browser_scrape':
      return JSON.stringify(await ncoPost('/api/tools/browser-scrape', {
        url: args.url, selector: args.selector,
        timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : 30000,
      }));
    case 'nco_browser_form':
      return JSON.stringify(await ncoPost('/api/tools/browser-form', {
        url: args.url,
        actions: typeof args.actions === 'string' ? JSON.parse(args.actions) : (args.actions || []),
        submitSelector: args.submitSelector,
        timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : 30000,
        returnContent: args.returnContent === 'true' || args.returnContent === true,
      }));
    case 'nco_browser_pdf':
      return JSON.stringify(await ncoPost('/api/tools/browser-pdf', {
        url: args.url, timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : 30000,
      }));
    case 'nco_discord_send':
      return JSON.stringify(await ncoPost('/api/tools/discord-send', {
        webhookUrl: args.webhookUrl, content: args.content,
        username: args.username,
        embeds: typeof args.embeds === 'string' ? JSON.parse(args.embeds) : args.embeds,
      }));
    case 'nco_email_send':
      return JSON.stringify(await ncoPost('/api/tools/email-send', {
        to: args.to, subject: args.subject, text: args.text,
        html: args.html, from: args.from, smtpUrl: args.smtpUrl,
      }));
    case 'nco_notify':
      return JSON.stringify(await ncoPost('/api/tools/notify', {
        message: args.message,
        channels: typeof args.channels === 'string' ? JSON.parse(args.channels) : (args.channels || []),
        slackUrl: args.slackUrl, telegramToken: args.telegramToken,
        telegramChatId: args.telegramChatId, discordUrl: args.discordUrl,
      }));
    case 'nco_file_list':
      return JSON.stringify(await ncoPost('/api/tools/file-list', {
        path: args.path, pattern: args.pattern,
        recursive: args.recursive === 'true' || args.recursive === true,
      }));
    case 'nco_backup_create':
      return JSON.stringify(await ncoPost('/api/backup/create', { description: args.description }));
    case 'nco_backup_list':
      return JSON.stringify(await ncoFetch('/api/backup'));
    case 'nco_skill_list':
      return JSON.stringify(await ncoFetch('/api/skills'));
    case 'nco_skill_create':
      return JSON.stringify(await ncoPost('/api/skills', {
        name: args.name, description: args.description,
        triggerKeywords: typeof args.triggerKeywords === 'string' ? JSON.parse(args.triggerKeywords) : (args.triggerKeywords || []),
        pipeline: typeof args.pipeline === 'string' ? JSON.parse(args.pipeline) : (args.pipeline || []),
      }));
    case 'nco_skill_execute':
      return JSON.stringify(await ncoPost(`/api/skills/${args.id}/execute`, { prompt: args.prompt, context: args.context }));
    case 'nco_plugin_list':
      return JSON.stringify(await ncoFetch('/api/plugins'));
    case 'nco_plugin_create':
      return JSON.stringify(await ncoPost('/api/plugins', {
        name: args.name, code: args.code, description: args.description,
        exports: typeof args.exports === 'string' ? JSON.parse(args.exports) : (args.exports || []),
      }));
    case 'nco_plugin_call':
      return JSON.stringify(await ncoPost(`/api/plugins/${args.id}/call`, {
        fn: args.fn,
        args: typeof args.args === 'string' ? JSON.parse(args.args) : (args.args || []),
      }));
    case 'nco_notion_create':
      return JSON.stringify(await ncoPost('/api/tools/notion-create-page', {
        databaseId: args.databaseId, title: args.title, content: args.content,
        properties: typeof args.properties === 'string' ? JSON.parse(args.properties) : (args.properties || {}),
      }));
    case 'nco_notion_query':
      return JSON.stringify(await ncoPost('/api/tools/notion-query', {
        databaseId: args.databaseId,
        filter: typeof args.filter === 'string' ? JSON.parse(args.filter) : args.filter,
        pageSize: args.pageSize ? Number(args.pageSize) : 10,
      }));
    case 'nco_email_receive':
      return JSON.stringify(await ncoPost('/api/tools/email-receive', {
        imapUrl: args.imapUrl, mailbox: args.mailbox || 'INBOX',
        limit: args.limit ? Number(args.limit) : 10,
        unseen: args.unseen === 'true' || args.unseen === true,
      }));
    default: return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// ─── Stdio MCP Protocol ──────────────────────────────
// Simple JSON-RPC over stdin/stdout
import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin });

function send(msg: any) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

rl.on('line', async (line) => {
  try {
    const req = JSON.parse(line);

    if (req.method === 'initialize') {
      send({ jsonrpc: '2.0', id: req.id, result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'nco-mcp-server', version: '1.0.0' },
      }});
    } else if (req.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: req.id, result: {
        tools: TOOLS.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: {
            type: 'object',
            properties: Object.fromEntries(t.params.map(p => [p, { type: 'string' }])),
          },
        })),
      }});
    } else if (req.method === 'tools/call') {
      const result = await handleTool(req.params.name, req.params.arguments || {});
      send({ jsonrpc: '2.0', id: req.id, result: {
        content: [{ type: 'text', text: result }],
      }});
    } else if (req.method === 'notifications/initialized') {
      // No response needed
    } else {
      send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `Unknown method: ${req.method}` }});
    }
  } catch (err: any) {
    // Ignore parse errors on notification lines
  }
});
