/**
 * inter-session 라우트 — NCO에서 Claude Code 세션 간 메시지 전달
 *
 * INTER_SESSION_PPID_OVERRIDE 메커니즘을 사용하여
 * client.py 데몬 없이 send.py를 직접 호출한다.
 *
 * GET  /api/inter-session/list         — 연결된 세션 목록
 * GET  /api/inter-session/status       — NCO 세션 키 상태
 * POST /api/inter-session/send         — 특정 세션에 메시지 전송
 * POST /api/inter-session/broadcast    — 모든 세션에 브로드캐스트
 */

import type { FastifyInstance } from 'fastify';
import { execFile } from 'child_process';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('inter-session');

const BIN = '/Users/nova-ai/.claude/plugins/cache/inter-session/inter-session/0.1.2/skills/inter-session/bin';
const SESSIONS_DIR = join(homedir(), '.claude', 'data', 'inter-session', 'clients');

/** 프로세스 PID가 살아있는지 확인 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** ~/.claude/data/inter-session/clients/*.session 파일에서 활성 세션 목록 조회 */
async function listSessions(onlyAlive = true): Promise<Array<{ name: string; key: string; since?: string }>> {
  const result: Array<{ name: string; key: string; since?: string }> = [];
  try {
    const files = await readdir(SESSIONS_DIR);
    for (const file of files) {
      if (!file.endsWith('.session')) continue;
      try {
        const key = file.replace('.session', '');
        const pid = parseInt(key, 10);
        if (onlyAlive && !isPidAlive(pid)) continue; // stale 세션 제외
        const raw = await readFile(join(SESSIONS_DIR, file), 'utf-8');
        const data = JSON.parse(raw);
        if (data.name) {
          result.push({ name: data.name, key, since: data.connected_at });
        }
      } catch { /* skip */ }
    }
  } catch { /* no sessions dir */ }
  return result;
}

/** 이름으로 활성 세션 키 조회 */
async function findSessionKey(name: string): Promise<string | null> {
  const sessions = await listSessions(true);
  return sessions.find(s => s.name === name)?.key ?? null;
}

/** python3 send.py 실행 (PPID_OVERRIDE 주입) */
function runSendPy(args: string[], ppidKey: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'python3',
      [join(BIN, 'send.py'), ...args],
      {
        env: { ...process.env, INTER_SESSION_PPID_OVERRIDE: ppidKey },
        timeout: 10_000,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message));
        } else {
          resolve(stdout.trim());
        }
      },
    );
  });
}

