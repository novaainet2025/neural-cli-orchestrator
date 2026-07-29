/**
 * provider.ts — 프로바이더 추가/삭제 CLI
 *
 * 배경: 2026-07-29 nvidia 퇴출은 config·src·DB·마이그레이션·인덱스·훅·vault 에
 * 흩어진 참조를 손으로 41개 파일에서 걷어내야 했다. 이 스크립트는 그 절차를
 * 한 명령으로 만든다. 라우팅 코드는 provider-registry 를 경유하므로 여기서
 * 다루는 건 "레지스트리 바깥의 산출물"뿐이다.
 *
 *   npm run provider:list
 *   npm run provider:add -- <id> --role Reasoner --type api --caps reasoning,analysis
 *   npm run provider:remove -- <id>            # dry-run (기본)
 *   npm run provider:remove -- <id> --apply    # 실제 적용
 *
 * remove 가 건드리는 것:
 *   config/ai-providers.json          프로바이더 항목 삭제
 *   config/ai-providers.local.json    머신 오버레이 삭제
 *   config/failover-chains.json       자기 체인 + 타 체인 내 등장 삭제
 *   db/migrations/NNN_retire_<id>.sql 팀 lead/멤버/조직 manager 재배정 생성
 *   db/hnsw-indices/<id>.hnsw         에이전트 벡터 인덱스 삭제
 *
 * remove 가 일부러 건드리지 않는 것 (판단이 필요해 사람 몫으로 남긴다):
 *   .env 의 API 키               — 다른 용도로 쓰일 수 있다
 *   과거 실행기록(tasks/work_events 등) — 그때 무엇이 돌았는지의 증거
 *   문서·보고서 본문             — 기록 개작은 별도 결정 사항
 * 이 항목들은 실행 후 후속 작업으로 출력한다.
 */
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const P = {
  providers: resolve(ROOT, 'config/ai-providers.json'),
  local: resolve(ROOT, 'config/ai-providers.local.json'),
  failover: resolve(ROOT, 'config/failover-chains.json'),
  migrations: resolve(ROOT, 'db/migrations'),
  indices: resolve(ROOT, 'db/hnsw-indices'),
};

interface Provider { id: string; name: string; [key: string]: unknown }
interface ProvidersFile { version: number; updated: string; providers: Provider[] }

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf-8')) as T;
const writeJson = (path: string, value: unknown): void =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');

/** 변경 계획 한 줄. dry-run 에서는 출력만 하고 apply 에서는 실행한다. */
interface Change { what: string; run: () => void }

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function loadProvidersFile(): ProvidersFile {
  return readJson<ProvidersFile>(P.providers);
}

function nextMigrationNumber(): string {
  const numbers = readdirSync(P.migrations)
    .filter((file) => file.endsWith('.sql'))
    .map((file) => Number.parseInt(file.slice(0, 3), 10))
    .filter((value) => Number.isFinite(value));
  return String(Math.max(0, ...numbers) + 1).padStart(3, '0');
}

/**
 * 퇴출 마이그레이션 본문.
 *
 * 팀 lead 재배정을 데이터 기반으로 하는 이유: 086 계약상 teams.lead 는 반드시
 * 그 팀의 team_members 중 하나여야 한다. 고정값으로 바꾸면 그 계약이 깨진다.
 * 멤버 삭제보다 먼저 lead 를 옮겨야 후보가 남아 있다.
 */
