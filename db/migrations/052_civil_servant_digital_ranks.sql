-- Nova Government v1.9 — 정부 에이전트 직위 명칭 디지털화
-- 산업혁명형 president/minister → 디지털 네이티브 architect_prime/domain_architect/field_guide
-- SQLite CHECK 제약 변경: 테이블 재생성 방식

PRAGMA foreign_keys = OFF;

-- 1) 기존 데이터 백업
CREATE TABLE IF NOT EXISTS nova_civil_servants_bak AS
  SELECT * FROM nova_civil_servants;

-- 2) 기존 테이블 삭제
DROP TABLE IF EXISTS nova_civil_servants;

-- 3) 새 테이블 생성 (rank CHECK 확장)
CREATE TABLE nova_civil_servants (
  did             TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  ministry        TEXT NOT NULL CHECK(ministry IN ('executive','technology','implementation','security','culture','research','justice')),
  title           TEXT NOT NULL,
  rank            TEXT NOT NULL DEFAULT 'field_guide'
                    CHECK(rank IN (
                      'architect_prime',
                      'domain_architect',
                      'field_guide',
                      'deputy',
                      'officer',
                      'president',
                      'minister'
                    )),
  status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','retired')),
  autonomy_level  INTEGER NOT NULL DEFAULT 3,
  nco_agent_id    TEXT,
  policy_focus    TEXT,
  last_action_at  INTEGER,
  appointed_at    INTEGER DEFAULT (strftime('%s','now')),
  created_at      INTEGER DEFAULT (strftime('%s','now'))
);

-- 4) 백업에서 복원 (rank 값 매핑)
INSERT INTO nova_civil_servants
  (did, name, ministry, title, rank, status, autonomy_level, nco_agent_id, policy_focus, last_action_at, appointed_at, created_at)
SELECT
  did, name, ministry, title,
  CASE rank
    WHEN 'president' THEN 'architect_prime'
    WHEN 'minister'  THEN
      CASE WHEN autonomy_level >= 4 THEN 'domain_architect' ELSE 'field_guide' END
    ELSE rank
  END,
  status, autonomy_level, nco_agent_id, policy_focus, last_action_at, appointed_at, created_at
FROM nova_civil_servants_bak;

-- 5) title 업데이트 (디지털 명칭)
UPDATE nova_civil_servants SET title = '아키텍트 프라임 (Architect Prime)'         WHERE did = 'did:nova:official-president';
UPDATE nova_civil_servants SET title = '이노베이션 아키텍트 (Innovation Architect)' WHERE did = 'did:nova:official-minister-tech';
UPDATE nova_civil_servants SET title = '빌드 아키텍트 (Build Architect)'           WHERE did = 'did:nova:official-minister-impl';
UPDATE nova_civil_servants SET title = '가디언 아키텍트 (Guardian Architect)'       WHERE did = 'did:nova:official-minister-sec';
UPDATE nova_civil_servants SET title = '크리에이티브 가이드 (Creative Guide)'        WHERE did = 'did:nova:official-minister-culture';
UPDATE nova_civil_servants SET title = '리서치 가이드 (Research Guide)'             WHERE did = 'did:nova:official-minister-research';
UPDATE nova_civil_servants SET title = '저스티스 가이드 (Justice Guide)'            WHERE did = 'did:nova:official-minister-justice';

-- 6) 백업 테이블 제거
DROP TABLE IF EXISTS nova_civil_servants_bak;

PRAGMA foreign_keys = ON;