export async function registerInterSessionRoutes(app: FastifyInstance) {

  // ─── GET /api/inter-session/list ─────────────────────────────────────────
  app.get('/api/inter-session/list', async (_req, reply) => {
    const sessions = await listSessions();
    return reply.send({ sessions, count: sessions.length });
  });

  // ─── GET /api/inter-session/status ───────────────────────────────────────
  app.get('/api/inter-session/status', async (_req, reply) => {
    const key = await findSessionKey('nco-server');
    if (!key) {
      return reply.send({ connected: false, message: 'nco-server 세션 없음. /inter-session connect nco-server 실행 필요' });
    }
    return reply.send({ connected: true, name: 'nco-server', key, bin: BIN });
  });

  // ─── 발신 dedup 가드 (2026-07-02 감사: 671건 중 고유 273종 — 평균 2.5배 중복) ──
  // (호스트, 내용지문) 단위로 6시간 내 동일 발신을 차단한다. 세션이 아니라 "호스트"
  // 기준: kangnote-claude-1/2/3은 같은 기계이므로 1회면 충분. force:true로 우회 가능.
  const sentLog = new Map<string, number>(); // key: host|fingerprint → sentAt
  const DEDUP_WINDOW_MS = 6 * 60 * 60_000;
  const DEDUP_MAX_ENTRIES = 2000;
  function dedupKey(to: string, text: string): string {
    const host = to.replace(/-claude-\d+(-\d+)?$/, ''); // kangnote-claude-2 → kangnote
    const fingerprint = text.replace(/\s+/g, ' ').trim().slice(0, 120);
    return `${host}|${fingerprint}`;
  }
  function checkDedup(to: string, text: string): number | null {
    const now = Date.now();
    if (sentLog.size > DEDUP_MAX_ENTRIES) {
      for (const [k, t] of sentLog) { if (now - t > DEDUP_WINDOW_MS) sentLog.delete(k); }
    }
    const key = dedupKey(to, text);
    const prev = sentLog.get(key);
    if (prev && now - prev < DEDUP_WINDOW_MS) return prev;
    sentLog.set(key, now);
    return null;
  }

  // ─── POST /api/inter-session/send ────────────────────────────────────────
  app.post<{
    Body: { to: string; text: string; fromSession?: string; force?: boolean };
  }>('/api/inter-session/send', async (req, reply) => {
    const { to, text, fromSession = 'nco-server', force = false } = req.body ?? {};
    if (!to || !text) {
      return reply.code(400).send({ error: '`to`와 `text` 필드 필수' });
    }
    if (!force) {
      const prevAt = checkDedup(to, text);
      if (prevAt !== null) {
        const ago = Math.round((Date.now() - prevAt) / 60_000);
        log.warn({ to, ago }, '[inter-session] duplicate send blocked');
        return reply.send({
          ok: false, deduped: true,
          message: `동일 내용을 같은 호스트에 ${ago}분 전 발신함 — 재발신하려면 force:true`,
        });
      }
    }

    // NCO 자신의 세션 키 조회 (없으면 speaker-mobile 등 다른 활성 세션 키 사용)
    let ppidKey = await findSessionKey(fromSession);
    if (!ppidKey) {
      const sessions = await listSessions();
      ppidKey = sessions[0]?.key ?? null;
    }
    if (!ppidKey) {
      return reply.code(503).send({ error: 'inter-session 연결된 세션 없음' });
    }

    try {
      // 장문 자동 분할 — 수신측 notification이 ~512B에서 잘리는 문제(2026-07-02
      // 실측: 원격들이 617B에서 절단 수신) 방지. 400B 단위로 [i/N] 접두 분할 전송.
      const CHUNK = 400;
      const bytes = Buffer.byteLength(text, 'utf-8');
      if (bytes > CHUNK + 100) {
        const parts: string[] = [];
        let buf = '';
        for (const word of text.split(/(\s+)/)) {
          if (Buffer.byteLength(buf + word, 'utf-8') > CHUNK && buf) { parts.push(buf); buf = word.trimStart(); }
          else buf += word;
        }
        if (buf.trim()) parts.push(buf);
        for (let i = 0; i < parts.length; i++) {
          await runSendPy(['--to', to, '--text', `[${i + 1}/${parts.length}] ${parts[i]}`], ppidKey);
        }
        log.info({ to, ppidKey, parts: parts.length }, '[inter-session] sent (chunked)');
        return reply.send({ ok: true, to, ppidKey, chunks: parts.length });
      }
      await runSendPy(['--to', to, '--text', text], ppidKey);
      log.info({ to, ppidKey }, '[inter-session] sent');
      return reply.send({ ok: true, to, ppidKey });
    } catch (err: any) {
      log.error({ err: err.message }, '[inter-session] send failed');
      return reply.code(500).send({ error: err.message });
    }
  });

  // ─── POST /api/inter-session/broadcast ───────────────────────────────────
  app.post<{
    Body: { text: string; fromSession?: string };
  }>('/api/inter-session/broadcast', async (req, reply) => {
    const { text, fromSession = 'nco-server' } = req.body ?? {};
    if (!text) {
      return reply.code(400).send({ error: '`text` 필드 필수' });
    }

    let ppidKey = await findSessionKey(fromSession);
    if (!ppidKey) {
      const sessions = await listSessions();
      ppidKey = sessions[0]?.key ?? null;
    }
    if (!ppidKey) {
      return reply.code(503).send({ error: 'inter-session 연결된 세션 없음' });
    }

    try {
      await runSendPy(['--all', '--text', text], ppidKey);
      log.info({ ppidKey }, '[inter-session] broadcast sent');
      return reply.send({ ok: true, ppidKey });
    } catch (err: any) {
      log.error({ err: err.message }, '[inter-session] broadcast failed');
      return reply.code(500).send({ error: err.message });
    }
  });
}