function retireMigrationSql(id: string): string {
  return `-- ${nextMigrationNumber()}_retire_${id.replace(/-/g, '_')}_provider.sql
-- ${id} 프로바이더 퇴출 (scripts/provider.ts 생성, ${today()})
--
-- 설정/토폴로지 행만 정리한다. 과거 실행기록(tasks, work_events, agent_actions,
-- agent_invocations 등)은 "그때 무엇이 돌았는가"의 증거이자 team-scorer 의
-- 입력이므로 건드리지 않는다.

-- 1) 팀 lead 재배정 — team_members 삭제보다 먼저. lead 는 그 팀의 멤버여야 한다.
UPDATE teams
   SET lead = COALESCE(
         (SELECT tm.member_ref
            FROM team_members tm
           WHERE tm.team_id = teams.id
             AND tm.member_type = 'provider'
             AND tm.member_ref <> '${id}'
           ORDER BY tm.rowid
           LIMIT 1),
         'opencode')
 WHERE lead = '${id}';

UPDATE required_capabilities
   SET lead = COALESCE((SELECT t.lead FROM teams t WHERE t.id = required_capabilities.id), 'opencode')
 WHERE lead = '${id}';

-- 2) 조직 manager 재배정. 헌정 5개 회사의 manager 는 서로 달라야 하므로
--    nco-government 만 따로 잡는다(086 계약).
UPDATE organizations          SET manager = 'hermes'   WHERE manager = '${id}' AND slug = 'nco-government';
UPDATE organizations          SET manager = 'opencode' WHERE manager = '${id}';
UPDATE required_organizations SET manager = 'hermes'   WHERE manager = '${id}' AND slug = 'nco-government';
UPDATE required_organizations SET manager = 'opencode' WHERE manager = '${id}';

-- 3) 팀 소속 해제
DELETE FROM team_members WHERE member_type = 'provider' AND member_ref = '${id}';

-- 4) 정부 공직 재임명
UPDATE nova_civil_servants SET nco_agent_id = 'hermes' WHERE nco_agent_id = '${id}';

-- 5) 동적 스킬 파이프라인 단계 교체
UPDATE dynamic_skills
   SET pipeline   = replace(pipeline, '"${id}"', '"opencode"'),
       updated_at = datetime('now')
 WHERE pipeline LIKE '%"${id}"%';

-- 6) 런타임 상태 및 등록 제거
DELETE FROM circuit_states   WHERE agent_id = '${id}';
DELETE FROM rate_limit_state WHERE agent_id = '${id}';
DELETE FROM agents           WHERE id = '${id}';
`;
}

function planRemove(id: string): Change[] {
  const changes: Change[] = [];

  const file = loadProvidersFile();
  if (!file.providers.some((provider) => provider.id === id)) {
    throw new Error(`provider '${id}' is not registered in config/ai-providers.json`);
  }
  changes.push({
    what: `config/ai-providers.json — '${id}' 항목 삭제`,
    run: () => {
      const current = loadProvidersFile();
      current.providers = current.providers.filter((provider) => provider.id !== id);
      current.updated = today();
      writeJson(P.providers, current);
    },
  });

  if (existsSync(P.local)) {
    const local = readJson<{ overrides?: Record<string, unknown> }>(P.local);
    if (local.overrides && id in local.overrides) {
      changes.push({
        what: `config/ai-providers.local.json — overrides.${id} 삭제`,
        run: () => {
          const current = readJson<{ overrides?: Record<string, unknown> }>(P.local);
          delete current.overrides?.[id];
          writeJson(P.local, current);
        },
      });
    }
  }

  if (existsSync(P.failover)) {
    const chains = readJson<Record<string, string[]>>(P.failover);
    const mentions = Object.entries(chains).filter(
      ([key, chain]) => key === id || chain.includes(id),
    );
    if (mentions.length > 0) {
      changes.push({
        what: `config/failover-chains.json — 자기 체인 + 타 체인 ${mentions.length}곳에서 제거`,
        run: () => {
          const current = readJson<Record<string, string[]>>(P.failover);
          delete current[id];
          for (const key of Object.keys(current)) {
            current[key] = current[key].filter((entry) => entry !== id);
          }
          writeJson(P.failover, current);
        },
      });
    }
  }

  const migrationName = `${nextMigrationNumber()}_retire_${id.replace(/-/g, '_')}_provider.sql`;
  changes.push({
    what: `db/migrations/${migrationName} — 팀/조직 재배정 마이그레이션 생성`,
    run: () => writeFileSync(resolve(P.migrations, migrationName), retireMigrationSql(id), 'utf-8'),
  });

  const indexPath = resolve(P.indices, `${id}.hnsw`);
  if (existsSync(indexPath)) {
    changes.push({
      what: `db/hnsw-indices/${id}.hnsw — 에이전트 벡터 인덱스 삭제`,
      run: () => unlinkSync(indexPath),
    });
  }

  return changes;
}

