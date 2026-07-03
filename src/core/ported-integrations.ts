/**
 * ported-integrations.ts — 오픈소스 스웜 패턴 이식분의 라이브 싱글턴 배선.
 *
 * delegation-payload(협업19)는 gateway.ts /api/task 인테이크에 직접 배선됨.
 * context-budget(P2-13)/recursive-decomposer(P2-11)/evidence-gate(P1-6)는
 * gateway.ts에서 함수로 직접 호출.
 * 이 파일은 상태를 가진 서브시스템 3종을 라이브 싱글턴으로 노출한다:
 *   - fleet-gateway(협업16): 노드 상태기계 + 라우팅 제외
 *   - hive-relay(협업17): 세션 릴레이 + 지식 증류
 *   - pa-inbox(협업15): 영속 inbox (SQLite, lazy 초기화)
 */
import { getDb } from '../storage/database.js';
import { createFleetGateway } from './fleet-gateway.js';
import { createHiveRelay } from './hive-relay.js';
import { createPaInbox, type PaInbox } from './pa-inbox.js';
import { createPaLifecycle } from './pa-lifecycle.js';

/** 협업16 — fleet 노드 게이트웨이 (인메모리, 부팅 시 생성 안전) */
export const fleetGateway = createFleetGateway();

/** 협업17 — Hive Relay. 초대코드는 env(NCO_HIVE_INVITE_CODES), 기본 'nco-fleet' */
export const hiveRelay = createHiveRelay({
  inviteCodes: (process.env.NCO_HIVE_INVITE_CODES ?? 'nco-fleet')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
});

/** 협업15 — PA inbox. SQLite 테이블을 만들므로 첫 사용 시점에 lazy 초기화(부팅 트립 방지) */
let _paInbox: PaInbox | null = null;
export function getPaInbox(): PaInbox {
  if (!_paInbox) {
    _paInbox = createPaInbox(getDb(), { now: () => Date.now() });
  }
  return _paInbox;
}

/**
 * P2-10 — PA 수명주기 비용 노브. 기본 sticky(반복 위임 cold-start 절감).
 * brain 계열(유료·고지능)은 always-on 성향, on-demand는 필요 시 setMode로.
 */
export const paLifecycle = createPaLifecycle({
  defaultMode: 'sticky',
  modes: { 'claude-code': 'always-on' },
});