function planAdd(id: string, options: Record<string, string>): Change[] {
  const file = loadProvidersFile();
  if (file.providers.some((provider) => provider.id === id)) {
    throw new Error(`provider '${id}' already exists in config/ai-providers.json`);
  }
  const capabilities = (options.caps ?? 'code,analysis').split(',').map((entry) => entry.trim());
  const entry: Provider = {
    id,
    name: options.name ?? id,
    enabled: false, // 키·명령 확인 전에는 꺼둔 채로 등록한다
    type: options.type ?? 'cli',
    role: options.role ?? 'Worker',
    score: Number(options.score ?? 70),
    model: options.model ?? null,
    command: options.command ?? null,
    args: [],
    env: {},
    concurrency: Number(options.concurrency ?? 2),
    rateLimitRpm: Number(options.rpm ?? 20),
    cost: options.cost ?? 'free',
    capabilities,
    permissions: {
      canInitiateCollaboration: true,
      canDelegateToOthers: false,
      canSupervise: false,
      canFinalApprove: false,
    },
    persona: {
      systemPrompt: `You are the ${options.role ?? 'Worker'} of the NCO AI team.`,
      tone: 'concise',
      style: 'practical',
    },
    healthCheck: { type: options.type === 'api' ? 'api' : 'command', timeout: 5000 },
  };
  return [{
    what: `config/ai-providers.json — '${id}' 항목 추가 (enabled=false, capabilities=${capabilities.join('/')})`,
    run: () => {
      const current = loadProvidersFile();
      current.providers.push(entry);
      current.updated = today();
      writeJson(P.providers, current);
    },
  }];
}

function main(): void {
  const [command, id, ...rest] = process.argv.slice(2);
  const apply = rest.includes('--apply');
  const options: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token.startsWith('--') && token !== '--apply') {
      options[token.slice(2)] = rest[index + 1] ?? '';
    }
  }

  if (command === 'list') {
    for (const provider of loadProvidersFile().providers) {
      const state = provider.enabled ? 'enabled ' : 'disabled';
      console.log(`  ${state}  ${provider.id.padEnd(16)} ${String(provider.role ?? '')}`);
    }
    return;
  }

  if (!id || (command !== 'add' && command !== 'remove')) {
    console.log('usage: provider.ts <list|add|remove> [id] [--apply] [--role R --type cli|api --caps a,b]');
    process.exitCode = 2;
    return;
  }

  const changes = command === 'add' ? planAdd(id, options) : planRemove(id);
  console.log(`\n${command} '${id}' — ${changes.length} change(s)${apply ? '' : '  [dry-run]'}\n`);
  for (const change of changes) {
    console.log(`  ${apply ? '✓' : '·'} ${change.what}`);
    if (apply) change.run();
  }

  if (!apply) {
    console.log('\n  --apply 를 붙이면 실제로 반영된다.');
    return;
  }

  console.log('\n다음은 자동으로 하지 않는다 (판단이 필요):');
  if (command === 'remove') {
    console.log(`  · 생성된 마이그레이션을 라이브 DB 에 적용: sqlite3 db/nco.db < db/migrations/<file>`);
    console.log(`  · .env 의 API 키 정리 (다른 용도로 쓰일 수 있음)`);
    console.log(`  · 문서·보고서 본문의 '${id}' 언급 (기록 개작은 별도 결정)`);
    console.log(`  · Obsidian vault 의 01-AGENTS/${id}.md`);
  } else {
    console.log(`  · config 에서 enabled=true 로 전환 (명령/키 확인 후)`);
    console.log(`  · .env 에 API 키 추가 (type=api 인 경우)`);
  }
  console.log('\n라우팅(tier·capability·decomposer·ensemble 등)은 provider-registry 가');
  console.log('config 를 읽어 자동 반영하므로 코드 수정은 필요 없다.\n');
}

main();
